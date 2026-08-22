# Tab5 interpreted MicroPython instructions

These instructions apply to all work under `tab5/`.

## Current platform

- The supported path is interpreted MicroPython on the M5Stack Tab5 using the stock M5Stack UIFlow 2.5.0 image installed with M5Burner.
- The owner performs M5Burner flashes and device file installation. Agents do not build firmware, flash hardware, erase flash/NVS, format media, or operate the physical device unless the user explicitly requests a supervised hardware session.
- Do not use ESP-IDF, CMake, compiled firmware, microSD, the old build scripts, or the old platform runbook for current development.
- `firmware/tab5/`, `docs/tab5-platform-runbook.md`, and the `agent/tab5-*` branches describe an abandoned compiled approach. They are not implementation authority.

## Baseline and delivery

- Until the first interpreted baseline is imported, the hardware-working source is the owner's plain-file directory `C:\Tab5\pilot-micropython`.
- After import, committed files under `tab5/` on the `Tab5` branch are the source authority. Hardware truth still requires the owner's physical verification.
- `C:\Tab5\pilot-micropython` is never a Git checkout. Copy a release candidate there only when the user explicitly says it is ready to install.
- The owner manually installs the runtime files and reports the result. Do not call a revision known-good until that report is received; then preserve it with a clear commit and, when requested, a known-good tag.
- UIFlow's stock boot process and flashed Wi-Fi configuration are the current baseline. `boot.py` behavior, the boot menu, and recovery modes remain deliberate architecture decisions; do not silently replace the stock file.

## Change discipline

- First preserve and import the working interpreted baseline without redesign.
- Split `pilot.py` mechanically into clearly named modules before adding application functionality. Preserve observable behavior at each split.
- Make one bounded work unit per commit. State what can be checked without hardware and what still needs owner verification.
- Prefer plain MicroPython modules and explicit data structures over frameworks, generators, build systems, or dependency managers.
- Do not implement future rules, controls, logging, watch mode, boot options, or recovery behavior merely because they appear in planning records. Implement only the work unit the user approved.
- A syntax check or host-side test is not physical proof. Never claim display, touch, ADC, battery, Wi-Fi, Shelly, TLS, reset, threading, or timing behavior without a reported Tab5 test.

## Accepted architecture boundary

- One CPU/thread owns device work: ADC sampling, touch, display, battery, Shelly interaction, control decisions, event state, and the one-second application loop.
- The other CPU/thread owns remote communications: Netlify, Firebase RTDB, TLS, authentication refresh, reconnects, and network waits.
- Exchange complete immutable messages through small bounded inbound and outbound queues. Do not share mutable working dictionaries, hardware objects, or application state across threads.
- Device work must continue when communications stall. Network work must not directly manipulate hardware or HMI objects.
- Routine telemetry may be coalesced or discarded when stale. Event transitions and acknowledgements require a separate bounded priority path. Ephemeral watch samples are never backlogged.
- RAM is the default device store. Firestore is durable history/configuration; RTDB is the approved low-latency command/watch transport. Do not add device filesystem persistence without an essential, reviewed reason.
- Keep active events on the device until cleared. Keep their cloud-delivery queue separate from the active-event table.
- The detailed rules engine and event schema are future work. Read the records selected by `PROJECT_WORKFLOW.md` before touching those areas.

## Startup, networking, and secrets

- Provisioned UIFlow Wi-Fi is the preferred network source. Retain a short post-association delay and design reconnect behavior, but remove application-embedded Wi-Fi credentials only after real-device association and reconnect tests pass.
- WebREPL is intended for LAN-only maintenance and file transfer. Do not expose it through router port forwarding or place it on the public Internet.
- Preserve the hardware-verified Thonny reset procedure in `PROVISIONING.md`: issue `import machine; machine.reset()`, immediately switch Thonny to Local Python, wait for complete device startup, and only then select ESP32/WebREPL and reconnect. Leaving Thonny on WebREPL during reboot can prevent application startup and require physical power-button recovery.
- Real device values belong in an uncommitted `device_secrets.py` on the Tab5. Commit only `device_secrets.example.py` with placeholders and provisioning documentation.
- Expected secrets include the dedicated Firebase device login, Netlify ingest token, and WebREPL password. Wi-Fi belongs there only if testing proves an application fallback is necessary.
- A Firebase web API key is a public project identifier, not device authentication. Never store a Firebase Admin/service-account private key on the Tab5.

## Safety behavior

- Missed telemetry, a lost log record, or reconstructed short-lived state is acceptable; blocking the local control loop is not.
- After restart, rebuild decisions from current observations and normal rule evaluation.
- Never restore a stale inhibit blindly. Any future Tab5-requested Shelly lockout must expire or be released if healthy Tab5 polling disappears, while Shelly-local anti-cycle behavior remains independent.
- Physical HAND operation remains outside software authority.
