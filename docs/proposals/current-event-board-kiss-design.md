# Clean-sheet KISS design: current-event synchronization and bounded observation delivery

> **Status: proposal only; not implemented.** This document defines a deliberately lossy supervisory history path. It changes no application code, interface, Firebase rule, deployed service, rules package, or installed Tab5 file.

## Decision in one page

CPU A remains the only event authority. After each event-board change, and about every 30 seconds while running, it hands CPU B one complete sparse snapshot of the active V3 events. The handoff is a single replaceable latest-value slot. CPU B posts the newest snapshot to a small authenticated Pilot endpoint; it does not interpret the events.

Pilot compares each accepted complete board with its online projection. It writes a deterministic open record when it first sees an occurrence. It closes a missing occurrence only after later complete, fresh boards from the same session have continued to omit it for at least 60 seconds. No request means no reconciliation, so silence can never close an event. A newly accepted device session ends unmatched occurrences from the prior session as `ended-by-restart`, with unknown actual end time.

Durable observations use a separate FIFO of individual encoded records, bounded by approximately 100 entries and 384 KiB. When full, it discards the oldest records to retain the most recent useful history. The board neither enters nor waits behind this FIFO. There are no event batches, event transition queue, replay protocol, event ACK ledger, persistent outbox, or flash writes.

This application is layered above a conventional well installation: the mechanical pressure switch, contactor, and hardwired controls continue to pump water without Tab5 or Pilot. Cloud synchronization is therefore a supervisory visibility function and must never enter the local protection path. The target is approximately 95–98% useful history, not forensic reconstruction. It deliberately accepts loss of an event that opens and closes entirely while Pilot is unreachable. Important locking and latching events normally remain on CPU A's board until user action or restart, so a later heartbeat should rediscover them after communications recover.

## Verified starting point

Remote refs and the two supplied clean checkouts were read on 2026-09-12:

| Ref | Verified tip |
| --- | --- |
| `pilot` | `07a91c2260440bb05bdff41fa26cee4bab67460f` |
| `pilot-working` | `791b7e12c765a32ee0e632c2d4866bd232f17e2a` |
| `Tab5` | `688f491cf9b24b328cd95383cc5c190a544d9745` |
| `tab5-working` | `56f089d53b9d48adb06477005de2506bbf74abf0` (M6.34) |

The design is grounded in these current source facts:

- `tab5/pilot.py:new_rules_v3_kernel()` allocates V3 event state by event definition ID. `advance_rules_v3_kernel()` owns lifecycle, occurrence allocation, owners, actions, and transition production. `run_rules_v3_cycle()` replaces `runtime['kernel']` on CPU A. These are the event truth; Pilot must not feed changes back into them.
- `tab5/pilot.py` currently prints `v3_records` and publishes `v3_active_event_ids` only inside the broad current observation status. It does not submit V3 event records.
- `tab5/cloud.py:submit_observation()` and `_pending_observation` already implement a replaceable CPU A→B latest-value slot. The rules/status handoffs use the same bounded snapshot pattern.
- `tab5/cloud.py:submit_durable_record()` currently holds individual objects in `_pending_durable_records`, with `DURABLE_QUEUE_DEPTH = 8`; `_peek_durable_record()` retries the front record with its stable ID until `_publish_durable_record()` succeeds. This is already an ordinary FIFO, not a batch protocol.
- `tab5/cloud.py:_run()` performs network work only on CPU B. Durable service and `_run_rtdb_step()` are explicitly scheduled so CPU A's one-second observation/event/control loop does not wait on cloud traffic.
- `tab5/cloud.py:_run_rtdb_step()` writes disposable observations to `v1/sites/well-main/devices/tab5-well-main/currentObservation`; `firebase/rtdb.rules.json` currently defines that record, `presence`, `syncState`, and `rulesV3State`, but no current-event-board path.
- `cloud/netlify/functions/device-sync.js` is request-driven and returns commands, global enable, rules metadata, and temporary Firebase credentials. Its `canonicalOpenEvents` currently only echoes the request's declared IDs; it is not a current V3 reconciliation service.
- `cloud/netlify/functions/ingest-record.js` and `cloud/netlify/lib/ingest-record-contract.js` already use deterministic `recordId` documents and Firestore transactions for idempotent ingestion. Non-observation records go to `sites/well-main/eventRecords`.
- `interfaces/event-record-v1.schema.json` cannot honestly represent this proposal's records: it requires device `observedAt`, excludes Info severity, and has no bounded/unknown inferred-close time. A future implementation therefore needs a new event-record version; v1 must not be reinterpreted.
- `interfaces/runtime-package-v3.schema.json` limits a package to 64 event definitions. Reserving logical support for 100 definitions is harmless headroom, but the transmitted board remains sparse and the current enforced maximum is 64 active slots.
- M6.34 heap diagnostics and the accepted device measurement (about 23.3 MiB free after startup) make a 384 KiB transport ceiling reasonable. The implementation must still measure encoded real records and full-application high water before finalizing the constant.

