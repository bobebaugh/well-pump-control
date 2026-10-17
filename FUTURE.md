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
- **Timestamp the SMS leg:** the notification message carries no time because #24 set it
  when delivery was assumed prompt. The Verizon gateway now holds messages for hours and
  releases them out of order, so a text no longer dates itself and a close can arrive
  before its open. Prefixing HH:MM to the SMS body only would make each text
  self-dating; the email leg needs nothing, since its Date header already survives. A
  notifier change, not a package republish - the two legs are composed separately. Worth
  doing only if the SMS leg is still wanted; the owner's current position is email.

- **Loop time as a reading:** pilot.py already measures cycle work and interval time and
  shows them only on the Tab5's System page, in print small enough to need a photo. As
  tab5-runtime readings they would be the best remote indicator of network health. Most
  useful form: the longest cycle interval since boot (only rises, like lowest heap free)
  plus the last cycle's work time. Owner, 29 Sep: too late for M6.45. A photo of the
  System page at the PC, with M6.45 on package v49, read work 1,578 ms of a 2,002 ms
  interval; the Shelly 1 read alone took 854 ms (EM 380, ADC 187, rules 42), so a slow
  Shelly link is what would push a cycle past its 2 s budget. The Tab5's Wi-Fi is better
  at the PC than at the tank, and the weak link is the wellhead end, the Shelly 1's
  network (owner), so that 854 ms is the wellhead link, not the Tab5's.
- **Reset cause at boot:** the session-start record carries no reason for the restart,
  so a reset at power return cannot be told from a manual one (29 Sep power cut).
  Recording the reset cause in that record is a device change for after the freeze.
- **RTDB timeout:** the evidence M6.44 was built to collect is in. Over 29 Sep-5 Oct
  CloudAvailable went false 125 times, nearly all RTDB calls timing out (errno 116) at
  RTDB_TIMEOUT_S = 1 s, across current-observation, rules-metadata, global-enable,
  operator-command, presence and sync-state; telemetry posts almost never. Raising it to
  2 s is the candidate, a device change for after the freeze. Harmless meanwhile: each
  drop recovers within seconds and nothing protective depends on the cloud.
- **Simulator as a test:** the owner's concept, worth keeping, but not yet something to
  rely on (29 Sep). Known oddities: E002, P001, P013 and W09 open in a normal run, and
  P013 opens at cycle 2 for reasons nobody has examined. Qualify it against recorded
  real days before trusting it for a package change.
- **firestore-peek depth:** it truncates nested rules partway down, so full clauses
  need a separate read-only .get() script. Deepen its output when next needed.
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
- **Battery and diagnostics:** retain the 75/90 charge policy (Tab5 M6.45) pending a deliberate change;
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

## Running cost (measured 12 October 2026)

Everything that runs more often than every 10 minutes. Netlify is on the free plan:
300 credits a month shared by all five sites, and at zero every site pauses, the device
path and silent alert included. Firebase is on Blaze: RTDB download is free to 10 GB a
month, then about $1/GB; Firestore stays inside its daily free quota.

| Activity | Rate | Relative cost |
| --- | --- | --- |
| Tab5 RTDB currentObservation PUT | every 2 s, always | ~half of RTDB (~8 GB/month) |
| Tab5 RTDB coordination GETs (global-enable, rules, command) and V3 pointer GET | every 10 s | ~a third of RTDB (~5 GB/month) |
| Tab5 RTDB presence and other PUTs (~9K/day not yet attributed, likely rulesV3State) | 30 s and up | ~15% of RTDB |
| Tab5 ingest-power (Netlify + Firestore current write with no reader) | 60 s heartbeat | largest device Netlify caller, ~1.4K calls/day |
| Home page current-observation (Netlify + RTDB GET) | every 2 s while visible | ~1.8K calls per watched hour |
| Home page operator-control (four RTDB reads) | 15 s, 5 s signed in | 240-720 calls per watched hour |
| Home page events / services / history | 60 s / 5 min / 5 min | small; history reads Firestore (see below) |
| Tab5 to Shelly sampling | 2 s | local only, no cost |

