# Current status — Pilot line

## Now — Pilot owner-observed browser and control-status repair awaiting deployment

The Pilot repair fixes event links by using the Firestore-valid partial boundary
`startAt(cycle)` while retaining document-ID tie ordering for stable paging and the
three preceding durable records. Actual Firebase Admin SDK validation now guards
that boundary; focused fixtures cover the owner's cycle-600 entry, earlier/later
paging and an unsynchronized startup session.

The operator-status 503 was not a Firebase-rules failure. Firebase Admin SDK 13.10.0
accepts an explicit RTDB URL through `getDatabaseWithUrl(url, app)`; the prior
`getDatabase(app, url)` call ignored its unsupported second argument and immediately
raised `database/invalid-argument` because the app had no default database URL. The
status path now uses the supported API and logs a bounded stage, SDK code and message
without credentials or command contents. The UI separately reports rejected owner
authentication, missing service configuration and an authenticated-but-unavailable
status read.

Session/cycle, release and receipt-time columns are selectable in the existing
column area and hidden by default. Their selections survive paging, data-column
changes and browsing-mode changes; Observation time remains visible and CSV export
is unchanged.

The approved Pilot–Tab5 operator unit is implemented on `pilot-working` and
`tab5-working` but is not deployed or installed. M6.37 repairs the reviewed
operator-control defects without changing the approved controls. Command v2 uses a
non-empty no-arguments marker that survives RTDB storage. CPU B admission and CPU A
execution both reject non-increasing command sequences, so duplicates, A → B → A,
and older different IDs cannot replace or execute after newer work. Session,
expiry, synchronized-clock, and no-retry boundaries remain.

Online Tab5 restart now atomically preserves the exact accepted request before
`machine.reset()`. The new session emits a matching completion result and removes
that marker only after RTDB accepts the result. An unrelated later session never
confirms an old request; explicit rejection remains rejection, and missing linked
evidence after possible execution is unknown. A marker-write failure reports
failure and does not schedule the reset.

The earlier approved event/durable browser remains in this branch and its prior
evidence still applies. This unit does not alter its history semantics or the
event-disable/publication workflow.

The latest owner startup runs M6.35 on both CPU A and CPU B with package V17:
20260913010057-event-v3-v17, hash prefix 207cca64ea14.
Logs show successful board and durable ingestion, startup S020 opening/closure,
and S020 opening/closure after temporary Shelly acquisition failure. Screenshots
confirm observation-v2 fields, coalesced reasons, explicit unavailable pressure
values, and stored event-open/event-close records. The displayed open and close
screenshots represent different occurrences, not a verified matching pair.

## Verification

- Focused record-browser, UI and operator-control regressions passed 24/24. They
  include actual Admin SDK rejection of the old empty document-ID boundary and the
  installed-SDK reproduction/repair of the RTDB initialization failure.
- The single completion host run passed 158/158 tests. A bounded browser check was
  attempted without authenticating or issuing commands, but this session's cloud
  browser could not access localhost and permission to open the deployed owner URL
  was declined; browser-source verification therefore remains an owner retest.

- M6.37 repair host runs passed 152/152 Pilot tests and 181/181 Tab5 tests.
  Focused cases cover command-v2 shape, immediate duplicate, A → B → A and older
  different-ID rejection at both CPU boundaries, stale pending replacement,
  expired/old-session rejection, request-linked restart completion, explicit
  rejection followed by another session, manual restart after expiry, and lost
  acknowledgements remaining unknown.
- GitHub Actions Java 21 run 34759331965 passed 12/12 actual RTDB emulator tests.
  The log specifically confirms that the production command builder's record was
  written to the emulator, read back through device permissions, and accepted by
  the checked-out `tab5-working` production CPU-B validator/admission path. This
  is separate from the permission matrix and the host suites.

