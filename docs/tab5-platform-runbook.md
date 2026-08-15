# Tab5 Platform Runbook

## Purpose and authority

This runbook preserves the board-specific engineering knowledge needed to build, flash, diagnose, and safely extend the M5Stack Tab5 firmware in this repository.

- The Google Drive project documents remain authoritative for installed facts and system architecture.
- This repository is authoritative for firmware, dependencies, executable contracts, tests, and developer procedures.
- The untouched M5Stack `M5Tab5-UserDemo` is the board-integration reference. Do not convert the vendor demo tree into the owned application.
- The current firmware is observational only. It has no pump-control output and must not gain pump-start authority.

## Verified checkpoint

| Item | Verified value |
| --- | --- |
| Branch | `pilot` |
| Stable platform commit | `6222cb5824793b39ee76b09781a0c8578c38bdc0` |
| ESP-IDF | `v5.4.2` |
| Target | ESP32-P4 with ESP32-C6 Wi-Fi coprocessor |
| Verified image size | 1,418,320 bytes (`0x15a450`) |
| Display controller observed | ST7123 |
| Local meter | Gen-1 Shelly EM channel 0 at `192.168.50.141` |
| Pilot cadence | Shelly poll approximately 1 Hz; Cloud heartbeat approximately 60 seconds |

The checkpoint built, flashed, initialized the display, brought up the C6/SDIO transport and Wi-Fi, produced predominantly successful one-second Shelly samples, published repeated Netlify heartbeats, and recorded a real pump start and stop in Firestore. No reset, abort, watchdog, or I2C-driver conflict was observed during the bounded verification.

## Source and dependency model

The owned application is under `firmware/tab5/` and uses:

- ESP-IDF exactly `5.4.2`;
- ESP-Hosted `1.4.0` and ESP Wi-Fi Remote `0.8.5`;
- the repository's reproducible `dependencies.lock`;
- a local, licensed LVGL `9.2.2` component under `firmware/tab5/components/lvgl`;
- the local Tab5 BSP/component layout carried forward from the known-working UserDemo platform.

The local LVGL component is intentional. The original reconstructed pilot selected an incompatible managed LVGL 8 path, while the working UserDemo used its local LVGL 9.2.2 component and corresponding LVGL-port sources. Do not replace the local component casually or regenerate the platform around selected BSP pieces.

Important `sdkconfig.defaults` decisions include:

```text
CONFIG_IDF_TARGET="esp32p4"
CONFIG_ESP_HOSTED_ENABLED=y
CONFIG_ESP_HOSTED_SDIO_HOST_INTERFACE=y
CONFIG_ESP_WIFI_REMOTE_ENABLED=y
CONFIG_ESP_WIFI_REMOTE_LIBRARY_HOSTED=y
CONFIG_CODEC_I2C_BACKWARD_COMPATIBLE=n
CONFIG_BSP_I2C_FAST_MODE=n
```

`CONFIG_CODEC_I2C_BACKWARD_COMPATIBLE=n` keeps the codec and BSP on the same ESP-IDF I2C API family. The BSP I2C bus is deliberately aligned to 100 kHz rather than the earlier 400 kHz pilot default.

## Board-specific hardware facts

### Wi-Fi antenna selection

Tab5 selects its Wi-Fi antenna through PI4IOE1 expander pin P0:

- LOW: internal antenna
- HIGH: external antenna

No external antenna is installed. Firmware must initialize board I2C/the expander and explicitly call:

```cpp
bsp_set_ext_antenna_enable(false);
```

This must occur before `esp_wifi_init()` triggers the C6 reset/SDIO/Wi-Fi startup sequence. Do not rely on a default or floating state. The verified pilot performs the selection in `initialize_board_io_and_internal_antenna()` before creating the Wi-Fi task. The display task must not reconfigure P0.

Missing or late antenna selection caused association loss, disconnect reason 200, intermittent Shelly requests, and TLS connection timeouts even though the router sometimes retained a client entry.

### ESP-Hosted SDIO connection

