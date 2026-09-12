# Next unit — operating-mode inputs (discussion brief)

## Starting point

Verify live pilot/pilot-working and Tab5/tab5-working refs. Read both Project
Contexts and relevant interfaces; read tab5/AGENTS.md. Pilot CURRENT.md records
the accepted editor tests and closeout awaiting promotion. Tab5 M6.33 remains at
6d4b54cc9806e34b01343caf69f1df86e540d486 on tab5-working, ahead of operating Tab5.
Resolve operating alignment with the owner before coding; preserve accepted work.
Do not reconstruct history, read Google Drive or repeat completed editor review.

## Proposed single functional batch

Connect web operator Monitor/Normal and Clear Events requests to the existing V3
kernel. Express mode ownership and required-source health policy in JSON rules as
far as possible, using existing availability fields/occurrences. Assess what already
works before adding anything. Avoid hard-coded event IDs or a parallel evaluator.
Keep generic request handling, acquisition and relay/lock mechanics in Tab5.

Before implementation, present the smallest complete design and decide:

1. How generic requests reference declared occurrence fields, acknowledge processing,
   reject stale/duplicate/replayed requests, and communicate actual mode vs requested mode.
2. How operator Normal closes only the operator Monitor owner, without clearing
   required-source owners; whether existing closing policies express this already.
3. Whether health events can use existing Boolean acquisition availability directly
   instead of adding redundant internal occurrences. Define startup and recovery
   qualification explicitly; do not silently change S020/S010 meanings.
4. How Clear Events applies only to JSON closing policies and reports completion.

## Acceptance criteria for the eventual implementation

- Operator Monitor opens its JSON owner; operator Normal closes that owner alone.
- Multiple Monitor owners compose correctly. A bad-source owner keeps Monitor
  active after operator Normal; final-owner closure returns Normal.
- Monitor continues polling, calculations, logging, event evaluation and ownership
  bookkeeping. Relay behavior honors current Shelly lock evidence and all existing
  mechanical/Shelly protections; no ordinary pump demand is created.
- Duplicate requests do not produce repeated unintended actions; interrupted/offline
  paths remain bounded and distinguish pending requests from confirmed processing.
- Clear Events closes only eligible JSON events. Reboot/package adoption starts
  an empty event board and never restores past open-event ownership.
- Host tests cover owner combinations, unavailable evidence, replay and restart;
  one short owner bench cycle verifies the integrated path after authorized deployment.
- Update producer/consumer, both mirrored interfaces if exchanged records change,
  online validation as needed, and the incremental user guide together.

## Separate later batch — script health

Issue #5: resolve the configured script by name (currently AntiFastCycle), expose
running health and decide re-enable gating. Do not assume script ID 2 or treat
retained virtual values as proof a script is executing. Script-health semantics,
final protection-script implementation and its tests are not part of mode inputs.

## Exclusions

No general Shelly command catalog, additive import, retention system, event history
browser/summary execution, power/USB charging work, or unrelated logging cleanup.
Mode design approval does not authorize deployment, Firebase changes, package
transfer, board installation or hardware operation. Stop for owner discussion of
the concrete mode design before implementation; keep it one coherent batch.