- Browser repair: `node --test tests/record-browser.test.js` passes 6/6 using
  Firestore-like timestamp/query fixtures. It covers mixed V1/V2 tie ordering,
  first/next pages, anchors, receipt fallback, malformed cursors, >50 closures,
  both close reasons, sparse unsynchronized session navigation and missing prior
  records. A bounded localhost mock was also operated in a real browser: event
  session → Latest/date anchor/receipt fallback, older/newer paging, and column
  changes were exercised. This is mock-backend evidence, not a live Firebase audit.
- Follow-up browser repair: `node --test tests/record-browser.test.js
  tests/record-browser-ui.test.js` passes 8/8. Backend fixtures preserve Firestore
  Timestamp observation fields versus production-shaped string closure fields, and
  traverse every history page and replay prior pages with no missing or duplicate
  closure identity. The JavaScript harness and bounded real-browser mock check both
  retain populated session pages at earlier/later boundaries, preserve columns, and
  exercise Latest, date anchor and receipt fallback. This remains local mock evidence.
- Fresh host run: `node --test tests/*.test.js` passed 139/140. The only failure,
  `rules-engine-v3-compatibility` (`null !== 0` while starting its Python resolver),
  was reproduced unchanged at pre-browser parent `167a40ed`; it is pre-existing and
  unrelated to the browser repair. `npm` was not on this host PATH, so the equivalent
  Node test command was used directly.
- The follow-up full host run passed 141/142; its only failure is the same documented
  `rules-engine-v3-compatibility` resolver failure.
- 168 Tab5 and 134 Pilot host tests passed, independently rerun during prior review.
- Corrected RTDB rules at f97f909a137f9faf2c369614178f72d5a75f7869 passed
  10/10 local demo-project emulator tests. Java 21.0.12.1, Node 22.22.2,
  npm 10.9.7; npm ci then npm run test:rtdb-rules; clean emulator shutdown.
  An empty local XDG config resolved a shared-config EPERM. Evidence was
  committed in ed7a757b686e8360dfaa652369587b64290dfa84.
- Prior 404/400 failures occurred before the matching backend rollout; subsequent
  logs show acceptance. Do not treat those earlier errors as unresolved defects.
- Extended outage, saturated FIFO, full-device heap and maximum practical board
  checks remain outstanding. Encoded FIFO byte cap is provisional at 393,216.
- No live Firebase audit or hardware action was performed by this closeout.

## Next

Owner review of the coordinated M6.37 source and the test sequence in the handoff.
Deployment, RTDB-rules publication, Tab5 file installation/restart, and any branch
promotion are separate synchronized owner actions. Online controls must not be used
until the matching Pilot function/rules and Tab5 M6.37 are all in place.

## Later / unresolved

- Battery charging: retain current 75/80 policy until new limits are chosen.
  Owner finds percentage misleading and expects higher thresholds; input power
  versus charging current remains unexplained. Supported UIFlow interfaces only.
- System Monitor automatic actuation remains deferred under issue #6. Missing
  telemetry does not release inhibits or advance clearing qualification. There is
  no Clear Events or Monitor OFF control in M6.37.
- Shelly script-health monitoring (issue #5) remains separate; resolve by script
  name, not assumed ID. Shelly-local lockouts/protections remain authoritative.
- S020 startup sensitivity, brief Cloud-yellow with a pending record, and potential
  two-second polling remain separate questions, not approved changes here.
- Rules editor Tab5 status-read failure remains parked by owner.
- Never fabricate unavailable values, physical action success or exact inferred
  close time. Runtime packages adopt only on restart with an empty event board.

## Boundaries

Source promotion does not install Tab5 files or publish Firebase rules. New coding,
deployment, package delivery and hardware operations require their applicable owner
authorization. Preserve mechanical/hardwired/Shelly-local protection; CPU A remains
sole local event/control authority. No routine flash/SD logging or durable outbox.
GitHub is the portable source of truth. Keep environment setup bounded. The
restart marker's atomic write/removal and reset linkage are host-simulated;
installed-device filesystem and reset behavior remain owner acceptance evidence.
