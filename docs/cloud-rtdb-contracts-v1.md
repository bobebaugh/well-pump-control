# M2 Cloud and RTDB contracts v1

## Scope and authority

This document defines contracts only. It does not add Netlify functions, Firebase writes, web listeners, device transport, deployment configuration, or Tab5 runtime behavior. CPU A remains the sole operational decision authority. CPU B transports complete observations, events, commands, and synchronization data without reevaluating rules or manipulating hardware.

The existing `ingest-power`, `current-power`, `monitor-session`, `firebase-status`, and `health` functions and the verified legacy power-telemetry contract remain unchanged.

## Contract catalog

| Contract | Canonical use | Persistence |
| --- | --- | --- |
| `current-observation-v1` | Latest complete CPU A observation for live display and freshness | Disposable RTDB overwrite |
| `durable-observation-v1` | CPU A-selected sparse observation | Firestore append |
| `event-record-v1` | CPU A event opening or closing | Firestore append |
| `device-command-v1` | Authorized request waiting for CPU A application | RTDB coordination until terminal |
| `device-sync-v1` | Startup/reconnect comparison and repair exchange | Request/response; latest device sync summary may be disposable RTDB state |
| `rules-release-metadata-v1` | Current published rules version and integrity pointer | RTDB current pointer |

`values`, `status`, `condition`, and the observation envelopes deliberately allow unknown future fields. Cloud transport must preserve them. Required envelope fields remain closed or explicitly versioned where expanding meaning could change coordination behavior.

## Proposed RTDB paths

All target data is rooted below a versioned namespace. `{siteId}` is `well-main` for the pilot and `{deviceId}` is the Tab5 application identity.

| Path | Writer | Reader | Meaning |
| --- | --- | --- | --- |
| `/v1/sites/{siteId}/devices/{deviceId}/currentObservation` | CPU B | Web/Home, cloud diagnostics | Complete disposable current observation; overwrite only |
| `/v1/sites/{siteId}/devices/{deviceId}/syncState` | CPU B | Web/System, `device-sync` | Last completed exchange ID, session, sequence high-water marks, and last-sync result |
| `/v1/sites/{siteId}/devices/{deviceId}/presence` | CPU B | Web/System, absence monitor | Session and server-resolved `lastSeenAtMs`; diagnostic only |
| `/v1/sites/{siteId}/devices/{deviceId}/commands/{commandId}` | `control-request`; CPU B updates terminal coordination state | addressed CPU B, web | Unique ordered command; never a direct relay instruction |
| `/v1/sites/{siteId}/commandSequence` | `control-request` transaction | `control-request` | Monotonic allocator for `commandSequence` |
| `/v1/sites/{siteId}/control/globalEnable` | `control-request`; CPU B reports applied state | CPU B, web | Desired and applied Global Enable coordination; CPU A applies priority locally |
| `/v1/sites/{siteId}/rules/current` | Rules publication service | CPU B, web | `rules-release-metadata-v1` current pointer |

The RTDB current observation and presence timestamps use Firebase `ServerValue.TIMESTAMP` on write and are read as integer epoch milliseconds. RTDB is not an event log. Terminal commands may be retained briefly for diagnosis, but Firestore event/audit records are authoritative.

## Proposed Firestore paths

| Path | Record |
| --- | --- |
| `sites/{siteId}/observations/{recordId}` | `durable-observation-v1` |
| `sites/{siteId}/eventRecords/{recordId}` | `event-record-v1` opening or closing |
| `sites/{siteId}/rulesReleases/{releaseId}` | Full immutable rules package, defined in M6 |

The existing pilot paths, including `sites/well-main/current/well-power`, stay in service until the replacement listeners and callers are proven. M2 does not create the proposed paths.

## Identifiers, sequencing, and idempotency

### Device session and sequence

CPU A creates a fresh opaque `sessionId` on each application start and increments one nonnegative `sequence` for every complete message it emits. The pair `(deviceId, sessionId, sequence)` is unique. Sequence ordering is valid only inside one session; timestamps are not used to infer missing commands or exactly-once delivery.

### Durable records

CPU A creates `recordId` before delivery. UTC `YYYYMMDDHHMMSS` is the prefix, followed by the record type, `sessionId`, and zero-padded ten-digit sequence. A retry reuses the identical `recordId` and payload. `ingest-record` creates the Firestore document at that ID transactionally:

- absent ID: validate and create;
- existing ID with identical canonical payload: return the original accepted result;
- existing ID with different payload: reject as `idempotency_conflict`.

`observedAt` is CPU A measurement/transition time. `receivedAt` is added by the cloud from Firebase server time and is excluded when comparing a retry with the stored canonical payload.

