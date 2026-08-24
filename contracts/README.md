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

Every schema has one or more valid examples under `examples/v1/`. Unknown observation fields are deliberately preserved. See `docs/cloud-rtdb-contracts-v1.md` for paths, identifiers, idempotency, and the staged endpoint migration.
