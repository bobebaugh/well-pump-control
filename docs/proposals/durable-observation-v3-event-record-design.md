# Proposed durable-observation and V3 event-record design

> **Status: NOT YET IMPLEMENTED.** This is a review contract and synthetic-fixture set only. It does not change an active schema, producer, transport, ingest endpoint, Firebase data, rules package, browser, or installed Tab5 behavior.

## Scope and verified baseline

This proposal defines the next record boundary between Tab5 and Pilot. It does not authorize implementation before the separate Tab5 diagnostics unit has finished and passed owner testing. The owner has settled transport durability as **RAM only**: no persistent outbox, no routine operational writes to internal flash, and no SD-card persistence unless a substantial later need justifies a separate decision. Runtime-package staging is an existing separate mechanism and is unchanged.

Live GitHub refs were read on 2026-09-12 before this document was prepared:

| Ref | Verified tip |
| --- | --- |
| `pilot` | `07a91c2260440bb05bdff41fa26cee4bab67460f` |
| `pilot-working` | `5754451045e4c28d5f9f5c7e08e1f84242692a9e` |
| `Tab5` | `688f491cf9b24b328cd95383cc5c190a544d9745` |
| `tab5-working` | `56f089d53b9d48adb06477005de2506bbf74abf0` (reported M6.34) |
| `agent/event-v3-checkpoint2-tab5-staging` | `a416034dae6ef622c73d8b1d88dc10bc8208587f` |
| `agent/event-v3-checkpoint2-delivery` | `54b75b7409a1cfc48a627ec16d179574937e771a` |

The current implementation was checked read-only, including M6.34 directly from commit `56f089d53b9d48adb06477005de2506bbf74abf0`; no Tab5 branch or diagnostics checkout was changed. `tab5/pilot.py` builds a broad observation and wraps the complete envelope for durable storage. Its runtime logging-policy collector covers enabled Device and Calculated fields but not `systemFields`; detailed change/delta reasons are printed but not recorded; hard-coded material triggers remain. V3 transitions are printed and may cause a reviewed STOP request after the observation is built, but they are not queued as event records and do not force an observation. `tab5/cloud.py` provides an eight-record RAM FIFO with stable-ID retries, but currently rejects event records and loses queued records on restart. Pilot `ingest-record` transactionally deduplicates by `recordId`, stores observations under `observations`, and stores other durable/audit records under `eventRecords`. Its v1 validator does not accept current V3 transition objects. The older `ingest-power` detector writes unrelated pump-start/stop documents to `events`; that collection is not V3 event history.

M6.34 makes battery **display** validity explicit: a failed read clears `battery_valid`, and the HMI model withholds cached voltage, current, level, and charging values when `battery_available` is false. That is not the same as record validity. The acquisition loop leaves the last numeric battery values cached after failure; `build_observation()` still places those numbers in `values` while separately reporting `status.battery_available: false`; and the V3 device-field collector reads declared paths such as `values.battery_percent` without consulting that availability flag. A package declaring that path can therefore pass the cached number into operational evaluation and the current broad durable envelope. M6.34 improves the display path but does not sanitize or tag the operational/durable path; the later v2 producer must emit an unavailable tagged field instead of a stale numeric value there. This conclusion follows the updated path rather than labeling the entire battery behavior simply fixed or broken.

The owner also reports intermittent program-download failures while the full application runs, with calibration mode providing a workaround. That is a separate unresolved operational issue. It requires its own reproduction and diagnosis; larger durable queues are not claimed to fix it.

## Versioning decision

Add `durable-observation-v2` and `event-record-v2` later. Do not reinterpret v1 records. Pilot ingestion may accept v1 and v2 side by side, and existing stored v1 documents remain readable. The examples beside this document use `schemaVersion: 2`, but they are intentionally outside `contracts/examples` and the active test suite.

## Durable observation v2

### Fixed header

Every record has these fixed fields:

