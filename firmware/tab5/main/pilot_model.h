#pragma once
#include <stddef.h>
#include <stdint.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

struct PowerSample {
    int64_t captured_us;
    double power_w, reactive_var, power_factor, voltage_v, total_wh, total_returned_wh;
    bool valid;
};

struct PilotSnapshot {
    PowerSample sample;
    bool has_sample, wifi_connected, cloud_connected, ads1110_available;
    int64_t ads1110_microvolts;
    int32_t ads1110_error;
    uint32_t sample_count, sample_sequence, cloud_failures, ads1110_sequence;
    int64_t sample_heartbeat_us, cloud_heartbeat_us;
};

class PilotModel {
public:
    bool begin();
    void set_wifi(bool connected);
    void add_sample(const PowerSample &sample);
    void set_ads1110_result(bool available, int64_t microvolts, int32_t error);
    void note_cloud_attempt(bool success);
    PilotSnapshot snapshot();
private:
    SemaphoreHandle_t mutex_ = nullptr;
    PilotSnapshot state_ = {};
};

extern PilotModel g_pilot_model;
