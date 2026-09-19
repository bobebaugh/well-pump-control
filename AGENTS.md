# Beta maintenance instructions

## Read only what the task needs

Start with CURRENT.md and BETA.md. Read DESIGN.md for behavior changes and
interfaces/ for cross-application work. FUTURE.md preserves ideas, not authority to
implement them. Do not reconstruct milestone history or revive archived proposals.
The owner's current instructions take precedence.

This beta is past major surgery. Architecture rewrites, file-wide reformatting,
re-platforming and new control authority are out of scope. A proposal to start
one, including from the owner, gets this reminder and a smaller alternative
before any work begins. Cleanup never ends; that is not a reason to start.

Verify against the deployed artifact, never a seed or a stored fixture.
rules-engine-defaults.js seeds a fresh draft; tests/fixtures/ holds dated
snapshots. The authoritative package is the saved Firestore draft and the
authoritative device files are the installed ones.

## Small fixes with minimum overhead

- Use pilot-working for web/cloud and tab5-working for device/Shelly work. Retain
  only these, pilot, Tab5 and main as normal remote branches; use tags for archives.
- Fetch and verify advertised remote tips, inspect status, and preserve existing
  work. One writer per checkout. Do not reset or clean someone else's checkout.
- A requested fix authorizes investigation, the smallest sensible repair, relevant
  tests, a concise commit and publication to its working branch. No separate design
  unit, new branch, approval of implementation details, or mandatory PR is needed.
- A working branch can contain accepted work awaiting promotion. Do not discard
  it or require it to equal an older operating branch before a new small fix.
- Check the affected behavior, then stop testing once the relevant checks pass.
  Docs-only changes need link/content checks, not a hardware or emulator campaign.
- Keep CURRENT short: accepted behavior, installed evidence, next owner decision.
  Put deferred ideas in FUTURE rather than creating new handoff documents.

## Release and physical boundaries

Promotion to pilot, Tab5 or main requires owner direction unless already included
in the active request. A push can deploy a web branch. A source promotion does not
install device files, publish runtime packages, apply Firebase rules/indexes, or
change DNS. Do not do those actions without authorization for that activity.
Do not automatically restart devices after source changes. When the owner is away,
finish authorized reversible work and record remaining decisions in CURRENT.

## Preserve the operating contract

- Never create ordinary pump demand or weaken mechanical, hardwired or Shelly-local
  protection. Cloud services never provide immediate protection.
- Tab5 writes its own inhibition flag; the Shelly script alone owns RLY0. A timeout,
  RPC acknowledgement or unavailable measurement is not physical success/recovery.
- Preserve units, source, validity, observation time and staleness. No fabricated
  values, lock state, event close time or execution confirmation.
- Keep interfaces byte-identical on both working branches. If their meaning changes,
  update the relevant producer, consumer, schema/examples and checks together.
- Keep secrets out of Git, logs, URLs and reports. The beta password is checked by
  server functions. Pilot and Main share live data: a test write is a real write.
- Under tab5/, also read tab5/AGENTS.md. Preserve every tracked runtime/support file;
  stamp only files actually changed. UIFlow MicroPython is the supported platform.

## Git recovery

Prefer normal fast-forward pushes; recheck remote tips before publishing. Never
force over concurrent work. Keep rollback source and runtime package compatibility
separate. Archived tips live under archive/beta-2026-09-16/ tags; restore a tag to a
temporary detached checkout for inspection rather than reviving obsolete branches.
