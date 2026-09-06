# Current status — Pilot line

**Verified operating base:** `pilot` at `8e6207d765c9de4d0070f2630df00afa001de619` on 2026-09-06.

Pilot is the browser/cloud application: web files, Netlify functions, Firebase/
Firestore-facing services, package authoring, and retained records. This checkpoint
is source-reviewed only; it did not rerun tests or inspect deployed services.

## Now

Review the new Project Context and mirrored `interfaces/` seed on
`pilot-working`. No runtime behavior has changed.

## Next

Decide the narrow cleanup unit: retain useful contracts/tests, remove the obsolete
ESP-IDF `firmware/` tree from the Pilot line, and avoid moving history into a new
archive directory.

## Later

Reconcile the current V3 package/pointer and record interfaces with the implemented
Pilot and Tab5 behavior before making a new execution change.

## Boundaries

Do not promote this branch to `pilot`, deploy, change Firebase rules, or change
runtime code without a separately approved work unit.
