# Current status — Pilot line

**Verified operating/working base:** `pilot` and `pilot-working` at
`4bbfff0872e108231e6759bf7791ead883e69685` on 2026-09-11. This hash remains
the pre-promotion review base; the work below is committed only on the working
branch.

This review-correction unit starts from reviewed working commit
`13f4bfee552892fde8d6f66813271363708bcbb2` and preserves it as an ancestor.

Pilot is the browser/cloud application: web files, Netlify functions, Firebase/
Firestore-facing services, package authoring, and retained records. This unit is
host-tested source work only. It did not inspect or change deployed services,
publish/deliver a package, or alter live Firebase configuration.

## Now

V3 publication now produces schema-4 runtime pointers with
`executionEnabled: true`; the old schema-3 execution-disabled staging pointer
retains its old meaning. Publication state uses schema 4 and the device reports
actual running/staged state with schema 2. The delivery endpoint, store, browser
copy, contract validators, checked-in RTDB rules source, and tests agree that a
delivered V3 package is executable but is adopted by Tab5 only on restart.

Delivery now validates both the stored publication state and the prospective
delivered state before publishing the RTDB pointer or writing state. An existing
schema-3 publication state is rejected with an explicit instruction to publish
again; it is not reinterpreted, and immutable release bytes remain unchanged.

Host evidence: `npm test` passes all 112 tests. `npm run test:rtdb-rules` could
not start because this environment's required network approval was cancelled
before a decision was returned. No Firebase rules were deployed.

## Next

Owner design review, then run the RTDB emulator suite and perform separately
authorized bench acceptance of pointer download, staging, and restart adoption.

## Later

Add retained event-record and browser support after Tab5 occurrence/command and
summary integration is designed. Obsolete firmware-tree removal and broad UI
cleanup remain separate work units.

## Boundaries

Do not promote this branch to `pilot`, deploy, change Firebase rules, or change
runtime code without a separately approved work unit.
