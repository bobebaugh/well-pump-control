# Well Pump Event V3 Implementation Authority

**Status date:** August 30, 2026

**Status:** Owner-approved temporary implementation authority

**Repository:** `bobebaugh/well-pump-control`

**Drive authority:** `well-pump-event-actions-modes-and-recovery-design.md`

This record governs the next event-engine coding and testing sessions. It supersedes older proposals for event actions, ordinary inhibit arbitration, Monitor/Normal mode, latching, Clear Events, restarts, and event-queue recovery. Preserve it until V3 is stable and the owner replaces the broader design with documentation derived from the accepted implementation.

Do not reopen settled design questions during implementation unless code or test evidence shows that the approved model cannot work. Do not merge, deploy, promote, populate a device-upload mirror, or touch hardware without explicit owner approval.

## 1. Current repository state

Live remote identities verified August 30, 2026:

| Line | Branch | Verified SHA | Meaning |
|---|---|---|---|
| Web and contracts | `pilot` | `9683db11c7c5fcc12530622738808b71b6a3f615` | Deployed Rules Engine V2 web/package baseline |
| Interpreted Tab5 | `Tab5` | `67553473745970372e9da11c27c7de496f7f79d5` | Current M6.27 STOP-only runtime baseline |
| Unpromoted event work | `agent/event-command-reconciliation` | `3f2248f44b726e6db28dba5d92aae944cdebb712` | Partial web command/event projection; untested and not a V3 base |
| V3 web work | `agent/event-v3-contract` | starts at `pilot` SHA above | Nondeploying V3 contract/editor work line |
| V3 Tab5 work | `agent/event-v3-runtime` | starts at `Tab5` SHA above | Nondeploying V3 semantic runtime work line |

The repository deliberately has two current product lines. `pilot` contains the web, Netlify, contracts, and JavaScript tests. `Tab5` contains the complete interpreted MicroPython upload tree and Python host tests while omitting the web tree. Do not merge the two histories merely to make one working branch.

### Verified behavior

The completed Rules Engine V2 vertical flow has been exercised end to end:

1. Define device instances and fields online.
2. Define calculated fields and approved functions.
3. Define event rules and consequences.
4. Publish one immutable runtime package.
5. Deliver it through RTDB.
6. Download, validate, persist, and adopt it on Tab5.
7. Use rules-defined deltas to select complete durable observation records.
8. Open a High Voltage event and issue the reviewed Shelly 1 STOP consequence.

The test changed Shelly `RLY(0)` from ON to OFF. The relay was not connected to the pump control circuit, so the software/device path was exercised but an actual pump inhibit was not.

Tab5 host baseline: 105 of 105 tests pass with `python3 -m unittest discover -s tests -p 'test_*.py'`.

Web baseline in the current clean review environment: 59 of 61 Node test entries pass. `tests/device-sync.test.js` and `tests/ingest-record.test.js` fail to load because this environment lacks `firebase-admin`; this is a dependency/environment limitation, not observed assertion failure. Run the complete suite in a checkout with the committed dependencies installed before accepting web work.

### Present but unverified work

`agent/event-command-reconciliation` is two commits ahead of `pilot`. It contains early web control-request plumbing and Firestore event-instance projection. It does not implement the approved V3 package or Tab5 executor, uses superseded command concepts, and lacks complete session reconciliation and hardware evidence. Treat it as reference material to reconcile later, not as a branch to continue now.

## 2. Settled architecture boundary

- Tab5 is a generic device facilitator and rules executor.
- Device adapters know protocols, parse complete device records, and issue supported typed writes.
- Rules packages define device instances, direct fields, calculations, logging deltas, events, conditions, lifecycle, and actions.
- Adding another instance of a supported device family, such as a Shelly 1, should require definitions rather than well-specific Tab5 code.
- Adding a new protocol family, such as Modbus, requires a generic adapter.
- Tab5 and web HMI layouts remain hard coded. Buttons may trigger named events or explicit maintenance commands, but V3 does not generate screens from rules.
- Netlify, RTDB, Firestore, and cloud availability are never in the immediate protective path.
- Tab5 never manufactures ordinary pump demand.

The one-second semantic cycle is:

1. Poll configured devices without blocking the semantic evaluator indefinitely.
2. Accept or discard each complete device record atomically.
3. Freeze one observation snapshot.
4. Populate direct fields and calculate derived fields.
5. Select durable observations using field-defined change thresholds.
6. Evaluate event opening and closing qualification.
7. Update event ownership and choose transition actions from the frozen snapshot.
8. Dispatch selected device writes outside the semantic decision path.
9. Queue durable observations and event records for CPU B.

