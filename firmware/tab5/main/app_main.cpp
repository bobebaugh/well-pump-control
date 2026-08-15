#include <cstdio>
#include <cstring>
#include <ctime>
#include "bsp/esp-bsp.h"
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "nvs_flash.h"
#include "pilot_config.h"
#include "pilot_model.h"

namespace {
constexpr EventBits_t WIFI_CONNECTED_BIT = BIT0;
constexpr size_t HTTP_BUFFER_SIZE = 2048;
const char *TAG = "well-pilot";
EventGroupHandle_t wifi_events;
lv_obj_t *state_label, *power_label, *voltage_label, *pf_label;
lv_obj_t *cycle_label, *network_label, *history_label;
uint32_t wifi_start_events;
uint32_t wifi_disconnect_events;

struct HttpBuffer { char data[HTTP_BUFFER_SIZE]; size_t length; };

esp_err_t http_event(esp_http_client_event_t *event) {
    auto *buffer = static_cast<HttpBuffer *>(event->user_data);
    if (event->event_id == HTTP_EVENT_ON_DATA && buffer && event->data_len > 0) {
        const size_t available = sizeof(buffer->data) - buffer->length - 1;
        const size_t count = event->data_len < available ? event->data_len : available;
        memcpy(buffer->data + buffer->length, event->data, count);
        buffer->length += count;
        buffer->data[buffer->length] = '\0';
    }
    return ESP_OK;
}

void wifi_handler(void *, esp_event_base_t base, int32_t id, void *event_data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        ++wifi_start_events;
        const esp_err_t result = esp_wifi_connect();
        ESP_LOGI(TAG, "Wi-Fi STA_START #%lu; esp_wifi_connect()=%s (0x%lx)",
            (unsigned long)wifi_start_events, esp_err_to_name(result), (unsigned long)result);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        ++wifi_disconnect_events;
        const auto *disconnect = static_cast<const wifi_event_sta_disconnected_t *>(event_data);
        const unsigned reason = disconnect ? disconnect->reason : 0;
        xEventGroupClearBits(wifi_events, WIFI_CONNECTED_BIT);
        g_pilot_model.set_wifi(false);
        const esp_err_t result = esp_wifi_connect();
        ESP_LOGW(TAG, "Wi-Fi disconnected #%lu reason=%u; esp_wifi_connect()=%s (0x%lx)",
            (unsigned long)wifi_disconnect_events, reason, esp_err_to_name(result), (unsigned long)result);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(wifi_events, WIFI_CONNECTED_BIT);
        g_pilot_model.set_wifi(true);
        ESP_LOGI(TAG, "Wi-Fi connected");
    }
}

bool log_wifi_result(const char *operation, esp_err_t result) {
    ESP_LOGI(TAG, "Wi-Fi init %s=%s (0x%lx)", operation, esp_err_to_name(result), (unsigned long)result);
    return result == ESP_OK;
}

bool initialize_board_io_and_internal_antenna() {
    const esp_err_t i2c_result = bsp_i2c_init();
    if (i2c_result != ESP_OK) {
        ESP_LOGE(TAG, "Board I2C initialization failed: %s", esp_err_to_name(i2c_result));
        return false;
    }

    // PI4IOE1 P0 is the Tab5 antenna select.  Its BSP initialization makes it
    // an output; explicitly drive it low to select the internal antenna.
    bsp_io_expander_pi4ioe_init(bsp_i2c_get_handle());
    bsp_set_ext_antenna_enable(false);
    ESP_LOGI(TAG, "Internal Wi-Fi antenna selected (PI4IOE1 P0 low)");
    return true;
}