- `schemaVersion`: `2`.
- `recordType`: `observation`.
- `recordId`: `obs_<sessionId>_<cycleSequence>`. Identity does not depend on UTC.
- `siteId`, `deviceId`, `sessionId`: producer and boot-session identity.
- `cycleSequence`: monotonically increasing observation-cycle number within the session.
- `time`: required `uptimeMs`, required `utcStatus`, and `observedAt` only when UTC is synchronized.
- `source`: `tab5`.
- `rulesRelease`: the running release's `releaseId`, version, and content hash.
- `observationPhase`: `pre-dispatch`.
- `triggerReasons`, `relatedEventRecordIds`, and `fields` as defined below.

`sessionId` must contain at least 128 bits from the hardware random source. A tick-derived fallback is not sufficient for cross-restart occurrence identity. `cycleSequence` and a wrap-extended `uptimeMs` provide ordering inside a session. Comparisons and qualification use wrap-safe elapsed-time arithmetic; raw tick subtraction is not acceptable.

`observedAt` is an RFC3339 instant with an explicit offset, normally UTC `Z`. When the clock is not synchronized, omit it and set `utcStatus` to `unsynchronized`; Pilot still adds authoritative `receivedAt`. Do not invent a device UTC time or rewrite the immutable record after synchronization. Browsers may show receipt time with an “observation time unavailable” indicator, but must not label it as observation time.

### Selected fields and unavailable values

`fields` is keyed by the active runtime package's `systemName`. It contains every Device field, Calculated output, and System field whose logging mode is not `none`, independent of which field triggered the record. It contains no hard-coded compatibility measurements.

Each selected field is a tagged value:

```json
"SupplyVoltage": { "state": "available", "value": 266.1 }
```

or:

```json
"SupplyVoltage": { "state": "unavailable", "reason": "source-unavailable" }
```

The initial reason vocabulary is `not-yet-observed`, `source-unavailable`, `invalid-reading`, and `calculation-unavailable`. An unavailable entry never carries `value`, a previous value, zero, or false. Type, unit, origin, and display metadata remain in the saved rules catalog rather than being repeated in every record.

Logging modes retain the existing runtime JSON spelling:

| JSON mode | Meaning |
| --- | --- |
| `none` | Exclude; never trigger. |
| `always` | Include; never independently trigger. The editor may label this **Include**. |
| `change` | Include; trigger when two available discrete values differ. |
| `delta` | Include; trigger when the absolute numeric difference from the last successfully queued durable available value reaches the configured threshold. |

A field moving to or from the tagged unavailable state does not itself trigger. A separately named availability Boolean is still an ordinary value: to implement the agreed “qualified health event, not immediate missing/recovered record” behavior, its rules logging mode should be `always`, and the health event boundary should select the record after qualification. This design does not assume Monitor or internal occurrence wiring already exists.

### Selection and reasons

System selection reasons are limited to session start, the ten-minute maximum interval, and event boundaries. Rules supply all field selection and field-trigger behavior. Remove the current hard-coded material-change paths and thresholds when v2 production is implemented.

`triggerReasons` is an array because one cycle may satisfy several causes:

- `session-start` for the first evaluated cycle under the running package;
- `change`, including field name, baseline, and observed value;
- `delta`, including field name, baseline, observed value, threshold, and difference;
- `event-boundary`, including transition, occurrence ID, and event-record ID;
- `maximum-interval`, including `intervalMs: 600000`.

One cycle produces at most one durable observation. All reasons are retained; they are not collapsed to a generic `material-change`. Every opening or closing transition forces that cycle's observation. `relatedEventRecordIds` names every transition record from the cycle, and every transition record points back with `relatedObservationId`.

The first evaluated cycle in a new session is selected even when UTC is unsynchronized or one or more selected fields are unavailable. For every field, `change` or `delta` compares the current available value with that field's last available value in a **successfully queued durable observation**. Intervening unavailable values do not replace that retained baseline. Missing or recovery alone does not select a record; after recovery, an available value can select one when its rule-defined comparison with the retained baseline is large enough.

### Delta baseline

Advance per-field baselines only after CPU B accepts the complete same-cycle batch into its outbound queue. This preserves the useful current behavior without waiting for cloud ACK:

- advancing on selection can suppress later records when queue insertion fails;
- advancing only on cloud ACK can select every cycle during an outage and exhaust the queue;
- advancing on successful batch queueing makes upload retry reuse stable records while a queue-full rejection leaves the baseline unchanged for a later attempt.

