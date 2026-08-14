#pragma once
#if __has_include("secrets.local.h")
#include "secrets.local.h"
#define PILOT_HAS_LOCAL_SECRETS 1
#else
#define PILOT_WIFI_SSID ""
#define PILOT_WIFI_PASSWORD ""
#define PILOT_INGEST_TOKEN ""
#define PILOT_HAS_LOCAL_SECRETS 0
#endif
#define PILOT_DEVICE_ID "shelly-em-well"
#define PILOT_SHELLY_URL "http://192.168.50.141/emeter/0"
#define PILOT_INGEST_URL "https://pilot--well-pump-control.netlify.app/.netlify/functions/ingest-power"
#define PILOT_SAMPLE_PERIOD_MS 1000
#define PILOT_HEARTBEAT_PERIOD_MS 60000
#define PILOT_MONITOR_LIMIT_MS (15 * 60 * 1000)
#define PILOT_START_THRESHOLD_W 1000.0
#define PILOT_STOP_THRESHOLD_W 100.0
#define PILOT_RING_CAPACITY 3600
