#include "pilot_model.h"
#include "esp_timer.h"

PilotModel g_pilot_model;

bool PilotModel::begin() {
    mutex_ = xSemaphoreCreateMutex();
    return mutex_ != nullptr;
}

void PilotModel::set_wifi(bool connected) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    state_.wifi_connected = connected;
    xSemaphoreGive(mutex_);
}

void PilotModel::add_sample(const PowerSample &sample) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    state_.sample = sample;
    state_.has_sample = true;
    ++state_.sample_count;
    ++state_.sample_sequence;
    state_.sample_heartbeat_us = esp_timer_get_time();
    xSemaphoreGive(mutex_);
}

void PilotModel::note_cloud_attempt(bool success) {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    state_.cloud_connected = success;
    state_.cloud_heartbeat_us = esp_timer_get_time();
    if (!success) ++state_.cloud_failures;
    xSemaphoreGive(mutex_);
}

PilotSnapshot PilotModel::snapshot() {
    xSemaphoreTake(mutex_, portMAX_DELAY);
    PilotSnapshot copy = state_;
    xSemaphoreGive(mutex_);
    return copy;
}