Only available fields in the accepted observation advance their baselines. The maximum-interval clock advances at the same complete-batch acceptance point. Baselines and the clock are RAM state too. A restart after queue acceptance but before cloud acknowledgement may lose the accepted batch and its local baseline; the next session starts fresh. That loss window is the settled RAM-only tradeoff, not a reason to add flash persistence.

## Event record v2

Tab5 emits one immutable record per opening or closing transition. Records use `recordType: event-open` or `event-close` so stored history stays easy to query, but their schema version is 2.

Each device-produced record includes:

- `recordId`: `evt_<sessionId>_<cycleSequence>_<transitionIndex>`;
- `siteId`, `deviceId`, `sessionId`, `cycleSequence`, and per-cycle `transitionIndex`;
- `source: tab5` and the same boundary `time` as its observation;
- `rulesRelease`: running release ID, version, and content hash;
- `eventDefinition`: definition ID, system name, display name, severity, and event class as evaluated;
- `occurrenceId`: `occ_<sessionId>_<definitionId>_<openingCycle>_<openingIndex>`;
- structured `reason` and `relatedObservationId`;
- `observationPhase: pre-dispatch`.

Severity values are `red`, `yellow`, and `info`; the browser renders informational events in blue. The definition snapshot is intentionally small. It is enough to render history without a new historical-definition retrieval service, while the saved current rules still provide the logged-field catalog and condition/assignment/guard suggestions for default columns.

The opening record mints the occurrence ID. The local event board retains it and the closing record reuses it. A fresh random session ID makes occurrence IDs noncolliding across restarts. Restart creates a fresh board and never restores old ownership.

`reason.kind` distinguishes `opening-condition-qualified`, `opening-occurrence`, `closing-condition-qualified`, `clear-events`, and `ended-by-restart`. Device closes may add qualification and duration details measured by wrap-safe monotonic time. Do not claim a duration across sessions when the end time is unknown.

The related observation is the complete pre-dispatch observation that caused evaluation. An action request or RPC ACK is not observed physical state. A later acquisition cycle may record a confirmed consequence if it is actually observed.

## Queueing, retries, and arrival order

The existing inter-CPU handoffs are not all queues and must not be treated alike:

| Direction | Current handoff | Semantics to preserve |
| --- | --- | --- |
| CPU A to B | `_pending_observation` | Replaceable latest-value slot; overwriting old disposable state is intentional. |
| CPU A to B | `_pending_durable_records` | Ordered RAM FIFO; replace with the bounded batch queue below. |
| CPU A to B | `_pending_rules_request`, `_pending_rules_v3_request` | One request slot each; replacement is bounded. |
| CPU A to B | `_rules_v3_state`, `_applied_rules_reference` | Latest status/reference snapshots; do not create growing backlogs. |
| CPU B to A | `_state`, `_transport_status`, `_sync_state` | Latest result/snapshot slots. |
| CPU B to A | `_pending_rules_pointer`, `_pending_rules_v3_pointer` | Replaceable latest-pointer slots. |
| CPU B to A | `_pending_rules_release`, `_pending_rules_v3_release` | One result slot for each request path. |
| CPU B to A | `_pending_commands` | Separate bounded ordered FIFO; keep its present server-backed backpressure behavior and do not merge it with durable records. |

CPU A constructs the observation and every same-cycle event record with final IDs and canonical content before queueing. CPU B accepts the complete batch or rejects it; it never accepts a partial batch. The largest package currently supported by the reviewed M6.34 source has 64 event definitions, so the largest supported same-cycle batch is one observation plus 64 transitions, or 65 records.

Use a four-batch RAM queue with all three hard limits enforced simultaneously:

- at most **4 batches**;
- at most **260 records**;
- at most **384 KiB of encoded queued record content**.