### Answers to the 12 required design questions

| # | Decision |
| --- | --- |
| 1 | Dedicated authenticated endpoint and `devices/{deviceId}/currentEventBoard`; do not overload observations or rules status. |
| 2 | Complete envelope identity/sequence/release plus sparse keyed active slots containing occurrence, display, class/severity, and opening evidence only. |
| 3 | CPU A replaces the handoff after first evaluated board, any board change, and a roughly 30-second monotonic heartbeat. |
| 4 | CPU B sends the newest pending board when networking/scheduling permits; transient retry is supersedable and permanent invalid input is dropped. |
| 5 | First fresh absence stores server receipt evidence; one later strictly newer complete same-session request can close after elapsed time is at least 60 seconds. No request means no action. |
| 6 | Deterministic open/close document IDs use device, session, and occurrence identity. |
| 7 | A different valid non-retired session ends unmatched prior occurrences as restart-ended with unknown actual end time. |
| 8 | Invalid/incomplete/oversize/conflicting boards change nothing; duplicates and stale boards are successful no-ops and do not count as fresh evidence. |
| 9 | Only bounded queue/board depth, byte, age, high-water, failure, supersede/eviction, and last-success diagnostics. |
| 10 | Explicitly no exact history, inferred close precision, outage retention, cross-store atomicity, or cloud control guarantee. |
| 11 | Delete/omit batches, transition/tombstone queues, pairing, persistent outbox, epochs/tokens, replay/ACK, and complex reconstruction. |
| 12 | Two compact JSON fixture tables plus pure reducer/FIFO host tests; only a few focused integration checks later. |

## 1. Authority and data separation

There are three distinct objects:

1. **CPU A event board:** authoritative volatile lifecycle/control state. It includes inactive qualification state, active occurrences, owners, and executor consequences. It never waits for Pilot.
2. **Current-event-board report:** a complete sparse description of only the active occurrences, copied from CPU A and transported as replaceable latest state.
3. **Pilot projection/history:** Pilot's best online copy plus durable open and inferred-close records. It is observational. It cannot alter CPU A state, operating mode, relay requests, owners, qualification, or latches.

The ordinary durable-observation FIFO is a fourth, independent transport object. Observation congestion cannot delay or consume capacity from the current-event-board report.

## 2. Board identity and schema

### Stable keys and occurrence identity

The JSON member name is the authoritative event definition key, for example `E007`. Array positions are never identities. The active package may reserve internal state for every supported event, but the report includes active events only.

Each opening receives an occurrence ID stable for its lifetime. Reuse the kernel's current `eventInstanceId` and make the durable identity the tuple `(deviceId, sessionId, occurrenceId)`. The existing instance ID is unique only inside one running release, so the session component is required. Pilot must not derive occurrence identity from a timestamp.