bool start_wifi() {
    // This mirrors the known-working UserDemo task sequence: netif, default
    // event loop, remote Wi-Fi netif, Wi-Fi init, configuration, then start.
    if (!log_wifi_result("esp_netif_init", esp_netif_init())) return false;
    if (!log_wifi_result("esp_event_loop_create_default", esp_event_loop_create_default())) return false;
    esp_netif_t *station_netif = esp_netif_create_default_wifi_sta();
    ESP_LOGI(TAG, "Wi-Fi init esp_netif_create_default_wifi_sta=%s", station_netif ? "OK" : "NULL");
    if (!station_netif) return false;
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    if (!log_wifi_result("esp_wifi_init", esp_wifi_init(&config))) return false;
    if (!log_wifi_result("register_wifi_events",
            esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_handler, nullptr))) return false;
    if (!log_wifi_result("register_ip_event",
            esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_handler, nullptr))) return false;
    wifi_config_t station = {};
    strlcpy(reinterpret_cast<char *>(station.sta.ssid), PILOT_WIFI_SSID, sizeof(station.sta.ssid));
    strlcpy(reinterpret_cast<char *>(station.sta.password), PILOT_WIFI_PASSWORD, sizeof(station.sta.password));
    station.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    station.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
    if (!log_wifi_result("esp_wifi_set_mode", esp_wifi_set_mode(WIFI_MODE_STA))) return false;
    if (!log_wifi_result("esp_wifi_set_config", esp_wifi_set_config(WIFI_IF_STA, &station))) return false;
    if (!log_wifi_result("esp_wifi_start", esp_wifi_start())) return false;
    esp_sntp_config_t time_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    if (!log_wifi_result("esp_netif_sntp_init", esp_netif_sntp_init(&time_config))) return false;
    return true;
}

void wifi_start_task(void *) {
    if (!start_wifi()) {
        ESP_LOGE(TAG, "Wi-Fi startup failed; telemetry will remain offline");
    }
    vTaskDelete(nullptr);
}

bool read_shelly(PowerSample &sample) {
    HttpBuffer response = {};
    esp_http_client_config_t config = {};
    config.url = PILOT_SHELLY_URL;
    config.method = HTTP_METHOD_GET;
    config.timeout_ms = PILOT_SHELLY_REQUEST_TIMEOUT_MS;
    config.event_handler = http_event;
    config.user_data = &response;
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return false;
    const esp_err_t result = esp_http_client_perform(client);
    const int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (result != ESP_OK || status != 200) return false;

    cJSON *root = cJSON_Parse(response.data);
    if (!root) return false;
    auto number = [root](const char *key, double &out) {
        cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
        if (!cJSON_IsNumber(item)) return false;
        out = item->valuedouble;
        return true;
    };
    cJSON *valid = cJSON_GetObjectItemCaseSensitive(root, "is_valid");
    sample = {};
    sample.captured_us = esp_timer_get_time();
    const bool parsed = number("power", sample.power_w) && number("reactive", sample.reactive_var) &&
        number("pf", sample.power_factor) && number("voltage", sample.voltage_v) &&
        number("total", sample.total_wh) && number("total_returned", sample.total_returned_wh) &&
        cJSON_IsBool(valid);
    sample.valid = parsed && cJSON_IsTrue(valid);
    cJSON_Delete(root);
    return parsed;
}

void format_timestamp(char *output, size_t size) {
    time_t now = time(nullptr);
    struct tm utc = {};
    gmtime_r(&now, &utc);
    if (now < 1700000000 || strftime(output, size, "%Y-%m-%dT%H:%M:%SZ", &utc) == 0)
        snprintf(output, size, "1970-01-01T00:00:00Z");
}

