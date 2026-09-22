# Current beta status â€” Tab5/Shelly

As of 22 September 2026. pilot.py and cloud.py are M6.43, main.py M6.41.
Release stamps are per file, not per bundle. The Tab5 operating branch remains
older and needs accepted-source synchronization. M6.43 is the candidate upload
set: it has host checks only and is not installed.

## Implemented and verified

The working source uses two-second acquisition, counts-based qualified pressure,
V3 events and calculations, Tab5IsLocked inhibition, Monitor release, bounded
observation/event-board transport and explicit operator controls. M6.42 sets
PRESSURE_SENSOR_COMMISSIONED true; the fitted calibration is in main.py.

The owner believes M6.42 is installed and confirms the Shelly script is fully unit
tested on the real hardware. The M6.38â€“M6.41 integration verification record and raw
pressure measurements are retained under docs/ as evidence. They are not competing
roadmaps. Exact installed file hashes and current rules-package identity are not
established by this housekeeping.

## Known limits

Abandoned-inhibit recovery needs the beta decision in FUTURE. Script liveness is
now observed and bindable but drives nothing: no event is authored on it, no
package declares it, and retained zero lock values can still authorize re-enable
while the script is stopped. Clear Events/Monitor OFF are absent. The shipped flow
window cannot fill at the current cadence unless the live package has already been
corrected. Utility capture-path follow-ups remain separate from normal operation.
RAM history is best effort, not a persistent outbox. See FUTURE for all deferred
work.

## Next owner decisions

Approve synchronization of the accepted candidate into Tab5, choose any beta
reliability repairs, and record the actual upload set/running package and recovery
procedure. Source promotion does not reinstall files or change Shelly settings.
Main/ebaugh.net activation concerns the web/cloud line and is planned in BETA.

M6.43 needs device evidence for three things once uploaded: the Wi-Fi power mode
logged at startup and whether PM_NONE holds the association, one Shelly reboot
reporting accepted then confirmed-completed, and the script liveness field reading
true in normal operation. Whether any event or inhibit policy should depend on that
field is a separate decision, not taken here.

The 16 September housekeeping changed documentation and host-test maintenance only.
It did not change uploadable source, package bytes, calibration values, network
addresses, device state or cloud configuration. M6.43 does change uploadable source,
in pilot.py and cloud.py, and nothing else on that list. Archive inventory is under
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