The P4 reaches the C6 through the configured four-bit SDIO host interface. Current pin assignments are source-controlled in `sdkconfig.defaults`:

| Function | GPIO |
| --- | ---: |
| SDIO clock | 12 |
| SDIO command | 13 |
| SDIO D0 | 11 |
| SDIO D1 | 10 |
| SDIO D2 | 9 |
| SDIO D3 | 8 |
| C6 reset | 15, active low |

Do not start TCP, HTTP, or TLS work merely because the SDIO INIT event occurred or the router remembers the C6. Network traffic is permitted only after the P4 receives `IP_EVENT_STA_GOT_IP` and sets the Wi-Fi connected event bit. Clear the bit on disconnect and pause network work until IP readiness returns.

### External I2C and ADC

The external Port A I2C interface was verified as:

| Function | Value |
| --- | --- |
| SDA | GPIO 53 |
| SCL | GPIO 54 |
| ADC | M5Stack I2C ADC Unit V1.1 / ADS1110 |
| ADC address | `0x48` |
| Verified mode | 240 SPS, PGA 1x |

The non-destructive diagnostic detected the ADC and obtained valid conversion/configuration responses. Near-zero readings were expected with no pressure sender connected.

### Pressure sender electrical boundary

The selected sender is:

- 0–100 psi;
- 5–16 VDC supply;
- 0.5–4.5 V output;
- red supply positive, black ground, green signal.

Tab5 ground and ADC ground are common; the ADC is not galvanically isolated. Do not connect the sender to the 24 VDC well-control supply. The planned local wiring is:

```text
Tab5 5 V       -> sender red
Tab5/ADC GND   -> sender black and ADC GND
sender green   -> ADC positive input
```

USB-A VBUS must be explicitly enabled in firmware and verified by meter before the sender is connected. Measure sender operating current before committing to permanent Tab5 power.

### microSD

The native SDMMC slot communicated with the inserted card. Mounting returned FatFs result 13 (`FR_NO_FILESYSTEM`), establishing that the slot/card electrical path worked but that the card did not contain a usable FAT filesystem for the diagnostic.

The diagnostic did not format, write, erase, or repartition the card. The next hardware step is to format the card FAT32 on a PC and rerun the already-built non-destructive mount/listing test.

## Required startup order

Preserve this sequencing unless a later verified platform change deliberately replaces it:

1. Initialize NVS and the fixed pilot model.
2. Initialize board I2C and PI4IOE1.
3. Drive PI4IOE1 P0 LOW to select the internal antenna.
4. Create the Wi-Fi event group.
5. Start the Wi-Fi task using the known-working UserDemo flow:
   - `esp_netif_init()`;
   - create the default event loop;
   - create the default Wi-Fi station netif;
   - `esp_wifi_init()`;
   - register Wi-Fi and got-IP handlers;
   - set station mode/configuration;
   - `esp_wifi_start()`;
   - initialize SNTP.
6. Start sampling and Cloud tasks, but gate all sockets on the got-IP event bit and valid clock as appropriate.
7. Start display/LVGL initialization independently on CPU1.
8. Start UI refresh only after display initialization succeeds.

Telemetry tasks are allowed to exist before IP readiness; they are not allowed to race ESP-Hosted by opening sockets before readiness.

## Task and resource ownership

- Sampling/model code is the sole writer to live sample/state storage.
- UI and Cloud tasks consume bounded snapshots, not writable model pointers.
- Display/LVGL has one renderer owner and uses the BSP display lock.
- Display initialization failure stops only the HMI path. Telemetry remains active.
- The future SD subsystem has one filesystem writer task.
- Future fixed arrays use bounded write indices, valid counts, and source sequence values. Readers receive copies or immutable snapshots.

The current pilot creates separate Wi-Fi startup, Shelly sampling, Cloud publishing, display initialization, and UI refresh tasks. Sampling waits on the IP-ready bit before local HTTP requests. Cloud publishing uses bounded timeouts and a failure backoff so TLS failure cannot monopolize the Wi-Fi transport or destroy the one-second sampler cadence.

