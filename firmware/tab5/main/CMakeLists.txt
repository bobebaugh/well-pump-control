idf_component_register(
  SRCS "app_main.cpp" "pilot_model.cpp"
  INCLUDE_DIRS "."
  REQUIRES esp_http_client esp_wifi esp_event esp_netif nvs_flash json lwip mbedtls m5stack_tab5 lvgl__lvgl
)
