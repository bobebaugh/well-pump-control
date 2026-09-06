# Repository operating rules

## Start here

Read only these active records before starting work:

1. `CURRENT.md` — verified current status, the rolling plan, and stop boundaries.
2. `DESIGN.md` — owner-approved operating behavior.
3. This file — durable safety and working rules.

Do **not** read project history, old work plans, historical platform documents, or
superseded V3 material unless the current task specifically requires it. If
`CURRENT.md` points to an evidence source, read only that source.

## Current source lines

- `pilot`: cloud/web source — Netlify functions, Firebase paths, web HMI,
  contracts, and JavaScript tests.
- `Tab5`: current device source — MicroPython/UIFlow2 under `tab5/`.
- `firmware/tab5/` and its ESP-IDF workflow are historical evidence, not the
  current Tab5 application.

## Safety

- Preserve mechanical and hardwired protection; never weaken it.
- Tab5 must never manufacture ordinary pump demand or gain pump-start authority.
- Cloud services and network connectivity must never be in an immediate
  protection path.
- Never fabricate unavailable sensor, lock, or control state.
- Preserve units, validity, observation time, source, and staleness semantics.
- Never expose or commit secrets, credentials, tokens, private keys, Wi-Fi
  information, or production configuration.

## Working model

- One owner and one primary agent work at a time. A primary agent may use one
  bounded sub-agent only for evidence gathering or review.
- Work one bounded unit at a time. `CURRENT.md` may name only **Now**, **Next**,
  and **Later**; those are not approval for work beyond Now.
- Treat design as evolving with evidence. Do not silently turn a proposal into an
  approved design decision.
- Keep reports owner-readable: behavior, safety effect, evidence, limits, and the
  next decision—not implementation detail unless needed for review.
- Preserve unrelated work. Never delete branches, commits, patches, worktrees, or
  recovery material without explicit approval.

## Approval boundaries

Separate explicit owner approval is required for each merge, deployment, package
adoption on a board, hardware action, wiring change, flash/erase, or test involving
connected equipment. A review, plan, or accepted commit authorizes none of those by
itself.