Keep the existing RAM-only session mechanism. `tab5/cloud.py:_new_session_id()` currently uses `os.urandom(6)` and falls back to ticks if randomness fails. This personal, single-device system does not justify a new session service or a routine flash-backed boot counter. A rare collision or ambiguous fallback is an explicitly accepted limit.

### Complete board envelope

```json
{
  "schemaVersion": 1,
  "kind": "current-event-board",
  "siteId": "well-main",
  "deviceId": "tab5-well-main",
  "sessionId": "boot_0123456789ab",
  "boardSequence": 18,
  "complete": true,
  "producedUptimeMs": 418215,
  "producedAt": "2026-09-12T16:42:10.125Z",
  "rulesRelease": {
    "releaseId": "20260912001035-event-v3-v15",
    "packageVersion": 15,
    "contentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "openEvents": {
    "E007": {
      "occurrenceId": "20260912001035-event-v3-v15:E007:1",
      "displayName": "Utility voltage high",
      "severity": "Red",
      "eventClass": "transient",
      "opening": {
        "kind": "condition-qualified",
        "cycleSequence": 1204,
        "uptimeMs": 417980,
        "observedAt": "2026-09-12T16:42:09.890Z"
      }
    }
  }
}
```

Required envelope fields are `schemaVersion`, `kind`, the three identities, `boardSequence`, `complete: true`, `producedUptimeMs`, `rulesRelease`, and `openEvents`. `producedAt` is optional and present only with a synchronized device clock. Pilot adds its own receipt time and never substitutes it for device production/open time.

The release identity is envelope-level because restart-only package adoption means one board cannot contain two releases. It includes release ID, package version, and content hash so a key such as `E007` can be interpreted against immutable rules.

Each active slot requires only occurrence ID, display name, severity, class, and opening evidence. `opening.kind` is `condition-qualified`, `occurrence-qualified`, or `unknown`; cycle sequence and monotonic uptime are required when available, and synchronized `observedAt` is optional. The small display snapshot prevents online history from depending on a later rules lookup. Conditions, assignments, summaries, current values, owners, and relay state do not belong in the board.

Limits: no more than the active package's event count, never more than 100 slots, unique keys and occurrence IDs, and at most 64 KiB of compact UTF-8 JSON. The present package contract's 64-event maximum should normally keep the report well below that byte ceiling.

## 3. CPU A publication and CPU B transport

CPU A builds and submits a replacement board:

- after the first successfully completed V3 evaluation cycle of a session, including an empty board;
- promptly after the active key set or any active slot's occurrence identity/opening metadata changes; and
- on a monotonic heartbeat deadline of about 30 seconds, even if unchanged.

Each submission increments `boardSequence`. CPU A computes the report from the just-committed kernel state, not from the transition list. It performs only bounded copying/encoding and never waits for CPU B or the network.

`cloud.py` adds a dedicated `_pending_event_board` protected by its own lock. `submit_event_board()` replaces whatever unsent board is there. CPU B retains the latest board across transient HTTP failures, but CPU A may supersede it at any time. There is no FIFO, transition list, tombstone, producer retry backlog, or board ACK history.

When network traffic is ready, CPU B posts the pending board to `/.netlify/functions/event-board`. A successful response clears that exact pending sequence. A transient failure retries with bounded backoff unless a newer board supersedes it. A permanent 4xx validation rejection drops that exact invalid board, increments a counter, and waits for CPU A's next change/heartbeat; it must not retry poison data forever. CPU B does not compare event keys or make lifecycle decisions.

Board work should be scheduled alongside RTDB work and ahead of disposable current observations, with at most one bounded network operation per CPU B pass. It does not preempt the existing legacy telemetry call already given first priority, nor does it block durable-observation service indefinitely.

## 4. Why a dedicated endpoint and RTDB path are preferable