Per-batch validation also limits one observation to 32 KiB, each event record to 4 KiB, one batch to 65 records, and one batch to 288 KiB (`32 + 64 * 4`). Thus one largest supported batch always fits an empty queue. The current fixture shapes are about 1.1–1.7 KiB per observation and 0.9–1.1 KiB per event, so a synthetic 64-transition batch is roughly 64–72 KiB and four such typical maximum-transition batches fit the byte cap. Store compact immutable encoded bodies plus small batch descriptors rather than duplicate object trees. The queue payload ceiling is 384 KiB; allowing descriptors, allocator overhead, and one active upload body gives an estimated **0.5–0.7 MiB** transport budget. Later implementation must confirm at least 1 MiB of measured full-application heap headroom, using the M6.34 heap diagnostics, or reduce the number of retained batches while never reducing below one maximum batch.

Publish current depths for batches, records, and encoded bytes; high-water marks for each; the wrap-safe monotonic age of the oldest batch; and cumulative loss counts split into rejected batches, ordinary observations, event transitions, and oversize batches. Treat 3 batches, 195 records, or 288 KiB (75% of any limit) as high-water. These are RAM diagnostics and reset on restart.

The recommended overflow policy favors scarce event evidence while remaining simple and bounded:

1. If a new observation-only batch does not fit, reject that newest whole batch. Its baselines and periodic clock do not advance, so a later cycle can select again; CPU A does not retain a producer-side retry list.
2. If a batch containing an event transition or rule audit does not fit, evict the oldest queued **observation-only** batches until it fits, counting every evicted observation. Never evict a queued event transition or rule-audit batch.
3. If the protected incoming batch is oversize or still cannot fit because the queue is occupied by protected batches, reject the whole incoming batch and count its observation and every lost transition separately. Continue acquisition, event evaluation, and relay processing.

This trades older ordinary snapshots for event boundaries, but it is not lossless: a long outage can exhaust protected capacity and lose event transitions. Loss is visible without trying to insert another record into a full queue: CPU B exposes the RAM status/counters through its replaceable transport-status snapshot, and the HMI/current disposable status may show them immediately and later after connectivity returns. No “loss record” is required to enter the saturated FIFO. A restart erases the queue and these RAM counters, so Pilot may infer only a session discontinuity, not an exact lost-record count. CPU A performs one bounded submission after acquisition, event evaluation, and relay work; it does not block those paths on network activity, wait for space, or build an unbounded retry list.

CPU A advances field baselines and the periodic clock only after CPU B confirms complete batch acceptance. A rejected batch is not retried as a retained producer object: a later cycle evaluates current state against the unchanged baselines. The event board also continues forward, so an event transition rejected at saturation is a counted transition loss rather than silently replayed or reconstructed with invented timing.

After queue acceptance, members may upload independently and arrive out of order. Pilot accepts a close before its open and an event before its related observation. Each retry reuses byte-equivalent canonical content and the same ID. Pilot behavior remains:

- absent ID: create and return accepted;
- same ID and canonical content: return duplicate success;
- same ID and different content: reject with `idempotency_conflict`.

The browser/projection must show a temporarily missing linked observation as pending, not manufacture a snapshot. Stable IDs and late-link resolution handle partial upload failure. Queue members retain unchanged IDs and byte-equivalent canonical content across upload attempts; no timestamp or reason is regenerated on retry.

## Restart reconciliation

Random `sessionId` values establish uniqueness, not chronology. Neither their lexical order, device UTC, Pilot receipt time, nor the arrival order of delayed records may decide which session is current.

Extend the existing device-sync transaction with a small server-owned session registry. A live CPU B registers `(deviceId, sessionId)` and receives a monotonically increasing per-device `sessionEpoch` plus an opaque session token. CPU B discards a response if its session request slot has since been replaced by a different producer session. The token and epoch are transport metadata, not fields rewritten into CPU A's immutable queued records. Every v2 upload presents the token; ingestion validates that it names the record's device and session. Pilot advances the current-session projection only when it accepts a token-validated durable record from a higher registered epoch—never on registration alone.

This acknowledgement fence handles delayed requests as well as delayed records. If old session A received a token before restart and new session B later receives one, A's epoch is lower. A delayed A record, including its `session-start`, can be stored and linked but cannot supersede B or end B's events. If an A registration request reaches Pilot only after A has died, no running A remains to receive its returned token and send a validating record; that delayed registration alone cannot become current. Unsynchronized device UTC is immaterial to the known ordering.

