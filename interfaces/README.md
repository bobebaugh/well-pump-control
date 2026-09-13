# Pilot–Tab5 interfaces

This directory is the small, mirrored interface record between the two current applications:

- **Pilot** owns the web, Netlify functions, Firebase/Firestore authoring, and publication of runtime package bytes.
- **Tab5** owns local device observation, package validation/adoption, event execution, and outbound records.

The same files must be byte-for-byte identical in pilot-working and tab5-working. They describe data exchanged between the applications; they do not add a third runtime and do not change either application's behavior.

| Record | Direction and use | Current state |
|---|---|---|
| runtime-package-v3.schema.json | Pilot → Tab5: immutable Event V3 runtime package downloaded and validated before restart staging. | A valid staged file becomes running only at process startup with fresh event, owner, and calculation state. |
| release-pointer-v3.schema.json | Pilot → Tab5: retired staging-only pointer. | Preserved unchanged for version history; it declares execution disabled and is not accepted by the current consumer. |
| release-pointer-v4.schema.json | Pilot → Tab5: current RTDB pointer identifying exact Event V3 bytes, hash, length, download path, and execution intent. | Downloads stage the next restart package; they never replace the running kernel. |
| rules-v3-device-state-v2.schema.json | Tab5 → Pilot: actual running, desired, and staged identities plus execution state. | `running` is distinct from the package staged for the next restart. |
| current-observation-v1.schema.json | Tab5 → Pilot: disposable current RTDB observation. | Existing interface. |
| durable-observation-v1.schema.json | Tab5 → Pilot: selected immutable observation retained in Firestore. | Existing interface. |
| event-record-v1.schema.json | Tab5 → Pilot: immutable event-open or event-close record retained in Firestore. | Existing interface. |
| durable-observation-v2.schema.json | Tab5 → Pilot: one rules-driven, fixed-field-set observation with explicit unavailability and coalesced trigger reasons. | Current V3 producer format; v1 ingestion remains supported during rollout. |
| current-event-board-v1.schema.json | Tab5 → Pilot: complete sparse active-event board. Pilot adds receipt/revision/count fields only in its RTDB projection. | Current best-effort synchronization format. |
| event-record-v2.schema.json | Pilot reconciliation → Firestore: deterministic open and uncertain inferred-close history derived from accepted boards. | Current V3 event history format; it never claims an exact inferred close time. |
| operator-command-v1.schema.json | Pilot → Tab5: retired pre-transport operator request. | Preserved for version history. Its required empty payload object is removed by RTDB and is not accepted by the current consumer. |
| operator-command-v2.schema.json | Pilot → Tab5: one short-lived, identity- and session-targeted operator request with a non-empty no-arguments payload marker. | The RTDB location is a replaceable slot, not a durable queue. The marker survives an RTDB write/read round trip; Tab5 enforces the 45-second expiry, exact session, and monotonic sequence boundary before execution. |
| operator-command-result-v1.schema.json | Tab5 → Pilot: device evidence for the current operator request. | Separates not delivered, accepted, confirmed completed, failed, and unknown outcomes; relay restoration is reported independently. |

## Change rule

A cross-application record changes only in a bounded interface work unit. Update both mirrored directories, the producing and consuming code, relevant examples/tests, and the version when compatibility is broken. Never silently change the meaning of an existing versioned record.

The historical device-command interface remains obsolete. These narrowly scoped operator records replace it for User Monitor and the two restart actions; they do not revive event close, override, or global-enable commands.
