# Proposed durable-observation and V3 event-record design

> **Status: NOT YET IMPLEMENTED.** This is a review contract and synthetic-fixture set only. It does not change an active schema, producer, transport, ingest endpoint, Firebase data, rules package, browser, or installed Tab5 behavior.

## Scope and verified baseline

This proposal defines the next record boundary between Tab5 and Pilot. It does not authorize implementation before the separate Tab5 diagnostics unit has finished and passed owner testing.

Live GitHub refs were read on 2026-09-12 before this document was prepared:

| Ref | Verified tip |
| --- | --- |
| `pilot` | `07a91c2260440bb05bdff41fa26cee4bab67460f` |
| `pilot-working` | `07a91c2260440bb05bdff41fa26cee4bab67460f` |
| `Tab5` | `688f491cf9b24b328cd95383cc5c190a544d9745` |
| `tab5-working` | `6d4b54cc9806e34b01343caf69f1df86e540d486` |
| `agent/event-v3-checkpoint2-tab5-staging` | `a416034dae6ef622c73d8b1d88dc10bc8208587f` |
| `agent/event-v3-checkpoint2-delivery` | `54b75b7409a1cfc48a627ec16d179574937e771a` |

The current implementation was checked read-only. `tab5/pilot.py` builds a broad observation and wraps the complete envelope for durable storage. Its runtime logging-policy collector covers enabled Device and Calculated fields but not `systemFields`; detailed change/delta reasons are printed but not recorded; hard-coded material triggers remain. V3 transitions are printed and may cause a reviewed STOP request after the observation is built, but they are not queued as event records and do not force an observation. `tab5/cloud.py` provides an eight-record RAM FIFO with stable-ID retries, but currently rejects event records and loses queued records on restart. Pilot `ingest-record` transactionally deduplicates by `recordId`, stores observations under `observations`, and stores other durable/audit records under `eventRecords`. Its v1 validator does not accept current V3 transition objects. The older `ingest-power` detector writes unrelated pump-start/stop documents to `events`; that collection is not V3 event history.

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

The first evaluated cycle in a new session is selected even when UTC is unsynchronized or one or more selected fields are unavailable. Missing/recovered readings alone do not select a record. When an available reading returns, `change` or `delta` compares it with that field's last successfully queued durable **available** value; the unavailable observation never overwrites that baseline.

### Delta baseline

Advance per-field baselines only after CPU B accepts the complete same-cycle batch into its outbound queue. This preserves the useful current behavior without waiting for cloud ACK:

- advancing on selection can suppress later records when queue insertion fails;
- advancing only on cloud ACK can select every cycle during an outage and exhaust the queue;
- advancing on successful batch queueing makes upload retry reuse stable records while a queue-full rejection leaves the baseline unchanged for a later attempt.

Only available fields in the accepted observation advance their baselines. The maximum-interval clock advances at the same batch-acceptance point. If the queue is RAM-only, a restart after queue acceptance but before cloud ACK can lose the record while leaving no surviving baseline; the new session-start record limits the resulting observation gap but cannot recover a lost event transition. A bounded persistent outbox is therefore recommended if “durable before cloud ACK” must include ordinary CPU B restarts.

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

CPU A constructs the observation and every same-cycle event record with final IDs before queueing. CPU B accepts them as one batch or rejects the entire batch. CPU A advances baselines only after whole-batch acceptance and must retain an unqueued transition batch for retry rather than reevaluating an already changed event board as though no transition occurred.

After queue acceptance, members may upload independently and arrive out of order. Pilot accepts a close before its open and an event before its related observation. Each retry reuses byte-equivalent canonical content and the same ID. Pilot behavior remains:

- absent ID: create and return accepted;
- same ID and canonical content: return duplicate success;
- same ID and different content: reject with `idempotency_conflict`.

The browser/projection must show a temporarily missing linked observation as pending, not manufacture a snapshot. Stable IDs and late-link resolution handle partial upload failure. A queue implementation must never evict an event transition to make room for an observation.

## Restart reconciliation

Pilot maintains a small server-side session projection keyed by device. A `session-start` observation is the authoritative notice of a new session. When one is accepted, Pilot marks the previous session ended and finds occurrences from that session with an opening but no device close.

For each such occurrence, Pilot writes an idempotent synthetic `event-close` to `eventRecords`:

- `source` is `pilot-reconciler`, not `tab5`;
- `sessionId` remains the old occurrence-owning session;
- `recordId` is deterministic from occurrence ID and the detecting new session;
- `reason.kind` is `ended-by-restart`;
- `reconciliation.detectedBySessionId` and `relatedObservationId` point to the new session-start observation;
- `time.endTimeStatus` is `unknown`; `reconciledAt` is server time; no device `observedAt` or exact power-failure time is invented.

Late records are expected. On every late opening from a session already marked ended, Pilot reruns the same deterministic reconciliation. A late genuine device close is retained and takes precedence in the occurrence projection because it is direct old-session evidence; the synthetic reconciliation record remains immutable audit evidence but no longer supplies the displayed end disposition. This makes new-session ingestion, late old-session opens, retries, and out-of-order closes converge without restoring old ownership.

## Future browser contract context

The first view lists open occurrences before recently closed ones. Red and yellow follow configured severity; informational is blue. An event opens the durable timeline a few records before its boundary. Timeline navigation supports older/newer traversal and selected columns. Local display time is derived from an unambiguous stored instant; unsynchronized observations use receipt time only with a clear label. No browser, per-event display settings, or historical-definition service is part of this unit.

## Acceptance matrix for the later implementation

| Area | Acceptance condition | Primary later evidence |
| --- | --- | --- |
| Field catalog | Exactly every non-`none` Device, Calculated, and System field appears; no hard-coded compatibility field survives. | Producer unit fixture built from a synthetic runtime package. |
| Modes | `always` includes without triggering; `change` and `delta` trigger as defined; `none` does neither. | Producer selection tests. |
| Coalescing | Multiple change/delta and event-boundary causes create one observation with every reason. | Same-cycle fixture equality test. |
| Event linkage | Multiple event records have unique IDs and all reference the same observation; the observation lists all event IDs. | Producer and schema tests. |
| Unavailable | A selected unavailable field has a tagged reason and no stale/default value; unavailable/recovery alone does not select. | Gap/recovery producer tests, including battery failure. |
| Baseline | Queue rejection advances neither field baseline nor interval clock; whole-batch acceptance advances available fields only; cloud failure does not reselect. | Producer/transport failure-injection tests. |
| Start/time | First evaluated cycle records with or without UTC; IDs do not depend on UTC; elapsed logic passes tick-wrap cases. | Unsynchronized and wrap-boundary tests. |
| Periodic | A quiet session selects at 600000 ms with only a maximum-interval reason. | Fake-clock producer test. |
| Snapshot meaning | Boundary record is explicitly pre-dispatch; request/ACK is never reported as observed state. | Producer event/action ordering test. |
| Queue/retry | Same-cycle batch is all-or-none locally; event records are never evicted; retries preserve IDs/content. | CPU B queue, restart, and retry tests. |
| Ingestion | v1 remains accepted; valid v2 stores in existing `observations`/`eventRecords`; duplicate, conflict, and out-of-order behavior remain deterministic. | Pilot contract and handler tests. |
| Reconciliation | New session closes prior unmatched opens as unknown-time restart ends; late old records converge; a genuine late device close wins the projection. | Pilot reconciliation transaction tests. |
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
- `tests/contract-schemas.test.js`
- `tests/ingest-record.test.js`

No change belongs in `cloud/netlify/functions/ingest-power.js` or the older Firestore `events` collection. Browser files are deliberately absent from this list.

## Remaining owner decisions and order

One material durability choice remains: whether records accepted by CPU B must survive an ordinary CPU B restart before cloud ACK. Recommendation: yes, use a bounded persistent outbox and define its capacity/overflow alarm during the later transport unit. If RAM-only queueing is retained, document the pre-ACK loss window explicitly; the record contract itself does not hide it.

The active rules must also express source-availability fields consistently with the agreed policy: use `always` for inclusion when immediate missing/recovered selection is unwanted, and let separately qualified health-event boundaries force records. The owner should review that rules-policy change only when health-event input integration is a separately authorized unit.

After diagnostics owner acceptance, implement in this order: (1) approve and mirror v2 schemas; (2) add dynamic field selection, tagged unavailable values, stable IDs, reason coalescing, and occurrence retention in Tab5; (3) add all-or-none batch queueing and the chosen restart durability in CPU B; (4) add Pilot v2 validation, storage, and idempotent session reconciliation; (5) run host failure/ordering tests and owner-controlled ingest acceptance; (6) build the browser in a later unit.