RTDB totals about 16 GB a month (about $6). TLS handshakes are 75% of its bytes, so
cost follows request count, not payload. A watched hour costs Netlify roughly what the
device uses in a day; a visible tab left open around the clock could exhaust the free
credits within a week and pause the device path.

Options, largest benefit first:

- **Idle limit on the home page:** stop the 2-second and operator polls after about 15
  minutes without interaction and show a resume control. Restores the old
  monitor-session cap. Web only; protects the shared credit allowance.
- **Write currentObservation fast only while someone watches:** the page sets a viewer
  lease (expiring in about 15 minutes); otherwise the Tab5 writes on a material change
  or once a minute. Cuts about 40K requests a day and brings RTDB under the free 10 GB.
  Device, function and page together; interface change.
- **One coordination read instead of three or four:** read a common parent (or move
  the pointers under one node) every 10 s. Cuts about 20-25K GETs a day without
  lengthening command delivery. Device and RTDB layout.
- **Retire the ingest-power heartbeat:** base the device's cloud_available on the last
  successful ingest-record or event-board send plus RTDB, then stop ingest-power and its
  unread Firestore write. About two-thirds of device Netlify use. Not chosen for M6.46,
  which lengthens the heartbeat to 10 minutes instead and keeps CloudAvailable's meaning
  (CURRENT, decision 8); this remains the next step if credits still demand it.
- **TLS session reuse:** would remove most RTDB bytes on every path, if UIFlow
  MicroPython can keep a connection or resume a session. Research only.
- `print=silent` on Tab5 PUTs saves little: payload is 2% of RTDB bytes.
- **Netlify usage per site:** the owner's usage chart (18 October) shows only the
  account total, 2-3 credits a day across five sites after M6.46. Find a way to see the
  well's share (a per-project breakdown or function invocation counts) before judging
  any further Netlify saving.

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
- **Plan checked:** the owner confirmed on 27 September 2026 that the Firebase project is
  on a paid plan, so a day over the free 50,000 reads costs more rather than failing
  screens. The items above are cost savings, not reliability fixes.

## Dashboard and rules follow-ups from the 26 September well test

Source: the owner's well-head flow test (details kept outside the repo). Software items only.

- **Fill time, switch and leak-down trends:** built on pilot-working (46d19ca), with one
  delivery estimate for day and week. This is the record's 40-to-60 psi fill-time trend,
  timed from 48 to 58 psi so the switch's cut-in and cut-out scatter and the start delay
  stay out of it. Not built: a flow-at-50-psi trend. On the 18-27 September export normal fills took
  43.8-46.3 s from 48 to 58 psi and the drawn-down well 54.3 s. Draw before a start did not
  predict a slow fill, so only draw after cut-out marks a fill not clean.
- **Tank model:** calibrate against a bucket drain between static pressures, then adjust the
  Boyle parameters (79.3 gal, 38 psi precharge; the tank was replaced with a same-size unit,
  precharge to confirm). Let each static pressure sit about an hour before reading it: the
  records show the tank sagging about 3 psi (2-3 gal) over most of an hour after cut-out
  and recovering about 0.9 gal after a draw, as the air cools after compression and warms
  after expansion.
- **Water used overcounts after draws:** it sums falls in level between runs, so the thermal
  recovery after a draw is never netted back (roughly a gallon per draw that does not end
  in a pump start). Fix with the calibration above.
- **Switch cut-in held back:** a start delayed by a lockout or Tab5 inhibit shows as a low
  cut-in (34.9 psi during the well test). Separating those needs PumpEnable/IsLocked in the
  series read.
- **Season views:** 30 days reads about 11,000 records per load. A daily summary written
  once per day would make 90-day and yearly fill-time and leak-down views cheap.
- **Pressure sensor range:** the ADC fit is qualified for about 40-61 psi; the test ran at
  10-42 psi and gauges disagreed by about 3 psi at 60. Qualify at more points before relying
  on low-pressure readings.
- **Logging for tests:** PressurePSI rides along only; below the precharge (tank empty)
  pressure changes write no records. A temporary 0.5 psi delta is a package change + restart.