bool publish_sample(const PilotSnapshot &snapshot, const char *reason) {
    char observed_at[32], body[768];
    format_timestamp(observed_at, sizeof(observed_at));
    snprintf(body, sizeof(body),
        "{\"schemaVersion\":1,\"deviceId\":\"%s\",\"observedAt\":\"%s\","
        "\"publishReason\":\"%s\",\"power\":%.3f,\"reactive\":%.3f,\"pf\":%.3f,"
        "\"voltage\":%.3f,\"is_valid\":%s,\"total\":%.3f,\"total_returned\":%.3f}",
        PILOT_DEVICE_ID, observed_at, reason, snapshot.sample.power_w,
        snapshot.sample.reactive_var, snapshot.sample.power_factor, snapshot.sample.voltage_v,
        snapshot.sample.valid ? "true" : "false", snapshot.sample.total_wh,
        snapshot.sample.total_returned_wh);
    HttpBuffer response = {};
    esp_http_client_config_t config = {};
    config.url = PILOT_INGEST_URL;
    config.method = HTTP_METHOD_POST;
    config.timeout_ms = PILOT_PUBLISH_REQUEST_TIMEOUT_MS;
    config.event_handler = http_event;
    config.user_data = &response;
    config.crt_bundle_attach = esp_crt_bundle_attach;
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return false;
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "X-Pilot-Key", PILOT_INGEST_TOKEN);
    esp_http_client_set_post_field(client, body, strlen(body));
    const esp_err_t result = esp_http_client_perform(client);
    const int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    const bool success = result == ESP_OK && status >= 200 && status < 300;
    if (success) {
        cJSON *root = cJSON_Parse(response.data);
        cJSON *monitoring = root ? cJSON_GetObjectItemCaseSensitive(root, "monitoring") : nullptr;
        cJSON *active = monitoring ? cJSON_GetObjectItemCaseSensitive(monitoring, "active") : nullptr;
        g_pilot_model.set_monitoring(cJSON_IsTrue(active), esp_timer_get_time());
        cJSON_Delete(root);
    }
    return success;
}

void sampling_task(void *) {
    TickType_t next = xTaskGetTickCount();
    uint32_t sample_count = 0;
    bool polling_active = false;
    ESP_LOGI(TAG, "Shelly sampling task started");
    while (true) {
        PowerSample sample = {};
        const bool connected = wifi_events && (xEventGroupGetBits(wifi_events) & WIFI_CONNECTED_BIT) != 0;
        if (!connected) {
            sample.captured_us = esp_timer_get_time();
            sample.valid = false;
            if (polling_active) {
                ESP_LOGW(TAG, "Shelly polling paused while Wi-Fi is unavailable");
                polling_active = false;
            }
        } else if (!read_shelly(sample)) {
            sample.captured_us = esp_timer_get_time();
            sample.valid = false;
            ESP_LOGW(TAG, "Shelly read failed");
        } else {
            if (!polling_active) {
                ESP_LOGI(TAG, "Shelly polling active");
                polling_active = true;
            }
            ++sample_count;
            ESP_LOGI(TAG, "Shelly sample %lu received (%s)",
                (unsigned long)sample_count, sample.valid ? "valid" : "invalid");
        }
        const bool changed = g_pilot_model.add_sample(sample);
        if (changed) ESP_LOGI(TAG, "Pump transition detected at %.0f W", sample.power_w);
        xTaskDelayUntil(&next, pdMS_TO_TICKS(PILOT_SAMPLE_PERIOD_MS));
    }
}

void cloud_task(void *) {
    uint32_t sent_sample = 0, seen_state = 0;
    int64_t last_publish_us = -(int64_t)PILOT_HEARTBEAT_PERIOD_MS * 1000;
    int64_t last_attempt_us = -(int64_t)PILOT_PUBLISH_RETRY_MS * 1000;
    while (true) {
        PilotSnapshot snapshot = g_pilot_model.snapshot();
        const int64_t now = esp_timer_get_time();
        const bool connected = wifi_events && (xEventGroupGetBits(wifi_events) & WIFI_CONNECTED_BIT) != 0;
        const bool transition = snapshot.state_sequence != seen_state;
        const bool heartbeat = now - last_publish_us >= (int64_t)PILOT_HEARTBEAT_PERIOD_MS * 1000;
        const bool live = snapshot.monitoring_active && snapshot.sample_sequence != sent_sample;
        const bool clock_ready = time(nullptr) >= 1700000000;
        const bool retry_due = now - last_attempt_us >= (int64_t)PILOT_PUBLISH_RETRY_MS * 1000;
        if (connected && clock_ready && snapshot.has_sample && retry_due && (transition || heartbeat || live)) {
            const char *reason = live ? "monitoring" : (transition ? "state-change" : "heartbeat");
            last_attempt_us = now;
            const bool success = publish_sample(snapshot, reason);
            g_pilot_model.note_cloud_attempt(success);
            if (success) {
                last_publish_us = now;
                sent_sample = snapshot.sample_sequence;
                seen_state = snapshot.state_sequence;
                ESP_LOGI(TAG, "Netlify publish succeeded (%s)", reason);
            } else {
                ESP_LOGW(TAG, "Netlify publish failed (%s)", reason);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(snapshot.monitoring_active ? 200 : 1000));
    }
}

lv_obj_t *make_card(lv_obj_t *parent, int x, int y, int w, int h) {
    lv_obj_t *card = lv_obj_create(parent);
    lv_obj_set_pos(card, x, y);
    lv_obj_set_size(card, w, h);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x12172b), 0);
    lv_obj_set_style_border_color(card, lv_color_hex(0x2d365a), 0);
    lv_obj_set_style_border_width(card, 2, 0);
    lv_obj_set_style_radius(card, 14, 0);
    return card;
}

