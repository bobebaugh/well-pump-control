# Cross-component contracts

This directory defines data exchanged among the Tab5 firmware, Netlify functions, Firestore, and the web HMI.

The legacy source and telemetry contracts preserve the locally observed Gen-1 Shelly EM response without inventing a measured-current field.

The M2 v1 contracts define the target cloud/RTDB boundary without implementing or deploying it:

- `current-observation-v1.schema.json` — disposable RTDB current state;
- `durable-observation-v1.schema.json` — sparse Firestore observation;
- `event-record-v1.schema.json` — Firestore event opening or closing;
- `device-command-v1.schema.json` — RTDB command coordination;
- `device-sync-v1.schema.json` — `device-sync` request and response;
- `rules-release-metadata-v1.schema.json` — RTDB current rules pointer.
- `rules-runtime-release-metadata-v2.schema.json` — RTDB desired immutable Rules Engine runtime package. This supersedes the legacy v1 rules package pointer for new Tab5 releases.
- `rules-runtime-package-v3.schema.json` — nondeploying Event V3 package. It is deliberately a new package kind and requires a V3 adopter; V2 bytes must be rejected rather than interpreted as V3. Its immutable body includes `releaseId` and `packageVersion`; RTDB pointer, storage, publication, and delivery envelopes remain outside this Unit 1 contract. The deterministic host fixture is `examples/v3/rules-runtime-package.json`.

Every schema has one or more valid examples under `examples/v1/`. Unknown observation fields are deliberately preserved. See `docs/cloud-rtdb-contracts-v1.md` for paths, identifiers, idempotency, and the staged endpoint migration.

For durable observations and event transitions, `receivedAt` is cloud-owned. An
ingest request may omit it; Firestore stores a server Timestamp, and JSON
serialization represents that value as the schema's ISO date-time string.