If a device-authenticated upload has no recognized session-registration evidence, Pilot retains it as unordered audit evidence with server-owned `orderingStatus: unknown` metadata. A mismatched or invalid token is rejected. Unordered evidence does not advance the current-session projection, close occurrences, or invent an order. If the registry later establishes its epoch, projection work can be rerun idempotently. Immutable device record content remains unchanged.

When Pilot first accepts a token-validated record from a higher epoch, it marks the prior **known-earlier** session ended and finds occurrences from that session with an opening but no device close. A `session-start` reason is useful audit context but is not, by itself, proof of recency.

For each such occurrence, Pilot writes an idempotent synthetic `event-close` to `eventRecords`:

- `source` is `pilot-reconciler`, not `tab5`;
- `sessionId` remains the old occurrence-owning session;
- `recordId` is deterministic from occurrence ID and the detecting higher session epoch;
- `reason.kind` is `ended-by-restart`;
- `reconciliation.detectedBySessionId`, `detectedBySessionEpoch`, and `relatedObservationId` point to the accepted higher-session observation;
- `time.endTimeStatus` is `unknown`; `reconciledAt` is server time; no device `observedAt` or exact power-failure time is invented.

Late records are expected. On every late opening from a known-earlier session already marked ended, Pilot reruns the same deterministic reconciliation. A late genuine device close is retained and takes precedence in the occurrence projection because it is direct old-session evidence; the synthetic reconciliation record remains immutable audit evidence but no longer supplies the displayed end disposition. Delayed old-session starts cannot reconcile a newer session, and unknown-order evidence stays uncertain.

If restart occurs before prior queued records upload, those RAM records may be lost by owner decision. An old opening already accepted by Pilot is reconciled when the higher-epoch session produces a validated record. An opening that never reached Pilot cannot be reconstructed. If Pilot has evidence for two sessions but cannot establish their order, it retains both without manufacturing an `ended-by-restart` close. Restart still creates an empty local event board and restores no occurrence ownership.

## Future browser contract context

The first view lists open occurrences before recently closed ones. Red and yellow follow configured severity; informational is blue. An event opens the durable timeline a few records before its boundary. Timeline navigation supports older/newer traversal and selected columns. Local display time is derived from an unambiguous stored instant; unsynchronized observations use receipt time only with a clear label. No browser, per-event display settings, or historical-definition service is part of this unit.

## Acceptance matrix for the later implementation

| Area | Acceptance condition | Primary later evidence |
| --- | --- | --- |
| Field catalog | Exactly every non-`none` Device, Calculated, and System field appears; no hard-coded compatibility field survives. | Producer unit fixture built from a synthetic runtime package. |
| Modes | `always` includes without triggering; `change` and `delta` trigger as defined; `none` does neither. | Producer selection tests. |
| Coalescing | Multiple change/delta and event-boundary causes create one observation with every reason. | Same-cycle fixture equality test. |
| Event linkage | Multiple event records have unique IDs and all reference the same observation; the observation lists all event IDs. | Producer and schema tests. |
| Unavailable | A selected unavailable field has a tagged reason and no stale/default value; unavailable/recovery alone does not select; M6.34 cached battery values cannot enter v2 as available after a failed read. | Gap/recovery producer tests tracing display and record paths separately. |
| Baseline | Each field compares with its last available value in a successfully queued observation; intervening unavailable values do not replace it; queue rejection advances neither field baseline nor interval clock. | Producer/transport failure-injection tests. |
| Start/time | First evaluated cycle records with or without UTC; IDs do not depend on UTC; elapsed logic passes tick-wrap cases. | Unsynchronized and wrap-boundary tests. |
| Periodic | A quiet session selects at 600000 ms with only a maximum-interval reason. | Fake-clock producer test. |
| Snapshot meaning | Boundary record is explicitly pre-dispatch; request/ACK is never reported as observed state. | Producer event/action ordering test. |
| Handoffs | Latest-value and request/result slots remain bounded replacements; only durable batches use the enlarged FIFO; the command FIFO stays separate. | Handoff concurrency and overwrite tests. |
| Queue/capacity | An empty queue accepts 1 observation plus 64 transitions; 4-batch, 260-record, 384-KiB and per-record/per-batch limits are enforced together; high-water and oldest age are reported. | Boundary-size and measured-heap tests using full-app diagnostics. |
| Saturation | Observation-only overflow rejects newest; protected input may evict only observation-only batches; otherwise the whole input is rejected without blocking or producer backlog. Observation and transition loss counts remain visible outside the FIFO. | Queue-saturation fixture and failure-injection tests. |
| Queue/retry | Same-cycle batch is all-or-none locally; accepted records retain byte-equivalent content and stable IDs across retries; RAM restart loss is documented. | CPU B queue, restart, and retry tests. |
| Ingestion | v1 remains accepted; valid v2 stores in existing `observations`/`eventRecords`; duplicate, conflict, and out-of-order behavior remain deterministic. | Pilot contract and handler tests. |
| Reconciliation | Only a token-validated upload from a higher registered epoch advances current; delayed old or unknown-order session-starts cannot supersede/reconcile it; known late records converge and a genuine late close wins. | Device-sync/ingest transaction tests including delayed registration, delayed session-start, unsynchronized UTC, and restart-before-upload. |
| Operational separation | Intermittent full-app program-download failure remains a separate unresolved issue; queue tests make no claim to repair it. | Separate owner-controlled reproduction/diagnostic unit. |
| Scope | No older `events` collection, HMI, Firebase deployment, runtime package, hardware, or control behavior changes in this unit. | Diff and owner review. |

