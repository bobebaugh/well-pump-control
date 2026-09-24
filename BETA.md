# Beta operation and quick fixes

## One normal maintenance path

1. Fetch current refs and inspect the appropriate working checkout. Preserve pending
   work; do not reset it to an older operating branch.
2. Fix the reported problem on pilot-working or tab5-working. Avoid unrelated cleanup.
3. Run the relevant test file. Before a release, run the branch's host suite. Commit
   with a short problem/result description and push the working branch.
4. When the owner requests a release, promote the exact tested candidate to pilot
   or Tab5. Main advances only for a screen change, and only by fast-forwarding to a
   pilot commit. Keep a tag of the previous accepted release. No mandatory PR, duplicate review document,
   or new feature branch is needed for an ordinary repair.
5. Record only the installed version/package and any remaining limitation in CURRENT.

Checks from the repository root:

| Change | Check |
| --- | --- |
| Web/cloud | Node 22+, Python 3 available; npm ci once per lockfile change, then npm test |
| Specific web/cloud bug | node --test tests/NAME.test.js |
| Tab5 decisions | python -m unittest discover -s tests -p "test_tab5*.py" |
| Shelly script | node --test tests/shelly1-anti-chatter.test.js |
| RTDB rules/authorization | npm run test:rtdb-rules (Java 21+, matching Tab5 probe) |
| Documentation only | Check links and that claims match source; no hardware test |

The beta-checks workflow runs host tests on the five retained branches when relevant
files change. RTDB emulator checks stay separate and run when rules/authorization
files change. Host checks never prove hardware, deployed permissions or installation.

## Shared Firestore and RTDB

Use the existing well-pump-control Firebase project, its (default) Firestore
database and existing RTDB. There is no database migration or reset in the beta plan.
Pilot and Main intentionally share the same site/device IDs, rules drafts, release
versions, observations, event history and operator command slot.

Pilot is a test application against LIVE DATA, not a sandbox. A Save, Publish,
Deliver, Monitor or Restart there has the same effect as on Main. Do not test writes
against it casually or run two operators through conflicting publications. Use
fixtures/emulators for destructive tests. Keep both deployed versions compatible
with the shared schema. Reverting web source does not undo a database/package write.
No separate database or second password is needed just to maintain two web versions.

## Password boundary

Every supported mutation endpoint checks X-Pilot-Key against PILOT_INGEST_TOKEN
server-side before processing the request: rules-engine, rules-admin, operator-control,
ingest-power, ingest-record, event-board and device-sync. Missing or
wrong passwords cannot use those endpoints to change rules or request a reboot.
The public GET endpoints intentionally expose monitoring/history; this is not a
private-data login. Backend Firebase credentials and temporary device tokens are
not browser credentials. RTDB grants are purpose-scoped; Firestore access is via
the server credential. Actual deployed grants still need cutover verification.

For a single-owner beta, keep the single-password experience. Use a unique long
password-manager-generated secret, HTTPS, and the existing server checks. The
password is cached in sessionStorage per browser origin, not embedded in the site.
The same secret also authenticates device ingestion: rotating it requires updating
both Netlify contexts and device configuration. No values belong in Git.

There is no application-level guessing throttle in the reviewed functions, and this
review did not inspect the secret or verify provider rate controls. If the current
password is short, memorable or reused, strengthen it before public-domain activation;
consider endpoint/IP rate limiting if using a human-chosen password. No account/MFA
redesign is required for the stated beta scope. This password does not protect local
Shelly administration or LAN WebREPL. Keep those on the trusted LAN with no public
port forwarding; device management has its own credentials/access boundary.

## Main and ebaugh.net — activated, September 2026

Live on the existing Netlify project well-pump-control. The build-ignore safeguard
(`ignore = "exit 0"`) is gone: main was not merged into but replaced, so main = pilot
and the deployable netlify.toml came with it. The replacement took four steps because
GitHub refuses to delete a default branch - switch the default to pilot, delete main,
recreate main from pilot, switch the default back. Main's history is therefore pilot's
history, and the old stub tip survives only if archived under a tag. Preserve the
device line on Tab5.

The hostname is mfwell.ebaugh.net, a Cloudflare CNAME in DNS-only mode; it answers 200
and redirects http to https. Do not change the apex site or existing DNS/mail records
as a housekeeping action. Existing branch URLs remain, and one of them is load bearing:
the Tab5 still posts ingest, event boards, releases and device sync to the pilot branch
deploy, so that deploy must stay enabled and device-driven functions run in its context
rather than production's.

The production Functions context is configured with the same existing
Firebase project/database/RTDB and password as pilot: FIREBASE_PROJECT_ID,
FIRESTORE_DATABASE_ID, FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_WEB_API_KEY,
FIREBASE_RTDB_URL and PILOT_INGEST_TOKEN. Check any explicitly configured device ID.
Use the provider's secret management; do not copy values into docs, source or CLI logs.
Keep branch deployment restricted to pilot; working branches are source maintenance.

