# Clean-sheet KISS design: current-event synchronization and bounded observation delivery

> **Status: implemented on `pilot-working` and `tab5-working` by the M6.35 coordinated source unit; not promoted, deployed, configured in Firebase, packaged, or installed.** The executable contracts and tests now supersede the proposal where exact implementation field names are required. The deliberately lossy supervisory guarantees and exclusions below remain authoritative.

## Decision in one page

CPU A remains the only event authority. After each event-board change, and about every 30 seconds while running, it hands CPU B one complete sparse snapshot of the active V3 events. The handoff is a single replaceable latest-value slot. CPU B posts the newest snapshot to a small authenticated Pilot endpoint; it does not interpret the events.

Pilot compares each accepted complete board with its online projection. It writes a deterministic open record when it first sees an occurrence. A valid, strictly newer, complete same-session board closes any projected occurrence it omits during that request. There is no confirmation timer because CPU A produces the board after event processing and this design has no separate close-delivery path to wait for. No request means no reconciliation, so silence can never close an event. A newly accepted device session ends unmatched occurrences from the prior session as `ended-by-restart`, with unknown actual end time.

Durable observations remain Rules Engine-driven records with a small system header followed by the active package's logging-enabled Device, Calculated, and System fields. Field policies and event/periodic boundaries select at most one coalesced observation per cycle. That record uses a separate FIFO of individual encoded records, bounded by approximately 100 entries and 384 KiB. When full, the FIFO discards the oldest records to retain the most recent useful history. The board neither enters nor waits behind this FIFO. There are no event batches, event transition queue, replay protocol, event ACK ledger, persistent outbox, atomic event/observation pairing, or flash writes.

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
| 5 | A valid, strictly newer, complete same-session board immediately reconciles opens and omissions during request processing. No request means no action. |
| 6 | Deterministic open/close document IDs use device, session, and occurrence identity. |
| 7 | A different valid non-retired session ends unmatched prior occurrences as restart-ended with unknown actual end time. |
| 8 | Invalid/incomplete/oversize/conflicting boards change nothing; duplicates and stale boards are successful no-ops and cannot open or close occurrences. |
| 9 | Only bounded queue/board depth, byte, age, high-water, failure, supersede/eviction, and last-success diagnostics. |
| 10 | Explicitly no exact history, inferred close precision, outage retention, cross-store atomicity, or cloud control guarantee. |
| 11 | Delete/omit batches, transition/tombstone queues, pairing, persistent outbox, epochs/tokens, replay/ACK, and complex reconstruction. |
| 12 | Three compact JSON fixture tables plus pure reducer/selection/FIFO host tests; only a few focused integration checks later. |

## 1. Authority and data separation

There are three distinct objects:

1. **CPU A event board:** authoritative volatile lifecycle/control state. It includes inactive qualification state, active occurrences, owners, and executor consequences. It never waits for Pilot.
2. **Current-event-board report:** a complete sparse description of only the active occurrences, copied from CPU A and transported as replaceable latest state.
3. **Pilot projection/history:** Pilot's best online copy plus durable open and inferred-close records. It is observational. It cannot alter CPU A state, operating mode, relay requests, owners, qualification, or latches.

The ordinary durable-observation FIFO is a fourth, independent transport object. Observation congestion cannot delay or consume capacity from the current-event-board report.

Operating-mode integration and script-health monitoring remain separate work. This proposal does not alter their event definitions, inputs, ownership, or device behavior.

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

The authoritative online projection/reconciliation state should be one Firestore document per device, for example `sites/{siteId}/eventBoardState/{deviceId}`. Its `openEvents` map uses the same stable event keys as the device board and stores the current occurrence identity plus last accepted board evidence. One complete board is therefore enough to replace this projection without absence candidates or pending predecessor occurrences. The future Open Events UI can read this projection or a simple view derived from it; it must not treat raw RTDB presence as durable truth.

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

Only a strictly greater sequence is fresh evidence. A duplicate does not refresh the projection or open or close an occurrence.

### Same-session board

Reconcile the complete board in one request:

- A reported event key absent from the projection creates its deterministic open record and becomes current. This also handles a missed opening transmission: the open is labeled `reported-open`, and local opening evidence from the slot is preserved.
- The same event key with the same occurrence ID remains open and refreshes its last accepted board evidence without creating another open record.
- The same event key with a different occurrence ID creates an inferred close for the displaced occurrence and an open for the replacement in the same reconciliation.
- A projected event key omitted from the new complete board creates an inferred close and is removed from the online open projection immediately during request processing.

The inferred close uses `closeReason: inferred-board-disappearance`, `closeTimeStatus: unknown`, the closing board's sequence, and a server-owned `detectedAt`. `detectedAt` is when Pilot processed the report, not when CPU A closed the event. Preserve available device evidence from the last board where the occurrence was present and the first board where it was absent—monotonic production uptime and optional synchronized device timestamps—but never substitute server receipt times for device times or describe receipt times alone as bounds on the actual close.