## Exact files expected to change later

Tab5 producer/transport:

- `tab5/pilot.py`
- `tab5/cloud.py`
- `tests/test_tab5_observation_selection.py`
- `tests/test_tab5_event_engine.py`
- `tests/test_tab5_cloud_transport.py`

Mirrored interface and Pilot contract/ingestion:

- `interfaces/durable-observation-v2.schema.json` (new, byte-identical on both product branches)
- `interfaces/event-record-v2.schema.json` (new, byte-identical on both product branches)
- `contracts/durable-observation-v2.schema.json` (new Pilot validation copy)
- `contracts/event-record-v2.schema.json` (new Pilot validation copy)
- `contracts/examples/v2/durable-observation.json` (new only when implementation is active)
- `contracts/examples/v2/event-open.json` and `event-close.json` (new only when implementation is active)
- `cloud/netlify/lib/ingest-record-contract.js`
- `cloud/netlify/functions/ingest-record.js`
- `cloud/netlify/lib/device-sync-contract.js`
- `cloud/netlify/functions/device-sync.js`
- `tests/contract-schemas.test.js`
- `tests/ingest-record.test.js`
- `tests/device-sync.test.js`

No change belongs in `cloud/netlify/functions/ingest-power.js` or the older Firestore `events` collection. Browser files are deliberately absent from this list.

## Settled decisions, remaining evidence, and order

There is no remaining material durability choice: RAM-only queueing is settled. Pre-acknowledgement restart loss and finite-outage overflow are accepted and must remain explicit. Do not add a persistent outbox, routine internal-flash writes, or SD-card persistence in this unit, and do not alter runtime-package staging.

The active rules must eventually express source-availability fields consistently with the agreed policy: use `always` for inclusion when immediate missing/recovered selection is unwanted, and let separately qualified health-event boundaries force records. That later rules-policy change remains outside this proposal-only unit. The numeric queue constants are a concrete recommendation rather than an owner-policy question; the later implementation must validate them against full-application heap measurements and may tune retained batch count downward if required, while still accepting one 65-record maximum batch.

After diagnostics owner acceptance, implement in this order: (1) approve and mirror v2 schemas; (2) add dynamic field selection, tagged unavailable values, stable IDs, reason coalescing, and occurrence retention in Tab5; (3) add bounded all-or-none RAM batch queueing in CPU B; (4) add Pilot v2 validation, session registration/fencing, storage, and idempotent reconciliation; (5) run host capacity/failure/ordering tests and owner-controlled ingest acceptance; (6) build the browser in a later unit. Modes, script-health implementation, deployment, and hardware work remain deferred.