lv_obj_t *make_label(lv_obj_t *parent, const char *text, int x, int y, const lv_font_t *font) {
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, text);
    lv_obj_set_pos(label, x, y);
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(0xf2f5ff), 0);
    return label;
}

bool create_ui() {
    ESP_LOGI(TAG, "Display initialization started");
    const esp_err_t i2c_result = bsp_i2c_init();
    if (i2c_result != ESP_OK) {
        ESP_LOGE(TAG, "Display I2C initialization failed: %s", esp_err_to_name(i2c_result));
        return false;
    }
    bsp_reset_tp();
    if (bsp_display_start() == nullptr) {
        ESP_LOGE(TAG, "Display controller initialization failed");
        return false;
    }
    ESP_LOGI(TAG, "Display controller initialized");
    if (!bsp_display_lock(0)) {
        ESP_LOGE(TAG, "Display lock acquisition failed");
        return false;
    }
    ESP_LOGI(TAG, "Display lock acquired");
    lv_obj_t *screen = lv_scr_act();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x080b1d), 0);
    lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    make_label(screen, "PRIVATE WELL · OBSERVATIONAL PILOT", 34, 24, &lv_font_montserrat_18);
    make_label(screen, "Well Pump Monitoring", 34, 55, &lv_font_montserrat_36);
    lv_obj_t *notice = make_label(screen, "MONITOR ONLY · NO PUMP CONTROL", 845, 38, &lv_font_montserrat_18);
    lv_obj_set_style_text_color(notice, lv_color_hex(0xf2c94c), 0);

    lv_obj_t *state = make_card(screen, 30, 125, 380, 190);
    make_label(state, "PUMP", 20, 16, &lv_font_montserrat_18);
    state_label = make_label(state, "WAITING FOR METER", 20, 52, &lv_font_montserrat_24);
    power_label = make_label(state, "— W", 20, 100, &lv_font_montserrat_36);
    lv_obj_t *electrical = make_card(screen, 430, 125, 390, 190);
    make_label(electrical, "ELECTRICAL", 20, 16, &lv_font_montserrat_18);
    voltage_label = make_label(electrical, "Voltage  — V", 20, 58, &lv_font_montserrat_24);
    pf_label = make_label(electrical, "Power factor  —", 20, 105, &lv_font_montserrat_24);
    lv_obj_t *cycle = make_card(screen, 840, 125, 400, 190);
    make_label(cycle, "CURRENT CYCLE", 20, 16, &lv_font_montserrat_18);
    cycle_label = make_label(cycle, "—", 20, 64, &lv_font_montserrat_36);
    lv_obj_t *health = make_card(screen, 30, 340, 1210, 310);
    make_label(health, "DEVICE HEALTH", 20, 16, &lv_font_montserrat_18);
    network_label = make_label(health, "Wi-Fi: configuration pending", 20, 62, &lv_font_montserrat_24);
    history_label = make_label(health, "RAM history: 0 / 3600 seconds", 20, 112, &lv_font_montserrat_24);
    make_label(health, "Reserved: pressure · tank level · alarms · advanced controls", 20, 220, &lv_font_montserrat_18);
    bsp_display_unlock();
    bsp_display_backlight_on();
    ESP_LOGI(TAG, "Display initialized and backlight enabled");
    return true;
}

