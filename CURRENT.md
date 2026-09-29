# Current beta status â€” web/cloud

As of 23 September 2026. This records source and owner evidence, not assumed deployment.

## Available now

The web/cloud application includes live RTDB readings, power/history views, event
and durable-record browsing/CSV, V3 authoring/backup/publication and authenticated
User Monitor/Tab5 restart/Shelly restart requests. The owner reports the latest
home-page fix is promoted and appears to work. Existing Firestore and RTDB remain
the intended shared stores for Pilot and Main. No database move is planned.

For troubleshooting, maintenance/firestore-peek.cjs reads any collection from the
command line - read-only by construction - so a record can be inspected without copying
it out of the Firebase console. It needs FIREBASE_SERVICE_ACCOUNT_JSON in the
environment and adds no public route. On 27 September a cloud session with that
variable set listed the sites/well-main collections and read eventRecords and
eventBoardState documents. The owner provisioned the account read-only; that was not
tested with a write, since Pilot and Main share live data.

Installed on the Tab5: pilot.py M6.43 with DIAG logging, cloud.py M6.37 and main.py
M6.41, established by comparing the device's own files with Tab5 9e1accb.
tab5-working carries M6.44, not installed.
The owner confirms the Shelly 1 protection script is fully unit tested on real
hardware. Exact installed files/package identity still need a release receipt.

## Production activated, 23 September 2026

The owner replaced main with pilot through the GitHub web interface (default branch
switched, main deleted and recreated from pilot). main = pilot = 69601cc. The old main
was 3a8b2f3: a README and a netlify.toml whose ignore command cancelled every production
build. It was not archived under a tag; this session could not push one. Netlify built
production from the new main within seconds.

Checked from the cloud the same day: the netlify.app home, records, health,
current-observation and record-browser routes return 200; current-observation read a
2-second-old live record, so the production Functions context has the Firebase
variables. mfwell.ebaugh.net (Cloudflare CNAME, DNS only) answers 200 and redirects
http to https; the owner confirms the certificate in Netlify.

The Tab5 still posts ingest, event boards, releases and device sync to the pilot branch
deploy (pilot--well-pump-control.netlify.app), so that branch deploy must stay enabled
and device-driven functions, the notifier included, run in its context. Browsers may use
either address. Pilot is therefore not a test deploy: it is production for the device,
as main is production for the screens. A pilot push changes production behavior for the
Tab5 immediately. Main may lag pilot but never lead it, and advances only by
fast-forwarding to a pilot commit, only for a screen change. See BETA for the three
change categories and the recovery steps.

Same-day web changes now live on both: tank net flow under the gallons (zero below a
provisional 0.2 GPM floor or when not VALID; tune FLOW_FLOOR_GPM in web/app.js), record
browser columns from the records with a Standard default and a pinned header, and a
cloud-session start hook (.claude/hooks/session-start.sh).

## Lost event boards and notification text, 24 September 2026

Events with a non-ASCII display name (the em dashes in W01, W03-W08, E006) opened on the
device and wrote event-boundary durable records but never reached event history: the
board carrying them was rejected. Owner test: W03 renamed to plain ASCII, republished and
restarted, then opened, closed and emailed normally. pilot-working now rejects non-ASCII
event display names and enum choices at Validate/Publish, and the notifier sends each
event's own Notify on open/close and Open/Close message from the release on the record,
with the criteria table only as fallback. Promoted to pilot on the owner's direction, so
both are live on the device path. The owner republished the rules with plain names:
checked 25 September, published v46's display names and runtime package are ASCII. Em dashes
remain only in the events' notification messages (web open/close text), which never reach
the Tab5 but make a text message use the shorter UCS-2 segment.

## On pilot, not yet on main

Keep this list current on every pilot promotion and clear it when main is fast-forwarded
to pilot. Docs-only commits change no behavior. Empty: on 29 September, on the owner's
direction, pilot was fast-forwarded to pilot-working and main to pilot (main was
69601cc), the single main deploy of step C. Main now carries everything listed before,
from af8d8e2 through ca2079b, including the silent-device alert, which runs only on
production. Web tests: 415 pass. The Tab5 still posts to pilot until M6.45 is installed.

