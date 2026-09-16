# Beta operation and quick fixes

## One normal maintenance path

1. Fetch current refs and inspect the appropriate working checkout. Preserve pending
   work; do not reset it to an older operating branch.
2. Fix the reported problem on pilot-working or tab5-working. Avoid unrelated cleanup.
3. Run the relevant test file. Before a release, run the branch's host suite. Commit
   with a short problem/result description and push the working branch.
4. When the owner requests a release, promote the exact tested candidate to pilot
   or Tab5. After web acceptance, promote the accepted web tree to main. Keep a tag
   of the previous accepted release. No mandatory PR, duplicate review document,
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
monitor-session, ingest-power, ingest-record, event-board and device-sync. Missing or
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

## Main and ebaugh.net — prepared plan, not executed

Use the existing Netlify project well-pump-control. Main currently has a build-ignore
safeguard (`ignore = "exit 0"`); merely changing a branch label will not activate it.
When authorized, merge the accepted WEB/CLOUD candidate into main with its deployable
netlify.toml, deliberately resolving that safeguard. Preserve the device line on Tab5.

Choose a hostname under ebaugh.net (for example well.ebaugh.net) with the owner.
Do not change the apex site or existing DNS/mail records as a housekeeping action.
Add the chosen hostname to Netlify, set only its required DNS records, issue/verify
HTTPS and make it the primary application domain. Existing branch URLs may remain.

Before activation, configure the production Functions context with the same existing
Firebase project/database/RTDB and password as pilot: FIREBASE_PROJECT_ID,
FIRESTORE_DATABASE_ID, FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_WEB_API_KEY,
FIREBASE_RTDB_URL and PILOT_INGEST_TOKEN. Check any explicitly configured device ID.
Use the provider's secret management; do not copy values into docs, source or CLI logs.
Keep branch deployment restricted to pilot; working branches are source maintenance.

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