- **Rules:** P013's name says six minutes but opens at 3,600 s; W09 is at a 3,600 W test
  setting (intended 2,600 W); E007 stays at 266 V at the EM by the owner's decision (28
  Sep): the supply reaches 253 V almost daily and the motor sees 6-8 V less under load;
  define pump load against the
  13.2 A service-factor amps. Owner decisions in the rules editor.
- **Hand mode reading:** in Hand the contactor signal reads on without the pump running;
  watts is the running indicator. The screens should not label Hand-idle as running.
- **Fuller Hand-mode detection:** the package's Hand event fires only when the pump runs
  with the Shelly relay open (it opened as intended on 26 Sep). Detecting Hand with the
  relay closed needs harder rules: contactor on with idle watts for 5 s or more, then
  telling Hand from a contactor, box or motor fault by pressure staying in band and the
  condition outliving the timer's maximum run (technical record, Appendix B section 7).
  The owner kept the simple event for the freeze; not a protection gap, since Hand is
  unprotected by definition. The root cause is where the contactor is sensed: after the
  Shelly, so it reports what the coil actually sees. The true demand signal is the +24 V
  side of the coil, and in Auto there is no ground to switch until +24 V is already
  there. Sensing it (see the demand-leg idea under parked ideas) would replace these
  rules; the owner has a possible design with another relay or two and the control box
  rewired.
- **Shelly EM vs clamp:** the EM-derived current read about 6 % above a clamp meter at the
  Franklin box; both within rating. Note before treating EM watts as motor input.
- **Idle watts step, unexplained:** idle watts include the wellhead network gear (on its own
  breaker). On 26 September between 12:59 and 13:09, with the pump automation off, idle
  rose about 1.8 W (15 %; 12.0 to 13.9 W with the Shelly 1 on) with power factor unchanged,
  at the time of a momentary powerline-link fault; the adapter was never de-powered. On 27
  September the owner power-cycled everything there, the Shelly EM for the first time
  since, and idle returned to 12 W. Likely the powerline adapter holding some new task
  after the fault; not confirmed, and an EM low-end offset is not ruled out. If it recurs,
  power-cycle only the adapter and watch idle watts. An idle step may be network-side, not
  pump-side.

## Utility power-blip logger (next summer)

The owner's specification (12 October, held by the owner) for a standalone logger of
utility sags and brief outages, which the Shelly EM's averaged readings and an
unprotected smart plug both miss. Separate hardware; no change to the pump's control.

- A relay with a 120 V AC coil on an unprotected outlet acts as the comparator: its
  contact opens within 10-18 ms when the line drops below about 80% (about 95 V).
- A Shelly Plus 1 or Shelly 1 Gen3 on a UPS-backed outlet reads that contact on its SW
  input (input type Switch, mode Detached), so it never browns out and keeps Wi-Fi and
  SNTP time. The unprotected circuit connects only to the relay coil; the relay
  contact is the barrier between the two circuits.
- A startup script records each drop and restore time and the duration as a key in
  the Shelly's own KVS flash, readable at /rpc/KVS.List with no cloud or server.
- Before building: check how many KVS keys the device holds, since the script adds one
  per event and never prunes. A drop the Shelly sees while its own UPS power is also
  lost is not recorded. Give the Shelly a DHCP reservation like the others.
- Ring lights: after most of these failures some Ring lights come on and stay on. The
  process also needs a way to turn them off after each event. Ring has no local
  control interface, so the method is open: a Ring setting for power-restore
  behaviour, an automation through Ring's own service, or switching their power.
- Possible link to this app: compare logged blips with the Shelly EM dropouts and
  H001 openings in the durable records. The owner's thought: the logger's Shelly could
  send its records to the Tab5, so blips reach the durable records with everything
  else. That would be a new Tab5 input, a device change after the freeze.

## Web-Tab5 coordination store (next summer)

AGENTS treats a new platform as out of scope for the beta and asks for the smaller
alternative first: here that is the two RTDB mailboxes below, no new vendor or device
credential. The Durable Object is the larger option if the mailboxes are not enough.

