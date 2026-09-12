# Current status — Tab5 line

## Now — M6.35 working-branch implementation

M6.35 implements rules-driven durable observations and current-event-board
synchronization on `tab5-working`, pending owner sync/review. The running package's
logging-enabled Device, Calculated, and System fields form one fixed record shape;
None excludes, Include stores without triggering, Change/Delta select against the
last available successfully admitted value, and gaps remain explicitly unavailable.
Session start, all same-cycle event boundaries, and the ten-minute deadline coalesce
with field reasons into at most one pre-dispatch observation.

CPU B compact-encodes each record once and keeps at most 100 records / 384 KiB,
evicting oldest entries. A separate replaceable board slot carries the first board,
changes, and approximately 30-second heartbeats without waiting for observation
capacity or networking. M6.34 battery, timing, heap, staging/adoption, and local
control behavior are preserved. Nothing is promoted, installed, delivered, or
operated; owner sync/review is next.

Host sizing with the current representative fixture measured 1,753 encoded bytes
for a 24-field observation and 25,617 bytes for a synthetic 64-slot board using
160-character display names. Full-device heap with a near-full FIFO and one active
HTTP body remains an explicit owner bench check.

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

M6.34 explicitly establishes the UIFlow software charging request after M5
initialization instead of assuming charging is enabled. A failed setter leaves the
request unknown and is retried only at the separate 60-second policy cadence; the
75/80 percent hysteresis remains unchanged. Battery reads now run at about 1 Hz and
the SYSTEM page distinguishes signed current, estimated percentage, UIFlow charging
status, software request state, age and read failure. It also shows wrap-safe prior-
cycle work and actual interval, ADC, Shelly and V3 calculation/event timing plus
bounded MicroPython heap counters.
These diagnostics remain local to the HMI and do not alter current or durable record
interfaces.

## Verified starting bases — 2026-09-12

These were the advertised remote tips before the bounded M6.34 work. Re-read live
refs before any later work or promotion.

| Branch | Verified tip before handoff |
| --- | --- |
| pilot | 07a91c2260440bb05bdff41fa26cee4bab67460f |
| pilot-working | 07a91c2260440bb05bdff41fa26cee4bab67460f |
| Tab5 | 688f491cf9b24b328cd95383cc5c190a544d9745 (M6.32) |
| tab5-working | 6d4b54cc9806e34b01343caf69f1df86e540d486 (accepted, unpromoted M6.33) |

M6.34 preserves the accepted, unpromoted M6.33 work. No operating promotion,
installation, rules-package delivery, Firebase change or hardware operation is
included.

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
- Tab5 M6.34: 160 host tests passed; `pilot.py`, `main.py` and `cloud.py` compile
  under the host syntax check, and whitespace checks passed. The M5Unified source
  convention is positive battery current for charge and negative for discharge;
  M6.34 retains the signed number and uses `isCharging()` separately. Hardware
  read cadence, setter behavior, screen fit and heap values remain owner bench
  checks; no device result is claimed by host fixtures.
- Tab5 M6.35: 168 host tests pass with syntax and whitespace checks. The tests
  cover fixed logging fields, unavailable gaps, coalesced reasons, bounded FIFO
  admission/eviction, exact retry bodies, independent board replacement, and
  representative encoded sizes. Device heap and network timing remain bench-only.
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

After syncing and reviewing both M6.35 working commits, the owner may promote and
deploy Pilot, publish the checked-in RTDB rules, then separately promote/install
Tab5 and run the observation/board/FIFO/heap checklist. Promotion, deployment and
installation remain separate owner decisions.

## Later / unresolved

- Publish-and-deliver simplification, precise actionable validation errors,
  authoring JSON replacement/additive import, prior-release restoration review,
  and an evolving user guide: design brief in EDITOR-REVIEW.md.
- Normal/Monitor kernel exists; web operator requests, required-source occurrence
  generation and Clear Events integration remain incomplete. S020 availability
  correction does not wire automatic Monitor behavior. Separate design/work unit.
- V3 event browsing and summaries remain incomplete. Board-derived inferred and
  restart closes intentionally have unknown close time. Pilot permits
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