## 3. Atomic device observations

A device poll is an atomic record:

- If transport, JSON, or any required field is malformed, discard the entire record as a missed poll.
- Never retain some fields from a malformed record.
- Never convert missing, invalid, or stale input into zero, false, unlocked, or another fabricated value.
- The prior good record remains historical state but is not a new observation.
- Qualification counters requiring that device do not advance on a dropped poll.
- Dropped polls do not open or close dependent events.
- A writable action requiring current target state is not resolved from stale or partial target data.

For an enable write to Shelly 1, Tab5 requires a complete current Shelly record and `IsLocked=0`. A dropped Shelly poll results in no enable write for that cycle. Pump Disable remains allowed.

## 4. V3 event lifecycle

V2 opening conditions, AND/OR condition groups, consecutive observation qualification, and minimum-time qualification are established plumbing. V3 extends lifecycle and consequences without redesigning opening evaluation.

Each event definition has:

- an opening trigger: condition, manual event request, or approved internal occurrence;
- an opening qualification;
- a closing policy: condition, Clear Events, or immediate;
- a closing qualification where applicable;
- an `onOpen` phase; and
- an `onClose` phase.

Missing evidence freezes applicable qualification. It never supplies a good observation for clearing.

### Action language

The only initial action primitive is a typed assignment to an approved writable field:

```text
Set <writable field> to <typed value>
```

Each phase may contain:

- zero or more unconditional assignments; and
- zero or more guarded assignment groups.

When a transition qualifies, the engine freezes one field snapshot, evaluates all guards against that snapshot, accepts the transition, and executes qualifying actions in defined order. An earlier action cannot change the guard result for a later action.

V3 excludes arbitrary scripts, variables, loops, delays, nested condition branches, transactions, rollback, and direct event-to-event actions.

## 5. Active-event ownership replaces per-cause flags

The event board is the control ledger. An open event may own its opening assignment until that event closes. Internally, ownership is a set keyed by event-instance identity rather than a user-defined Boolean or raw counter.

Conceptually:

```text
Pump-disable owners = {event instance A, event instance B}
Monitor owners      = {resource event, operator event}
```

Opening adds exactly one owner. Closing removes exactly that owner. Repeated evaluation cannot double-add or double-remove it.

For held assignments to the same target, release occurs only when the final applicable owner closes. This intentionally supersedes the earlier accepted `first to clear wins` limitation. The effective initial rule is now `any active inhibit wins` without per-cause flags or compound flag-clearing logic.

Ownership is generic and target-specific. It is not a special global pump flag. The V3 validator must reject unsupported or ambiguous combinations, including incompatible simultaneously held values for the same initial target contract.

## 6. Three operating classes

Most events are ordinary informational or duration events and have no control assignment. Pump-control and mode behavior reduce to a default transient class plus two special classes.

### 6.1 Transient inhibit

- `onOpen` requests `PumpEnable=false` in Normal mode and owns that assignment while open.
- The opening condition continuing true resets recovery qualification.
- Valid recovery observations advance the configured close counter.
- Dropped polls freeze the counter.
- Closing releases that event's ownership.
- Pump Enable becomes eligible only when no other applicable pump-disable owner remains and Shelly protection is clear.

`Clear_sec: 30` in the operational workbook means 30 valid recovery observations at the present one-second cadence, not merely 30 elapsed wall-clock seconds.

### 6.2 Latched inhibit

- Opening owns `PumpEnable=false` as above.
- Ordinary recovery evidence may be displayed but does not auto-close the event.
- Clear Events closes eligible Tab5-latched events and releases their ownership.
- A Tab5 restart also clears the complete Tab5 board by design.
- Flash persistence of Tab5 latches is explicitly deferred unless operating evidence later justifies it.

Initial mapping of old recovery-policy rows:

- `E002 Pump running underload` becomes latched for initial V3 commissioning.
- `T004 Pressure high` becomes an ordinary transient inhibit using its valid recovery observations.
- Shared automatic-retry budgets and a special retry class are deferred.

### 6.3 Monitor

An event may own Monitor mode while it is open. Effective mode is Monitor while at least one Monitor owner exists.

- Required-source health events may be assigned Monitor behavior independently; no combined per-cause flags are needed.
- An operator Monitor event is opened by the hard-coded Monitor control.
- A Normal request closes the operator Monitor event but cannot release another event's Monitor ownership.
- Cloud unavailability alone does not require Monitor.
- Observation, calculations, event evaluation, event records, and logging continue in Monitor.
- Tab5 pump-disable assignments continue to open, close, and retain ownership, but Tab5 does not apply them to the relay while Monitor is effective.
- When the final Monitor event closes, Normal resumes and currently active pump-disable ownership is applied.
- Entering Monitor may release a Tab5-applied inhibit only after a complete current Shelly record positively shows `IsLocked=0`.
- Monitor never clears or overrides Shelly-local protection.

