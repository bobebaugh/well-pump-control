# Interpreted baseline provenance

Source directory: `C:\Tab5\pilot-micropython`

Source files reported as working with the M5Stack UIFlow 2.5.0 image:

- `main.py` SHA-256: `A03179E7BDA0DC0CF55B6986563567DB4424C0915D8F3A0F7D00A6A8B3FBB081`
- `pilot.py` SHA-256: `957A2FFA76422613FD9FE431E292B7ACE6A79D8FBB82FB89A4CE0C7E6D313A1C`

Baseline transformation: four device-specific assignments were moved from
`pilot.py` into the uncommitted `device_secrets.py`: Wi-Fi SSID, Wi-Fi
password, target access-point BSSID, and Netlify ingest token. No other
application behavior was intentionally changed.

`boot.py` and `deploy.ps1` were not imported. Startup, boot menu, WebREPL, and
future deployment automation remain separate work units.

This baseline is derived from a previously working device copy. The sanitized
version is not known-good until the owner installs these files and reports a
successful physical test.

