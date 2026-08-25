# M6.10 installed Shelly 1 telemetry candidate

The installed Gen-1 Shelly 1 is temporarily at `192.168.50.201`. Its relay output RLY0 is not connected to the pump circuit during commissioning. SW0 is expected to be ON while the well pump is running and OFF while it is stopped.

CPU A reads the local `/status` resource once per sample cycle and strictly extracts only `inputs[0].input` and `relays[0].ison`. It adds `shelly1_sw0`, `shelly1_rly0`, availability, age, and failure count to the existing complete observation. SW0, RLY0, and confirmed availability changes are material durable-observation changes. CPU B remains a byte-preserving transport and requires no new credential or endpoint.

The existing pilot ingest already stores the complete observation in the current Firestore document. The `current-power` read function now exposes a small `shelly1` view containing `available`, `sw0`, and `rly0`; older firmware returns nulls and remains compatible.

The monitoring page shows SW0 and RLY0 in the status strip and reports Shelly 1 health. With fresh telemetry, it flags SW0 when it disagrees with the EM-derived pump-running state. The page is status-only: it does not issue relay commands. RLY0 is explicitly labeled not wired.

This branch does not deploy the cloud candidate and does not change the running Tab5. A physical test requires uploading the reviewed Tab5 files, deploying the matching cloud candidate, and observing stopped/running transitions.
