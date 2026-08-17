# Tab5 hardware-validation baseline cookbook

## Scope and safety

This cookbook produces a clean, reproducible hardware-validation checkpoint. The validation firmware is not product pump-control logic. It proves only the Tab5 platform: ST7123 display/touch, PI4IOE1 internal-antenna selection, ESP32-C6 SDIO Wi-Fi, a bounded Wi-Fi/RSSI observation, approximately one-second Shelly polling, and the existing Netlify heartbeat.

Physical work occurs only in the Local-mode canonical checkout:

```text
C:\Tab5\well-pump-control
```

The pilot is observational only. It has no pump start, stop, inhibit, relay, or control authority. Do not erase NVS or the chip, change partitions, mount/probe/write/format the microSD card, or perform SD work. Do not use an archived build directory or `sdkconfig`; the recovery archive remains evidence only.

## Fixed platform inputs

The tracked source of configuration truth is `firmware/tab5/config/sdkconfig.validation.defaults`, not an ignored generated `sdkconfig`. It fixes ESP-IDF 5.4.2, ESP-Hosted 1.4.0, ESP Wi-Fi Remote 0.8.5, 200 MHz PSRAM, the Tab5 ST7123 panel/touch component set, and official ESP32-C6 four-bit/40 MHz SDIO: CMD 13, CLK 12, D0 11, D1 10, D2 9, D3 8, reset GPIO 15 active-low.

Declared component constraints are tracked in `firmware/tab5/main/idf_component.yml`. Resolved component versions and hashes are pinned in `firmware/tab5/dependencies.lock`. The build package copies both, plus local component manifests, to make the provenance receipt self-contained.

## Build a new checkpoint

Choose a new, unused suffix; the helper refuses both reuse of a build directory and overwrite of a checkpoint package. From `firmware\tab5` in the verified ESP-IDF 5.4.2 terminal:

```powershell
.\tools\verify-session.ps1
.\tools\build.ps1 `
  -BuildDirectory build-validation-<unique-suffix> `
  -PackageDirectory checkpoints\tab5-validation-<unique-suffix>
```

`verify-session.ps1` requires clean tracked files, verifies that `secrets.local.h` remains ignored without reading it, and verifies the advertised recovery ref. It reports untracked paths without modifying them, so preserved local SD artifacts do not block a baseline build.

`build.ps1` uses one new explicit build directory and writes the generated `sdkconfig` only inside it. It invokes only the checked-in ESP-IDF wrapper, then creates a checkpoint directory and ZIP. It never reuses, cleans, or overwrites an existing build/package directory.

The package contains the bootloader, application, partition table, generated `sdkconfig`, flash mapping files, ELF, map, tracked validation defaults, dependency lock, component manifests, `BUILD-RECEIPT.md`, and `ARTIFACT-MANIFEST.json`. The adjacent `.zip.sha256` file records the package ZIP hash. The receipt records the source SHA and clean state, IDF/Python paths and versions, configuration hashes, dependency lock hash, component provenance locations, build command, BIN/ELF hashes and sizes, flash mappings, and UTC time.

## Proposed authorized flash procedure

Do not run this procedure until a separate hardware authorization is given. First compare the recorded ZIP SHA-256 with the build output. Then validate the package without accessing a port or device:

```powershell
.\tools\flash-verified-artifact.ps1 `
  -Port COM3 `
  -ValidationPackageDirectory checkpoints\tab5-validation-<unique-suffix> `
  -Mock
```

The non-mock command is the same without `-Mock`:

```powershell
.\tools\flash-verified-artifact.ps1 `
  -Port COM3 `
  -ValidationPackageDirectory checkpoints\tab5-validation-<unique-suffix>
```

Before enumerating `COM3`, the helper validates every manifest-listed package file by path, size, and SHA-256; validates exactly the three permitted mappings—`0x2000` bootloader, `0x10000` application, and `0x8000` partition table; and rejects package path escape. It calls ESP-IDF 5.4.2 `esptool.py` directly and never calls `idf.py`, CMake, Ninja, erase, or a partition-changing command. Its normal flash uses the package mappings and preserves NVS. It also rehashes the package files after esptool exits.

## Monitor and acceptance

`idf.py monitor` normally toggles DTR/RTS and resets the target when monitor startup attaches. ESP-IDF 5.4.2 supports `--no-reset` when an explicit port is supplied. The checked-in monitor helper exposes that supported path:

```powershell
.\tools\monitor.ps1 `
  -Port COM3 `
  -BuildDirectory build-validation-<unique-suffix> `
  -Sdkconfig build-validation-<unique-suffix>\sdkconfig `
  -NoReset
```

Use `-NoReset` for serial capture of an already-running Tab5. Omit it only when a reset on attachment is intended and authorized. `-Mock` prints the literal IDF arguments without opening the port.

After an authorized flash, accept the checkpoint only when physical and serial evidence shows, in order:

1. NVS initializes without erase; the reset reason is logged.
2. PI4IOE1 initializes and P0 is explicitly driven LOW for the internal antenna. The current BSP exposes no antenna readback API, so the firmware logs that limitation rather than fabricating a readback.
3. The C6 SDIO initialization uses four-bit/40 MHz and the official pins; Wi-Fi starts and reports connection time and RSSI.
4. Got-IP occurs before all socket traffic. For 60 seconds afterward, only Wi-Fi/RSSI observation occurs; no Shelly or Netlify socket is opened.
5. After the quiet period, Shelly sampling begins at approximately one-second cadence and the Netlify heartbeat succeeds.
6. The ST7123 screen is visibly correct in landscape and the touch-test count advances exactly once per valid tap.
7. No disconnect loop, watchdog, abort, panic, unexpected reset, or unrecoverable SDIO error occurs during the bounded observation.

## Archived Stage 2 recovery evidence

`tab5-stage2-sdio-recovery-9c8b82e.zip` and the preserved recovery package remain evidence for the prior physical checkpoint. The helper retains its legacy default mode for that package. It is not the product baseline and must not be rebuilt, overwritten, or used as a substitute for a new validation receipt.
