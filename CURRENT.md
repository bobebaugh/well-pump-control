# Current beta status â€” Tab5/Shelly

As of 22 September 2026. Release stamps are per file, not per bundle.

Installed and running: pilot.py M6.43 plus diagnostic instrumentation, cloud.py
M6.37, main.py M6.41. pilot.py carries edge-triggered log() calls tagged DIAG and no
logic change: bindings resolved at startup, Boyle pump edges, script liveness
transitions, slow Shelly 1 reads, and Shelly restart request and resolution. 9e1accb,
on Tab5 and tab5-working, made pilot.py and cloud.py byte-identical to the files the
owner pulled off the device; cloud.py is back at M6.37, without the withdrawn Wi-Fi
modem sleep change.

## Implemented and verified

The working source uses two-second acquisition, counts-based qualified pressure,
V3 events and calculations, Tab5IsLocked inhibition, Monitor release, bounded
observation/event-board transport and explicit operator controls. M6.42 sets
PRESSURE_SENSOR_COMMISSIONED true; the fitted calibration is in main.py.

M6.43 is installed and running, established by comparing the device's own files
against the branch rather than inferred from a release number. The owner confirms
the Shelly script is fully unit tested on the real hardware. The M6.38â€“M6.41 integration verification record and raw
pressure measurements are retained under docs/ as evidence. They are not competing
roadmaps. The running pilot.py and cloud.py were compared directly against tab5-working on
22 September; main.py and the Shelly script were not.

The freeze rules package was published and adopted on 22 September 2026: twenty
events, of which supply-voltage high and low hold a self-releasing inhibition,
and tank overpressure and long runtime latch one. The events new to this package
are authored but disabled; enabling them is the main work outstanding. Its authoring backup is recorded
under docs/rules-packages/ as the editable record of what was published; the staged
runtime bytes and their server-minted release identity remain the only authority
for what the device runs.

What the Tab5 posts to Firestore can be read without the Firebase console.
maintenance/firestore-peek.cjs, on the web/cloud line only, reads collections under
sites/well-main such as eventRecords, eventBoardState and observations. On 27
September a cloud session with FIREBASE_SERVICE_ACCOUNT_JSON set read the first two. The
script is read-only, and the owner provisioned the account read-only. The records
are what the cloud received, not proof of what the device ran or did.

## Known limits

Abandoned-inhibit recovery needs the beta decision in FUTURE. Script liveness is
now observed and bindable but drives nothing: no event is authored on it, no
package declares it, and retained zero lock values can still authorize re-enable
while the script is stopped. Clear Events/Monitor OFF are absent. The flow window
is corrected in the live package: twenty seconds and seven samples fills at the
two-second cadence, where the shipped ten-second window never could. Utility
capture-path follow-ups remain separate from normal operation. RAM history is best
effort, not a persistent outbox. See FUTURE for all deferred work.

## Next owner decisions

The pre-freeze round is the plan: see pilot-working's CURRENT, section "Pre-freeze
round". Source already matches the device (9e1accb). Record the running package and
recovery procedure at the final install.
Source promotion does not reinstall files or change Shelly settings.
Main/ebaugh.net activation concerns the web/cloud line and is planned in BETA.

M6.44 is on tab5-working (06d0598), not installed. It changes cloud.py and pilot.py
only. CloudAvailable turns false on one failed telemetry post or RTDB call: 10-20
times a day, each back within 3-9 s, about 1 in 3,000-5,000 RTDB calls. The cause
of each failure reached only the console. M6.44 adds it to the durable reason as
cause, and the records page shows it. It rides the final pre-freeze install rather
than going in alone, so RTDB_TIMEOUT_S stays at 1 s for the freeze. Host
tests: 268 run. Four WifiPowerSaveTests errors predate it; they test the withdrawn
power-save change.

