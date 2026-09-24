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
environment, ideally from a viewer-scoped account, and adds no public route.

The latest device working source is M6.42; the owner believes it is installed.
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
both are live on the device path. Until the package is republished with plain names, W04,
W06, W07, W08 and E006 still carry em dashes on the Tab5; a latched W07 would block every
board. The owner will publish the corrected rules from the pilot deploy's editor.

## On pilot, not yet on main

Main last matched pilot at 69601cc. Keep this list current on every pilot promotion and
clear it when main is fast-forwarded to pilot. Docs-only commits change no behavior.

| Pilot commit | Change | Kind |
|---|---|---|
| 0a1f097 | Record production activation and where the Tab5 posts | docs |
| 6ff3d7e | Catch the docs up with production | docs |
| 948e5fd | Record that pilot is production for the device | docs |
| 6e5b9c8 | Record the notification channel as live | docs |
| af8d8e2 | Reject non-ASCII event display names and enum choices at Validate/Publish; notify from each event's own settings in its release | cloud + rules editor screen |

Main's rules editor still accepts non-ASCII display names and still says notification
settings are authoring only; publish rules from the pilot deploy until main follows.

## Maintenance baseline

Before housekeeping: pilot = 150bb8ab6297062ca6a8157708f05700c6cd74d0;
pilot-working = b368cf6a44db95a22a6623696a60cbf07f968a29. The working branch contains
an additional observation-series repair. Housekeeping adds documentation/test
maintenance only; it does not promote that repair or change live behavior.
Old branch tips are archived in maintenance/branch-archive-2026-09-16.csv.

## Next owner decisions

1. Review the remaining beta reliability choices in FUTURE. No application fix was
   authorized or applied by housekeeping.
2. Promote the accepted working candidates to pilot/Tab5 when ready, and advance main
   to pilot when production should follow.
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
6. The notification transport is proven. On 22 September a live batch send from
   resend.ebaugh.net delivered both legs to the owner: the email, and the text through
   the Verizon gateway a few seconds behind it. A sending domain with no history was
   therefore not filtered, and the path is far faster than the owner's earlier
   Gmail-to-gateway route at about three minutes. The application's own send is covered
   by tests but has not yet made a live call - the transport was exercised directly
   against the same endpoint and envelope - so the first T010 after deployment closes
   that last gap. Only the short T010 message has been sent: the display names carry an
   em-dash, which is outside the GSM-7 alphabet and forces UCS-2 at seventy characters
   per segment, so watch how a full-length name such as W07 arrives during the soak.

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