Do not expand `currentObservation`. It changes about once per second, carries a broad measurement payload, and can be stale or absent independently of event state. Coupling the board to it wastes bandwidth and makes the 30-second board heartbeat ambiguous.

Do not overload `rulesV3State`. That record reports running/desired/staged package state, not lifecycle truth.

Use the small dedicated scratch path:

`v1/sites/{siteId}/devices/{deviceId}/currentEventBoard`

CPU B should not PUT this path directly. A direct RTDB write cannot run request-driven Pilot reconciliation. Instead the authenticated `event-board` endpoint validates and reconciles the request, then mirrors the last accepted complete envelope to that RTDB path with a server-owned `receivedAtMs`. This is one latest-value record, not history.

The authoritative online projection/reconciliation state should be one Firestore document per device, for example `sites/{siteId}/eventBoardState/{deviceId}`. Its `openOccurrences` map is keyed by composite occurrence identity, with each entry carrying its event key and any absence-candidate evidence. That permits a newly reported occurrence and its displaced, not-yet-confirmed predecessor to coexist briefly without pretending the predecessor has already closed. The future Open Events UI can read this projection or a simple view derived from it; it must not treat raw RTDB presence as durable truth.

Use one Firestore transaction per accepted board to read and replace this projection and create any deterministic open/close documents. This transaction protects only Pilot's own projection from duplicate/concurrent requests. It does **not** pair an event with an observation, provide device delivery acknowledgement, or make RAM history durable.

After that transaction, mirror the board to RTDB. If the RTDB mirror fails, return a retryable error; repeating the deterministic Firestore transaction is idempotent. A later heartbeat repairs the mirror. No reverse reconciliation from RTDB is needed. Firestore reconciliation and the RTDB mirror are **not atomic with one another**, and this design makes no cross-database atomicity claim.

## 5. Request-driven reconciliation algorithm

Pilot records server `receivedAt` for every accepted board and applies the following steps inside the projection transaction.

### Admission before comparison

Reject without changing projection or history when the body is malformed, `complete` is not exactly `true`, identities do not match the authorized device, limits are exceeded, a slot is malformed, or the rules/session/sequence fields are invalid.

For the current session:

- `boardSequence` below the stored last accepted value is stale: return accepted/ignored with `stale: true` and make no writes.
- equal sequence with byte-equivalent semantic content is a duplicate: make no Firestore reconciliation writes and do not count it as fresh evidence. The endpoint may still retry the RTDB mirror for this already-accepted current board.
- equal sequence with different content is an identity conflict: return 409 and make no writes.
- greater sequence is fresh and may reconcile.

Only a strictly greater sequence is fresh evidence. A duplicate does not refresh `lastPresentReceivedAt`, start or advance an absence interval, satisfy the “later report” requirement, or postpone a close.

### Same-session board

For each reported occurrence:

- If its composite identity is unknown, create its deterministic open record and put it in the online projection. This also handles a missed opening transmission: the open is labeled `reported-open`, and local opening evidence from the slot is preserved.
- If it is already current, refresh `lastPresentBoardSequence` and `lastPresentReceivedAt` and clear any absence candidate.
- If the same event key now contains a new occurrence ID, create the new open and make it the current occurrence for that key. Treat the displaced occurrence as absent starting with this board; do not grant it a special immediate-close path. Keep it as a pending open occurrence until the normal confirmation rule below is satisfied.

For each projected occurrence omitted from this complete board:

- On first absence, store `firstAbsentBoardSequence` and `firstAbsentReceivedAt`. Keep it online during confirmation.
- On a later fresh complete same-session board that still omits it, close only when server receipt time is at least 60 seconds after `firstAbsentReceivedAt`. The later board must have a strictly greater sequence; a duplicate cannot confirm absence.
- If it reappears first, clear the absence candidate and leave it open.

