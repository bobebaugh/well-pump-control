# Current beta status â€” Tab5/Shelly

As of 22 September 2026. Release stamps are per file, not per bundle.

Installed and running: pilot.py M6.43 plus diagnostic instrumentation, cloud.py
M6.37, main.py M6.41. The running pilot.py is not in Git. It is tab5-working's
M6.43 with edge-triggered log() calls tagged DIAG and no logic change: bindings
resolved at startup, Boyle pump edges, script liveness transitions, slow Shelly 1
reads, and Shelly restart request and resolution. The running cloud.py is
byte-identical to tab5-working at 732e4e9, one commit before Wi-Fi modem sleep was
disabled. Both operating branches therefore differ from the device until the source
is reconciled.

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

Reconcile source with the device, then approve synchronization into Tab5. That
means committing the DIAG instrumentation to pilot.py and reverting cloud.py to
M6.37, undoing aaf1e22 and the cloud.py half of df290e6. Until then a rejected
change sits in the source and Git does not describe the device. Also choose any
beta reliability repairs and record the running package and recovery procedure.
Source promotion does not reinstall files or change Shelly settings.
Main/ebaugh.net activation concerns the web/cloud line and is planned in BETA.

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
