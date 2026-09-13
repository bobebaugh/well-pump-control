# Current status — Tab5 line

## Now — M6.37 operator-control repair awaiting owner review

The approved Pilot–Tab5 operator unit is implemented on `tab5-working` and
`pilot-working` but is not installed or deployed. M6.37 preserves the three
approved controls and repairs their transport and evidence boundaries. Command v2
uses a non-empty no-arguments marker that survives RTDB storage. CPU B queue
admission and CPU A execution each enforce a per-session monotonic sequence
high-water mark, preventing immediate duplicates, A → B → A replay, older
different-ID execution, and stale replacement of a newer pending command.

User Monitor enters the existing manual V3 Monitor event without a recovery
prerequisite. Existing events and owners remain open/evaluated/logged while Tab5
inhibit application is suppressed. Owner release still requires fresh Shelly lock
evidence exactly equal to zero; accepted entry never fabricates RLY0 restoration.
Monitor lasts until Tab5 restarts. Actual `machine.reset()` restarts CPU A and CPU B,
creates a new cloud session/fresh kernel board, and preserves restart-only adoption
of a valid staged package. Shelly restart uses one `Shelly.Reboot` RPC with no retry;
only a later fresh `islocked = 0` sample confirms clearance. For online Tab5
restart, the exact accepted request is atomically preserved before reset. The new
session reports completion from that marker, which is removed only after RTDB
accepts the result. A marker-write failure does not schedule a reset.

The latest owner startup runs M6.35 on both CPU A and CPU B with package V17:
20260913010057-event-v3-v17, hash prefix 207cca64ea14.
Logs show successful board and durable ingestion, startup S020 opening/closure,
and S020 opening/closure after temporary Shelly acquisition failure. Screenshots
confirm observation-v2 fields, coalesced reasons, explicit unavailable pressure
values, and stored event-open/event-close records. The displayed open and close
screenshots represent different occurrences, not a verified matching pair.

## Verification

- Current M6.37 host runs passed 181/181 Tab5 tests and 152/152 Pilot tests.
  Repair coverage includes RTDB-stable command-v2 validation, immediate duplicate,
  A → B → A and older different-ID rejection at both CPU boundaries, stale pending
  replacement, expired/old-session rejection, atomic restart evidence, explicit
  rejection followed by a later session, manual restart after expiry, and lost
  acknowledgements remaining unknown. Existing coverage still includes Monitor
  with an existing inhibit, event opening/closing during suppression, all reviewed
  Shelly lock states, staged-only startup, Shelly restart outcomes, two-tap
  controls, and telemetry loss preserving inhibit/recovery state.
- GitHub Actions Java 21 run 34759331965 passed 12/12 actual RTDB emulator tests.
  Its log confirms the production Pilot command was written to the emulator, read
  back through device permissions, and accepted by this branch's production CPU-B
  validator/admission path. This round trip is separate from permission tests.

- 168 Tab5 and 134 Pilot host tests passed, independently rerun during review.
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

Owner review of the coordinated M6.37 source and test sequence. Installation,
restart, Pilot deployment, RTDB-rules publication, package delivery/adoption, and
branch promotion remain separate synchronized owner actions. Online controls must
not be used until the matching Pilot function/rules and Tab5 M6.37 are all present.

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
