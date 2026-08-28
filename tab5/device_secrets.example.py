# Release: 2026-08-22 — add the device-local WebREPL password placeholder.
# Copy this file to device_secrets.py and replace every placeholder.
# device_secrets.py is device-local and must never be committed.

WIFI_SSID = "YOUR_WIFI_SSID"
WIFI_PASSWORD = "YOUR_WIFI_PASSWORD"

# Optional access-point pinning. Use a six-byte bytes value when required.
# Example form: bytes([0x00, 0x11, 0x22, 0x33, 0x44, 0x55])
TARGET_BSSID = None

WEBREPL_PASSWORD = "YOUR_WEBREPL_PASSWORD"

INGEST_TOKEN = "YOUR_NETLIFY_INGEST_TOKEN"