## On pilot-working, not yet on pilot

Keep this list current on every pilot-working change and move rows to the table above
when pilot is advanced. Empty: pilot was fast-forwarded to pilot-working on 28 September.

## Maintenance baseline

Before housekeeping: pilot = 150bb8ab6297062ca6a8157708f05700c6cd74d0;
pilot-working = b368cf6a44db95a22a6623696a60cbf07f968a29. The working branch contains
an additional observation-series repair. Housekeeping adds documentation/test
maintenance only; it does not promote that repair or change live behavior.
Old branch tips are archived in maintenance/branch-archive-2026-09-16.csv.

## Pre-freeze round, approved 27 September 2026

After one last device install, pilot.py, cloud.py and main.py run untouched for six
months. Rules packages and screens can still change during the freeze; device files
cannot. The owner reviewed and approved this plan on 27 September. The longest Tab5
session on record is 1.85 days, so nothing that only appears after weeks of uptime has
been seen yet. Mark an item done only with a commit, a check or the owner's report.

Special unit: the M6.45 rules package. This is the one package change the freeze
depends on. The owner prepares it with a session, sharing screenshots, and saves it
without publishing. It is published right after the Tab5 starts M6.45.

- Prepare in the pilot deploy's rules editor, which offers the new readings; main's
  does not until step C. Add to tab5-main: heap free after collection, lowest heap
  free, CPU A faults and CPU B faults, logging "always" so they ride the health
  record. Per-reading acceptance (0c385f7) means no separate health device is needed.
