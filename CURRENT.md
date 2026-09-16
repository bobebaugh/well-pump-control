# Current beta status â€” Tab5/Shelly

As of 16 September 2026. Source baseline before housekeeping:
6b1210d97642481e7a7be53a4b727ec31d54a1ad on tab5-working. pilot.py is M6.42,
main.py M6.41 and cloud.py M6.37. Release stamps are per file, not per bundle.
The Tab5 operating branch remains older and needs accepted-source synchronization.

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

Worker/script liveness and abandoned-inhibit recovery need the beta decision in
FUTURE. The current Shelly reboot outcome reader can reject a successful null RPC
result. Clear Events/Monitor OFF are absent. The shipped flow window cannot fill
at the current cadence unless the live package has already been corrected. Utility
capture-path follow-ups remain separate from normal operation. RAM history is best
effort, not a persistent outbox. See FUTURE for all deferred work.

## Next owner decisions

Approve synchronization of the accepted candidate into Tab5, choose any beta
reliability repairs, and record the actual upload set/running package and recovery
procedure. Source promotion does not reinstall files or change Shelly settings.
Main/ebaugh.net activation concerns the web/cloud line and is planned in BETA.

Housekeeping changes documentation and host-test maintenance only. It does not
change uploadable source, package bytes, calibration values, network addresses,
device state or cloud configuration. Archive inventory is under maintenance/.

## Housekeeping verification

The remote repository now has exactly main, pilot, pilot-working, Tab5 and
tab5-working. Eighteen retired branch tips are preserved under published archive
tags; no unmerged commits were discarded. No operating branch was advanced.
Host verification: 301 web/cloud tests, 248 Tab5 tests and 31 Shelly tests passed.
The password regression covers missing/wrong keys on every mutation route. The
two Windows test adapters change host behavior only. Existing local Node dependencies
were reused; a fresh dependency install and hosted workflow run were not part of
these local results. Interfaces remain identical as Git blobs on both working lines.
