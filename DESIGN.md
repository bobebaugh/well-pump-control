# Implemented beta design

This describes the current working applications, not every historic proposal and
not proof of the exact files installed on a device. CURRENT records that evidence.

## Authority and runtime

The pressure switch, hardwired delays/limits and HAND path remain authoritative.
The Shelly 1 script detects short cycles and alone writes RLY0. Tab5 observes the
system and can withdraw automatic permission through its own inhibition flag; it
cannot create ordinary demand. Cloud outages do not remove existing local protection.

Signal topology behind ContactorFlag, recorded here because no other file carries
it. The pressure and wall switches feed a three-second on-delay timer, then the
HAND/OFF/AUTO relay, then the 24 VDC contactor coil; the contactor passes 240 VAC
to the pump control box. The Shelly 1 relay supplies that coil's ground path, so an
open RLY0 leaves the coil unable to energise. SW(0) senses the contactor itself,
downstream of both the delay and that ground path. ContactorFlag is therefore false
whenever RLY0 is open, a Tab5 inhibition or a Shelly lockout drops it, and true
means 240 VAC actually reached the pump control box. It is not the pressure switch
and it does not lead the motor. Current in the motor is what proves the pump is
running: the flag true with no current is a fault, and current with the flag false
is the HAND signature. Issue #12 holds those detection decisions.

Tab5 runs interpreted MicroPython on stock UIFlow 2.5.0. main.py owns startup,
the ADC and utility selection. pilot.py (CPU A) owns acquisition, calculations,
events, display and local dispatch. cloud.py (CPU B) owns Wi-Fi recovery, clock
sync, authenticated cloud transport and bounded RAM mailboxes. WebREPL is LAN
maintenance. Pressure qualification is a separate startup utility that runs instead
of both normal workers. From M6.45 every loop pass of both workers is contained: a
fault is logged and counted (CpuAFaults, CpuBFaults), and ten in a row stop that worker
cleanly, so durable records stop and the silent-device alert fires. CPU A then says so
on screen, and any Tab5 hold stays in force. Recovery is an on-site power cycle; there
is no watchdog and no automatic restart. CPU B resyncs SNTP every 24 hours (hourly
retry, keeping the synced state), which steps the clock back about 2 s a day; operator
commands are accepted only inside a 45 s wall-clock window.

Normal acquisition is scheduled every two seconds. ADS1110 acquisition uses three
fresh conversions and a median. Shelly EM supplies electrical measurements. Shelly
1 acquisition uses a filtered GetComponents response, with discovery by component
name and verification of every required component. It is not a simultaneous
physical snapshot. Network endpoints currently come from device source, not the
addresses entered in a package.

## Inhibition and modes

Shelly owns IsLocked (0 clear, positive temporary seconds, -1 permanent) and loCntr
(strike count). Tab5 reads them and normally writes only Tab5IsLocked via Boolean.Set
at a dynamically discovered ID. RLY0 is read-only to the rules engine. The separate,
deliberate operator reboot action uses Shelly.Reboot.

The script closes RLY0 when its lock is zero and Tab5IsLocked is false, otherwise
it opens it. It writes only on an observed mismatch. Short stops caused by its
application of Tab5 inhibition do not count as chatter. A missing/unusable Tab5
flag removes only Tab5's contribution; it never clears Shelly's own lock.
The flag is seeded false at script initialization, with a five-second startup
hold-open delay. A true flag has no expiry if Tab5 subsequently disappears.

V3 rules use frozen input values, typed bounded calculations and event ownership.
Conditions use three-valued all/any logic; absent evidence is unknown and does not
advance or reset qualification. Invalid/unsupported clauses are rejected. No V2
fallback may take event/control authority.

Normal evaluates ordinary events. User and System Monitor can own the operating
mode through configured events. Monitor retains event/ownership state, continues
acquisition/calculation/logging, freezes non-monitor event evaluation, and releases
Tab5's physical inhibition. Monitor-class events continue evaluating. The final
aggregate flag is reconciled after evaluation. User Monitor lasts until Tab5 restart;
there is no Monitor OFF or Clear Events operator input. Package policy determines
which System Monitor conditions exist; the complete field event suite is not audited.

