# M6 rules-release service candidate

This nondeploying pilot-branch candidate completes the cloud half of M6 without changing legacy telemetry or web behavior.

- `/.netlify/functions/rules-release/20260825000000-rules-v1.json` is a device-authenticated, immutable release download. It returns the exact reviewed UTF-8 package bytes, bounded to 64 KiB. The expected SHA-256 is `ee0220eebdd0fa9b3b9751435180c17a16d3c93cb5f7325f1ab74d8d132e410a`.
- `cloud/netlify/rules-releases/current.json` is the reviewed metadata value for RTDB `v1/sites/well-main/rules/current`. A later authorized publication must validate this schema/package pair and write that exact JSON pointer; this candidate deliberately does not grant a browser or unauthenticated caller the ability to publish rules.
- `ingest-record` accepts `rule-adoption` and `rule-rejection` audit records in addition to M4 observations and event-open/event-close records. They are stored under `sites/well-main/eventRecords` with deterministic IDs and idempotent retry behavior. They do not create an operational event lifecycle or pump consequence.
- `contracts/rules-package-v1.schema.json` and its full release example are the shared web/Tab5 validation contract. Both implementations also enforce the ordered 59-rule workbook completeness list noted in the schema extension.

No cloud deployment is authorized by this branch. Before a physical M6 test, review and deploy this cloud candidate to `pilot`, then set the RTDB current pointer exactly to `cloud/netlify/rules-releases/current.json` through the approved publication path. The Tab5 candidate remains safe offline with its packaged baseline if that pointer is absent or invalid.
