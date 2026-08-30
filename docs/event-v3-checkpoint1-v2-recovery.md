# Event V3 Checkpoint 1 — V2 recovery record

Checkpoint 1 is nondeploying package authoring work.  It creates isolated V3
Firestore draft and release records only; it does not update an RTDB pointer,
request Tab5 adoption, populate an upload mirror, or write to a device.

## Approved V2 recovery assets

| Asset | Verified recovery reference |
| --- | --- |
| V2 web application | `pilot` at `9683db11c7c5fcc12530622738808b71b6a3f615` |
| Tab5 V2 application | `Tab5` at `67553473745970372e9da11c27c7de496f7f79d5` |
| Candidate V3 contract (reference only) | `agent/event-v3-contract` at `78ca53aff0998d87656016964838acc6881821e2` |
| Candidate V3 runtime (reference only) | `agent/event-v3-runtime` at `554a64657e5e82bf221f724c99962887423c405d` |

The V2 Firestore recovery assets are the site-scoped collections
`rulesEngineDraft`, `rulesEngineReleases`, and `rulesEngineState/current`.
The deployed RTDB current-rule pointer remains
`v1/sites/well-main/rules/current`; Checkpoint 1 does not modify it.

V3 uses separate `rulesEngineV3Draft`, `rulesEngineV3Releases`, and
`rulesEngineV3State/current` records.  Those records are not a V2 recovery
replacement and do not imply delivery.

## Approval-gated recovery sequence

1. Stop at diagnosis and confirm the currently deployed web revision, Tab5
   revision, V2 Firestore state, and RTDB pointer. Do not assume an empty
   Firestore database is safe.
2. Obtain explicit approval for any production recovery action.
3. If web recovery is approved, use the verified `pilot` V2 revision above and
   verify its V2 Rules Engine loads the preserved V2 draft/release/current
   records.
4. If Tab5 recovery is separately approved, use the verified `Tab5` V2
   revision and follow the existing device-upload approval process. This is a
   distinct action from web recovery.
5. Change the RTDB pointer, upload mirror, or device only after an explicit,
   separately approved release/delivery plan and its verification steps.

No empty-database test and no rollback test were performed for Checkpoint 1.

## Implementation authority

`EVENT_V3_IMPLEMENTATION.md` remains authoritative at the referenced contract
candidate tip. It is intentionally not duplicated here: a copied document
would create a second authority on this clean checkpoint branch. Checkpoint 1
implements only the reviewed authoring/package subset and must be read with
that source authority and the checkpoint approval record.

## Checkpoint 2 contract routing

The accepted Checkpoint 1 package must not be passed through the older broad
candidate Tab5 prototype resolver at
`agent/event-v3-runtime` `554a64657e5e82bf221f724c99962887423c405d`.
That prototype requires the older root shape with `calculatedFields` and no
`lifecycle` or `systemFields`; the Checkpoint 1 runtime package emits
`calculations`, `lifecycle`, and `systemFields`. Its occurrence triggers also
expect `request` / `occurrence` rather than the accepted `occurrenceField`.

This is not a Checkpoint 1 runtime change. Checkpoint 2 must adopt and resolve
the accepted Checkpoint 1 contract explicitly, with its own validation and
tests, rather than blindly reusing the broad candidate resolver.
