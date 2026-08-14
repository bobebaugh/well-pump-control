# Tab5 well-power pilot

This is the owned pilot firmware for the M5Stack Tab5. It replaces neither the
existing pump controls nor their protections. It has no pump-control output.

Runtime: `Shelly EM (1 Hz) -> Tab5 RAM/display -> Netlify -> Firestore current`

- The Tab5 polls Shelly every second and retains 3,600 samples in a volatile
  PSRAM circular buffer.
- It normally publishes state changes immediately and a heartbeat every 60
  seconds.
- A web-requested monitoring lease temporarily publishes at 1 Hz. The Tab5
  enforces its own 15-minute maximum even if connectivity is lost.
- The backend overwrites one Firestore current document; it does not create a
  permanent second-by-second history.

## One-time setup

1. Install ESP-IDF 5.4.2 and its VS Code extension.
2. Copy `main/secrets.example.h` to `main/secrets.local.h`.
3. Enter the well Wi-Fi credentials and the value already used for Netlify's
   `PILOT_INGEST_TOKEN`.
4. Open an ESP-IDF terminal in this directory.

The local secrets file is ignored by Git. Do not paste it into chat or commit it.

## Build and load

```powershell
idf.py set-target esp32p4
idf.py build
idf.py -p COM3 flash monitor
```

Exit the monitor with `Ctrl+]`. After a successful flash, the PC may be turned
off; the Tab5, Shelly, Wi-Fi, Netlify, and Firestore are the complete runtime.

## First bench acceptance

- Display says `MONITOR ONLY · NO PUMP CONTROL`.
- Wi-Fi and Cloud become connected.
- Off-state power and voltage update every second locally.
- One normal pump cycle shows RUNNING above 1,000 W and STOPPED below 100 W.
- The Netlify HMI becomes fresh after a heartbeat.
- Starting live view produces 1-Hz updates and ends within 15 minutes.
