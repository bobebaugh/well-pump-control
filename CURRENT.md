# Current beta status â€” web/cloud

As of 16 September 2026. This records source and owner evidence, not assumed deployment.

## Available now

The web/cloud application includes live RTDB readings, power/history views, event
and durable-record browsing/CSV, V3 authoring/backup/publication and authenticated
User Monitor/Tab5 restart/Shelly restart requests. The owner reports the latest
home-page fix is promoted and appears to work. Existing Firestore and RTDB remain
the intended shared stores for Pilot and Main. No database move is planned.

The latest device working source is M6.42; the owner believes it is installed.
The owner confirms the Shelly 1 protection script is fully unit tested on real
hardware. Exact installed files/package identity still need a release receipt.

## Maintenance baseline

Before housekeeping: pilot = 150bb8ab6297062ca6a8157708f05700c6cd74d0;
pilot-working = b368cf6a44db95a22a6623696a60cbf07f968a29. The working branch contains
an additional observation-series repair. Housekeeping adds documentation/test
maintenance only; it does not promote that repair or change live behavior.
Old branch tips are archived in maintenance/branch-archive-2026-09-16.csv.

## Next owner decisions

1. Review the remaining beta reliability choices in FUTURE. No application fix was
   authorized or applied by housekeeping.
2. Promote the accepted working candidates to pilot/Tab5 when ready. Main remains
   intentionally suppressed until the owner authorizes public-beta activation.
3. Choose the ebaugh.net hostname; verify Netlify production environment scope,
   shared database access, password strength/access checks and HTTPS using BETA.
4. Record the web deploy, actual device file set, running package/hash, authoring
   backup, Shelly settings and applied Firebase rules/indexes. Do not substitute an
   old package number or this source revision for installed evidence.
5. Set the notification environment variables in Netlify before the channel can send:
   `RESEND_API_KEY`, `NOTIFY_FROM`, `NOTIFY_EMAIL_TO`, `NOTIFY_SMS_TO`, and
   `NOTIFY_DRY_RUN=1` while testing. Missing values leave the notifier inert and log
   the names only; ingestion is unaffected. Verify with a test event, T010-T040,
   using tests/notification-live.check.cjs. Netlify injects these into a function at
   deploy time, so adding them to a site that is already deployed changes nothing until
   the next deploy; trigger one. An event record whose notification field reads
   not-configured names the variables the running deploy is missing.
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
