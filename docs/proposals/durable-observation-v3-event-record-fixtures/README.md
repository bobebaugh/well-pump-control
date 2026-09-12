# Proposed v2 fixture notes

These files are synthetic review examples for `durable-observation-v2` and `event-record-v2`. They are **not implemented contracts**, are not loaded by the active schema suite, and are not expected to pass current `ingest-record` validation.

For compactness, the fictional running package used by the observation examples logs these fields: `PumpEnable`, `ContactorFlag`, `IsLocked`, `Shelly1Available`, `SupplyVoltage`, `ShellyEMAvailable`, `PressurePSI`, `WiFiConnected`, and `OperatingMode`. The examples therefore include all nine on every observation even when only one triggers. Fictional hash/release/session values do not identify a deployed package or real device run.

Files:

- `observation-multiple-reasons.json`: two field reasons and two event boundaries coalesced into one observation.
- `event-transitions-same-cycle.json`: two distinct transitions referencing that same observation.
- `observation-unavailable-field.json`: an event-selected observation with one selected field explicitly unavailable.
- `observation-periodic.json`: the ten-minute maximum interval with no field or event reason.
- `restart-session-reconciliation.json`: a registered old opening, a higher-epoch unsynchronized new-session observation, and a server reconciliation close with no invented end time.
- `delayed-session-start.json`: a delayed lower-epoch start and an unordered start arrive after the current session without superseding it or ending its events.
- `queue-saturation.json`: finite RAM limits, observation-first eviction, protected-batch rejection, and out-of-FIFO loss visibility.

The last two files describe queue/projection decisions as synthetic state transitions, not wire records. Server-owned session epochs, ordering status, tokens, queue metrics, and loss counters are deliberately outside immutable Tab5 record bodies.