Owner discussion, 12 October. The need is two small overwrite-latest mailboxes, a few
KB together: an outbox the Tab5 writes (live reading, presence, rules state, command
result) and an inbox the web writes (global enable, rules pointers, operator command).
Append-only history stays in Firestore through ingest-record. RTDB was not the wrong
store; the cost is the pattern: about nine separate paths, each its own request, and a
new TLS session per request (see Running cost).

- **Target: a Cloudflare Durable Object** on the owner's existing Cloudflare account and
  domain. One object holds both mailboxes in its SQLite storage. The Tab5 keeps one
  outbound WebSocket: readings go up, commands are pushed down, and presence is the
  socket itself. The page opens its own socket and is pushed readings, so no polling;
  the object asks the Tab5 for fast readings only while a page is connected (capped at
  15 minutes). Workers Free limits per day: 100K requests (incoming WebSocket messages
  count 20:1, outgoing free), 100K SQLite row writes, 13,000 GB-s; no bandwidth
  charge. Even 2-second readings all day use a few percent. Over a limit, requests
  fail until 00:00 UTC rather than bill. Workers KV does not fit: 1,000 writes a day.
- **First test:** a Tab5 WebSocket client (TLS, UIFlow MicroPython) soaked through Wi-Fi
  drops and router restarts on CPU B without starving protection. Also needed: a device
  credential the object can verify (Netlify-minted token or device key) and the beta
  password covering the page's socket (Netlify-minted short-lived pass). Code is
  JavaScript like the Netlify functions; Firestore and the Netlify site stay.
- **Fallback if the Tab5 cannot hold a socket: two mailboxes in RTDB.** One multi-path
  PATCH writes the whole outbox, one GET reads the inbox parent every 10 s; presence
  folds into the outbox timestamp. About 1.4K writes and 8.6K reads a day, about 2 GB a
  month, inside the free 10 GB. Each inbox writer updates only its own child. Items keep
  their own observation time, units and validity. Optional later step: RTDB streaming
  (Accept: text/event-stream) for the inbox, which pushes commands but still needs
  separate write requests, presence writes and a hand-written MicroPython client
  (keep-alive watchdog, hourly auth_revoked reconnect, redirects).
- **Other options weighed:** MQTT (HiveMQ or EMQX free tiers) fits technically but adds
  a vendor and changes the web side. Firebase Storage files bill per operation (about
  $0.30 a month at mailbox rates; needs no-cache headers, still polls). Cloudflare R2 is
  free at mailbox rates but needs new credentials.
- **Rejected:** a firewall port forward to the Tab5 (exposes the protection device and
  WebREPL to internet scanners; dynamic address and CGNAT risk; a new control path).
  Code on the UniFi gateway (unsupported; community on-boot tools break on firmware
  upgrades; makes the firewall a server). A home hub (another always-on box to keep).
  Google Drive or OneDrive (broad account credential on the device, rate limits,
  revision churn, still polls).

## Technical record consistency (owner's document, not the app)

Found reading revision 3 of the owner's technical record (linked from AGENTS) on 27
September. None affects the app.

- Appendix B says the control run is about 350 ft; revision 3.0 corrected it to 250 ft.
  Neither run is measured: about 50 ft to the basement subpanel, then about 250 ft buried.
- The file is named rev 3-3, while its header and revision table end at 3.0.
- Section 14 still lists as unrecorded the timer, interface relay and coil suppressor
  models, which Appendix B now gives (ProSense T2R-M3-ADJ-240U, Murrelektronik 51152,
  HMX1-SSVRC-DC).
- Appendix B section 7 says the Shelly 1 relay leads are disconnected for testing. The
  owner plans to reconnect them on 28 September; update the record then.

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
- A sense point on the +24 VDC demand leg would make the start delay, a latched timer
  and Hand mode directly observable (technical record, Appendix B section 7). New
  hardware (another relay or two and control-box rewiring, owner's outline, 28 Sep);
  not a freeze item.
- File-wide formatting, architecture rewrites, additional hardware/control authority,
  new accounts/MFA and workflow complexity are not beta prerequisites.

Resolved milestones are not backlog: named Shelly components, local inhibition-flag
cutover, Monitor release, event-board history, browser navigation, pressure commissioning
and script unit testing already exist. Preserve any still-useful details from retired
branches through archive tags rather than treating their defect lists as current.
