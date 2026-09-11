# Current status — Tab5 line

**Verified aligned base before this unit:** `Tab5` and `tab5-working` at
`688f491cf9b24b328cd95383cc5c190a544d9745` (M6.32). The owner authorized
fast-forwarding `Tab5` from `cd61954d2538abcc996987aa7d2ecfec85dbbd8f`
before beginning this work. `pilot` and `pilot-working` both remain at
`2f02f158bd5c73ff946f208ab7d1549d6d44c6fc`. M6.33 is working-branch work
for separate owner bench acceptance; no new operating promotion is included.

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

M6.32 owner logs additionally confirm S010 opening for sticky and positive locks
with relay ON, and closing on zero lock with relay ON without control assignments.
Diagnostics separated transport timeouts, RPC errors and missing named components.
The owner stopped/rebooted/renamed the test script during fault testing. Minimal
utility polling reduced communication failures but does not prove their cause.
Two source defects were verified: rejected device records removed availability
from the event snapshot, and raw lock changes bypassed configured delta logging.

## Now

M6.33 corrects those two defects. For enabled devices declaring `$availability`,
the V3 event/calculation snapshot contains the actual acquisition result as a
Boolean even when the complete device measurement record is rejected. All device
measurements remain absent on rejection. A false availability flag cannot allow
retained values to qualify as a complete current record. This also applies to
Shelly EM; it does not integrate the deferred internal-occurrence path.

Raw `shelly1_lock` and `shelly1_lockout_count` no longer independently trigger a
durable record on every change. Named package logging policies govern those
values; confirmed availability, other existing triggers and maximum-interval
records continue independently. Delta is measured against the previous selected
durable observation, which can also have been selected by another field. Local
M6.32 diagnostic print lines remain independent of durable logging thresholds.
No package/interface schema, online compiler, polling, event qualification,
relay-dispatch or restart-adoption change was required.


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

Host evidence: `python -m unittest discover -s tests` passes 149 tests,
including mocked integrated acquisition/cycle/startup boundaries and the existing
V3 semantic replay suite. `python -m py_compile tab5/pilot.py tab5/cloud.py`
passes. No live Shelly response has been captured.

## Next

Owner installs M6.33 pilot.py from tab5-working and tests S020 failure/recovery
qualification and IsLocked delta logging with the existing V3 package. No upload,
restart, deployment or hardware operation was performed by the agent.

## Later

Deferred issue #5: monitor AntiFastCycle script running status by configured name
when online changes are next scheduled. Stable retained zero values do not prove
script execution. The current runtime does not check this.

Integrate real occurrence/command inputs, retained event-record production and
browser handling, and V3 summary accumulation. Write and separately accept the
production Shelly protection script. Continue retiring obsolete V2 transport and
source only after their remaining observation/coordination uses are replaced.

## Boundaries

Do not promote this branch to `Tab5`, deliver or upload a runtime package,
flash/erase/restart a board, or test connected equipment without separate owner
approval.
