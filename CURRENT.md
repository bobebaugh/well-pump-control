# Current status — Tab5 line

**Verified advertised refs for this follow-up:** `Tab5` remains at
`cd61954d2538abcc996987aa7d2ecfec85dbbd8f`; `tab5-working` starts clean at
`5984591e0dfad338d23ca3cc975e2e26c7d1c0be`. The owner authorized this diagnostic
follow-up on the working version already installed and bench-tested. No operating
branch promotion is part of this unit.

## Owner bench evidence — 2026-09-11

Owner-supplied M6.31 logs show V3 event opening, relay OFF acknowledgement and
subsequent OFF observation, inhibit reassertion after owner manual ON operations,
normal event closing and automatic ON acknowledgement/observation, and durable
observation acceptance. V7 staged while V6 ran and became running only after the
owner restarted Tab5. With IsLocked=-1, events closed without re-enable. A later
manual test change to zero selected ON but timed out; the owner reports manually
turning the relay ON afterward. That timeout/recovery case is unresolved, not a
confirmed event-logic defect. The production Shelly protection script is still
unwritten; -1 is intended to remain sticky until restart.

The owner reports frequent unavailable/recovered readings while the Windows test
utility polls, substantially reduced when it is closed. Occasional dropouts remain;
request contention is a hypothesis, not a proven cause. These are bench observations
on an unloaded relay, not proof of installed well-system behavior.

## Now

M6.32 adds local print diagnostics only: request name, elapsed time, transport/JSON/
RPC or specific field-validation reason, failure count and recovery. Outages print
on the first and every thirtieth failed request. Relay evidence prints on changes,
including releasePending, current availability, relay state, lock value and selected
actions. Dispatch lines include cycle sequence and elapsed time. No additional
requests, retry policy, event/lock behavior, package schema or cloud record changes
are introduced. Raw responses, URLs and arbitrary read exception text are not logged.


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

Host evidence: `python -m unittest discover -s tests` passes 145 tests,
including mocked integrated acquisition/cycle/startup boundaries and the existing
V3 semantic replay suite. `python -m py_compile tab5/pilot.py tab5/cloud.py`
passes. No live Shelly response has been captured.

## Next

Review the M6.32 diagnostic follow-up, then owner installation and a short bench
run to identify read failures and observe timeout recovery. No upload, restart,
deployment or hardware operation was performed by the agent.

## Later

Integrate real occurrence/command inputs, retained event-record production and
browser handling, and V3 summary accumulation. Write and separately accept the
production Shelly protection script. Continue retiring obsolete V2 transport and
source only after their remaining observation/coordination uses are replaced.

## Boundaries

Do not promote this branch to `Tab5`, deliver or upload a runtime package,
flash/erase/restart a board, or test connected equipment without separate owner
approval.
