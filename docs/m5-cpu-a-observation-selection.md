# M5 CPU A observation selection candidate

## Scope

This Tab5 candidate implements M5 only. CPU A still builds one complete matched observation each second. It now selects a sparse subset for durable Firestore ingestion when a configured material field changes or when the default maximum ten-minute interval expires. Insignificant samples remain in RAM and continue through the existing disposable RTDB and legacy Netlify paths.

CPU A remains the sole materiality authority. CPU B accepts a complete selected record into a bounded eight-record RAM FIFO and retries that exact record against the M4 `ingest-record` endpoint. Legacy Netlify retains first service priority, and CPU B yields to RTDB after each accepted durable record so the FIFO cannot starve M3 coordination. CPU B does not recalculate materiality, alter fields, evaluate rules, infer events, or apply pump consequences.

## Selection contract

- CPU A constructs one matched observation per one-second loop. When Shelly polling is unavailable, its current Shelly values are `null`, availability is false, and last-valid timing remains explicit; the last valid sample continues to drive the HMI and legacy Netlify path.
- A bounded 600-sample RAM ring retains the current event-working window independently of the last durable selection. It is not persisted and performs no M6/M7 rule or event evaluation.
- The first observation with a valid synchronized UTC timestamp is selected as `material-change`.
- Numeric thresholds are parameterized by observation field path. The pre-M6 defaults are 50 W active power, 2 V line voltage, 25,000 microvolts ADC input, 0.1 V battery voltage, 0.1 A battery current, and 1 percent battery level.
- Validity, availability, charging, charge-enable, and clock-synchronization state changes are exact material changes.
- If no material change occurs, the next observation is selected at 600,000 ms.
- Future fields are preserved in any selected record but do not silently become materiality inputs. A later reviewed parameter package must opt them in.
- Selection state advances only after CPU B accepts the record into its bounded queue. A full queue therefore causes CPU A to retry selection on a later one-second observation without blocking.

Each selected observation uses the M4 durable-observation v1 envelope and deterministic identifier `YYYYMMDDhhmmss-observation-{sessionId}-{sequence}`. The temporary all-zero rules hash remains an unmistakable pre-M6 bridge; M6 owns real rules adoption.

## Compatibility and verification boundary

The existing `submit_observation` coalescing path, legacy `ingest-power` behavior, RTDB current observation, device synchronization, command transport, HMI, sensors, battery policy, and all operational authority remain unchanged. M5 adds no event lifecycle, rule evaluation, pump start, stop, inhibit, relay, or hardware behavior.

Host tests prove threshold boundaries, maximum interval, RAM-only insignificant samples, deterministic IDs, future-field preservation, bounded FIFO behavior, exact retry payloads, and successful duplicate acceptance. Physical acceptance still requires the owner to install the reviewed `pilot.py` and `cloud.py` and observe normal startup, current telemetry, one initial durable selection, and no one-second durable-write flood.
