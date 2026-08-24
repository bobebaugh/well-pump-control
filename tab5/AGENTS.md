# Tab5 interpreted MicroPython instructions

These instructions apply to work under `tab5/`.

## Current platform and authority

- The supported device path is interpreted MicroPython on the M5Stack Tab5 using the stock UIFlow 2.5.0 image installed with M5Burner.
- The authoritative workflow is `PROJECT_WORKFLOW.md` in the Google Drive Well Pump folder. Read it first.
- The settled design authority is the Google Doc `Well Pump Current Architecture Baseline`. Follow it when older repository notes, compiled branches, or historical summaries disagree.
- Committed interpreted source under `tab5/` on the `Tab5` branch is the software source of truth. Physical behavior is verified only when the owner reports the Tab5 result.
- `firmware/tab5/`, `docs/tab5-platform-runbook.md`, compiled build machinery, and old `agent/tab5-*` branches are historical evidence. Do not build, flash, repair, or extend them.

## Branch and delivery boundary

- All interpreted Tab5 development belongs on the `Tab5` branch.
- `main` and `pilot` are deployment branches and are off limits during Tab5-only work unless the owner explicitly opens that scope.
- `C:\Tab5\pilot-micropython` is a device-upload mirror, never a Git checkout. Populate it only when the owner says a candidate is ready for installation.
- Keep the runtime intentionally small: `main.py`, `pilot.py`, `cloud.py`, `webrepl.py`, the validated rules file when implemented, and uncommitted device secrets. Do not create more MicroPython modules without a reviewed need.
- Make one bounded work unit per commit. State host-test evidence separately from hardware verification.
- Put a one-line release description in the opening comments of each changed upload file.

## Runtime ownership

- `main.py` is the thin startup and supervision layer. It starts WebREPL and the two application workers and must not return into an unwanted UIFlow relaunch path.
- `pilot.py` is CPU A. It owns all hardware access, matched observations, calculated values, HMI servicing, rules, operational events, timers, Shelly polling, and Shelly relay consequences.
- `cloud.py` is CPU B. It owns Wi-Fi recovery, time synchronization, Netlify, Firebase RTDB, Firestore-facing transport, authentication refresh, and network waits.
- CPU B never manipulates hardware or HMI objects. CPU A never waits for cloud completion.
- Exchange complete extensible messages through bounded RAM queues/mailboxes. Do not share mutable hardware objects or working dictionaries across CPUs.
- Disposable current observations may be coalesced or dropped when stale. Durable event transitions, rule results, and audit records receive higher delivery priority.
- RAM is the normal working store. Do not add routine telemetry filesystem persistence.

## Data and cloud boundary

- CPU A is the sole operational decision authority.
- CPU B preserves complete messages and does not reinterpret materiality, events, or pump consequences.
- RTDB carries disposable current state and short-term coordination. Firestore carries sparse durable observations, events, and audit history.
- If CPU A sends a durable observation, cloud transport preserves the complete valid record, including unknown future fields.
- The resulting event/open/close/adoption/rejection record is the acknowledgement of a command; do not invent a second acknowledgement record unless the architecture baseline changes.
- Netlify, RTDB, and Firestore must never be placed in the immediate protective path.

## Rules, events, and restart

- Implement only an owner-approved work unit from the current Excel operational-rules workbook. Do not treat historical rule prose or the old CSV as current authority.
- A valid ruleset always exists on Tab5. Keep using the last validated version while offline.
- Download a changed release to a temporary file, validate its supported schema, completeness, and hash, then atomically replace the active rules file. Reject incomplete releases and retry later.
- New rules take effect immediately. Reevaluate open events using the adopted rules and log the adoption or rejection.
- Firebase is canonical for durable open/close history. On restart, synchronize open events and control state.
- Restore an open latched event without a closing record and reapply its consequence. If its condition has cleared, it remains eligible for user closure according to the architecture baseline.
- Close other previously open events during restart reconciliation; current evaluation may open a new event immediately.
- Volatile timers restart from zero. Do not reconstruct elapsed runtime from ordinary telemetry history.
- Global Enable is the top-priority fail-allow state. Store its minimal mutable state separately from the versioned rules file and synchronize it with RTDB.

## Networking, WebREPL, and secrets

- UIFlow-provisioned Wi-Fi is the preferred credential source. Application code uses credential-free association and recovery; do not embed the Wi-Fi password.
- WebREPL is LAN-only maintenance. Never expose it by router port forwarding or on the public Internet.
- Preserve the verified Thonny reset procedure in `PROVISIONING.md`: execute `import machine; machine.reset()`, immediately switch Thonny to Local Python, wait for complete startup, then reconnect to ESP32/WebREPL.
- Real device values belong in uncommitted `device_secrets.py`. Commit only `device_secrets.example.py` with placeholders.
- Never commit or print credentials, passwords, tokens, Wi-Fi data, Firebase administrative keys, or production secret values.
- A Firebase web API key identifies the project; it is not device authentication. Never place a Firebase Admin/service-account private key on Tab5.

## Safety and verification

- Tab5 may inhibit automatic pump permission only through an explicitly approved control work unit. It never manufactures ordinary pump demand.
- A forgotten persistent inhibit is the principal software hazard. Implement clearing, latching, Global Enable, restart, and synchronization exactly as defined in the architecture baseline.
- Existing hardwired protection, HAND operation, Shelly-local anti-cycle behavior, and independent timer protection remain outside cloud authority.
- Missed telemetry or a lost log record is acceptable; blocking CPU A is not.
- Do not build firmware, flash hardware, erase flash/NVS, format media, or operate the physical device unless the owner explicitly requests a supervised hardware action.
- Syntax checks and host tests do not prove display, touch, ADC, battery, Wi-Fi, Shelly, TLS, reset, threading, timing, or field behavior.
