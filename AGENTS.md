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
  clean and match its operating branch. Read-only reviews and documentation
  closeout of an accepted unit do not require discarding unpromoted work. Resolve
  alignment with the owner before the next coding unit.

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

## Cloud workflow and handoffs

- GitHub is the durable source of truth; the owner may switch Windows computers.
  Work directly on the reusable working branches; avoid routine per-task branches
  and Windows bundle transfers. Verify remote refs and a clean checkout first.
- GitHub plugin authorization and shell Git authentication are separate. Verify
  the intended write route before implementation. If shell push is unavailable,
  use authenticated GitHub blob/tree/commit/ref tools when available. Never ask
  the owner to expand permissions merely because shell credentials are absent.
- Connector-created commits may have different metadata/hashes from local commits.
  Preserve the intended parent, verify every uploaded blob and the full tested
  tree, then fast-forward without force. Recheck the advertised tip and align the
  local checkout only after verifying its files are identical. Report the canonical
  remote commit, not an abandoned local commit identity.
- Owner approval is still required for operating promotion. Record the prior tip
  for rollback; prefer a revert preserving history. Source rollback does not roll
  back runtime packages, Firebase rules or installed Tab5 files automatically.
- Keep CURRENT.md current after host/owner acceptance. Distinguish source facts,
  host fixtures, owner logs and unverified hardware behavior. A focused review or
  handoff file may carry the next unit; do not grow a competing historical roadmap.
- Use one active coding agent for a bounded approved unit. A design session reviews
  first and discusses requirements; do not interpret a design review as coding
  authorization. Ordinary implementation choices within an approved unit do not
  require repeated permission requests.
