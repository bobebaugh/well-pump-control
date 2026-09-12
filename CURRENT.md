# Current status — Pilot line

## Now — M6.35 working-branch implementation

The coordinated rules-driven durable-observation and current-event-board unit is
implemented on `pilot-working` and `tab5-working`, pending owner sync/review. It is
not promoted or deployed. Pilot now accepts durable observation schema v2 while
retaining schema-v1 ingestion, reconciles authenticated complete boards in one
Firestore transaction, creates deterministic event-record-v2 history, and mirrors
only revision-current accepted boards to the dedicated RTDB path. Same-session
newer omissions close immediately; silence does nothing; restart closes prior
session occurrences with unknown end time.

The checked-in RTDB rules add the fixed Netlify event-board writer and must be
published separately after source promotion. No Firebase, Netlify, package, or
hardware change was made by this unit. The owner checklist is
`docs/m635-owner-install-test.md`.

## Now — Pilot implementation

Pilot owns browser authoring/HMI, compiler, immutable publication, delivery and
cloud retention. V3 runtime remains schema 3; current pointer/publication state
uses schema 4 with executionEnabled true, device state uses schema 2 with running,
desired and staged identities. Legacy publication state requires republishing;
delivery does not rewrite immutable releases. Tab5 adopts only on restart.

The accepted configuration unit is deployed on pilot at 30bdcc2. Owner reported
all requested tests OK on 2026-09-12, including backup replacement/publication and
historical restoration. The supplied backup uses E007 >265 V / <=265 V. Its apparent
import failure was a confusing preview/confirmation step; Replace draft restored
265 and publication created V15. Owner logs confirm V15 staging
(20260912001035-event-v3-v15, hash prefix f69005f96623). Owner later reported all
tests OK; a separate V15 startup log was not supplied here.

The approved closeout replaces separate load/import/history/restore controls with
one Load popup: Seed, Last saved, Published (10 most recent), Backup JSON. All load
into the editor without persistence. Validate is read-only; Save Draft atomically
replaces all sections; every deliberate Publish creates a new version. Retry delivery
retains that version. Guide: web/rules-engine-guide.html.

## Verified source bases — 2026-09-12

Re-read live refs; these are the tips before the closeout commit, not its own SHA.

| Branch | Verified base |
| --- | --- |
| pilot | 30bdcc2e7c92c0539d9d2de037cc5539a6881ed6 |
| pilot-working | 30bdcc2e7c92c0539d9d2de037cc5539a6881ed6 |
| Tab5 | 688f491cf9b24b328cd95383cc5c190a544d9745 (M6.32) |
| tab5-working | 6d4b54cc9806e34b01343caf69f1df86e540d486 (M6.33) |

Pilot working/operating matched and were clean at closeout start. Tab5 remains
unchanged. Its accepted M6.33 still needs owner-approved operating promotion;
do not discard it to align branches. The next unit brief is NEXT-UNIT.md.

## Evidence and limits

- M6.35 has 134 ordinary host tests passing, including strict v2 observation
  ingestion, board reconciliation, deterministic callback retry, mirror revision
  ordering, and executable schema examples. The corrected current-event-board
  rules passed the local Java 21 RTDB emulator gate on 2026-09-12 at
  `f97f909a137f9faf2c369614178f72d5a75f7869`: Java 21.0.12.1, Node 22.22.2,
  and npm 10.9.7; `npm ci` then `npm run test:rtdb-rules` started the
  `demo-well-pump-control` database emulator, loaded `firebase/rtdb.rules.json`,
  and completed 10 tests passed, 0 failed before clean shutdown. Firebase CLI
  configuration was isolated in an empty local XDG config directory because the
  shared user config was unreadable; no login, live Firebase access, or remaining
  emulator-gate blocker exists.

- Pilot 2f02f158: 112 host tests passed. The owner-provided Windows Codex report
  confirms RTDB emulator acceptance using demo-well-pump-control on localhost,
  followed by shutdown. The earlier blocked emulator attempt was subsequently
  resolved; do not keep reporting it as an outstanding gate.
- Owner confirmed Pilot deployment at 2f02f158 and published the updated RTDB
  rules through Firebase Console. No Firestore rule update was required for that
  unit. These are session-reported deployment facts, not a fresh cloud audit.
- Tab5 M6.33: 149 host tests passed, syntax and whitespace checks passed. The
  GitHub tree was verified identical to the tested local tree before ref update.
