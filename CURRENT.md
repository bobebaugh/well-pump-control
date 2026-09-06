# Current project status

**Checkpoint:** source review completed 2026-09-06. This is the only current status
record. It is rewritten as the project changes; Git history retains prior versions.

## Evidence reviewed

| Source | Verified point |
|---|---|
| `pilot` | `8e6207d765c9de4d0070f2630df00afa001de619` |
| `Tab5` | `39b0d81e1a0eb989677f78f1f7f29605fc1485a3` |
| V3 authority | `EVENT_V3_IMPLEMENTATION.md` at `78ca53aff0998d87656016964838acc6881821e2` |

This checkpoint is source-verified only. It did not rerun tests, inspect the
installed Tab5 image, query deployed Netlify/Firebase state, or perform hardware work.

## What works now

- `pilot` is the web/cloud line; `Tab5` is the MicroPython device line.
- V2 remains the working calculation, durable-observation selection, HMI, and
  existing protective-action path.
- V3 also runs in the device cycle: it evaluates direct mapped values, maintains
  event ownership and Monitor state, and can issue limited Shelly actions.
- V3 packages validate and stage to flash, but are not adopted live.

## What is incomplete now

- V3 does not yet have its complete atomic device-observation, calculation,
  Function, final-snapshot, occurrence, summary, event-record, or generic
  per-target action/retry path.
- Current code fabricates `IsLocked = 0` when Shelly responds; missing lock
  evidence must never be treated as unlocked.
- V2 and V3 operate in parallel. V2 cannot be retired until V3 has absorbed the
  generic calculation and logging work it still supplies.
- Current web/documentation status labels contain stale claims and must not be
  relied on outside this checkpoint.

## Rolling plan

**Now — documentation checkpoint:** review this proposed simple operating workflow:
`AGENTS.md`, this file, and `DESIGN.md`. No implementation is approved.

**Next — contract and product alignment:** after owner approval, align the V3/event
contract with accepted behavior and remove the owner-facing V2 rules editor. No
device-runtime or hardware change.

**Later — trustworthy V3 input/snapshot foundation:** build and host-test the
atomic observation, calculation, Function, and V3 logging-input path before retiring
any V2 calculation/logging behavior.

## Owner decisions needed

1. Approve, revise, or reject this simple three-document workflow and `DESIGN.md`.
2. Before a later Shelly-script unit, decide the sense-wire/capture behavior and
   the resulting `P009` classification.
3. Approve any merge, deployment, board adoption, or hardware action separately
   when it is actually proposed.

## Do not do yet

Do not merge this proposal, deploy, adopt a package, change wiring, flash/erase a
board, test connected equipment, remove V2 runtime behavior, or use Google Drive
documents as pilot-phase design authority.
