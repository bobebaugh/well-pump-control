# Tab5 pilot build and exact-artifact flash cookbook

## Scope and safety

Physical Tab5 work occurs only in the canonical Local-mode checkout:

```text
C:\Tab5\well-pump-control
```

The pilot is observational only. Do not use this procedure to add pump control, erase the chip or NVS, format SD media, or access the microSD card. Before a physical operation, verify the current branch/commit and query its advertised ref directly with `git ls-remote`; cached `origin/*` refs are not authoritative.

## Two different operations

`tools/flash.ps1` is a build-and-flash helper. It delegates to `idf.py flash`, which may reconfigure CMake and rebuild when its generated state and supplied configuration are inconsistent. It must not be used where the objective is to reflash an exact archived artifact.

On 2026-08-17, an attempted recovery flash through `tools/flash.ps1 -BuildDirectory build-sdio-release -Sdkconfig sdkconfig.sdio-release` re-ran CMake and rebuilt the application as `844e398`. The original accepted binary SHA-256 was replaced with `3764480f3861c8d411642a4edb12f10614c01d1f370d596b77e0b8fadd46b48f`. The outer session timed out and did not retain final esptool verification/reset output. That attempt is not exact-artifact acceptance.

Use `tools/flash-verified-artifact.ps1` only for the archived Stage 2 recovery package. It calls the ESP-IDF 5.4.2 `esptool.py` directly; it never invokes `idf.py`, CMake, Ninja, or any build target.

## Exact Stage 2 recovery artifact

The source ZIP is:

```text
firmware\tab5\build-sdio-release\tab5-stage2-sdio-recovery-9c8b82e.zip
```

Its SHA-256 must be:

```text
ff3f6cf95efd2c154efda4391cca9b0e6526970f1407234bb446e704ef08721d
```

Extract to a new directory under `firmware\tab5\recovery-artifacts\`; never overwrite a prior build or package. The current package directory is deliberately ignored and must not be staged.

Before any port lookup, the helper validates the package receipt and all package artifacts, including the application, bootloader, partition table, mapping files, ELF, and map. The accepted application is `well_pump_tab5.bin`, 1,398,048 bytes, SHA-256 `10bada0124c6c7a9fbf6f543ea263e39481f38d7445629e59015df759ebbaa87`.

Run the non-hardware validation first:

```powershell
.\firmware\tab5\tools\flash-verified-artifact.ps1 -Port COM3 -Mock
```

`-Mock` performs package and tool-path validation and prints the literal direct-esptool argument list. It does not enumerate COM ports or devices and does not modify artifacts.

For a separately authorized recovery flash, use an explicit COM port:

```powershell
.\firmware\tab5\tools\flash-verified-artifact.ps1 -Port COM3
```

The non-mock path confirms an operational Espressif `VID_303A&PID_1001` device, uses only the package’s three addresses/files (`0x2000` bootloader, `0x10000` application, `0x8000` partition table), preserves NVS, forbids erase operations by construction, captures the direct-esptool exit code/verification/reset markers, and rehashes the package after the command.
