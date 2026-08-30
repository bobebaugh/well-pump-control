# Repository guidance

> **READ FIRST — `00-CURRENT-STATE-READ-FIRST.md` at the repository root.**
> Current verified branch SHAs, active decisions and their rationale, open and
> blocking items, the owner's work sequence, and which older records are superseded.
> Read it before this file's references and before starting any work unit.
> It is a state record, not a design authority.

## Branch and scope

- `main` and `pilot` are Netlify deployment branches. They are off limits during Tab5 work: do not commit, push, merge, rebase, or otherwise update either branch unless the user explicitly opens that scope.
- All interpreted Tab5 development belongs on the `Tab5` branch.
- `Tab5/tab5/` is the complete, version-managed recovery source for the interpreted device upload set. A promotion must preserve every tracked upload file, not only files changed by the work unit. Verify the live GitHub tree after promotion; the owner's PC copy is a backup, not the primary release record.
- The existing `agent/tab5-*` branches, `firmware/tab5/`, compiled build machinery, and `docs/tab5-platform-runbook.md` are historical evidence, not the current Tab5 development path. Do not build, flash, repair, or extend them. Do not delete that history unless separately requested.
- Preserve the established web, Netlify, and Firestore implementation while working on Tab5. A Tab5 task does not authorize web redesign or deployment.

## Sources of truth

- Treat the deployed web/Netlify/Firestore implementation and the corresponding GitHub source as established evidence.
- The authoritative design records are in the Google Drive Well Pump folder:
  https://drive.google.com/drive/folders/1JWa7dOhqgtryOppsqgWP4Qqe26e_1MHv
- Read `PROJECT_WORKFLOW.md` there first, then the records it identifies as relevant. Do not maintain a fixed list of design files here; that collection will continue to grow.
- For current Tab5 behavior, prefer hardware-verified interpreted source and current test results over older summaries, compiled branches, build receipts, or historical plans.
- Keep these states distinct in reports: remote GitHub state, committed Tab5 state, uncommitted or staging files, generated configuration, and results physically verified by the owner.

## Safety and authority

- The current pilot is observational unless an explicitly reviewed work unit grants specific control authority.
- Never add pump start, stop, inhibit, relay, or control behavior merely because a design document discusses it.
- Tab5 must never manufacture ordinary pump demand.
- Netlify, Firestore, and RTDB must never be placed in an immediate protective path.
- Do not weaken existing hardwired or Shelly-local protection.
- A persistent forgotten pump inhibit is the principal software hazard. Any future inhibit must have a reviewed release path and fail-allow behavior.

## Data contracts

- Update versioned files under `contracts/` before changing exchanged field meaning.
- Preserve units, validity, observation time, source, and staleness semantics.
- Do not label a derived value as directly measured.
- Treat unavailable future sensors and controls as unavailable; never fabricate values for the HMI.

## Security

- Never commit credentials, passwords, tokens, private keys, Wi-Fi information, or production secret values.
- Public examples must contain placeholders only.
- Keep device secrets in the uncommitted device secrets file described by the Tab5 provisioning instructions. Never print or quote real values in logs, reviews, or conversation.

## Repository sessions

- Verify the live GitHub branch before editing; cached `origin/*` refs and obsolete checkouts are not authoritative.
- Prefer the connected GitHub repository directly. If local Git tooling is necessary, use a task-owned temporary clone, work only on `Tab5`, push the completed commits, and remove the temporary clone afterward.
- Do not turn `C:\Tab5\pilot-micropython` into a Git repository. It is a device-deployment staging directory and is populated only when the user says a revision is ready for hardware installation.
- Preserve unrelated and user-owned files. Never clean or modify the obsolete repositories under `C:\Tab5`.
- Route work under `tab5/` to `tab5/AGENTS.md`.
