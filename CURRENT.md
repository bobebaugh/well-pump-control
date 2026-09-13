# Current status — Tab5 line

## Now — M6.35 initial bench closeout

The owner authorized operating-branch promotion and a design handoff on 2026-09-13.
M6.35 production, ingestion and event-board synchronization have initial real-device
and Firestore evidence. This is not completion of all outage or memory tests.

Read [the browser design handoff](docs/online-browser-design-handoff.md) for the
current next-unit scope, source bases, evidence and unresolved issues. It supersedes
older NEXT-UNIT.md/editor-review next-step suggestions. Verify live branch tips;
this document does not contain its own future commit hash.

The latest owner startup runs M6.35 on both CPU A and CPU B with package V17:
20260913010057-event-v3-v17, hash prefix 207cca64ea14.
Logs show successful board and durable ingestion, startup S020 opening/closure,
and S020 opening/closure after temporary Shelly acquisition failure. Screenshots
confirm observation-v2 fields, coalesced reasons, explicit unavailable pressure
values, and stored event-open/event-close records. The displayed open and close
screenshots represent different occurrences, not a verified matching pair.

## Verification

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

Fresh bounded design review for the online event/durable-record browser, followed
by one coding prompt and owner discussion before implementation. Home shows all
open events first and recent closed events; durable navigation uses selectable
rules-derived columns and event-time links. See the handoff for full requirements.

## Later / unresolved

- Battery charging: retain current 75/80 policy until new limits are chosen.
  Owner finds percentage misleading and expects higher thresholds; input power
  versus charging current remains unexplained. Supported UIFlow interfaces only.
- Normal/Monitor operator integration, required-source health qualification and
  Clear Events remain separate from the browser unit.
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
