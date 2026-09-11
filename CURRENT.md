# Current status — Tab5 line

## Now — Tab5 implementation

Tab5 is interpreted MicroPython under tab5/. V3 is the sole normal-loop event and
relay-write authority. Remaining V2 observation/transport support is not a V2
execution fallback. Downloads validate/resolution-check and stage atomically;
restart adopts with fresh kernel, owners and calculation history. Unsupported
candidates preserve the usable staged package.

M6.32 added passive Shelly request/failure/recovery and relay-decision logging.
M6.33 exposes each enabled device's declared $availability as Tab5's acquisition
result even if all device measurements are rejected. Rejected measurements never
supply safe defaults. It also removes raw lock/count every-change durable triggers
so named package policies govern those fields. Diagnostic prints are independent
of durable selection. Delta compares with the previous selected durable record.
No compiler or shared schema change was needed for these two fixes.

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

## Next

Read EDITOR-REVIEW.md and conduct a read-only complete editor/workflow review with
the owner. Present current behavior, gaps, proposed screens/workflows, design
questions and small implementation units. Stop for discussion before coding.
The upcoming coding agent must receive a bounded accepted unit, exact source
bases, acceptance criteria and exclusions, not the entire roadmap as authorization.

## Later / unresolved

- Publish-and-deliver simplification, precise actionable validation errors,
  authoring JSON replacement/additive import, prior-release restoration review,
  and an evolving user guide: design brief in EDITOR-REVIEW.md.
- Normal/Monitor kernel exists; web operator requests, required-source occurrence
  generation and Clear Events integration remain incomplete. S020 availability
  correction does not wire automatic Monitor behavior. Separate design/work unit.
- Retained V3 event records/browser and summaries remain incomplete. Desired
  standard close-record duration is a proposal, not implemented. Pilot permits
  some declarations that Tab5 rejects; review the full compatibility surface.
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