There is no absence candidate, delay, confirmation counter, or timer. If reports stop, Pilot changes nothing and the displayed board becomes stale. When communication resumes, the first valid strictly newer complete board reconciles its contents immediately.

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

A close record distinguishes `inferred-board-disappearance` and `ended-by-restart`; both retain honest uncertainty fields. Reopening the same key with a new occurrence closes the displaced occurrence as `inferred-board-disappearance` during that same reconciliation. The board protocol does not claim an exact local close time, transition reason, or physical consequence from board absence.

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

An invalid or missing board is never treated as an empty board. Silence and error responses never close an occurrence; they only make Pilot's displayed information older.

## 8. Ordinary durable-observation FIFO

### Current code cross-check, not design authority

This section was cross-checked against `interfaces/runtime-package-v3.schema.json` and the logging-policy, field-resolution, V3-cycle, durable-selection, and durable-record functions in `tab5/pilot.py` on `tab5-working` at `56f089d53b9d48adb06477005de2506bbf74abf0`. That code is implementation evidence, not the source of the intended behavior below.

The current runtime-package schema already puts a `logging` policy on Device fields, Calculated outputs, and System fields, and accepts `none`, `always`, `change`, and thresholded `delta`. The current `runtime_logging_policies()` collector, however, reads Device and Calculated policies only; it omits System fields. Current V3 change detection supplements older fixed material-change selection, while `build_durable_observation()` still copies the complete legacy observation and accepts only the legacy `material-change` and `maximum-interval` reason names. Event records returned by the V3 cycle are logged but do not themselves select a durable observation. These are incomplete implementation facts, not intended exclusions or deferrals.

The intended clean-sheet behavior is therefore the complete rules-driven selection and projection specified next: all three field categories participate, `none` controls exclusion, every other policy controls inclusion, event boundaries participate in selection, and all same-cycle reasons coalesce. Implementing that behavior will require a later active durable-record/interface unit; this documentation correction makes no runtime or schema change.

### Rules-driven observation content

The active Rules Engine package determines one fixed field set for every durable observation produced during that running package. Each record has:

1. a small system-generated header: schema/record identity, site/device/session, cycle sequence, device observation time evidence, source, running rules-release identity, trigger reasons, and snapshot phase; then
2. every logging-enabled Device, Calculated, and System field, keyed by its stable system name.

Every durable observation for that package contains the same selected field names regardless of why the record was selected. A selected field that is unavailable remains present as an explicitly tagged unavailable value and reason. It never carries a retained reading, zero, false, or another invented substitute.

The runtime logging modes retain their existing JSON meanings:

| Mode | Editor label | Included in every durable observation? | Independently selects a record? |
| --- | --- | --- | --- |
| `none` | None | No | No |
| `always` | Include | Yes | No |
| `change` | Change | Yes | Yes, when an available discrete value changes from its comparison baseline |
| `delta` | Delta | Yes | Yes, when the absolute numeric difference from its comparison baseline reaches the configured threshold |

Each `change` or `delta` field compares with that field's last available value in a durable observation successfully admitted to the RAM FIFO. Unavailable samples neither trigger on missing/recovery alone nor replace the last available baseline. For `delta`, sub-threshold changes therefore accumulate against the retained admitted baseline. Admission of any observation for another reason updates the baseline for every selected field that is available in that admitted record; unavailable selected fields preserve their earlier available baseline.

### Selection and per-cycle coalescing

A cycle selects a durable observation when one or more of these reasons applies:

- a logging-enabled `change` field changes;
- a logging-enabled `delta` field reaches its threshold;
- a V3 event opens or closes during evaluation of that cycle's frozen snapshot;
- the ten-minute maximum interval expires; or
- the existing session-start selection applies.

Collect every reason arising from the same evaluation cycle into one `triggerReasons` array and build at most **one** durable observation. An event boundary is a normal selection reason; it does not create a protected queue class, require a matching event-history document, or guarantee delivery.

The durable observation uses the agreed per-cycle frozen evidence: acquisition and calculations finish, the snapshot is frozen, and V3 evaluates that snapshot. Opening/closing reasons may describe the event-evaluation result, but the field values remain the observed pre-dispatch state. A requested action, RPC acknowledgement, or later confirmed physical result must not be presented as though it were already observed in that snapshot.

After CPU B successfully admits the complete encoded observation to the RAM FIFO, CPU A advances the available-field comparison baselines and maximum-interval baseline. It does not wait for cloud acknowledgement. Failed admission advances neither. CPU A retains no producer-side retry record.

This restores Rules Engine control over durable content and frequency without restoring delivery guarantees. M6.35 implements this content as `durable-observation-v2`; Pilot retains schema-v1 ingestion only for rollout compatibility and does not reinterpret stored v1 records. Event open/close records are created by Pilot from boards and never occupy this FIFO. The currently uncalled rule-adoption/rejection builder is not activated or redesigned here; it must not be used to justify protected classes or a second queue in this work.