void ui_task(void *) {
    while (true) {
        PilotSnapshot snapshot = g_pilot_model.snapshot();
        bsp_display_lock(0);
        if (!snapshot.has_sample || !snapshot.sample.valid) {
            lv_label_set_text(state_label, "METER UNAVAILABLE");
            lv_label_set_text(power_label, "— W");
            lv_label_set_text(voltage_label, "Voltage  — V");
            lv_label_set_text(pf_label, "Power factor  —");
        } else {
            lv_label_set_text(state_label, snapshot.pump_running ? "RUNNING" : "STOPPED");
            lv_label_set_text_fmt(power_label, "%.0f W", snapshot.sample.power_w);
            lv_label_set_text_fmt(voltage_label, "Voltage  %.1f V", snapshot.sample.voltage_v);
            lv_label_set_text_fmt(pf_label, "Power factor  %.2f", snapshot.sample.power_factor);
        }
        if (snapshot.pump_running) {
            lv_label_set_text_fmt(cycle_label, "%02lu:%02lu",
                (unsigned long)(snapshot.cycle_seconds / 60), (unsigned long)(snapshot.cycle_seconds % 60));
        } else {
            lv_label_set_text(cycle_label, "IDLE");
        }
        lv_label_set_text_fmt(network_label, "Wi-Fi: %s     Cloud: %s     Live: %s",
            snapshot.wifi_connected ? "connected" : "offline",
            snapshot.cloud_connected ? "connected" : "offline",
            snapshot.monitoring_active ? "active" : "off");
        lv_label_set_text_fmt(history_label, "RAM history: %lu / %d seconds     Cloud failures: %lu",
            (unsigned long)snapshot.sample_count, PILOT_RING_CAPACITY, (unsigned long)snapshot.cloud_failures);
        bsp_display_unlock();
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

void display_task(void *) {
    if (!create_ui()) {
        ESP_LOGE(TAG, "Display task stopped; telemetry remains active");
        vTaskDelete(nullptr);
        return;
    }

    if (xTaskCreate(ui_task, "pilot-ui", 6144, nullptr, 3, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "UI refresh task creation failed; telemetry remains active");
    }
    vTaskDelete(nullptr);
}
}  // namespace

extern "C" void app_main(void) {
    esp_err_t nvs = nvs_flash_init();
    if (nvs == ESP_ERR_NVS_NO_FREE_PAGES || nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvs = nvs_flash_init();
    }
    ESP_ERROR_CHECK(nvs);
    ESP_ERROR_CHECK(g_pilot_model.begin() ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_LOGI(TAG, "Pilot application initialized");
    const bool internal_antenna_ready = initialize_board_io_and_internal_antenna();
#if PILOT_HAS_LOCAL_SECRETS
    wifi_events = xEventGroupCreate();
    if (!wifi_events) {
        ESP_LOGE(TAG, "Wi-Fi event group allocation failed; telemetry will remain offline");
    } else if (!internal_antenna_ready) {
        ESP_LOGE(TAG, "Internal antenna selection failed; telemetry will remain offline");
    } else if (xTaskCreate(wifi_start_task, "pilot-wifi", 6144, nullptr, 5, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "Wi-Fi startup task creation failed; telemetry will remain offline");
    }
    xTaskCreate(sampling_task, "shelly-sample", 8192, nullptr, 5, nullptr);
    xTaskCreate(cloud_task, "cloud-publish", 10240, nullptr, 4, nullptr);
#else
    ESP_LOGW(TAG, "secrets.local.h is absent; networking and Shelly sampling are disabled");
#endif
    if (xTaskCreatePinnedToCore(display_task, "pilot-display", 10240, nullptr, 3, nullptr, 1) != pdPASS) {
        ESP_LOGE(TAG, "Display task creation failed; telemetry remains active");
    }
}
