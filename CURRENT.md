# Current status — Tab5 line

**Verified operating base:** `Tab5` at `39b0d81e1a0eb989677f78f1f7f29605fc1485a3` on 2026-09-06.

Tab5 is the interpreted MicroPython device application under `tab5/`. Its current
upload set is small and separate from the Pilot web/cloud application. This
checkpoint is source-reviewed only; it did not inspect the installed device image,
run host tests, upload a package, or touch connected equipment.

## Now

Review the new Project Context and mirrored `interfaces/` seed on
`tab5-working`. No device runtime behavior has changed.

## Next

Reconcile `tab5/pilot.py` and its current V3 work with the shared interface
definitions before selecting a bounded implementation unit.

## Later

Build and host-test the next trustworthy V3 input/snapshot path before retiring
working V2 behavior.

## Boundaries

Do not promote this branch to `Tab5`, upload/adopt a package, flash/erase a board,
or test connected equipment without a separately approved work unit.
