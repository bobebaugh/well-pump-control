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
of both normal workers. Worker crash recovery is not yet supervised automatically.

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
Session start, event boundaries and the ten-minute maximum interval also select
records. Transport is an oldest-first 100-record/384-KiB RAM FIFO with discard
accounting, not a flash outbox. A reset or long outage can lose records.

CPU A publishes a complete sparse current-event board on changes and approximately
every 30 seconds. CPU B keeps only the latest board independently of the FIFO.
Firestore transactions reconcile newer boards into deterministic event-open/close
records. Silence never closes an event; disappearance/restart closes have unknown
device close times. A revision guards the RTDB mirror from delayed overwrites.
Events entirely between delivered boards may be absent from cloud history.

Open and close records notify by event ID from a cloud-side criteria table, which is
authoritative; the package's `web` blocks carry the same intent but are stripped at
compile and can drift. The message is the event number in a marked subject and the
event's display name in the body, taken from the record so the name is the one the
device ran. Two emails go out per record through Resend, in one batch, between the
transaction and the mirror so a mirror retry cannot drop a send; a Resend idempotency
key derived from the records makes a repeat a no-op. Delivery is at-most-once and is
reporting only: a send failure is recorded on the event record and never changes the
response to the device, and no inhibition is gated on it. Nothing polls or is scheduled,
so an unreachable function is not detectable from the cloud.

The web home displays live RTDB observations and event state. Every live reading,
the pump badge and the Tab5/meter/Shelly 1 health rows come from one observation
record, so the state and the numbers beside it are the same instant. The badge
reads SW(0) directly and falls back to meter watts only when Shelly 1 is
unavailable; unknown is a distinct state and is never shown as stopped. The page
displays a disagreement between the contactor and motor current without judging
it; the rules engine owns what one means. The record browser supports selected
columns, event/session navigation, paging, date anchors and daily CSV export.
Reporting time, acquisition time, inferred closure and transport age must remain
distinct. Device age on screen is the server-stamped receipt, so a resent
observation cannot present itself as fresh.

ingest-power still accepts device telemetry and writes the Firestore current
document, which no longer has a reader; it remains only until the device's
cloud_available formula stops depending on its result. current-power and
monitor-session are retired, and with them the 1 Hz live view. User Monitor is a
separate RTDB operator control and is unaffected.
