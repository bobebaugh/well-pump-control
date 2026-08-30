# Repository guidance

## Event V3 sessions

- Read `EVENT_V3_IMPLEMENTATION.md` completely before event, Rules Engine, Monitor, latch, Clear Events, restart, or event-record work.
- For those subjects it is the temporary implementation authority and supersedes older repository and Drive guidance until accepted V3 behavior is documented from the implementation.
- Interpreted V3 semantic work belongs on `agent/event-v3-runtime`, based exactly on the live `Tab5` SHA recorded there.
- Host-only implementation and tests do not authorize copying files to the owner's upload mirror, device upload, relay operation, merge, promotion, or hardware work.

## Branch and scope

- `main` and `pilot` are Netlify deployment branches. They are off limits during Tab5 work: do not commit, push, merge, rebase, or otherwise update either branch unless the user explicitly opens that scope.
- Interpreted Tab5 development normally belongs on `Tab5` or an owner-approved nonpromoted feature branch based exactly on it. Current V3 work belongs on `agent/event-v3-runtime`.
- `Tab5/tab5/` is the complete, version-managed recovery source for the interpreted device upload set. A promotion must preserve every tracked upload file, not only files changed by the work unit. Verify the live GitHub tree after promotion; the owner's PC copy is a backup, not the primary release record.
- The existing `agent/tab5-*` branches, `firmware/tab5/`, compiled build machinery, and `docs/tab5-platform-runbook.md` are historical evidence, not the current Tab5 development path. Do not build, flash, repair, or extend them. Do not delete that history unless separately requested.
- Preserve the established web, Netlify, and Firestore implementation while working on Tab5. A Tab5 task does not authorize web redesign or deployment.

## Sources of truth

- Treat the deployed web/Netlify/Firestore implementation and the corresponding GitHub source as established evidence.
- The authoritative design records are in the Google Drive Well Pump folder:
  https://drive.google.com/drive/folders/1JWa7dOhqgtryOppsqgWP4Qqe26e_1MHv
- For Event V3, read the branch-local `EVENT_V3_IMPLEMENTATION.md` first; it carries the verified repository status and points to the matching Drive authority. Consult `PROJECT_WORKFLOW.md` for broader process only when the active unit requires it.
- For current Tab5 behavior, prefer hardware-verified interpreted source and current test results over older summaries, compiled branches, build receipts, or historical plans.
- Keep these states distinct in reports: remote GitHub state, committed Tab5 state, uncommitted or staging files, generated configuration, and results physically verified by the owner.

## Safety and authority

- The deployed pilot retains only its already reviewed STOP-only authority. V3 host work selects consequences but grants no new physical authority until a separately approved acceptance unit.
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
- Prefer the connected GitHub repository directly. If local Git tooling is necessary, use a task-owned temporary clone, work only on the branch named by the approved unit, push completed commits only when authorized, and remove the temporary clone afterward.
- Do not turn `C:\Tab5\pilot-micropython` into a Git repository. It is a device-deployment staging directory and is populated only when the user says a revision is ready for hardware installation.
- Preserve unrelated and user-owned files. Never clean or modify the obsolete repositories under `C:\Tab5`.
- Route work under `tab5/` to `tab5/AGENTS.md`.
