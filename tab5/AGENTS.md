# Tab5 beta maintenance

Follow root AGENTS, CURRENT and BETA; consult DESIGN/interfaces as needed.
Work on tab5-working. Promotion to Tab5 and physical installation are separate
owner-directed actions. Never edit or deploy the obsolete ESP-IDF application.

Preserve the complete interpreted upload source: main.py, pilot.py, cloud.py,
webrepl.py, pressure_qualification.py and the supported configuration files.
Upload only files actually changed when doing an incremental repair; a recovery
installation needs the compatible complete set. Never commit device_secrets.py.

Release stamps are per file. Change the first-line Release only on an uploadable
file you modified. In pilot.py keep SOFTWARE_RELEASE and the startup log consistent
with its header. Do not bump untouched files to a matching bundle number.

Tab5 never creates ordinary demand or clears Shelly-owned protection. Preserve
current evidence, validity and confirmed-versus-accepted outcomes. Runtime packages
stage and adopt on restart. No upload, reset, wiring, calibration, or connected
equipment test without owner direction for that action. Host tests prove decisions,
not physical behavior. Use tab5/PROVISIONING.md for installation/recovery.