## Build, flash, and monitor

From an ESP-IDF 5.4.2 terminal in `firmware/tab5`:

```powershell
idf.py set-target esp32p4
idf.py build
idf.py -p COM3 flash monitor
```

Exit the monitor with `Ctrl+]`.

Safety rules:

- Do not run `erase-flash` as a debugging shortcut.
- Do not erase NVS or the full chip unless a separately diagnosed problem and explicit instruction require it.
- A normal `flash` updates the standard bootloader/partition/application ranges; it is not a full-chip erase.
- If COM3 is busy, identify the owning PID, executable, and command line. Terminate it only when it is a session-owned `idf.py monitor`, Python serial observer, or other known process. Do not kill an unidentified process.
- Never print, copy into logs, or commit `main/secrets.local.h`. It must remain ignored and untracked.

## Privacy-safe runtime acceptance

The serial observer should record aggregate counters and non-sensitive phase markers, not SSID, password, tokens, full configuration values, or response bodies.

Minimum platform acceptance:

- one normal boot;
- internal antenna selected before C6 reset/Wi-Fi initialization;
- one C6/SDIO INIT sequence;
- one station-start event and successful `esp_wifi_connect()` result;
- got-IP received before the first Shelly/Netlify socket attempt;
- display initialized once, or a contained display failure with telemetry continuing;
- Shelly attempts maintain approximately one-second cadence and are predominantly successful;
- at least one successful Netlify heartbeat;
- no reset loop, abort, watchdog, I2C conflict, or unrecoverable SDIO reset;
- no secrets printed or staged.

Application acceptance additionally requires a real stopped → running → stopped observation producing coherent current state and start/stop event records.

## Failure signatures and established causes

| Symptom | Established interpretation / action |
| --- | --- |
| `i2c: CONFLICT!`, abort or reset | Mixed legacy/new ESP-IDF I2C APIs. Preserve `CONFIG_CODEC_I2C_BACKWARD_COMPATIBLE=n` and the known-good BSP/component graph. |
| Display initialization blocks or watchdogs | Reconstructed display/LVGL stack differs from the UserDemo platform. Preserve local LVGL 9.2.2 and the complete known-good BSP foundation; do not disable the watchdog. |
| White screen flashes repeatedly | Usually whole-device reboots, not proof of a bad panel. Capture reset reason, last phase marker, panic/backtrace and watchdog output. |
| Display fails but telemetry also stops | Architectural regression. Display must remain isolated in its own task and must not gate telemetry. |
| ESP-Hosted reports unrecoverable SDIO state after sampling starts | A network task opened sockets before got-IP readiness. Gate and clear traffic using the Wi-Fi event bit. |
| SDIO INIT occurs but no station-start event | Wi-Fi Remote station flow is incomplete. Compare with and adopt the UserDemo initialization order; log non-sensitive return codes. |
| Association followed by reason 200, intermittent Shelly reads or TLS timeouts | Verify PI4IOE1 P0 is explicitly LOW before C6/Wi-Fi startup; do not assume the antenna default. |
| Shelly cadence collapses during Cloud failures | Local request timeout exceeds the sample period or Cloud retry has no backoff. Keep Shelly timeout below one second and bound failed Cloud retries. |
| Router shows a client but P4 has no got-IP event | Router entry may be retained/stale. P4 event state, not the router screen, authorizes network traffic. |
| `FR_NO_FILESYSTEM` from the inserted microSD | Slot/card communication succeeded, but no usable FAT filesystem was found. Format FAT32 externally and repeat the non-destructive test. |

## Display qualification Stage 1

The qualification branch replaces the dashboard with a static LVGL 9 scene: dark navy background, centered white `TAB5 DISPLAY QUALIFICATION` title, and red/green/blue rectangles. It does not create a UI update task or read telemetry data; the existing telemetry-first startup and separate display task remain intact.