The inferred close record uses `closeReason: inferred-board-absence`, `closeTimeStatus: bounded`, `lastPresentReceivedAt`, `firstAbsentReceivedAt`, and `confirmedAbsentAt`. None is presented as the actual close time. The user-facing display may say “ended sometime after last seen; absence confirmed at …”.

There is no timer. The first absent request starts the interval, and a later heartbeat request performs the check. With a nominal 30-second heartbeat, normal confirmation occurs about 60–90 seconds after the first observed absence. If requests stop for an hour, no close occurs during that hour. A later fresh board can confirm the stored absence after communications recover; the close happens while processing that report, never merely because an hour elapsed.

### New session

When a valid complete board arrives from a session ID different from the current non-retired session:

1. Create deterministic close records for all unmatched prior-session projected occurrences with `closeReason: ended-by-restart` and `closeTimeStatus: unknown`.
2. Preserve only `restartDetectedAt` (the new board's server receipt time), not a fabricated event end time or duration.
3. Retire the prior session ID, install the new session/release/sequence as current, and process every event in the new board as a reported open.

Boards from a known retired session are stored nowhere and return stale/ignored. Package release changes are allowed only with a new session. A release change inside one session is rejected as malformed protocol state and cannot close anything.

Without a server epoch, a never-before-seen old request that arrives after a new session is theoretically indistinguishable from another restart. The replaceable RAM-only sender makes this unlikely: an unsent old board disappears on reboot, and known retired sessions are fenced. The remaining in-flight-request race is an explicit accepted uncertainty, not justification for tokens, epochs, replay, or persistent state on Tab5.

## 6. Idempotent Firestore records

Store open and close history under the existing logical `sites/{siteId}/eventRecords` collection using a new event-record contract version.

The composite occurrence identity is `(deviceId, sessionId, occurrenceId)`. Require occurrence IDs to exclude `/`. Deterministic document IDs are:

- `event-open--<deviceId>--<sessionId>--<occurrenceId>`
- `event-close--<deviceId>--<sessionId>--<occurrenceId>`

Exactly one open and one close record can therefore exist for an occurrence. A repeated attempt with identical canonical content is a duplicate success; conflicting content is rejected and counted. Do not use receipt time in document identity.

An open record distinguishes:

- `openingEvidenceStatus: exact-device` when the slot carries synchronized opening time and local sequence/uptime evidence; or
- `openingEvidenceStatus: reported-open` when Pilot first discovers the still-open event later.

Even in the first case, “exact” describes CPU A's recorded opening boundary, not network receipt or physical relay action.

A close record distinguishes `inferred-board-absence` and `ended-by-restart`; both retain honest uncertainty fields. Reopening the same key with a new occurrence uses the ordinary `inferred-board-absence` close after confirmation, not a third close mechanism. The board protocol does not claim exact local close transition history.

## 7. Malformed, incomplete, oversize, stale, and reordered boards

| Input | CPU A / CPU B behavior | Pilot behavior |
| --- | --- | --- |
| CPU A cannot build/encode within bounds | Do not submit; clear any older unsent board so stale state is not transmitted; count build rejection; retry from fresh kernel state on next heartbeat | No request, therefore no close |
| `complete` false/missing | CPU B may transport only if its shallow checks miss it | 400; no projection/history change |
| Malformed slot/envelope | Drop on local validation if possible; otherwise 4xx becomes permanent rejection | 400; no projection/history change |
| More than 100 slots or more than 64 KiB | Reject locally and count oversize | 413/400; no change |
| Duplicate sequence/content | Clear exact pending item on success | Idempotent success; no duplicate record |
| Equal sequence/different content | Drop after permanent conflict response; count conflict | 409; no change |
| Lower sequence in current session | Clear as stale success | Ignore; no change |
| Known retired session | Clear as stale success | Ignore; cannot supersede current |
| Release changes without restart | Drop after permanent protocol rejection | 409/400; no change |

An invalid or missing board is never treated as an empty board. Silence and error responses never start or advance absence confirmation.

## 8. Ordinary durable-observation FIFO

This work changes transport bounds, not observation meaning. Existing `durable-observation-v1` records may continue unchanged until a separately approved record-content revision. Event open/close records are created by Pilot from boards and never occupy this FIFO. The currently uncalled rule-adoption/rejection builder is not activated or redesigned here; it must not be used to justify protected classes or a second queue in this work.

CPU A hands CPU B one complete individual durable observation at a time. CPU B compact-encodes it once before admission. The FIFO is bounded simultaneously by:

- 100 records; and
- 393,216 encoded payload bytes (384 KiB).

Whichever bound is reached first controls admission. Descriptor/list overhead is outside the encoded-byte counter and must be included in heap acceptance measurement. Reject a single record larger than the total byte cap.

Overflow policy: evict the oldest queued ordinary observations until the new ordinary observation fits, then append it. The only normal admission rejection is a single incoming record larger than the total byte cap or structurally invalid input. This keeps the most recent useful outage history, requires no priorities or batch logic, and prevents an unchanged producer baseline from selecting/rejecting the same observation every second. Count every eviction. CPU A advances its selection baseline when CPU B accepts the new record; it retains no retry object. CPU B retries only the FIFO head using the record's unchanged deterministic ID and content.

There is one small concurrent-handoff caveat: CPU A can submit while CPU B is awaiting HTTP for the old head. Treat that head as logically evictable. If overflow evicts it during the attempt, let the already-started request finish; a success is harmless idempotent extra history, and a failure is not reinserted. This keeps admission nonblocking and avoids rejecting a normal new record merely because an old request is in flight. The 384 KiB counter covers queued encoded bodies; heap acceptance must also allow one temporary active HTTP body.

During a long outage, this intentionally loses the oldest observations. A restart loses the entire FIFO and RAM counters. No flash or SD write is added. Network failure, queue saturation, encoding failure, and Pilot rejection never delay CPU A event evaluation or relay consequences.

The board has its own one-slot handoff, retry state, sequence, and counters. Even with the observation FIFO at 100 records/384 KiB, a board change or heartbeat can still be submitted and reconciled.

## 9. Useful diagnostics only

All counters are bounded/saturating RAM values and reset on reboot.

Board diagnostics:

- pending yes/no and pending board sequence;
- last submitted, attempted, and accepted board sequence;
- age since last successful board report;
- current active slot count and encoded bytes;
- cumulative boards superseded before send;
- transient send failures;
- permanent validation/conflict rejects;
- local build/oversize rejects;
- Pilot result category: accepted, duplicate, stale, or rejected.

Observation FIFO diagnostics:

- current record count/capacity and encoded bytes/capacity;
- high-water record count and encoded bytes;
- oldest queued age;
- cumulative oldest-record evictions;
- cumulative oversize/invalid admission rejects;
- transient upload failures and permanent Pilot rejects;
- last durable success age.

Do not add per-event ACK maps, transition loss ledgers, session registries on Tab5, or unbounded error histories. Current status/HMI may display the counters; they need not themselves enter the saturated FIFO.

## 10. Guarantees deliberately not provided

The design does not guarantee:

- history for an event that opens and closes entirely while no board reaches Pilot;
- exact close time or local close reason when closure is inferred from disappearance;
- retention of ordinary observations beyond the bounded RAM FIFO;
- preservation of any queue, board pending state, counter, or local event state across restart/power loss;
- atomic pairing, ordering, or arrival of observations with event history;
- reconstruction of every transition or exact cross-session chronology;
- prevention of the rare never-before-seen delayed old-session request race;
- cloud availability, immediate cloud protection, or any cloud influence over local control;
- durable proof that a relay consequence physically occurred.

It does guarantee within the implemented protocol that a valid persistent open event is rediscovered on a later accepted complete board, duplicate/current-session stale boards do not duplicate history, same-session silence does not close an event, and Pilot never writes back into CPU A authority.

## 11. Mechanisms removed from future work

Relative to `docs/proposals/durable-observation-v3-event-record-design.md` at `791b7e1`, future implementation should delete or omit:

| Earlier mechanism | KISS replacement |
| --- | --- |
| Observation/event record batches and batch descriptors | Individual observation FIFO plus independent latest board |
| Atomic group admission and all-or-none transition batches | No coupling; each observation admitted individually |
| Device-generated immutable event-open/event-close transition FIFO | Pilot derives best-effort history from complete boards |
| Event-priority eviction and protected batch classes | One oldest-first observation eviction rule |
| Transactional event↔observation pairing and link repair | No required relationship |
| Event tombstones or transition queues | Absence across later complete boards |
| Session-start durable records, server-issued session epochs/tokens, registration fences | Device-generated session ID, board sequence, retired-session fence, explicit rare-race limit |
| Replay and ACK machinery intended to preserve event history | Periodic full-board heartbeat and deterministic Pilot IDs |
| Complex close-before-open and out-of-order transition reconstruction | Latest complete state reconciliation |
| Four batch / 260-record multi-limit planning | About 100 individual records plus 384 KiB |
| Requirement that every event boundary force and link an observation | No forced coupling |
| Persistent device outbox or routine internal-flash writes | RAM only |

The prior proposal and fixtures should remain untouched for comparison, but none of these mechanisms should be copied into the new implementation plan.

## 12. Minimal host-test fixtures

Use only the two JSON scenario files beside this proposal and a short README:

- `current-event-board-kiss-fixtures/board-reconciliation.json` is one ordered table of board arrivals and expected projection/history changes. It covers initial empty state, appearance, duplicate, rediscovery, outage persistence, absence cancellation, confirmed absence, silence, restart, reopening, stale delivery, malformed/incomplete input, and accepted loss.
- `current-event-board-kiss-fixtures/observation-fifo.json` covers count overflow, byte overflow/oversize rejection, stable FIFO-head retry, and board independence while the FIFO is saturated.

A small pure host reducer should accept `(storedProjection, request, serverReceivedAt)` and return `(decision, newProjection, recordCreates)`. A small FIFO model should accept encoded lengths and success/failure results. Tests compare those outputs with the fixture expectations. Do not boot a browser, emulator, Netlify server, or Firebase for these semantic unit cases.

Later implementation needs a few focused integration tests beyond the fixtures:

1. the endpoint transaction is idempotent under concurrent duplicate requests;
2. accepted state is mirrored to the dedicated RTDB path under the new rules/configuration;
3. M6.34's CPU A control/event tests remain unchanged when all cloud calls fail;
4. measured full-device heap retains comfortable headroom with a 384 KiB encoded FIFO and a maximum board.

## Explicit remaining uncertainties

1. **Exact future event-record-v2 fields and browser query shape.** The required uncertainty semantics are settled here, but schema naming and whether the online UI reads the device projection document directly should be decided with the browser work.
2. **Session race without epochs.** A previously unseen old HTTP request arriving after a newer session cannot be perfectly ordered. Known retired sessions are rejected and the RAM-only latest sender sharply limits the window. Perfectly solving it would recreate the rejected token/epoch protocol.
3. **Rare session ambiguity.** M6.34 uses 48 random bits and a tick fallback. The small collision/fallback risk is accepted; testing should only verify that a session ID stays unchanged during one boot and normally changes after restart.
4. **Final byte cap.** 384 KiB is justified by current heap evidence and prior representative record sizes, but real compact-encoded maximum/typical observations must be measured before acceptance.
5. **RTDB mirror versus web read source.** The dedicated raw board path is settled. The simplest current UI read source—Firestore projection document or a later thin endpoint—belongs to the event-browser work, not synchronization.

None of these uncertainties requires batches, persistent storage, transition replay, or cloud authority over the well.
