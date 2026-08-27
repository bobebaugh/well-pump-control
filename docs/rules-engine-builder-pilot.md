# Rules Engine Builder Pilot

## Purpose

The Rules Engine Builder is an isolated authoring pilot for sophisticated users. It tests whether device observations, programmed calculations, event lifecycles, device consequences, logging ranges, and web notification policy can be managed as one understandable package.

It does not deliver a package to RTDB or change Tab5 behavior. All seeded events are disabled.

## Authoring model

The page has three independently saved draft sections:

1. **Devices** define a driver, address, named direct observations, on-change logging policy, and any writable device command. Other sections reference only the system name. A device-specific name such as `SW(0)` remains inside the device mapping.
2. **Calculated Fields** select a function already implemented in the Tab5 function catalog. The author supplies named inputs, function parameters, named outputs, and output logging policy. Free-form arithmetic is not supported.
3. **Events** define independent opening and closing conditions, `ALL`/`ANY` clause combination, observation count, minimum elapsed time, normal or latched lifecycle, optional supported functions on open/close, active device consequences, and web-owned notification policy.

Field selectors group names as **Direct Observations** and **Calculated Values**.

Each named field owns its logging mode and, for numeric fields, its change threshold. When any field's policy requests a durable observation, the record contains every named field in the active package plus standard observation time and package version. A historical extract forms the union of names used in its requested time range and emits null where an older record predates a name.

## Event and action semantics

An event consequence such as `PumpEnable = false` is active while the event is active. The `PumpEnable` device field owns the exact Shelly mapping:

```text
Switch.Set(id=0, on=<event value>)
```

The field also defines `true` as its normal value. When no active event requires another value, the consequence arbiter returns the field to that normal value.

- A normal event clears after its closing condition qualifies.
- A latched event requires a user clear request and a qualified closing condition.
- Persistent System Override suppresses Tab5 consequences while event evaluation and logging continue.
- Shelly-local locking remains independent of Tab5 and System Override.

These are runtime lifecycle rules, not editable expressions.

Observation counts are consecutive. Minimum time is continuous. When both are configured, both must qualify; a false or missing condition value resets qualification and can never clear an event by itself. Clauses in one `ALL` or `ANY` group are evaluated against the same observation.

## Boyle-law calculation

`boyle_tank` is a programmed function, not an event expression. Its definition selects a pressure field and supplies effective tank size, precharge, local atmospheric pressure, regression window, and minimum sample count. It emits named water-volume, pressure-slope, flow, demand, and quality fields. The function implementation is responsible for timestamped multi-observation regression and quality rejection.

## Firestore layout and versioning

The server uses the following documents below `sites/well-main`:

```text
rulesEngineDraft/devices
rulesEngineDraft/calculatedFields
rulesEngineDraft/events
rulesEngineReleases/{releaseId}
rulesEngineState/current
```

Each draft section has its own optimistic `draftRevision`. If any draft document is absent, the server seeds that section from the built-in defaults.

Publishing creates one version for the complete validated package. It does not version or deliver the sections independently. The Firestore transaction checks the current package version and all three draft revisions, creates an immutable release, and advances `rulesEngineState/current`. A concurrent edit or publication causes a conflict instead of a mixed release.

Each release contains:

- The complete authoring package, including web notification policy.
- The compiled, ordered runtime package with web-only fields removed.
- A canonical JSON body and SHA-256 content hash.
- `deliveryEnabled: false`.

The runtime body is rejected if it exceeds the current 65,536-byte Tab5 pilot limit.

## Validation boundary

Publication requires all of the following:

- Unique device, calculation, event, and field identities.
- Only implemented drivers, functions, operators, and lifecycle functions.
- Resolvable, acyclic calculated-field dependencies and compatible input/output types.
- Valid event clause values, observation counts, and minimum durations.
- Actions that target writable direct fields with complete device command mappings and type-compatible values.
- Required notification messages when web notification is selected.

## Reset and removal

Deleting the three `rulesEngineDraft` documents causes the defaults to be seeded again on the next load. Releases are not automatically deleted. Removing the navigation link and the isolated Rules Engine files removes the pilot without changing the existing rules editor, RTDB contracts, or Tab5 runtime.
