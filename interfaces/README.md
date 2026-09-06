# Pilot–Tab5 interfaces

This directory is the small, mirrored interface record between the two current
applications:

- **Pilot** owns the web, Netlify functions, Firebase/Firestore authoring, and
  publication of runtime package bytes.
- **Tab5** owns local device observation, package validation/adoption, event
  execution, and outbound records.

The same files must be byte-for-byte identical in `pilot-working` and
`tab5-working`. They describe data exchanged between the applications; they do
not add a third runtime and do not change either application's behavior.

| Record | Direction and use | Current state |
|---|---|---|
| `runtime-package-v3.schema.json` | Pilot → Tab5: immutable Event V3 runtime package downloaded by Tab5 and validated before staging/adoption. | V3 staging interface; execution remains disabled. |
| `release-pointer-v3.schema.json` | Pilot → Tab5: RTDB pointer identifying exact package bytes, hash, length, and download path. | V3 staging interface; execution remains disabled. |
| `current-observation-v1.schema.json` | Tab5 → Pilot: disposable current RTDB observation. | Existing interface. |
| `durable-observation-v1.schema.json` | Tab5 → Pilot: selected immutable observation retained in Firestore. | Existing interface. |
| `event-record-v1.schema.json` | Tab5 → Pilot: immutable event-open or event-close record retained in Firestore. | Existing interface. |

## Change rule

A cross-application record changes only in a bounded interface work unit. Update
both mirrored directories, the producing and consuming code, relevant examples/tests,
and the version when compatibility is broken. Never silently change the meaning of an
existing versioned record.

This directory intentionally does **not** define the old device-command interface:
its listed commands include superseded control concepts and it must be reconciled
before becoming a current shared record.