Operator controls are User Monitor, Tab5 restart and Shelly 1 restart. Local actions
use deliberate confirmation; online actions require the server password. RTDB
commands have exact-session targeting, monotonic sequence, unique identity and a
45-second lifetime. Admission and execution reject old sequences/expired commands.
An uncertain command is not automatically replayed. RPC acceptance and later
observed completion are distinct. Online Tab5 restart writes a request-linked
marker before reset and reports completion from the new session. Known outcome
reporting limitations are recorded in FUTURE.

## Rules, pressure and history

Pilot authors Devices, Calculated Fields, System Fields and Events. Load replaces
browser working data only; Validate does not save. Save Draft uses revision checks
and replaces all sections atomically. Complete authoring backup JSON is the recovery
and editing format; a runtime package alone is not an authoring backup.

Publish and Deliver validates, saves and produces an immutable version. Retry
delivery reuses the current version. Resolve interrupted publication by readback,
not blind repetition. Tab5 validates exact bytes, hash, length, schema and runtime
support before atomically staging. A restart adopts the staged package with fresh
event/ownership/calculation state. Running, desired and staged identities remain
distinct. Old direct-RLY0 packages and new inhibition-flag packages are incompatible.

Each cycle a Shelly device's fields are accepted atomically: one declared field that is
missing or mistyped makes all of that device's fields unavailable. From Tab5 M6.45 a
tab5-runtime device's readings are accepted one at a time instead, so a battery with no
reading or a cloud flag with no value yet leaves out only that reading, which reads as
unknown and holds any qualification timer; pressure still needs its guards. The
tab5-runtime driver also offers long-run health, all integers: free heap after a garbage
collection taken every 10 minutes (never per cycle), the lowest free heap seen, and the
CPU A and CPU B loop-fault counts. The editor suggests each driver's objects and fills
in their type, unit and access.

M6.42 enables pressure commissioning. ADC counts are the primary evidence; the
qualified local fit is PSI = (counts - 3732.02) / 211.492, qualified approximately
40–61 PSI. Pressure availability still requires valid ADC evidence. Package pressure
expressions must match the local calibration. Tank flow is a model-derived estimate,
not a flow-meter measurement. Invalid pressure breaks its history. The shipped
eight-sample/ten-second window cannot fill at two-second cadence; see FUTURE.

RTDB holds replaceable current observations, device presence, operator coordination,
package pointers and device package state. Firestore holds selected observations,
authoring, immutable releases and derived event history. Both are the existing
well-pump-control project; web clients go through Netlify functions.

Durable observation v2 includes every logging-enabled field, explicit unavailable
reasons and coalesced selection reasons. Change/Delta compare against the last
available value admitted to the RAM queue. Include does not trigger by itself.
From Tab5 M6.44, a change to false of the field bound to status.cloud_available
carries cause: CPU B's own text for the failed telemetry or RTDB call, or which
channel's last success is stale. It is diagnostic text only.
Session start, event boundaries and the ten-minute maximum interval also select
records. Transport is an oldest-first 100-record/384-KiB RAM FIFO with discard
accounting, not a flash outbox. A reset or long outage can lose records.

CPU A publishes a complete sparse current-event board on changes, at once after boot,
and otherwise every 30 minutes (every 30 seconds before M6.45). CPU B keeps only the
latest board independently of the FIFO.
Firestore transactions reconcile newer boards into deterministic event-open/close
records. Silence never closes an event; disappearance/restart closes have unknown
device close times. A revision guards the RTDB mirror from delayed overwrites.
Events entirely between delivered boards may be absent from cloud history.
Because an unchanged board is re-sent only every 30 minutes, the home page judges the
board by the live reading, not its age: while the live reading is fresh (30 s or less,
the readings panel's rule) the board is current; otherwise its open events are as of the
last board.

Open and close records notify from the event's own `web` block (Notify on open/close,
Open/Close message) in the release the record names. The compiler strips `web` from the
runtime package, but each Firestore release keeps its authoring package, and the record's
releaseId and content hash identify the one the device ran. The message is the event
number in a marked subject and that open or close message in the body, or the record's
display name when the message is empty. If the release cannot be read or does not match
the reported hash, a cloud-side table keyed by event ID decides instead.

