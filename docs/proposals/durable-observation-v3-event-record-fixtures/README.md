# Proposed v2 fixture notes

These files are synthetic review examples for `durable-observation-v2` and `event-record-v2`. They are **not implemented contracts**, are not loaded by the active schema suite, and are not expected to pass current `ingest-record` validation.

For compactness, the fictional running package used by the observation examples logs these fields: `PumpEnable`, `ContactorFlag`, `IsLocked`, `Shelly1Available`, `SupplyVoltage`, `ShellyEMAvailable`, `PressurePSI`, `WiFiConnected`, and `OperatingMode`. The examples therefore include all nine on every observation even when only one triggers. Fictional hash/release/session values do not identify a deployed package or real device run.

Files:

- `observation-multiple-reasons.json`: two field reasons and two event boundaries coalesced into one observation.
- `event-transitions-same-cycle.json`: two distinct transitions referencing that same observation.
- `observation-unavailable-field.json`: an event-selected observation with one selected field explicitly unavailable.
- `observation-periodic.json`: the ten-minute maximum interval with no field or event reason.
- `restart-session-reconciliation.json`: an old opening, an unsynchronized new-session observation, and a server reconciliation close with no invented end time.
