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
    bool has_sample, pump_running, wifi_connected, cloud_connected, monitoring_active;
    uint32_t sample_count, sample_sequence, state_sequence, cloud_failures, cycle_seconds;
    int64_t monitoring_deadline_us, sample_heartbeat_us, cloud_heartbeat_us;
};

class PilotModel {
public:
    bool begin();
    void set_wifi(bool connected);
    bool add_sample(const PowerSample &sample);
    void note_cloud_attempt(bool success);
    void set_monitoring(bool active, int64_t now_us);
    PilotSnapshot snapshot();
private:
    SemaphoreHandle_t mutex_ = nullptr;
    PowerSample *ring_ = nullptr;
    size_t ring_head_ = 0, ring_count_ = 0;
    PilotSnapshot state_ = {};
    int64_t cycle_started_us_ = 0;
};

extern PilotModel g_pilot_model;