### FIFO admission and loss

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
- delivery of an event-selected observation merely because the event board arrived;
- reconstruction of every transition or exact cross-session chronology;
- prevention of the rare never-before-seen delayed old-session request race;
- cloud availability, immediate cloud protection, or any cloud influence over local control;
- durable proof that a relay consequence physically occurred.

The proposed protocol does ensure that a valid persistent open event is rediscovered on a later accepted complete board, a strictly newer complete omission reconciles immediately, duplicate/current-session stale boards do not change history, same-session silence does not close an event, and Pilot never writes back into CPU A authority.

## 11. Mechanisms removed from future work

Relative to `docs/proposals/durable-observation-v3-event-record-design.md` at `791b7e1`, future implementation should delete or omit:

| Earlier mechanism | KISS replacement |
| --- | --- |
| Observation/event record batches and batch descriptors | Individual observation FIFO plus independent latest board |
| Atomic group admission and all-or-none transition batches | No coupling; each observation admitted individually |
| Device-generated immutable event-open/event-close transition FIFO | Pilot derives best-effort history from complete boards |
| Event-priority eviction and protected batch classes | One oldest-first observation eviction rule |
| Transactional event↔observation pairing and link repair | No required relationship |
| Event tombstones or transition queues | Direct comparison with each strictly newer complete board |
| Session-start durable records, server-issued session epochs/tokens, registration fences | Device-generated session ID, board sequence, retired-session fence, explicit rare-race limit |
| Replay and ACK machinery intended to preserve event history | Periodic full-board heartbeat and deterministic Pilot IDs |
| Complex close-before-open and out-of-order transition reconstruction | Latest complete state reconciliation |
| Four batch / 260-record multi-limit planning | About 100 individual records plus 384 KiB |
| Atomic or mandatory event↔observation linkage | Event boundaries still select one coalesced observation, but neither record waits for or guarantees the other |
| Persistent device outbox or routine internal-flash writes | RAM only |

The prior proposal and fixtures should remain untouched for comparison, but none of these mechanisms should be copied into the new implementation plan.

## 12. Minimal host-test fixtures

Use only the three JSON scenario files beside this proposal and a short README:

- `current-event-board-kiss-fixtures/board-reconciliation.json` is one table of board arrivals and expected projection/history changes. It covers initial empty state, appearance, duplicate, rediscovery, outage persistence, immediate complete-board disappearance, silence/staleness, restart, same-key replacement, stale delivery, malformed/incomplete input, and accepted loss.
- `current-event-board-kiss-fixtures/durable-observation-selection.json` covers the fixed logging-enabled field set, Include/Change/Delta behavior, unavailable gaps, accumulated delta, event/field/periodic reason coalescing, opening and closing boundaries, and independent board success when the associated observation is lost.
- `current-event-board-kiss-fixtures/observation-fifo.json` covers count overflow, byte overflow/oversize rejection, stable FIFO-head retry, and board independence while the FIFO is saturated.

A small pure host reducer should accept `(storedProjection, request, serverReceivedAt)` and return `(decision, newProjection, recordCreates)`. A pure selection model should accept logging policies, field states, per-field admitted baselines, event boundaries, and interval state and return zero or one candidate observation plus updated baselines only after simulated FIFO admission. A small FIFO model should accept encoded lengths and success/failure results. Tests compare those outputs with the fixture expectations. Do not boot a browser, emulator, Netlify server, or Firebase for these semantic unit cases.

Later implementation needs a few focused integration tests beyond the fixtures:

1. the endpoint transaction is idempotent under concurrent duplicate requests;
2. accepted state is mirrored to the dedicated RTDB path under the new rules/configuration;
3. M6.34's CPU A control/event tests remain unchanged when all cloud calls fail;
4. event opening/closing, field triggers, and the maximum interval still coalesce to one observation per cycle without coupling board delivery;
5. measured full-device heap retains comfortable headroom with a 384 KiB encoded FIFO and a maximum board.

## Explicit remaining uncertainties

1. **Exact future event-record-v2 fields and browser query shape.** The required uncertainty semantics are settled here, but schema naming and whether the online UI reads the device projection document directly should be decided with the browser work.
2. **Session race without epochs.** A previously unseen old HTTP request arriving after a newer session cannot be perfectly ordered. Known retired sessions are rejected and the RAM-only latest sender sharply limits the window. Perfectly solving it would recreate the rejected token/epoch protocol.
3. **Rare session ambiguity.** M6.34 uses 48 random bits and a tick fallback. The small collision/fallback risk is accepted; testing should only verify that a session ID stays unchanged during one boot and normally changes after restart.
4. **Final byte cap.** 384 KiB is justified by current heap evidence and prior representative record sizes, but real compact-encoded maximum/typical observations must be measured before acceptance.
5. **RTDB mirror versus web read source.** The dedicated raw board path is settled. The simplest current UI read source—Firestore projection document or a later thin endpoint—belongs to the event-browser work, not synchronization.

None of these uncertainties requires batches, persistent storage, transition replay, or cloud authority over the well.
