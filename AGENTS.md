# Repository guidance

## Safety and authority

- The current pilot is observational only.
- Never add pump start, stop, inhibit, relay, or control authority unless the requested phase explicitly includes a reviewed control change.
- Tab5 must never manufacture ordinary pump demand.
- Netlify and Firestore must never be placed in an immediate protective path.
- Do not weaken existing hardwired protection.

## Data contracts

- Update versioned files under `contracts/` before changing exchanged field meaning.
- Preserve units, validity, observation time, source, and staleness semantics.
- Do not label a derived value as directly measured.
- Treat unavailable future sensors and controls as unavailable; never fabricate values for the HMI.

## Security

- Never commit secrets, credentials, tokens, private keys, Wi-Fi information, or production configuration values.
- Tab5 sends authenticated HTTPS requests to Netlify and never holds Firestore administrative credentials.

## Repository sessions

- At session start, run `git fetch origin --prune`, then query the actual advertised branch with `git ls-remote`; a cached `origin/*` ref is not authoritative.
- When a task specifies a starting SHA, verify that exact SHA before editing. Stop rather than silently changing branches, bases, dependencies, or toolchains.
- Preserve unrelated and user-owned changes. Never display, stage, or commit secrets.
- Never delete branches, commits, patches, or worktrees unless explicitly authorized. Do not run simultaneous modifying agents in the same local checkout.
- Route Tab5 firmware work to `firmware/tab5/AGENTS.md` and `docs/tab5-platform-runbook.md`.