## 7. Shelly 1 authority and reconciliation

Shelly 1 local protection is above Tab5:

| `IsLocked` | Meaning | Tab5 enable behavior |
|---:|---|---|
| `<0` | Shelly-local latch | Never enable |
| `0` | No Shelly inhibit | Enable may be eligible |
| `>0` | Remaining timed hold seconds | Never enable while positive |

- Tab5 may request Pump Disable at any time.
- Tab5 never writes `PumpEnable=true` without a complete current Shelly record showing `IsLocked=0`.
- Clear Events cannot clear Shelly protection.
- Restarting Tab5 cannot clear Shelly protection.
- Restart Shelly 1 remains a separate explicit maintenance command.
- The older separate timed and one-hour workbook rows may collapse into one `IsLocked>0` duration event. `IsLocked<0` is the Shelly latch event.
- A Shelly timer may re-enable locally without considering Tab5. On the next complete Tab5 cycle, if mode is Normal and pump-disable owners remain, Tab5 reapplies Pump Disable. In Monitor, it does not.

## 8. Clear Events and restart

### Clear Events

Clear Events:

- closes Tab5 events whose close policy is Clear Events;
- releases only those events' held assignments;
- closes the operator Monitor event if configured for Clear Events; and
- records the user request and resulting transitions.

It does not restart either device, erase history, clear Shelly protection, or reload old online events.

### Tab5 restart

Every Tab5 startup creates a new session with an empty event board and no retained Tab5 ownership, timer, or latch state.

- Do not restore event state from flash, RTDB, Firestore, or the prior online board.
- Do not issue a blind startup enable.
- Fresh observations rebuild events using their ordinary opening qualification.
- A continuing unsafe condition naturally reopens and reapplies its consequence.
- A user may intentionally disable an event in the active rules package before restarting; the disabled rule will not reopen.
- The normal restart case is an investigated user reset. An unexpected restart coincident with another changing failure is accepted as a second-failure limitation.
- Online treats the new session identity as a board-replacement boundary and resolves prior-session open instances as interrupted by restart.

## 9. Event records and outage recovery

- Event open and close records are immutable and distinct from disposable current state.
- CPU A never waits for cloud delivery.
- CPU B owns bounded transport retry.
- Event records use a bounded RAM queue sized for several days of expected event traffic.
- Event records are not journaled to flash.
- Observation records may be dropped under the existing bounded-queue policy.
- If the event queue fills, local observation and control continue; newer event records may be lost and perfect online reconciliation is no longer guaranteed.
- A user-directed Tab5 restart after communications recover is the accepted clean-board recovery when necessary.

## 10. Operational workbook coverage

`well_pump_operational_rules_1.xlsx` contains 59 candidate rows. V3 coverage is:

- 51 rows are informational, observational, health, or Shelly-owned events requiring no Tab5 pump write.
- Eight rows specify Tab5 pump-control behavior.
- `E006` and `E007` are transient voltage inhibits.
- `P013`, `P014`, `E005`, and `T013` are latched inhibits.
- `E002` is initially reclassified as latched.
- `T004` is initially reclassified as transient.
- Separate recovered rows such as H002/H004/H006/H008/H010/H013 may later be removed because a duration event's close record already documents recovery.
- Required-source health rows can own Monitor directly instead of feeding per-source flags into one compound mode event.

Do not commission all 59 rows merely because the contract can represent them. The first V3 package should contain only the small reviewed set needed to test each lifecycle class.

## 11. Current code map and known contradictions

### Web/contracts line

- V2 compiler and validator: `cloud/netlify/lib/rules-engine-contract.js`
- V2 defaults: `cloud/netlify/lib/rules-engine-defaults.js`
- Primary contract tests: `tests/rules-engine-contract.test.js`

Current V2 uses one flat `actions` array and emits `eventLifecycle.actionMode="while_event_active"`, but the Tab5 implementation executes one reviewed STOP only on opening. It has no V3 action phases, guarded groups, owner sets, Monitor class, Clear Events executor, or close restoration.

### Tab5 line

- Runtime evaluator and STOP executor: `tab5/pilot.py`
- Event lifecycle host tests: `tests/test_tab5_event_engine.py`
- Observation-selection tests: `tests/test_tab5_observation_selection.py`
- Cloud transport tests: `tests/test_tab5_cloud_transport.py`