### Events

`eventId` identifies one event opening across its lifecycle. The open and close transitions have different `recordId` values and share the same `eventId`. A close record references any originating `commandId`. No close record means Firestore considers the opening active. Rules version/hash on each transition records the rules used at that boundary.

### Commands

`control-request` allocates a strictly increasing `commandSequence` transactionally and creates a globally unique `commandId`. CPU B delivers only commands above CPU A's `lastAppliedCommandSequence`, ordered by sequence. CPU A still deduplicates by `commandId`; it never treats RTDB delivery as permission to bypass local validation. Repeated, reordered, or stale commands are harmless.

The durable resulting event record is the authoritative acknowledgement. RTDB command status is coordination state for pending/cancelled/completed/rejected display, not a second operational authority.

### Synchronization

`exchangeId` makes a `device-sync` retry idempotent. The response echoes it and includes the command high-water mark, current rules pointer, canonical open event IDs, Global Enable, pending commands, and an authentication bootstrap. CPU B exchanges the short-lived Firebase custom token, retains ID and refresh tokens, refreshes when required, and uses the ID token with the returned RTDB URL. CPU A receives only noncredential synchronization content and decides reconciliation consequences.

## Endpoint migration map

No migration occurs in M2.

| Existing service | Target | Staged compatibility behavior |
| --- | --- | --- |
| `ingest-power` | `ingest-record` | Keep unchanged through M3/M4. Add the generic endpoint beside it; cut over only after equivalent current display and legacy telemetry are proven. Retire later. |
| `current-power` | Direct RTDB current listener | Keep unchanged while Home still reads the pilot Firestore current document. Switch the web only after RTDB current is populated and listener behavior is proven. |
| `monitor-session` | RTDB presence/current freshness | Keep unchanged until presence and monitoring workflows have replacements. Do not infer operational decisions from cloud freshness. |
| none | `device-sync` | Add for startup/reconnect reconciliation. It does not reevaluate rules or operate the relay. |
| none | `control-request` | Add as the authorized web mutation boundary. It validates authority and writes coordination commands; CPU A remains responsible for acceptance and consequences. |
| `firebase-status` | `firebase-status` | Keep unchanged. A future cosmetic rename is outside this migration. |
| `health` | `health` | Keep unchanged. |

Target rollout order is: define contracts (M2), implement CPU B RTDB transport (M3), add generic durable ingest (M4), then add rule/event/control behavior in later approved milestones. A feature-branch test result does not authorize deployment or caller migration.

## Compatibility invariants

- The optional M1 nested observation and all unknown observation fields remain preserved.
- The legacy flat Shelly EM payload remains accepted without the nested observation.
- The five established pilot functions keep their names and code during M2.
- The current Firestore pilot record and legacy web monitoring behavior are untouched.
- No file under `tab5/`, `firmware/tab5/`, or `C:\\Tab5\\pilot-micropython` changes in M2.
- Netlify and Firebase remain outside the immediate protective path.

## Settled authentication design — no M3 blocker

Netlify reuses the existing well-pump-netlify service account and existing Netlify-held service-account JSON/private key. It retains Cloud Datastore User only. No additional service account or permanent key will be created; Editor, Firebase Admin, and Realtime Database Admin are not granted.

After authenticating the existing device request, device-sync locally signs a short-lived Firebase custom token for the fixed identity tab5-well-main. Its response authenticationBootstrap contains the custom token, Firebase API key, project ID, RTDB URL, token-exchange URL, refresh URL, and expiry. CPU B exchanges it for Firebase ID and refresh tokens, refreshes when required, then writes RTDB directly. This documents the exchange only: M2 does not implement Netlify, Firebase Auth, RTDB, or CPU B work.

No service-account key or Firebase administrative credential is on Tab5. Committed examples use unmistakably fake values only. The actual private key remains only in Netlify environment variables.

Proposed RTDB rules grant only tab5-well-main write access to its currentObservation, presence, and syncState; and read access to its addressed commands, Global Enable coordination, and current rules-release metadata. They deny writes to commands, control requests, rules publication, other devices, and unrelated paths. RTDB Security Rules—not the service-account IAM role—enforce those limits. CPU A remains the sole operational decision authority.

No authentication, schema, or sequencing decision remains blocking M3.

## Deliberate branch separation

Cloud/Netlify development continues on a nondeploying feature branch descended from M2. Tab5 runtime development remains on Tab5. Do not merge, cherry-pick, or copy Tab5 runtime code into pilot or a cloud branch, and do not incorporate cloud commits into Tab5 history.
