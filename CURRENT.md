# Current status — Tab5 line

## Now — M6.36 operator controls awaiting owner review

The approved Pilot–Tab5 operator unit is implemented on `tab5-working` and
`pilot-working` but is not installed or deployed. M6.36 adds three two-tap local
controls and the matching session-targeted online execution path: User Monitor,
actual whole-Tab5 restart, and supported Shelly 1 restart.

User Monitor enters the existing manual V3 Monitor event without a recovery
prerequisite. Existing events and owners remain open/evaluated/logged while Tab5
inhibit application is suppressed. Owner release still requires fresh Shelly lock
evidence exactly equal to zero; accepted entry never fabricates RLY0 restoration.
Monitor lasts until Tab5 restarts. Actual `machine.reset()` restarts CPU A and CPU B,
creates a new cloud session/fresh kernel board, and preserves restart-only adoption
of a valid staged package. Shelly restart uses one `Shelly.Reboot` RPC with no retry;
only a later fresh `islocked = 0` sample confirms clearance.

The latest owner startup runs M6.35 on both CPU A and CPU B with package V17:
20260913010057-event-v3-v17, hash prefix 207cca64ea14.
Logs show successful board and durable ingestion, startup S020 opening/closure,
and S020 opening/closure after temporary Shelly acquisition failure. Screenshots
confirm observation-v2 fields, coalesced reasons, explicit unavailable pressure
values, and stored event-open/event-close records. The displayed open and close
screenshots represent different occurrences, not a verified matching pair.

## Verification

- Current full host run: 180/180 Tab5 tests passed. Coverage includes entry with an
  existing inhibit, events opening/closing while Monitor suppresses physical
  inhibition, `islocked` full/temporary/zero/unavailable states, fresh board and
  requalification after restart, staged-only startup behavior, Shelly restart
  accepted/failed/unknown results, two-tap controls, expiry, duplicates, old-session
  rejection, and telemetry loss preserving inhibit/recovery state.

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

Owner review of the coordinated M6.36 source and test sequence. Installation,
restart, Pilot deployment, RTDB-rules publication, package delivery/adoption, and
branch promotion remain separate synchronized owner actions. Online controls must
not be used until the matching Pilot function/rules and Tab5 M6.36 are all present.

## Later / unresolved

- Battery charging: retain current 75/80 policy until new limits are chosen.
  Owner finds percentage misleading and expects higher thresholds; input power
  versus charging current remains unexplained. Supported UIFlow interfaces only.
- System Monitor automatic actuation remains deferred under issue #6. Missing
  telemetry does not release inhibits or advance clearing qualification. There is
  no Clear Events or Monitor OFF control in M6.36.
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
GitHub is the portable source of truth. Keep environment setup bounded.
