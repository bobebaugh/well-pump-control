# Current status — Tab5 line

**Verified operating/working base:** `Tab5` and `tab5-working` at
`cd61954d2538abcc996987aa7d2ecfec85dbbd8f` on 2026-09-11. This hash remains
the pre-promotion review base; the work below is committed only on the working
branch.

This review-correction unit starts from reviewed working commit
`d29c9c77864b6b4e14091db642febea45e7eba91` and preserves it as an ancestor.

Tab5 is the interpreted MicroPython device application under `tab5/`. Its upload
set remains separate from the Pilot web/cloud application. This unit is host-tested
source work only: no package was delivered or uploaded, no device was restarted,
and no connected equipment was operated.

## Now

V3 is the sole event evaluator and device-write owner in the normal application
loop. V2 observation, HMI, transport, and durable-record support needed by the
current application remains, but V2 event evaluation and STOP dispatch have been
removed from the repeating loop. An unavailable V3 runtime does not fall back to
V2 execution.

The integrated V3 cycle atomically accepts complete records for Tab5/ADC, Shelly
EM, and Shelly 1; evaluates supported package calculations; freezes one snapshot;
then advances the V3 kernel. Missing, malformed, failed, or wrong-type device
fields make that whole device record unavailable. Shelly 1 evidence comes from
two sequential RPC responses: `Shelly.GetStatus` plus dynamically discovered
`IsLocked` and `loCntr` number components. These are one acquisition cycle, not a
simultaneous hardware snapshot.

Downloads validate and atomically replace only the next-restart staged file. The
running package and its kernel/ownership/calculation state remain unchanged until
restart. Schema-valid candidates must also resolve against the implemented drivers,
bindings, calculations, and event subset before they can replace that file, so an
unsupported candidate leaves the last usable staged bytes intact. Startup adopts
the last valid staged package with fresh state. Pointer
schema 4 and device-state schema 2 distinguish actual V3 runtime intent, running
identity, and staged identity without changing the meanings of the older schemas.

Relay dispatch now distinguishes a recognized successful Shelly acknowledgement
from RPC and transport failures. The next cycle always compares the requested
state with fresh observed relay state: an acknowledgement alone does not suppress
a retry, and an active inhibit owner reasserts OFF if the relay is observed ON.
Re-enable still requires available, valid, exactly-zero lock evidence.

All operational numeric inputs and calculation results must be finite. Raw ADC
diagnostics remain observable, but pressure-derived calculations require both a
commissioned sensor and valid ADC evidence. Invalid pressure evidence clears that
calculation's history so recovery must establish fresh history before flow can be
valid.

Host evidence: `python -m unittest discover -s tests` passes 140 tests,
including mocked integrated acquisition/cycle/startup boundaries and the existing
V3 semantic replay suite. `python -m py_compile tab5/pilot.py tab5/cloud.py`
passes. No live Shelly response has been captured.

## Next

Owner design review, followed by a separately authorized bench acceptance that
verifies the supplied Shelly RPC mappings and restart-only package adoption on the
test installation.

## Later

Integrate real occurrence/command inputs, retained event-record production and
browser handling, and V3 summary accumulation. Write and separately accept the
production Shelly protection script. Continue retiring obsolete V2 transport and
source only after their remaining observation/coordination uses are replaced.

## Boundaries

Do not promote this branch to `Tab5`, deliver or upload a runtime package,
flash/erase/restart a board, or test connected equipment without separate owner
approval.