- Owner bench logs show E007 opening/inhibiting, reasserting OFF after owner ON
  operations, qualifying closure and acknowledged/observed ON recovery; positive
  and sticky lock handling; package download/staging without live replacement,
  followed by adoption at restart; and accepted durable observations.
- Latest owner-reported running package is V11,
  20260911175226-event-v3-v11, hash prefix 6d9944a8dc7a. The owner disabled High
  Voltage for later S010 tests. Runtime packages are not source-branch versions.
- M6.33 S020 opened during startup before polling, closed after valid acquisition,
  reopened after failed acquisition and closed on recovery. IsLocked delta 10
  selected 0 -> 19 and 19 -> 8; 8 -> 0 did not itself select a record. These two
  fixes have bench evidence, not just host-test evidence.
- S010 intentionally opens when relay ON AND IsLocked != 0, and closes only when
  relay ON AND IsLocked == 0. It is informational, with no control assignments.
  Do not substitute the logical inverse of its opening condition for that policy.
- Reduced Windows utility polling reduced errors. Logs distinguish transport/body
  timeouts, HTTP/RPC errors and missing components. Owner intentionally stopped,
  rebooted and renamed script components during some tests; do not attribute all
  failures to network contention. One earlier timed-out enable request followed
  by owner manual ON remains inconclusive, not an established retry defect.
- Bench evidence is not proof of production protection. The relay was described
  by the owner as unloaded; the final Shelly protection script is not implemented.

## Closeout verification and remaining check

- 124 host tests pass, including actual browser-script orchestration against the
  in-memory backend. Coverage includes the 266 saved / 265 backup reproduction,
  all load sources and validation without saving, explicit atomic save, conflicts,
  malformed loads, deliberate identical publication, delivery retry, interrupted
  publication response recovery, and categorized device-status errors/timeouts.
- The original online compatibility tests remain, including the exact M6.33 resolver
  dependency slice. No changes to Tab5 support policy are included.
- Updated tests/editor-browser.check.cjs for the new dialog. Real-browser execution
  of this closeout remains unverified: Chromium is absent in this environment.
  Prior deployed editor acceptance does not imply acceptance of this new dialog.
- Tab5 status previously swallowed every read failure and invalid report into null.
  It now reports a completion time and distinct error categories, with an 8-second
  server read timeout. Live root cause remains unverified: no Firebase reads or
  configuration/permission changes were made. After promotion, refresh once and
  use the displayed category to resolve the actual failure if it persists.
- No live package publication/delivery or hardware operations occurred in closeout.
  Source promotion is a separate owner decision. Pilot remains on the accepted
  preceding build until that decision; this closeout is on pilot-working.
- Owner asked to synchronize branches at completion. Pilot promotion should be a
  fast-forward after review; Tab5 promotion of accepted M6.33 is separate and must
  preserve its work. Do not install Tab5 automatically.

## Later / unresolved

- Confirm the new Load dialog and classified status result after owner-approved promotion; do not repeat the already accepted original import tests.
- Normal/Monitor kernel exists; web operator requests, required-source occurrence
  generation and Clear Events integration remain incomplete. S020 availability
  correction does not wire automatic Monitor behavior. Separate design/work unit.
- V3 event browsing and summaries remain incomplete. Board-derived inferred and
  restart closes intentionally have unknown close time. Online checks target the current Tab5 supported subset; future runtime changes
  require updating compatibility fixtures and checks.
- Issue #5: https://github.com/bobebaugh/well-pump-control/issues/5 . Monitor the
  script named AntiFastCycle (currently script:2, copied test code) when online
  changes are next scheduled. WellTesting (script:1) is no longer authoritative.
  Configure/resolve the name, do not assume ID 2. Proposed script-running field
  and re-enable gating need coordinated design. Current code cannot detect a
  stopped script whose retained virtual values still validate. Final code will
  replace AntiFastCycle while preserving its agreed interface. Sticky -1 is
  intended to persist until restart; manual changes were test-harness operations.
- Decide S020 startup-not-yet-polled semantics. Durable selection is now governed
  by the running package's fixed logging field set plus session, event-boundary,
  and maximum-interval reasons; no separate legacy availability/material trigger
  remains. Do not silently change event qualification on unavailable cycles.
- Numeric Delta alone does not guarantee a zero/permanent-lock boundary record.
  No additional boundary policy has been approved.

## Boundaries

Next/Later is not implementation, promotion, deployment, package-delivery or
hardware authorization. The owner installs Tab5 and performs bench tests. No
hardware operation is needed for the editor design review.
