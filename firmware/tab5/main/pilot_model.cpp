#include "pilot_model.h"
#include <cstdlib>
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "pilot_config.h"

PilotModel g_pilot_model;

bool PilotModel::begin() {
    mutex_ = xSemaphoreCreateMutex();
    ring_ = static_cast<PowerSample *>(heap_caps_calloc(
        PILOT_RING_CAPACITY, sizeof(PowerSample), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!ring_) ring_ = static_cast<PowerSample *>(calloc(PILOT_RING_CAPACITY, sizeof(PowerSample)));
    return mutex_ && ring_;
}

void PilotModel::set_wifi(bool connected) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    state_.wifi_connected = connected;
    xSemaphoreGive(mutex_);
}

bool PilotModel::add_sample(const PowerSample &sample) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    const bool previous = state_.pump_running;
    if (sample.valid) {
        if (!state_.pump_running && sample.power_w >= PILOT_START_THRESHOLD_W) {
            state_.pump_running = true;
            cycle_started_us_ = sample.captured_us;
        } else if (state_.pump_running && sample.power_w <= PILOT_STOP_THRESHOLD_W) {
            state_.pump_running = false;
        }
    }
    ring_[ring_head_] = sample;
    ring_head_ = (ring_head_ + 1) % PILOT_RING_CAPACITY;
    if (ring_count_ < PILOT_RING_CAPACITY) ++ring_count_;
    state_.sample = sample;
    state_.has_sample = true;
    state_.sample_count = static_cast<uint32_t>(ring_count_);
    ++state_.sample_sequence;
    state_.sample_heartbeat_us = esp_timer_get_time();
    if (state_.pump_running && cycle_started_us_) {
        state_.cycle_seconds = static_cast<uint32_t>((sample.captured_us - cycle_started_us_) / 1000000);
    } else if (!state_.pump_running) {
        state_.cycle_seconds = 0;
    }
    const bool changed = state_.sample_sequence > 1 && previous != state_.pump_running;
    if (changed) ++state_.state_sequence;
    xSemaphoreGive(mutex_);
    return changed;
}

void PilotModel::note_cloud_attempt(bool success) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    state_.cloud_connected = success;
    state_.cloud_heartbeat_us = esp_timer_get_time();
    if (!success) ++state_.cloud_failures;
    xSemaphoreGive(mutex_);
}

void PilotModel::set_monitoring(bool active, int64_t now_us) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    if (active && !state_.monitoring_active) {
        state_.monitoring_active = true;
        state_.monitoring_deadline_us = now_us + (int64_t)PILOT_MONITOR_LIMIT_MS * 1000;
    } else if (!active) {
        state_.monitoring_active = false;
        state_.monitoring_deadline_us = 0;
    }
    xSemaphoreGive(mutex_);
}

PilotSnapshot PilotModel::snapshot() {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    if (state_.monitoring_active && esp_timer_get_time() >= state_.monitoring_deadline_us) {
        state_.monitoring_active = false;
        state_.monitoring_deadline_us = 0;
    }
    PilotSnapshot copy = state_;
    xSemaphoreGive(mutex_);
    return copy;
}
