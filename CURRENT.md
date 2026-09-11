# Current status — Pilot line

## Now — Pilot implementation

Pilot owns browser authoring/HMI, compiler, immutable publication, delivery and
cloud retention. V3 runtime remains schema 3; current pointer/publication state
uses schema 4 with executionEnabled true, device state uses schema 2 with running,
desired and staged identities. Legacy publication state requires republishing;
delivery does not rewrite immutable releases. Tab5 adopts only on restart.

The configuration unit implements complete authoring backup export/replacement
import, with no additive import. A read of the V3 draft no longer seeds missing
documents; import can initialize an empty V3 authoring store atomically. Existing
seeding and historical restoration remain optional. Publish and Deliver validates
online and reuses a matching current release; failed delivery retries that release.
Device status is a separate read of the existing rulesV3State record, with report
time and explicit unavailable identities. No Firebase rules change is included.

Online checks now cover known M6.33 support gaps, including summaries, expression
programs, Boyle parameters/quality enum, ADC prerequisites, mode assignments and
required relay/lock names. Authoring backup preserves unfinished definitions;
publication rejects unsupported configurations. The guide is web/rules-engine-guide.html.

## Verified handoff bases — 2026-09-11

These are the advertised tips before this documentation-only handoff, not claims
that documentation commit hashes equal their own parents. Re-read live refs.

| Branch | Verified tip before handoff |
| --- | --- |
| pilot | 2f02f158bd5c73ff946f208ab7d1549d6d44c6fc |
| pilot-working | 2f02f158bd5c73ff946f208ab7d1549d6d44c6fc |
| Tab5 | 688f491cf9b24b328cd95383cc5c190a544d9745 (M6.32) |
| tab5-working | 9d297ae4897a0a911e52a6d8b9881c2fa1ee93ff (M6.33) |

This handoff adds documentation commits only to the two working branches. No
operating promotion or deployment is included. M6.33 is bench-accepted but has
not been promoted to Tab5. Before the next coding unit, obtain owner approval
for needed operating alignment; never reset working branches to discard accepted
work. Read-only design review can proceed from the working branches now.

## Evidence and limits

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

## Configuration unit verification and closeout

- Owner authorized work from pilot-working 8d659d6dca5210828b8b0806b2439d1e644d468c,
  preserving its documentation handoff. Tab5 reference is unchanged M6.33 at
  6d4b54cc9806e34b01343caf69f1df86e540d486.
- 120 host tests passed; JavaScript syntax and whitespace checks passed.
  Host tests cover empty-store import, atomic rejection/conflict, full authoring
  round-trip, compatibility against an exact dependency slice of the real Tab5
  resolver, and actual browser-script orchestration with an in-memory backend.
- Visual/browser acceptance is not established: local Chromium was absent and its
  download timed out; the connected browser rejected the local fixture URL. The
  isolated Playwright check remains available as tests/editor-browser.check.cjs.
- No live Firebase access, package publication/delivery, hardware operation,
  operating promotion, or deployment occurred in this unit.
- Closeout: review source/test evidence, run the browser check where Chromium is
  available, then obtain owner direction for operating promotion/deployment and
  any actual package delivery/restart check.
- Owner requested branch synchronization when the unit is finished. Preserve
  accepted M6.33 and documentation; synchronize the corresponding working and
  operating branches only with explicit promotion approval. This is not approval
  to deploy or install Tab5 automatically.

## Later / unresolved

- Confirm the configuration workflow in the deployed browser after owner-approved promotion.
- Normal/Monitor kernel exists; web operator requests, required-source occurrence
  generation and Clear Events integration remain incomplete. S020 availability
  correction does not wire automatic Monitor behavior. Separate design/work unit.
- Retained V3 event records/browser and summaries remain incomplete. Desired
  standard close-record duration is a proposal, not implemented. Online checks target the current Tab5 supported subset; future runtime changes
  require updating compatibility fixtures and checks.
- Issue #5: https://github.com/bobebaugh/well-pump-control/issues/5 . Monitor the
  script named AntiFastCycle (currently script:2, copied test code) when online
  changes are next scheduled. WellTesting (script:1) is no longer authoritative.
  Configure/resolve the name, do not assume ID 2. Proposed script-running field
  and re-enable gating need coordinated design. Current code cannot detect a
  stopped script whose retained virtual values still validate. Final code will
  replace AntiFastCycle while preserving its agreed interface. Sticky -1 is
  intended to persist until restart; manual changes were test-harness operations.
- Decide S020 startup-not-yet-polled semantics. Remove duplicate availability
  records from named logging plus the older confirmation trigger (False -> False,
  True -> True). Do not silently change qualification on unavailable cycles;
  S010 bench logs showed qualification continuing across an unavailable sample.
- Numeric delta alone does not guarantee zero/permanent-lock boundary records.
  No additional boundary policy has been approved. Other fields can legitimately
  trigger a durable record and update the shared comparison baseline.

## Boundaries

Next/Later is not implementation, promotion, deployment, package-delivery or
hardware authorization. The owner installs Tab5 and performs bench tests. No
hardware operation is needed for the editor design review.
