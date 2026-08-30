# Repository guidance

## Event V3 sessions

- Read `EVENT_V3_IMPLEMENTATION.md` completely before event, Rules Engine, Monitor, latch, Clear Events, restart, or event-record work.
- For those subjects it is the temporary implementation authority and supersedes older repository plans and architecture prose until accepted V3 behavior is documented from the implementation.
- Web and contract V3 work belongs on `agent/event-v3-contract`, based exactly on the live `pilot` SHA recorded there. Do not use `agent/event-command-reconciliation` as the implementation base.
- Keep V2 deployed behavior intact while developing and testing an explicit V3 contract. Do not deploy, move the RTDB rules pointer, merge, or promote without explicit owner approval.

## Safety and authority

- The deployed pilot remains limited to its already reviewed behavior. V3 control design authorizes host-only contract and test work on its named nondeploying branch, not deployment or new hardware authority.
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