The pre-freeze round, approved 27 September, is in pilot-working's CURRENT (section
"Pre-freeze round"). Device items: heap stat, survive one bad loop pass, daily SNTP
resync, endpoints moved to main, and an unchanged event board re-sent every 30 minutes
instead of 30 s. They ride one install with M6.44's change, both files stamped M6.45.
Built: heap stat (95e5545), loop-fault containment (2b273d8), daily SNTP resync
(f16e01a), main endpoints (f4a357f), 30-minute board re-send (b25bc21). Do not install
this build before main is fast-forwarded to pilot: from M6.45 the device posts to main.
The Tab5's own readings are now accepted one at a time (0c385f7), so a boot with no
battery and no cloud keeps pressure and every pressure rule from the first cycle.

## On tab5-working, not yet on Tab5

Keep this list current on every tab5-working change; clear it when Tab5 advances.

| tab5-working commit | Change | Kind |
|---|---|---|
| 06d0598, f89ec9b | M6.44: durable reason carries the cause when CloudAvailable goes false; CPU B startup log names its release | cloud.py + pilot.py |
| 95e5545 | M6.45: heap and loop-fault health as tab5-runtime bindings; periodic gc.collect() every 10 minutes | cloud.py + pilot.py |
| 2b273d8 | M6.45: each loop pass contained and counted on CPU A and CPU B; ten faults in a row stop that CPU cleanly | cloud.py + pilot.py |
| f16e01a | M6.45: SNTP resync every 24 h; a failed resync keeps sync and retries hourly | cloud.py |
| f4a357f | M6.45: all five device endpoints move to main's production deploy | cloud.py |
| b25bc21 | M6.45: unchanged event board re-sent every 30 minutes instead of 30 s | pilot.py |
| 0c385f7 | M6.45: tab5-runtime readings accepted one at a time; Shelly devices stay all-or-nothing | pilot.py |
| 0e40cfc | M6.45: battery charging stops at 90%, not 80%, ending the charge on/off loop | pilot.py |
| ca0595b | Cloud-session start hook | session support |
| 08415b4, 9ae039e, 348aaad, ccbcd5d | Mirrored shared docs, Firestore peek, M6.44 and pre-freeze notes | docs |

The approved-plan update that follows them is docs-only too.

M6.43 needs device evidence for two things: one Shelly reboot reporting accepted
then confirmed-completed, and the script liveness field reading true in normal
operation. Whether any event or inhibit policy should depend on that field is a
separate decision, not taken here.

Disabling Wi-Fi modem sleep was deployed on 22 September and withdrawn the same
day. A combined deployment of the rules package, the web/cloud application and
M6.43 did not go well; bisection restored the package and pilot.py without
recurrence, leaving cloud.py as the only remaining difference. The owner declined
to reapply it: the disassociation pattern it targeted was last observed on the ASUS
router, which has since been replaced, and the residual meter failures are the RF
floor of a weak link, which power save does not affect. The mode has never been
read on this device, so what it actually is remains unknown.

The 16 September housekeeping changed documentation and host-test maintenance only.
It did not change uploadable source, package bytes, calibration values, network
addresses, device state or cloud configuration. M6.43 does change uploadable source,
in pilot.py only now that cloud.py is withdrawn, and nothing else on that list. Archive inventory is under
maintenance/.

## Housekeeping verification

The remote repository now has exactly main, pilot, pilot-working, Tab5 and
tab5-working. Eighteen retired branch tips are preserved under published archive
tags; no unmerged commits were discarded. No operating branch was advanced.
Host verification at the time: 301 web/cloud tests, 248 Tab5 tests and 31 Shelly
tests passed; the Tab5 suite is 263 at M6.43, with no hardware campaign for it.
The password regression covers missing/wrong keys on every mutation route. The
two Windows test adapters change host behavior only. Existing local Node dependencies
were reused; a fresh dependency install and hosted workflow run were not part of
these local results. Interfaces remain identical as Git blobs on both working lines.