The silent-device alert is a scheduled function (device-silence, every 15 minutes,
production deploy only). It reads the newest durable record by receipt time; more than
30 minutes without one sends one email and text, and records arriving again send one
more. It uses the notifier's settings and dry run, in plain ASCII. Its state is
sites/well-main/alerts/device-silence, written only after a send, so a failed send is
retried on the next run. On a branch deploy it runs only when invoked, and an extra
invocation cannot repeat a message.

Event display names and enum choices are text the Tab5 posts back, and it sends those
bodies with a character-count Content-Length, so a character over one byte truncates the
body and the cloud rejects the whole board. Validation therefore rejects non-ASCII in
those strings; publication is the only path to the device, so no such package runs. Two emails go out per record through Resend, in one batch, between the
transaction and the mirror so a mirror retry cannot drop a send; a Resend idempotency
key derived from the records makes a repeat a no-op. Delivery is at-most-once and is
reporting only: a send failure is recorded on the event record and never changes the
response to the device, and no inhibition is gated on it. Nothing polls or is scheduled,
so an unreachable function is not detectable from the cloud.

The web home displays live RTDB observations and event state. Every live reading,
the pump badge and the Tab5/meter/Shelly 1 health rows come from one observation
record, so the state and the numbers beside it are the same instant. The badge
reads SW(0) directly and falls back to meter watts only when Shelly 1 is
unavailable; unknown is a distinct state and is never shown as stopped. The SW(0)
and RLY0 tiles and the Shelly 1 row show a value only from a fresh record in which
Shelly 1 answered; a stale record, a failed read or an unreachable Shelly 1 shows
unknown rather than the last value. The page
displays a disagreement between the contactor and motor current without judging
it; the rules engine owns what one means. The tank shows the device's net flow estimate
(TankNetFlowGPM, signed, positive filling) from the same record. It reads zero when
TankFlowQuality is not VALID or the magnitude is under a provisional noise floor,
and a dash only when the record carries no flow calculation.

History charts a day, a week or 30 days, zoomed by a two-handle rail. The day's Tank
water line is drawn at the readings' own times, keeping a reading each time the level
has moved 1 gal from the last one kept (and the latest), held in steps and broken at
an unavailable level or a 20-minute silence; the week and month lines and the other
bucket views show the last reading of each bucket. Water used and
a run's delivered gallons rest on one delivery estimate in every view: the second
fastest clean 48-58 psi fill of the trailing week sets the level of the measured
August pump curve (its slope kept), or that whole curve when the week has fewer than
three clean fills. The trend views read the same records. Fill time is seconds from 48
to 58 psi at the sensor while running; a fill is untimed across a record gap over 15 s
or a fall part-way, and clean only when the settled tank loses no more than 2 gal in
the five minutes after cut-out (undecided until then). Switch shows each run's cut-in
(the reading as the pump started) and cut-out (the highest reading to the stop record),
the cut-out only for a run that reached 58 psi. Leak-down is tank level lost per hour
over quiet stretches of at least two hours that start an hour after the last run or
draw (half a gallon lost within ten minutes) and end at a draw, a run or a record gap
over 25 minutes. The record browser supports selected
columns, event/session navigation, paging, date anchors and daily CSV export. Its
columns are the fields the records on the page carry, so they follow the package
that wrote them rather than the draft being edited. Standard (contactor, watts,
pressure, tank water, net flow) is the default on every screen; presets and a
custom selection are kept by name in the browser, and a field absent from the page
stays selected and greyed. An event link adds that event's first trigger field for
the visit only; it is the one read of the rules.
Reporting time, acquisition time, inferred closure and transport age must remain
distinct. Device age on screen is the server-stamped receipt, so a resent
observation cannot present itself as fresh.

ingest-power still accepts device telemetry and writes the Firestore current
document, which no longer has a reader; it remains only until the device's
cloud_available formula stops depending on its result. current-power and
monitor-session are retired, and with them the 1 Hz live view. User Monitor is a
separate RTDB operator control and is unaffected.
