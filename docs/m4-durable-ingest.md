# M4 durable observation and event ingest candidate

## Scope

This nondeploying candidate adds `ingest-record` beside the verified pilot functions. It accepts CPU A-authored durable observations and event open/close transitions transported by CPU B. It does not select observations, evaluate rules, infer events, apply commands, change Tab5 runtime files, or operate hardware.

## Endpoint

`POST /.netlify/functions/ingest-record` uses the established `X-Pilot-Key` device authentication and permits only `siteId=well-main` and `deviceId=tab5-well-main`. It accepts schema version 1 records from the established durable-observation and event-record contracts, with a 64 KiB body limit and bounded nesting.

The cloud preserves the complete valid record, including unknown future fields. `receivedAt` is the one authoritative exception: it may be omitted from the JSON request; if supplied it must be a valid contract date-time but does not participate in idempotency. The endpoint stores a Firebase server timestamp instead. Contract timestamps use RFC3339 with zero to three fractional-second digits, matching the millisecond device and Firestore boundary. The versioned schemas describe receipt time's JSON serialization as an ISO date-time; Firestore stores it natively as a Timestamp. `observedAt` remains CPU A's timestamp and is normalized to UTC when stored and compared on retry.

## Firestore paths and retry behavior

- observations: `sites/well-main/observations/{recordId}`
- event transitions: `sites/well-main/eventRecords/{recordId}`

The endpoint uses a transaction and `recordId` as the Firestore document ID. A first valid request creates the document and returns HTTP 201. An identical retry, ignoring only cloud-owned `receivedAt`, returns HTTP 200 without another write. A different payload under the same ID returns HTTP 409 `idempotency_conflict`.

Event openings and closings are distinct immutable records sharing one `eventId`. M4 does not reject a close merely because its open record has not arrived yet; independent retries can reorder transport. Later lifecycle and restart milestones consume the durable transitions without turning the cloud into an operational decision authority.

The documented `(deviceId, sessionId, sequence)` uniqueness remains a CPU A contract invariant. M4 reconstructs each record identifier from its timestamp, type, session, and sequence, but does not add a cross-collection sequence ledger or canonical open-event state. Those would turn this bounded append endpoint into lifecycle coordination assigned to later milestones.

## Compatibility and verification boundary

`ingest-power`, `current-power`, `monitor-session`, `firebase-status`, `health`, the current Firestore pilot document, and the deployed RTDB transport remain unchanged. CPU A remains the sole operational decision authority.

Host tests cover validation, fixed identity, unknown-field preservation, authoritative receipt time, Firestore paths, separate event transitions, duplicate retry acceptance, and conflict rejection. A nondeploying branch cannot prove the production Firestore write or a browser listener receiving the new document without refresh. Those require an authorized branch deployment and a controlled test record; no Tab5 upload is required for that M4 cloud acceptance test.