The notification variables are a separate set: RESEND_API_KEY, NOTIFY_FROM,
NOTIFY_EMAIL_TO, NOTIFY_SMS_TO, and NOTIFY_DRY_RUN while testing. Set them for the
context the notifier actually runs in. Because the Tab5 posts to the pilot branch
deploy, production-only values leave the channel inert while everything else looks
healthy. Netlify injects variables at deploy time, so a site that is already deployed
does not see a new variable until it is redeployed - and "Trigger deploy" rebuilds
production only, so pilot's latest deploy has to be retried separately. Prove the
channel through the path the device uses, an event opened via event-board on the
pilot deploy, not through whichever copy answers a manual call.

### Two production surfaces

Pilot serves the Tab5; main serves the screens. The Tab5's Netlify endpoints are
hard-coded to the pilot deploy in `tab5/cloud.py`, so pilot is production for the
device even though its name suggests otherwise. It talks to RTDB directly using a
login issued by pilot's device-sync. Both deploys share one Firestore, one RTDB and
identical settings.

Main may lag pilot but never lead it. It advances only by fast-forwarding to a pilot
commit, and only for a screen change. Three categories:

- **Screen change** - `web/` plus the browser-called functions: current-observation,
  observation-series, record-browser, rules-admin, rules-engine, operator-control,
  health, firebase-status. Goes to pilot, then main follows.
- **Tab5-only function change** - ingest-power, ingest-record, event-board,
  device-sync. Pilot only. It must not change anything the screens read or write.
- **Rules-package pipeline** - `rules-engine`, `rules-admin`, the `rules-engine-v3-*`
  libs, `rules-engine-release`, and the pointer and package schemas. Must go to main
  and pilot together, usually with a matching Tab5 change: main compiles and writes
  the RTDB pointer, pilot re-verifies and serves the package.

Cloud-to-Tab5 inputs: rules packages come from both deploys; operator commands from
main and the installed Tab5 only; the device-sync login from pilot only.
`control/globalEnable` has no application writer and RTDB `.write` is false.
Everything else flows up from the Tab5.

Recovery. If the screens and the Tab5 functions disagree, fast-forward main to pilot.
For a bad pilot change, revert on pilot. After either, re-publish any rules written
during the mismatch - data, Netlify settings and device files do not roll back with
a push.

Settings traps. Pilot branch deploys must stay enabled: do not rename or delete the
pilot branch, and do not password-protect non-production deploys. The Tab5's function
logs appear under the pilot branch deploy. A password change must update both deploys
and the Tab5.

Changing the public hostname does not automatically update the Tab5's configured
Netlify endpoint. Keep its proven endpoint until a separate authorized device change
is useful. Relative function/download paths already support a new browser origin.
Verify the public home/records, rejection of missing/wrong passwords, legitimate
owner access, and absence of exposed credentials. Actual restart tests require the
owner present; do not reboot a device just to test the domain.

Netlify context/domain behavior: [deploys](https://docs.netlify.com/deploy/deploy-overview/),
[environment contexts](https://docs.netlify.com/build/environment-variables/overview/),
[domains](https://docs.netlify.com/manage/domains/domains-fundamentals/understand-domains/).
Password guidance: [OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

## Recovery and release record

Keep a known-good source tag, exact deployed web revision, full Tab5 upload set and
per-file hashes, Shelly script/settings, running rules-package ID/hash, complete
authoring backup JSON and the device secrets in the owner's separate recovery store.
Record applied Firebase rules/indexes independently of source promotion. Use CURRENT
for this compact release record; do not introduce a separate milestone log.

To roll back web source, deploy a compatible known-good version. Database content,
rules packages and installed device files do not roll back with Git. Restore a
compatible Tab5 file set/package deliberately; a restart clears volatile owners and
may adopt staged bytes. Do not restart blindly to fix an unknown command outcome.
Manual recovery must remain possible without the web app; final equipment recovery
and HAND procedure are owner-owned. See tab5/PROVISIONING.md on the device branch.

Before unattended use, choose the worker/script failure and abandoned-inhibit
recovery policy recorded in FUTURE, and finish bounded outage/soak acceptance.
The owner's completed Shelly real-hardware unit tests do not need repeating merely
because the documentation or Git branches changed.

## Historical recovery

Old milestone instructions have been consolidated into these documents. Exact old
trees, including unmerged ideas, remain under archive/beta-2026-09-16/<old-branch>.
The CSV in maintenance maps names to commits. Fetch tags, then use git show or a
detached checkout for recovery. A tag is a preservation point, not an accepted release.
Old local clones/worktrees may contain uncommitted files; they were not deleted or
reset. Use the two working branches for new work and retain old directories only
until their owner is satisfied nothing unique remains.