M6.27 accepts exactly one enabled action, `PumpEnable=false`, and issues a synchronous Shelly GET RPC when the event opens. It does not execute close actions or generic writable assignments. Network command execution must be moved out of the one-second semantic decision path in V3.

### Unpromoted branch

`agent/event-command-reconciliation` contains useful event-record and web-command fragments, but its command names and lifecycle assumptions are not authoritative. Reconcile selected pieces only after the V3 event/action contract and Tab5 transition executor are stable.

## 12. Bounded implementation sequence

### Unit 1 — V3 contract and fixtures

Work only on `agent/event-v3-contract`.

- Add an explicit V3 package schema without changing deployed V2 behavior.
- Define opening triggers, closing policies, `onOpen`/`onClose`, unconditional and guarded groups, typed assignments, ownership, and transient/latched/Monitor classes.
- Preserve the existing condition representation and writable-field/device binding model.
- Decide V2-to-V3 compatibility at package adoption explicitly; never reinterpret V2 bytes as V3.
- Add contract fixtures and exhaustive validator tests.
- Do not deploy or move the RTDB current pointer.

Acceptance is host-only: valid V3 fixtures compile deterministically; invalid references, values, guards, close policies, ownership conflicts, and unbounded structures are rejected; existing V2 tests remain unchanged.

### Unit 2 — Pure Tab5 V3 semantic kernel

Work only on `agent/event-v3-runtime`.

- Parse and resolve V3 once at adoption.
- Implement atomic device-record acceptance.
- Implement qualification, event-instance owner sets, transient release, latch release, Monitor ownership, and restart-clear behavior as pure selection logic.
- Produce selected actions and records without network I/O.
- Add deterministic replay tests before connecting the executor.

Required replay cases:

1. Transient High Voltage opens after its confirmation count and closes only after 30 valid recovery observations.
2. A dropped source poll freezes recovery qualification.
3. Two transient inhibits overlap; closing one cannot release the other.
4. A transient inhibit and a latch overlap; the latch remains authoritative.
5. Two Monitor causes overlap; Normal returns only after the final owner closes.
6. Operator Monitor closes while a required-source Monitor event remains open.
7. Events continue tracking during Monitor and active ownership is applied on return to Normal.
8. `IsLocked>0`, `IsLocked<0`, `IsLocked=0`, and a dropped Shelly poll select the required enable behavior.
9. A Shelly timed re-enable is re-disabled on the next valid Normal cycle while Tab5 owners remain.
10. Restart clears the Tab5 board and owner sets; persistent unsafe evidence reopens naturally.
11. A disabled rule does not reopen after restart.
12. Guarded action groups use one frozen transition snapshot.

### Unit 3 — Nonblocking writable-field executor

- Bind selected typed writes to the existing device adapter definitions.
- Enforce the Shelly enable gate centrally in the adapter/executor.
- Keep command I/O and retries outside the one-second semantic evaluator.
- Record selected, issued, rejected, and confirmed outcomes without inventing cloud control authority.

### Unit 4 — Event records, controls, and online projection

- Add immutable event transition records and bounded event queue recovery.
- Add session/board replacement semantics.
- Reconcile rather than blindly merge the old event-command branch.
- Add hard-coded Clear Events, Monitor, Normal, Restart Tab5, and Restart Shelly controls.
- Add online current and historical event display only after the supplying contracts are stable.

### Unit 5 — Controlled pilot acceptance

The owner must explicitly approve every promotion, device upload, and hardware step. Test in increasing consequence order:

1. V3 adoption and event logging with no actions.
2. Monitor ownership with no relay command.
3. STOP-only opening using an unconnected Shelly relay.
4. Transient close and guarded enable with the relay still isolated from the pump circuit.
5. Overlapping transient and latched replay plus physical relay confirmation.
6. Shelly timed and latched authority.
7. Only after those pass, separately approve connection to the real pump-control circuit and define the witnessed acceptance script.

## 13. Session start and completion rules

At the start of every V3 session:

1. Read this file completely.
2. Verify the live remote SHA for the one named work branch.
3. Confirm the worktree is clean except for known generated/user files.
4. Run that branch's baseline host tests.
5. Work on exactly one bounded unit from Section 12.

Do not spend the session rediscovering old proposals or searching unrelated branches. Inspect only the code locations named for the active unit unless tests identify another dependency.

At completion, report separately:

- files and contract meaning changed;
- host tests passed and tests blocked by environment;
- behavior not yet tested;
- exact branch and commit identity;
- whether anything was pushed;
- the next bounded unit; and
- the precise owner/hardware acceptance test, if any.
