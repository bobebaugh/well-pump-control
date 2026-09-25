# Deferred work

This is the single current list of unimplemented ideas and beta follow-ups. It is
not a request to implement them. Source behavior is in DESIGN; installation decisions
are in CURRENT. Issue links preserve supporting detail, but old issue text can
describe behavior that has since changed. Do not reinstate those old semantics.

## Beta reliability decisions

| Item | Smallest useful next step | Boundary |
| --- | --- | --- |
| Worker crash/stall recovery — [#8](https://github.com/bobebaugh/well-pump-control/issues/8) | Detect progress from each worker, report failure honestly, choose bounded recovery | CPU A death prevents its queued online restart; CPU B death gates local polling. Reset also clears owners/adopts staged bytes. No blind retry loop. |
| Script health — [#5](https://github.com/bobebaugh/well-pump-control/issues/5) | Identify the actual protection script by name and distinguish running/stopped/missing/unknown | Retained virtual values do not prove execution. Owner confirms the script itself is fully hardware-unit-tested. No automatic script restart or clearing of its lock. |
| Abandoned true Tab5IsLocked / outage policy — [#4](https://github.com/bobebaugh/well-pump-control/issues/4) | Decide and verify recovery when Tab5 disappears while inhibited | The flag has no lease. Do not silently expire a legitimate inhibit; keep manual recovery independent of cloud. |
| Shelly reboot outcome — [#7](https://github.com/bobebaugh/well-pump-control/issues/7) | Capture reboot RPC result and accept the supported success shape, then verify confirmation | Current reboot reader requires an object and rejects null. Never retry a reboot just because its result is uncertain. |
| Soak/outage acceptance | Test prolonged network loss, queue saturation/drain, restart, local recovery and heap/progress trend | Do not repeat completed Shelly unit tests. RAM queue loss and coalesced board history are accepted best-effort limits unless requirements change. |
| Event-suite loss/recovery policy — [#6](https://github.com/bobebaugh/well-pump-control/issues/6) | Review the actual deployed events for lost evidence, overlapping owners and recovery | Current Monitor releases Tab5 inhibition and freezes non-monitor events. The issue's older proposal to retain latched physical inhibition in Monitor is not current behavior. |

## Small repairs when their feature is needed

- **Flow window:** the shipped calc-tank asks for eight samples in ten seconds;
  two-second cadence permits six. Inspect the real running package; if still present,
  consider a 20-second window retaining eight samples, followed by normal publication,
  staging/restart and verification. Pressure is commissioned in M6.42; do not repeat
  the old instruction to enable its constant. This is package work, not a new estimator.
- **Authoring warnings/simulator:** derive inhibition targets by binding rather than
  PumpEnable, and distinguish unsupported internal occurrences/Clear Events from the
  operator occurrences already connected. [#10](https://github.com/bobebaugh/well-pump-control/issues/10).
- **Clear Events / Monitor OFF:** define operator scope, eligible closing policies,
  ownership and acknowledgements. User Monitor/restart is the current workaround.
  No blanket clear, global-enable revival, or bypass of another owner's authority.
- **Rules editor device status:** source fixes exist; confirm the current live read
  before reopening the issue. Do not assume older deployment-failure notes remain true.
- **Network migration:** keep current Shelly DHCP reservations until package addresses
  actually drive acquisition. Preserve bootstrap polling without an adopted package.
- **Tab5 Netlify endpoint:** the device is hard-coded to the pilot branch deploy, which
  is why pilot is production for the device. Repoint it to the production netlify.app
  host at the next authorized Tab5 install. Not urgent and not free: it moves the
  device's dependency from a branch deploy to production, so the change categories in
  BETA move with it.
- **Battery and diagnostics:** retain 75/80 charge policy pending a deliberate change;
  investigate percentage/current interpretation, brief pending-record cloud-yellow
  indication, and Wi-Fi/reconnect behavior only if observed. [#1](https://github.com/bobebaugh/well-pump-control/issues/1).

## Calibration, qualification and estimated flow

- Before another capture, repair the qualification utility's missing voltage field,
  close HTTP responses on every path, make its LAN/cloud wording accurate and test
  the launcher isolation/capture paths. Optionally start Fill Run from pressure change
  and let the owner mark the endpoint to remove the Shelly network dependency.
  [#9](https://github.com/bobebaugh/well-pump-control/issues/9).
- Recalibration currently requires reconciling local fit constants and the separately
  published package expression. Compare HMI pressure and rules PressurePSI at the same
  raw count; record the running package afterward. Atmosphere/tank constants also have
  separate utility/package copies. A single source of calibration is future design.
- Further flow work: use absolute pressure, actual sample timing/ADC midpoint, bounded
  regression, confidence and gaps; distinguish pump-off demand from pump-on inference.
  Preserve endpoint-volume/integrated-volume checks across qualified full cycles and
  the manufacturer's approximately 20.5-gallon reference with tolerance. A pump-on
  demand estimate needs a separately qualified inflow model. No weather dependency or
  automatic calibration from one cycle. [#3](https://github.com/bobebaugh/well-pump-control/issues/3).

## Firestore reads (next summer)

Durable observations never change once written, so a copy kept by the browser never
goes stale. Measured shape on 25 September 2026: about 100-250 records a day.

- **Dashboard history refresh, smallest step first:** every 5 minutes the home page
  re-reads the whole 1-day (about 100-250 records) or 7-day (about 700-1,700) window to
  pick up 2-3 new records - about 1,200-20,000 reads an hour while the tab is visible,
  roughly 98% of them repeats. Read only records received since the last refresh and
  merge them. One function plus the page; no browser storage.
- **Read once, then read only what is new or out of range:** keep records and events
  in the browser (IndexedDB, shared by the dashboard and records page on one device),
  load the last 1,000-5,000 once, then read only newer records or ranges outside the
  copy. Key "newer" on receipt time, not observation time: records delayed by a cloud
  outage arrive late and would otherwise be skipped. Fetch in chunks (a Netlify
  function reply is capped at 6 MB; full records are about 3 KB) or keep only the
  fields the screens use and fetch a full record when a row is opened. Event-open
  records are immutable; open occurrences must still be re-checked for their close.
- **Check first:** whether the Firebase project is on the free (Spark) plan. There a
  day over 50,000 reads makes screens fail until the quota resets, not just cost more.

## Owner password and device credential

The owner password checked by the browser-called functions is the same
PILOT_INGEST_TOKEN the Tab5 uses to post telemetry, event boards and device sync, so
anyone holding the owner password could post device data. Separating them changes the
Tab5-to-Netlify interface, which the owner has ruled out for the beta. Reads open by
default reduce how often the password is typed.

## Larger ideas to leave parked

- Package-derived network addresses with a boot fallback (former TAB5-15).
- One calibration source shared by HMI, runtime package and utility (TAB5-14).
- Optional/calculation enablement, unused-calculation elimination, generic driver
  bindings, and authoring-time cadence checks (TAB5-13). Every current calculation
  executes each cycle; disabled events do not make their calculations dormant.
- Expose loCntr as a rules binding only through a coordinated producer/path/catalog
  change; it is already acquired and displayed, so it is not a missing sensor.
- Bounded per-target action diagnostics/backoff, keeping physical confirmation separate
  from RPC acceptance and avoiding repeated irreversible operator commands.
- Generic history-dependent Functions, precise sample timestamps, richer event
  durations/aggregates/cycle summaries and quality-labelled flow diagnostics.
- Live rules adoption only through an explicit package-transition boundary: finish old
  records, close old-package events as specified and start a fresh kernel. Do not
  resurrect old state-preserving live-adoption proposals. Restart-only is the beta.
- Durable flash outbox, lossless event transitions, data retention/export automation
  and database isolation only if requirements justify them. Current transport is
  deliberately bounded RAM/best effort; sharing live databases is the beta plan.
- Remove obsolete V1/V2 UI/endpoints or compiled firmware source only as an explicit
  cleanup after checking consumers. They are not the current device platform.
- File-wide formatting, architecture rewrites, additional hardware/control authority,
  new accounts/MFA and workflow complexity are not beta prerequisites.

Resolved milestones are not backlog: named Shelly components, local inhibition-flag
cutover, Monitor release, event-board history, browser navigation, pressure commissioning
and script unit testing already exist. Preserve any still-useful details from retired
branches through archive tags rather than treating their defect lists as current.
