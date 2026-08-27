# Rules Engine Builder Pilot

## Purpose

The Rules Engine Builder is an isolated authoring pilot for sophisticated users. It tests whether device observations, stateless formulas, one specialized tank function, event lifecycles and summaries, device consequences, logging thresholds, and web notification policy can be managed as one understandable package.

It does not deliver a package to RTDB or change Tab5 behavior. All seeded events are disabled.

## Authoring model

The page has three independently saved draft sections:

1. **Devices** define a driver, address, named direct observations, on-change logging policy, and any writable device command. Other sections reference only the system name. A device-specific name such as `SW(0)` remains inside the device mapping.
2. **Calculated Fields** are either stateless arithmetic expressions or the programmed Boyle-law function. Expressions use named numeric fields, constants, `+`, `-`, `*`, `/`, and parentheses. The web validates references and dependency order and compiles a bounded arithmetic program while retaining the readable expression.
3. **Events** define opening qualification, normal inverse-opening or custom closing qualification, independent observation counts and warm-up/cool-off time, normal or latched lifecycle, standard summaries, active device consequences, and web-owned notification policy.

Field selectors group names as **Direct Observations** and **Calculated Values**.

Each direct or calculated field owns its logging mode and, for numeric fields, its change threshold. Every field compares with the corresponding value in the last snapshot accepted into the bounded delivery queue. When any policy requests a durable observation, at most one record is queued for that observation and it contains every named field plus standard observation time and package version. Queue acceptance immediately advances the comparison baseline; Tab5 does not wait for Firestore acknowledgement or attempt historical reconciliation. A historical extract forms the union of names used in its requested time range and emits null where an older record predates a name.

## Event and action semantics

An event consequence such as `PumpEnable = false` is active while the event is active. The `PumpEnable` device field owns the exact Shelly mapping:

```text
Switch.Set(id=0, on=<event value>)
```

The field also defines `true` as its normal value. When no active event requires another value, the consequence arbiter returns the field to that normal value.

- A normal event ordinarily clears when its complete opening expression is no longer true for the configured consecutive observations and cool-off time.
- A custom closing expression remains available for hysteresis and special reset conditions.
- A latched event requires a user clear request and a qualified closing condition.
- Persistent System Override suppresses Tab5 consequences while event evaluation and logging continue.
- Shelly-local locking remains independent of Tab5 and System Override.

These are runtime lifecycle rules, not editable expressions.

Observation counts are consecutive. Warm-up and cool-off time are continuous. When both count and time are configured, both must qualify; a false or missing condition value resets qualification and missing telemetry can never clear an event by itself. Clauses in one `ALL` or `ANY` group are evaluated against the same observation.

Every accepted event opening and closing queues a complete observation. An event may also declare standard closing-summary outputs: duration, opening value, closing value, closing-minus-opening delta, average, minimum, and maximum. Pump Running uses these operations for runtime, average watts, Shelly cumulative-energy delta, and starting/ending pressure. Summary output does not require an event-specific function.

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

Each draft section has its own optimistic `draftRevision`. If a draft document is absent or belongs to an older pilot schema, the server seeds that section from the current built-in defaults.

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
- Only implemented drivers, the Boyle-law function, arithmetic operators, event comparisons, and standard summary operations.
- Syntactically valid bounded expressions with resolvable, acyclic calculated-field dependencies and compatible numeric inputs.
- Valid event clause values, observation counts, and minimum durations.
- Actions that target writable direct fields with complete device command mappings and type-compatible values.
- Required notification messages when web notification is selected.

## Reset and removal

Deleting the three `rulesEngineDraft` documents causes the defaults to be seeded again on the next load. A pilot schema increment also replaces older draft documents with the new defaults. Releases are not automatically deleted. Removing the navigation link and the isolated Rules Engine files removes the pilot without changing the existing rules editor, RTDB contracts, or Tab5 runtime.