The target BSP retains the UserDemo display sequence: `bsp_display_start()` initializes the LVGL port, detects the panel and touch controller, creates the detected ST7123 display, then registers the LVGL display. The qualification code only observes that result through LVGL 9 APIs and LVGL display events; it does not force a panel type or modify the BSP/component.

On the first Stage 1 boot, the application observed: ST7123 detection; a 720x1280 default display with color format 18 (RGB565); an active screen; successful qualification-object creation; an explicit invalidation and refresh; and three LVGL flush start/finish pairs. Wi-Fi connected, Shelly sampling began at roughly one-second cadence, and the Netlify heartbeat succeeded while the static display task had already exited. Physical inspection nevertheless found a uniformly white, full-intensity screen, confirming that LVGL flush events alone do not prove physical scanout.

The same hardware then visibly rendered the exact unmodified UserDemo. Its boot diagnostic positively reported `Detected ST7123 touch controller (FW version: 3), using ST7123 display`, followed by `ST7123 Display initialized with resolution 720x1280`; this identifies the physical controller through firmware-version diagnostic 3 and the actual ST7123 detection branch rather than inferring it from the shared I2C address.

The final root cause was insufficient external-memory bandwidth. `CONFIG_SPIRAM_SPEED_200M=y` was already present in `sdkconfig.defaults`, but ESP-IDF 5.4.2 gates that ESP32-P4 selection on `CONFIG_IDF_EXPERIMENTAL_FEATURES`. Without the gate enabled, ESP-IDF silently generated and compiled a 20 MHz PSRAM configuration. That configuration could not reliably sustain the 70 MHz RGB565 DPI framebuffer scanout from PSRAM. Enabling `CONFIG_IDF_EXPERIMENTAL_FEATURES=y` caused both generated `sdkconfig` and compiled `sdkconfig.h` to select 200 MHz.

Physical confirmation after the controlled correction showed the expected dark-navy screen, centered white `TAB5 DISPLAY QUALIFICATION` text, and red/green/blue rectangles. The display rendered without changing the 128 KiB L2 cache, 64-byte cache line, LVGL partial buffer, portrait orientation, ST7123 panel driver, MIPI DSI/DPI timing, or application display code. The temporary flush diagnostics remain in this physically verified Stage 1 baseline; Stage 2 widgets and touch qualification remain separate work.

## Live display and touch qualification Stage 2

Stage 2 replaces the static qualification scene with a deliberately small `WELL PUMP MONITOR` screen. It uses the UserDemo's software-rotation approach to present a logical 1280x720 landscape canvas on the physical 720x1280 ST7123 panel. The dark-navy screen contains one live panel for pump state, active power, and line voltage, plus one large `TOUCH TEST` button whose count increments once per valid tap and whose color alternates after each tap.

The BSP still detects the physical controller and registers its ST7123 touch device with LVGL. LVGL applies the 90-degree display rotation to pointer coordinates. A one-second LVGL timer reads the existing mutex-protected `PilotSnapshot`; it retains the last valid display sample and shows `WAITING FOR DATA` before one exists or `STALE` when that sample is more than approximately three seconds old. Sampling, Wi-Fi, and Cloud tasks do not call LVGL, and the touch event callback and all widget updates remain in the LVGL context.

The numeric labels deliberately avoid dependence on globally enabled floating-point `printf` support. Power is checked for availability and finiteness, rounded, and formatted as an integer number of watts. Voltage is checked similarly, converted to signed integer tenths, and formatted from its integer and fractional portions with sign-safe magnitude handling. Unavailable values render as `-- W` and `--.- V`.

The accepted ESP-IDF 5.4.2 image is `0x155520` (1,398,048 bytes; size-tool total 1,397,653 bytes). The effective platform remains the physically proven configuration: 200 MHz PSRAM, 128 KiB L2 cache with 64-byte lines, RGB565, one DPI framebuffer, the single 720x50-pixel partial LVGL draw buffer, 70 MHz ST7123 DPI timing, and ESP-Hosted SDIO to the ESP32-C6 at 4-bit/40 MHz. The temporary rate-limited flush diagnostics remain in place.

