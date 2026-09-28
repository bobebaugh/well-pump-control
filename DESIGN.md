# Implemented beta design

This describes the current working applications, not every historic proposal and
not proof of the exact files installed on a device. CURRENT records that evidence.

## Authority and runtime

The pressure switch, hardwired delays/limits and HAND path remain authoritative.
The Shelly 1 script detects short cycles and alone writes RLY0. Tab5 observes the
system and can withdraw automatic permission through its own inhibition flag; it
cannot create ordinary demand. Cloud outages do not remove existing local protection.

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
not a flow-meter measurement. Invalid pressure breaks its history. A window counts as
covered once its samples span all but the final cadence interval; the allowance is
derived from the observation cadence rather than fixed, because a sample's timestamp
carries the acquisition that preceded it and a literal silently changes meaning when
the loop period moves. The package sets the window length and minimum sample count,
and a window a slower cadence cannot fill is reported at startup rather than refused.

A pump transition ends the current window. The switch input the contactor drives is
resolved by its device binding rather than by an editable system name, and a change
in it drops the retained history together with the cycle's own sample. The manifold
steps as the pump starts, and at a stop the tank air begins shedding the heat of its
own compression; neither is water moving, and a regression spanning either reports
flow that is wrong rather than imprecise. One cycle is also not one instant, since
the ADC burst, the switch and the energy meter are read moments apart, so on the edge
cycle nothing establishes which side of the transition the pressure belongs to.
Quality reads INSUFFICIENT_HISTORY until post-transition samples rebuild the window.
Estimated gallons is unaffected, being instantaneous and true whenever the pressure
is; only the slope needs clean provenance. Absent evidence is not a transition: a
switch read that failed leaves the field missing, and a missing field neither drops
the window nor advances the remembered pump state.

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

The web home displays live RTDB observations and event state, with legacy power
telemetry also retained. The record browser supports selected columns, event/session
navigation, paging, date anchors and daily CSV export. Reporting time, acquisition
time, inferred closure and transport age must remain distinct. The legacy
current-power freshness limitation is deferred in FUTURE, not described as fixed.
