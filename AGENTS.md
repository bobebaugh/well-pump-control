# Project Context — agent instructions

## Start here

A cold agent reads only this Project Context before work:

1. `AGENTS.md` — these durable rules.
2. `CURRENT.md` — verified current status and the rolling **Now / Next / Later** plan.
3. `DESIGN.md` — current operating design.
4. `interfaces/` — only when the task crosses the Pilot–Tab5 boundary.

Do not reconstruct project history or read old plans, historical ESP-IDF material,
unpromoted agent branches, or Google Drive design records unless the active task
specifically requires a named source.

## Working branches

- `pilot` and `Tab5` are the operating branches.
- `pilot-working` and `tab5-working` are the reusable development branches.
- One owner and one active agent work at a time. A bounded review/evidence
  sub-agent may assist but does not modify the working branch.
- Ordinary scoped commits and related bug fixes on the active working branch are
  permitted when the owner authorizes that work unit.
- Nothing may be merged, fast-forwarded, or otherwise promoted into `pilot` or
  `Tab5` without explicit owner approval.
- Before beginning a new work unit, the corresponding working branch must be
  clean and match its operating branch.

## Safety and evidence

- Preserve mechanical, hardwired, and Shelly-local protection. Tab5 never creates
  ordinary pump demand.
- Cloud services are never an immediate protection path.
- Never fabricate unavailable values, lock state, validity, source, time, or
  staleness.
- Keep interface definitions versioned. A cross-application record change updates
  both mirrored `interfaces/` directories and the relevant producer, consumer,
  examples, and tests.
- Never expose or commit secrets, tokens, private keys, Wi-Fi credentials, or
  production configuration.
- A deployment, board package adoption, flash/erase, wiring change, or connected
  equipment test needs explicit owner direction for that activity.

## Reporting

Report the intended behavior, test evidence, any changed operational configuration,
known limits, and the next owner decision in plain language. Do not replace a
missing fact with a historical narrative.