Runtime qualification observed 200 MHz PSRAM, ST7123 firmware version 3, a 1280x720 LVGL display, registered touch input, successful Wi-Fi and Netlify heartbeat operation, and forty valid Shelly samples at the one-second cadence. No underrun, reset after boot, watchdog, abort, or panic occurred during the bounded monitor. Physical acceptance confirmed correct landscape orientation, correctly updating pump state/watts/voltage, exactly one count increment per tap, and correct touch alignment.

## Current boundaries and deferred work

- The pilot is monitor-only and has no relay, inhibit, Shelly command, pump-start, or pump-stop implementation.
- The pressure sender is not yet connected or calibrated.
- FAT32 card formatting/mount verification remains pending.
- SD append logging, store-and-forward, minute records, incident capture, deterministic durable IDs, and parameter synchronization are designed but not implemented in this checkpoint.
- Web-HMI current refresh, event display, completed-cycle display, and minute-history graph work are separate application concerns; they must not reopen the stable Tab5 platform without a firmware requirement.
- Invalid Shelly observations must eventually update communication health without fabricating transitions or replacing the last valid operational measurement.

## Change discipline

When changing platform-sensitive code:

1. Compare against the known-working UserDemo platform and the verified `pilot` commit before changing component families or initialization order.
2. Change one platform variable at a time and define the expected runtime evidence first.
3. Build from clean generated artifacts when component selection or `sdkconfig` changes.
4. Flash only the required ranges and preserve NVS.
5. Run a short startup/cadence check before a longer stability observation.
6. Do not commit a platform change until display, Wi-Fi, Shelly polling, Netlify heartbeat, and bounded stability pass.
7. Keep diagnostic instrumentation non-sensitive and remove excessive per-second logging once the condition is understood.

## Local checkout and durable sessions

Physical Tab5 work uses Local mode in the canonical Windows checkout, `C:\Tab5\well-pump-control`. Automatically created Codex worktrees are appropriate for non-physical review work but are not valid for builds intended for a physical flash or monitor session.

At the start of a session, inspect the worktree, fetch `origin` with pruning, and query the advertised branch directly with `git ls-remote origin refs/heads/<branch>`. A cached remote-tracking ref can be stale and is never proof of the current remote tip. When a task names a starting SHA, compare that SHA with the advertised ref before editing; stop for a mismatch, dirty worktree, missing recovery artifact, or non-fast-forward condition.

### Known-working Windows environment

The verified ESP-IDF installation is `C:\esp\v5.4.2\esp-idf`. Its working tools configuration is intentionally explicit:

```powershell
$env:IDF_TOOLS_PATH = 'C:\Espressif\tools'
$env:IDF_PYTHON_ENV_PATH = 'C:\Espressif\tools\python\v5.4.2\venv'
. C:\esp\v5.4.2\esp-idf\export.ps1
```

Activation must produce ESP-IDF `v5.4.2` and Python `C:\Espressif\tools\python\v5.4.2\venv\Scripts\python.exe`. The associated constraints file is `C:\Espressif\tools\espidf.constraints.v5.4.txt`. An environment failure ends the firmware task; do not install, repair, replace, upgrade, or regenerate any toolchain component.

From `firmware\tab5`, use the checked-in helpers:

```powershell
.\tools\verify-session.ps1 -ExpectedPilotSha <40-character-sha>
.\tools\build.ps1
.\tools\flash.ps1 -Port COM3
.\tools\monitor.ps1 -Port COM3
```

`flash.ps1` requires an explicit port and verifies its presence. A normal flash has no NVS-erase, full-chip-erase, or SD-format path. COM3 remains the expected port but must be verified at the time of flashing. `monitor.ps1` only starts the standard serial monitor.

### Stale-base SD prevention

An SD qualification draft was prepared against a stale base. SD work must remain isolated until a session verifies the live advertised base and required starting SHA. One designated SD owner may access the filesystem, and no helper may automatically format SD media.