- In the same draft, the rules review: W09 back to 2,600 W if it is still at its
  3,600 W test setting; P013's name against its condition (now the 40-minute limit);
  keep the Hand-mode event as it is ("Motor running with the Shelly Rly Open - HAND or
  a bypass", Yellow). It opened as intended in the 26 Sep test and fires the first time
  the pump runs in Hand while the Shelly relay is open; Hand is unprotected by
  definition, so this is notice, not protection. Fuller detection is in FUTURE. Run the
  heap-low and loop-fault injections in the simulator. E007 stays at 266 V (owner, 28 Sep): the supply reaches 253 V at the
  house almost daily, the motor sees 6-8 V less under load, and the supply voltage is
  the power company's, not something the pump can act on.
- Prepared 29 September 2026: the draft is saved and ready, not published (latest
  release still v49, 20260928175025-event-v3-v49). Compared read-only with v49, the
  only differences are the four tab5-main readings (HeapFreeAfterGc, HeapLowestFree,
  CpuAFaults, CpuBFaults; integer, B/B/count/count, logging always) and P013's name and
  open/close messages, which no longer say "six minutes" (condition unchanged, 2,400 s).
  W09 was already 2,600 W; E007 (266 V) and the Hand-mode event W06 are unchanged.
  Editor Validate passed (37,144-byte V3 package). The simulator's heap-low and
  loop-fault cases change nothing: the same four events (E002, P001, P013, W09) open with
  and without them, and they open on v49 too. The simulator is not a reliable test
  (owner, 29 Sep): a worthwhile concept that needs more work before anything rests on
  it, so these runs are no evidence either way. Package checks rest on Validate, the
  draft-against-release comparison and the Tab5's own check at staging.
- Save only. The saved draft is shared by both deploys: publish nothing else until
  M6.45 is installed, since any publish would carry these readings and today's Tab5
  would reject it and keep v49.
- Done 29 Sep: v50 (20260929124355-event-v3-v50) published; the Tab5 staged it
  (hash 153dee66bc19) and adopted it at a web restart, session boot_7ae787c634c4 from
  about 12:46 UTC, at the owner's PC. First records: heap free after collection
  23,323,328 B, lowest free drifting down between collections as expected, CPU A and
  CPU B faults 0.
- Was: after M6.45 starts: Validate, Publish, restart the Tab5 from the web. Confirm the
  home page shows the new release running and the next health record carries the
  heap values.

Device work, one install from tab5-working:

1. Done, not installed: M6.44 records why CloudAvailable went false (06d0598, f89ec9b).
   The records page shows it from 968af5f. It rides the final install instead of going
   in alone. A week of causes would decide whether to raise RTDB_TIMEOUT_S from 1 to 2 s,
   but that would cost a second install, and a flag that recovers in 3-9 s is not a
   freeze risk.
2. Built, not installed: heap stat (device 95e5545 on tab5-working; editor 7573678). Checked
   read-only 27 Sep: the saved draft with the new readings added validates and compiles,
   and M6.45 accepts the result and the live v46. Spec: Free heap after gc.collect() about every 10 minutes, plus the
   lowest free seen, as new tab5-runtime bindings. pilot.py already measures both for
   its screen. The bindings need an entry in rules-engine-defaults.js and simulator
   support. That is rules-package pipeline, so main and pilot both carry it before a
   package uses it. The device rejects a package naming an unknown binding, so the
   order is install, then publish, then restart to adopt.
3. Built, not installed (2b273d8 on tab5-working): survive one bad loop pass, counting faults like the heap stat, in both
   CPU B (cloud.py) and CPU A (pilot.py); the owner approved CPU A on 27 September.
   CPU A takes the web restart command, so if it dies only an on-site power cycle
   recovers. Contain the pass, count it, and stop cleanly after a run of
   consecutive faults so the silent-device alert fires. No hardware watchdog and no
   endless retry (#8). Ten faults in a row stop that CPU; CPU A says so on screen and
   any Tab5 hold stays in force.
4. Built, not installed (f16e01a): daily SNTP resync, hourly retry keeping sync. cloud.py
   synced only until its first success after boot. The clock gains about 1.8 s a day
   (records, 21-27 Sep), 5-6 minutes by spring. Found while building: operator commands
   are accepted only inside a 45 s wall-clock window, so without a resync a web restart
   would start being refused as expired within about 2-3 weeks of uptime.
5. Built, not installed (f4a357f): move the device endpoints from pilot--well-pump-control.netlify.app to
   well-pump-control.netlify.app (main), not the custom domain. Main then serves the
   device as well as the screens and sends the notifications. Pilot becomes a test
   deploy that still writes live data. BETA and DESIGN change in the same push. Keep
   pilot's device functions working until the freeze, as the rollback for the old
   device files. Checked 27 Sep: main's five device endpoints reject an unauthenticated
   POST with 401 and main reads Firestore and RTDB; rules-engine-release, the V3
   package download, also answers 401 on both. BETA and DESIGN updated.
   Do not install this build before main is fast-forwarded to pilot (step C): until
   then main lacks af8d8e2 and the other device-facing changes the Tab5 relies on.
6. Built, not installed (b25bc21): re-send an unchanged event board every 30 minutes instead of 30 s
   (EVENT_BOARD_HEARTBEAT_MS), approved 27 September to save Netlify credits. A change
   in open events is still sent at once, the first board after boot is still sent at
   once, and cloud.py still retries an undelivered board, so boards and notifications
   are unaffected. The re-send's remaining job is recovery after the cloud permanently
   rejects a board and is then fixed: up to 30 minutes' wait. Calls fall from 2,880 to
   48 a day.

Cloud work on pilot-working:

7. Built (68de8ec; goes live with main's deploy): silent-device alert. A scheduled
   function runs every 15 minutes. It sends one message when the newest durable record
   is over 30 minutes old, and one when records resume. Netlify runs scheduled
   functions only on production, so it goes live with main's deploy. The internet
   outage test is its first live check.
8. Built: the heap-stat catalog entry and simulator support for item 2 (7573678). The
   editor now suggests each driver's objects and fills their type, unit and access.
9. Built (1d0ce79): the home page's events panel follows the live reading instead of the
   board's age. While the reading is fresh the board is current, since changes are sent
   at once; when it is stale, say the open events are as of the Tab5's last report.
   Today it calls a board stale after 120 s, which a 30-minute re-send would trip.
10. Built, not installed (0c385f7 on tab5-working): the Tab5's own readings are accepted
   one at a time. tab5-main was all-or-nothing, so a cloud flag with no value yet (a boot
   with the internet down never gets one) or a battery with no reading threw out
   pressure and every pressure rule. A missing reading is now left out and reads as
   unknown; Shelly devices stay all-or-nothing, and pressure still needs its guards.
   Tested on the published v46: a boot with no network and no battery has pressure from
   the first cycle and opens W07 on the second.
11. Built (70a96f2): the records page's Show options are named for what they show: All
   records, All changes (value steps, state flips, events, restarts; was "Hide health
   records"), All state changes (no value steps; was "Changes & events only") and All
   events. The "Changes, deltas & events" option added in d31c6c4 duplicated All
   changes and is removed. Ids are unchanged, so saved choices and exports still work.
12. Built, not installed (0e40cfc on tab5-working): battery charging stops at 90%, not
   80%. The voltage-based level reads 5-6 points high while charging, wider than the
   75/80 band, so charging toggled on and off and each toggle wrote a BatteryPercent
   record (28 Sep). At 75/90 the pack settles near 84-85% and, on USB, barely moves.
   Ride-through from there is about 6 h (the run-down passed 85% with 6.1 h left).

Sequence. Pilot is a branch deploy and costs no Netlify credits; each main production
deploy costs 15, so main moves once.

- A. Owner: CPU A containment approved 27 September (item 3).
- B. Build items 2-12 on the working branches.
- C. Done 29 Sep: pilot-working to pilot, then main fast-forwarded to pilot (was
  69601cc), the single main deploy. Main served the new code from 12:08 UTC, and the
  silent-device alert's first run, forced by the owner with Run now, wrote
  sites/well-main/alerts/device-silence at 12:09:44 UTC: status ok, newest record
  12:03:54, so no message (0.9 s, 159 MB; the logged ERROR is a punycode deprecation
  warning from a dependency). That document changes only on the first run and at a
  transition, so scheduled runs show only in the Netlify function log (next 12:15 UTC). Whether it can
  actually send (NOTIFY_DRY_RUN not "1" on production) is proven only by the internet
  outage test in step F. The owner considered keeping the
  device on pilot for free deploys and kept the move: the Tab5's functions freeze with
  it, so only screen changes would deploy, and those need main either way.
- D. Done 29 Sep (owner's report, records): M6.45 from tab5-working 462a4f3 installed,
  new session boot_616c029844fa from about 12:35 UTC on package v49; notifications work.
  The Tab5 was at the owner's PC for programming from 12:16 UTC, so pressure read -17.5
  psi (sensor unplugged, ADC near zero) and W04 "Pressure readings suspect" opened as
  it should. Not a fault. Record the file set once it is back at the tank.
- D (plan). Install the final Tab5 build and record its file set and stamps. Confirm records
  and notifications arrive through main, and nothing from the device reaches pilot.
- E. All restarts in one visit, because each resets uptime. Publish the reviewed rules
  package and restart to adopt it; request a Shelly reboot (accepted, then confirmed);
  restart the Tab5 from the web; last, the battery test and the whole-house power cut.
- F. Soak at least 13 days with no restart. The tick counter wraps at 12.4 days, and
  those days give the heap stat its baseline. Outage tests during the soak: internet
  only for 30-60 minutes (both alert messages should arrive), and router off for 10
  minutes. The 100-record queue lasts about 12 hours when quiet and about 4 hours on a
  typical day; each pump run adds about 45 records. A device fault found here means a
  reinstall, and the 13 days start again.
- G. Freeze. Record the running files and package in CURRENT. Add to AGENTS that the
  device-facing functions (ingest-power, ingest-record, event-board, device-sync,
  package delivery) and interfaces/ stay compatible with the installed files.

Owner tasks, no code:

- Done 28 Sep (owner's report): Shelly 1 relay connected. With it in circuit the Tab5
  cut a pump run for running too long at 40 minutes, the first physical proof that a
  Tab5 hold stops the pump in Auto. Bucket fill 21 s (recorded in the technical record).
  The old timer relay's maximum run was 6 minutes and is now somewhere between 40 and
  60 minutes, not measured: the owner made the Tab5's 40-minute limit the primary
  long-run protection while at home, and will lower the timer before leaving for the
  winter, when flush cycles are off. Until then the timer is a backup above the Tab5.
  Running package since 28 Sep: v49 (release 20260928175025-event-v3-v49), read from
  the event board at 22:59 UTC, no open events. Checked 29 Sep against v49's exact
  runtime bytes (read-only, sha256 matching the release): M6.45 (tab5-working 462a4f3)
  accepts it at staging; a boot with no network and no battery has PressurePSI from
  cycle 1 and opens W07 at 72 psi on cycle 2; with the LAN up it requests the Tab5
  hold. Main's and pilot's four device POST endpoints answer 401 without the password.
- Rules package review: now part of the special unit at the top of this section.
- Battery: M5Stack says a battery below 6 V enters protection mode, which needs manual
  recovery. Proposal: remove it for the freeze, after confirming in step E that the Tab5
  restarts unattended with the battery out (cut power 10 s, restore). No rule uses the
  battery.
- Whole-house power cut, soon: the owner wants it done ahead of the final install, and
  it does not depend on the new build. Everything restarts together, so the Tab5 likely
  boots before the router has Wi-Fi. cloud.py reconnects without limit and retries SNTP
  every 30 s, so it should recover alone; this has never been tested. Watch, after power
  returns: the home page's live reading, durable records resuming, a new event-board
  session, both Shellys reporting, and normal pump cycling. Do it with the battery in:
  a battery-out run waits until the package has moved BatteryPercent (see Battery), or
  pressure and its rules go blank. Repeat briefly in step E if the visit allows. On 27
  Sep at 18:45 EDT the owner unplugged the Tab5 with the battery in, to see how long it
  runs and whether it restarts alone when power returns after running flat. It ran on
  the battery until 02:40 on 28 Sep, about 8 hours, and shut itself off cleanly, well
  above the battery's protection threshold (owner's report).
- Caretaker card. No water: power-cycle the Tab5. Still none: selector to Hand. The Tab5
  hold has no time limit, so a Tab5 that stops while holding keeps holding (#4).
- Network, the owner's largest freeze risk: the UniFi system as a whole, not its DHCP.
  The Tab5 cannot change during the freeze, but UniFi can change underneath it. Before
  the soak, turn off or schedule automatic firmware updates, and settle the settings
  that can drop or steer a weak client: nightly channel optimization, minimum RSSI and
  band steering on the Tab5's network. Short router outages are covered by the outage
  tests and the silent-device alert; a settings change that keeps the Tab5 off Wi-Fi is
  not, except through that alert.
- Freeze contract: keep the Shelly DHCP reservations and PILOT_INGEST_TOKEN. Check the
  Netlify credit allowance against about 145,000 device function calls a month. Web
  requests cost 2 credits per 10,000 plus function compute, on branch and production
  deploys alike, so the endpoint move does not change the running cost. The account is
  on the free plan: 300 credits a month shared by all its projects, and at zero every
  project pauses until the next cycle, the device path and the silent alert included.
  Owner's screenshots, 27 Sep: 32.3 credits used since 23 Sep, about 200 a month at
  that pace, mostly function compute. Pilot's last 24 h: event-board 2.8K calls
  (30-second heartbeat), ingest-power 1.4K (60-second heartbeat), ingest-record 254;
  by count times median duration the device is about 90% of that compute, so an idle
  screen saves little. Items 6 and 9 cut the largest caller, event-board, by about 98%.
  Firebase is on Blaze and does not pause. Owner's screenshots, 27 Sep: about $4-5 a
  month, almost all Realtime Database download bandwidth (3.6 GB in 7 days), flat since
  1 September, so it does not depend on anyone viewing. Firestore, 20-27 Sep: 458K
  reads (peak 160K a day during dashboard work), 39K writes, 13K deletes; pennies.

Live readings need no change for the freeze. With no one watching, the Tab5 posts on a
material power or voltage change or a 60-second heartbeat; 1 Hz runs only while a
screen has monitoring on. The steady RTDB traffic is the 10-second coordination poll
that lets a web restart arrive within its 45-second lifetime, and the 30-second presence.

## Next owner decisions

1. Review the remaining beta reliability choices in FUTURE. No application fix was
   authorized or applied by housekeeping.
2. Work through the pre-freeze round above. It sets when pilot, Tab5 and main advance.
3. Finish activation from BETA: confirm the mfwell.ebaugh.net certificate, owner access
   and rejection of a missing or wrong password on production, and that Netlify branch
   deploys remain restricted to pilot.
4. Record the web deploy, actual device file set, running package/hash, authoring
   backup, Shelly settings and applied Firebase rules/indexes. Do not substitute an
   old package number or this source revision for installed evidence.
5. The notification channel is live and sending from the device. The variables
   `RESEND_API_KEY`, `NOTIFY_FROM`, `NOTIFY_EMAIL_TO`, `NOTIFY_SMS_TO` and
   `NOTIFY_DRY_RUN` are set on both main and pilot, and a text arrives on every pump
   run. One message per event is correct, not a half failure: only pilot serves the
   device, so only pilot sends. Two would mean main had started receiving device
   events. Main's copy stays inert until the device is repointed, and then carries the
   channel over without a settings change.

   Netlify injects these into a function at deploy time, so a site already deployed
   sees a new variable only after a redeploy, and "Trigger deploy" rebuilds production
   only - pilot's latest deploy must be retried separately. An event record whose
   notification field reads not-configured names the variables the running deploy is
   missing. Verify with a test event, T010-T040, using
   tests/notification-live.check.cjs, opened through event-board on the pilot deploy:
   a send proved by any other entry proves a path the device does not take.

   Pilot's deploy is currently behind on diagnostic logging only. The missing code
   writes function-log detail and changes no behaviour; it rides the next pilot push.
6. Email is the notification channel; the SMS leg is best-effort and degrading. Over
   22-28 September the application sent 184 messages and Resend delivered 184, with no
   bounce, failure or suppression, and every event record's notification field reads
   sent. Email arrives in seconds. The Verizon gateway is throttled by daily volume, not
   failing: on 27 September four texts handed over at 03:50:31 to 03:52:31 EDT arrived
   at 03:50 and 03:52, in order and with their two-minute spacing intact, while on 28
   September, a 29-text day, three handed over at 16:31:49, 16:37:47 and 16:40:30
   arrived together about 21:17 and in the wrong order - close before open. Same sender
   and recipient one day apart, so volume is the variable. Muting P001 at departure
   returns the daily count to roughly the four that deliver instantly, which should make
   the SMS leg usable for the one case that matters; that is inference from two days and
   is not yet proven. Resend reports the SMTP handoff, so "delivered" is never evidence
   a text arrived, and nothing on this side can observe the difference. Verizon is
   retiring email-to-text regardless: degrading through 2026, full shutdown 31 March
   2027. Email is the channel the owner relies on. Before departure, confirm the phone
   raises a Gmail alert on the MF-Well subject, since that is the only path that does
   not depend on a carrier's tolerance.

7. Review the dashboard changes now on pilot (f0acaa4-46d19ca). They reach main in the
   single main deploy, step C of the pre-freeze round. Cloud sessions can now read records directly with
   maintenance/firestore-peek.cjs instead of from a CSV export.

No DNS, Netlify settings, Firebase configuration, device upload, restart or source
promotion was performed by this housekeeping. History is in Git; all deferred work
is consolidated in FUTURE.

## Housekeeping verification

The remote repository now has exactly main, pilot, pilot-working, Tab5 and
tab5-working. Eighteen retired branch tips are preserved under published archive
tags; no unmerged commits were discarded. No operating branch was advanced.
Host verification: 301 web/cloud tests, 248 Tab5 tests and 31 Shelly tests passed.
The password regression covers missing/wrong keys on every mutation route. The
two Windows test adapters change host behavior only. Existing local Node dependencies
were reused; a fresh dependency install and hosted workflow run were not part of
these local results. Interfaces remain identical as Git blobs on both working lines.
