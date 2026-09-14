# Minimal Tab5Lock and Monitor implementation — design for review

Successor to `lock-coordination-design-proposal.md`. That document argued the
posture and the two-owned-flag shape. This one is the implementation plan:
the smallest set of edits that makes it real, using machinery already running.

**Governing constraint: minimum change.** The whole system is an optional
overlay on a well that worked without it. Every line added is a line that can
fail in the garage. Where a choice exists between reusing something proven and
building something better, this design reuses.

Four changes. `D` is a deletion and lands first; `A`, `B` and `C` are the
behaviour. All in `tab5/pilot.py` and `shelly1/anti-chatter.js` except one
editor control. **No new field type, no counter, no schema version bump, no
rules-package migration.**

---

## 1. What is already built, and is reused unchanged

This is the important half of the design. Nothing below is being written.

| Machinery | Where | Reused for |
| --- | --- | --- |
| `whileOpen` ownership | `_rules_v3_add_owner` 3355, `_rules_v3_remove_owner` 3364 | holding the new flag while an event is open |
| Generic transition dispatch | `advance_rules_v3_kernel` 3475 | nothing new needed for one-shot writes |
| Action collapse and dispatch | `rules_v3_collapse_actions` 1336, `dispatch_rules_v3_actions` 1355 | one write per target per cycle, unchanged |
| Idempotent write guard | `issue_rules_v3_action` 1296 returns `observed-desired-state` | zero writes in steady state, for free |
| Guarded groups | `_rules_v3_phase_assignments` 3346 | already evaluate guards; UI collapse fixed separately |
| Effective mode | `rules_v3_effective_mode` 3379 | already answers "are we in Monitor" |
| Monitor assignment validation | `_v3_assignment` 2493 | monitor events may only select Monitor, `whileOpen` |
| Manual Monitor discovery | `operator_monitor_occurrence_field` 743 | unchanged |
| Two-RPC Shelly read | `read_shelly1` 653 | one more component in the same reply |
| Name-based component discovery | `normalize_shelly1_components` 613 | ids are not stable; names are |
| Session working fields | `_v3_system_field` role `working` | already authorable, not needed here |

The editor already renders everything this design needs. The only editor change
is unlocking one greyed-out control.

---

## 2. Change A — `Tab5IsLocked`, a writable Shelly virtual component

The flag lives on the Shelly as a boolean virtual component, not as a Tab5
system field. That keeps it where the proposal put it: a value with exactly one
writer, visible to both parties, and volatile across a Shelly reboot.

### A1–A2. Declare the object

`RUNTIME_DIRECT_BINDINGS['shelly-gen4-switch']` (line 124) lists four objects
and every UDF in it is `read`. Add one row:

```python
'UDF(Tab5IsLocked)': ('boolean', None, 'readWrite'),
```

`RUNTIME_OBJECT_PATHS['shelly-gen4-switch']` (line 984) has no path for it. Add:

```python
'UDF(Tab5IsLocked)': 'values.shelly1_tab5lock',
```

Without both, a device field using that object is rejected at resolve and could
never be read back. This is why the field authored in the editor does nothing
today.

### A3. Read it

`normalize_shelly1_components` (613) accepts only `number:` keys named
`IsLocked` or `loCntr`. Extend it to also accept a `boolean:` key named
`Tab5IsLocked`, and to return **its component id** alongside its value. The id
is assigned at creation and is not stable across a rebuild, so the writer must
use the id discovered this cycle, exactly as the reader already resolves names.

Rejection stays all-or-nothing: a missing or duplicated `Tab5IsLocked` rejects
the whole acquisition, like the other two.

### A4. Surface it

`build_observation` (836) gains `values.shelly1_tab5lock` beside the existing
`values.shelly1_lock`, plus the discovered id in `status` for the writer.

### A5. Write it

`issue_rules_v3_action` (1283) refuses anything that is not `Switch.Set`. Add a
`Boolean.Set` branch:

```
http://<shelly>/rpc/Boolean.Set?id=<discovered id>&value=true|false
```

Same GET-only shape as the proven `Switch.Set` path, same timeout, same
`observed-desired-state` short-circuit against `values.shelly1_tab5lock`. The
existing lock-evidence guard at 1299 applies to the relay only and is untouched.

### A6. Editor

The write method is greyed to `Switch.Set`. Allow `Boolean.Set` when the object
matches `UDF(...)` and the type is boolean. One dropdown.

### A7. Shelly script

`shelly1/anti-chatter.js` declares a third component and its relay policy
becomes the two-input function from the proposal:

```
relay closed  ⟺  IsLocked == 0  AND  Tab5IsLocked == false
```

The script becomes the sole writer of RLY0. That is safe **only because** Tab5
stops writing it, which is the whole point of A.

### A8. Ownership dispatch for non-pump device targets

`whileOpen` on a device target records an owner and emits nothing. The only
thing that turns ownership into a write is bespoke code keyed to `pump_target`,
which is the hardcoded name `PumpEnable`.

Add a per-cycle reconcile in `advance_rules_v3_kernel`, after the event loop,
for writable **device** targets that are not the pump target:

```
for each such target:
    emit an action with the owned value if an event owns it,
    otherwise with its normalValue
```

Roughly ten lines, purely additive. All pump and `releasePending` machinery is
untouched, so nothing existing changes behaviour.

#### The I/O contract this must obey — owner-specified, normative

**One Shelly read per cycle. One write, only when the value is wrong. The write
happens at the conclusion of event processing, and its decision comes from that
same cycle's read.**

Every clause is already satisfied by where this sits, and each is a constraint
on the implementation rather than a hope:

- **No read is added.** The reconcile compares against
  `observation['values']['shelly1_tab5lock']`, captured by the cycle's existing
  acquisition. It must never call the Shelly to find out what it wrote.
- **The write is last.** Actions are emitted after the event loop, then
  collapsed by `rules_v3_collapse_actions` and issued by
  `dispatch_rules_v3_actions`, which already runs at the end of the cycle. One
  write per target per cycle is the existing collapse guarantee, not a new one.
- **Only on disagreement.** `issue_rules_v3_action` (1296) already returns
  `observed-desired-state` without touching the device when the observed value
  equals the desired one. Steady state costs zero writes, in either state.
- **From the loop read, so a stale write is impossible.** If the acquisition was
  rejected this cycle, `shelly1_available` is false and nothing is issued at
  all.

A Shelly reboot that zeroes `Tab5IsLocked` is therefore repaired on the next
cycle with exactly one write, which is proposal test 7.

**Separately: the acquisition itself is still two RPCs.** `read_shelly1` (653)
calls `Shelly.GetStatus` then `Shelly.GetComponents`, measured at 708 ms
together. Proposal §6.1 covers collapsing them into one `Shelly.GetComponents`
with a `keys` filter — `dynamic_only=true` is what currently excludes
`switch:0`, which is why two calls were needed. That consolidation is a
prerequisite for "one read per cycle" and should land with this work, not
after it.

### Authoring shape

```
onOpen:  Tab5IsLocked = true,  while open
```

No `onClose` assignment. The owner is dropped at close and the reconcile writes
`false` on the next cycle.

`PumpEnable` stays declared and functional. Rules move their assignment from it
to `Tab5IsLocked`. Nothing is deleted, so the change is reversible by editing
the package.

---

## 3. Change B — three-valued condition evaluation

`rules_v3_condition_value` (3229) returns unknown on the **first** absent field,
before `mode` is applied:

```python
current = fields.get(name)
if current is None:
    return None
```

So one missing measurement makes the whole condition undecided even when the
answer is already determined, and `mode: any` cannot rescue it. This is why
E007's `ShellyEMAvailable == true` guard is inert, and why an event whose
telemetry vanishes stays open until Tab5 restarts.

Replace with proper three-valued logic. Collect results, treating unknown as a
third value:

- **all**: any `False` → `False`. Otherwise any unknown → unknown. Otherwise `True`.
- **any**: any `True` → `True`. Otherwise any unknown → unknown. Otherwise `False`.

About six lines. Strictly more correct: it returns a definite answer only where
one is logically determined, so **every existing package behaves identically
whenever all its fields are present.**

What it unlocks, expressible in the package with no code:

```
closing: any [ SupplyVoltage <= 266 , ShellyEMAvailable == false ]
```

E007 now closes when the EM is gone, the owner is dropped, and the reconcile
releases `Tab5IsLocked`. The ten-observation qualification is unchanged and
still debounces the recovery.

---

## 4. Change C — Monitor Mode

Today Monitor filters pump actions and every event keeps evaluating.

The owner's model is simpler: **Monitor stops event processing.** System Monitor
clears itself when telemetry returns; User Monitor is the same thing, locked.

### C1. Stop processing

In `advance_rules_v3_kernel`'s event loop, when the effective mode is Monitor,
`continue` past any event whose `eventClass` is not `monitor`.

Monitor-class events **must** keep evaluating, for two reasons. A System Monitor
could otherwise never close and would be terminal too. And monitor-class events
have a use that has nothing to do with mode, described next.

### C1a. Monitor class is not the same as engaging Monitor

Engaging Monitor requires **owning the operating-mode target** — an
`OperatingMode = Monitor, while open` assignment. `rules_v3_effective_mode`
(3379) already reads exactly that, and `_v3_assignment` (2493) already restricts
that assignment to monitor-class events.

A monitor-class event with **no assignments at all** is valid today and engages
nothing. That is the cheap logging flag: a condition set marked as an event
purely so it is highlighted on the board and in the durable log, costing no
control behaviour and no new machinery.

Two consequences worth stating, because they are easy to get backwards:

- Adding a logging-only monitor event must never suspend the controller. It
  does not, because it owns nothing.
- Because C1 exempts monitor-class events from the freeze, **logging flags keep
  working while Monitor is engaged.** During a suspension the board still marks
  the condition sets you asked it to mark, which is precisely when that is worth
  having.

So the class carries two unrelated privileges: exemption from the freeze, and
eligibility to engage it. Only the assignment does the engaging.

### C2. Release the inhibit

With non-monitor events skipped, their owners are still recorded — the board
stays frozen as evidence — but A8's reconcile treats the mode as releasing them
and writes the normal value. `Tab5IsLocked` goes false, and stays false, because
nothing is re-asserting it.

That is User Monitor's stated purpose: **release the physical inhibition, retain
the event and ownership evidence.** No new mechanism; one condition in the
reconcile.

When a System Monitor clears, the skipped events are still open and still owned,
so the reconcile re-asserts on the very next cycle. Nothing is lost across the
excursion, which is the failure mode a one-shot release would have.

### C3. Delete the pump-action filter

`advance_rules_v3_kernel` 3534-3535 is now redundant — nothing produces pump
actions while frozen. Remove it.

### User versus System needs no new concept

It is already expressed in the package, and both events already exist:

| | Trigger | Closing policy | Exit |
| --- | --- | --- | --- |
| `M001` Operator Monitor | manual occurrence | `clearEvents` | never closes → **Restart Tab5** |
| `H001` Electrical source invalid | internal occurrence | condition on `ShellyEMAvailable` | closes when the EM returns |

"User Monitor is a locked version of the same thing" is exactly `clearEvents`
versus `condition`. No mode enum, no user/system flag, no second code path.

### Consequence to accept

While Monitor is engaged no new events are recorded. A leak or an excessive
runtime starting during Monitor produces no event, only logged observations.
Protection continues at the layers below: Shelly chatter and short-cycle, the
3-second on-delay, the 6-minute runtime limit, and HAND.

---

## 5. Explicitly not in scope

- The generic counter field type. A8 plus B gives self-release without it.
- Generalising ownership dispatch for the pump target. Untouched.
- Clear Events. Still a concept; `M001` closing on it is what makes it terminal.
- Removing `PumpEnable` / RLY0 writing from Tab5. Left working and unused.
- A schema version bump. Nothing in the authoring contract changes.
- A boot-without-rules escape hatch. Worth doing; not this change.

Change D below is in scope, and is the largest single item by line count.

---

## 5a. Change D — delete the superseded engines

`tab5/pilot.py` is 5528 lines. A reachability walk from module scope finds
**47 top-level functions, 852 lines, that the running application never
reaches.** Every one of them is referenced by a test, which is why they have
survived: the tests are the only callers, so nothing looked unused.

That is the worst state for old code to be in. It reads as maintained, it is
covered, and it is wrong to trust — three of these functions are earlier
versions of code the loop still runs, and a reader cannot tell which is live
without the reachability walk.

| Group | Functions | What replaced it |
| --- | --- | --- |
| **V2 rules runtime** | `advance_runtime_event`, `new_runtime_event_state`, `_runtime_qualified`, `evaluate_runtime_events`, `runtime_condition_value`, `runtime_stop_only_action`, `issue_runtime_stop`, `clear_runtime_event_board`, `evaluate_runtime_calculations`, `runtime_direct_field_values`, `runtime_logging_change_details` | the V3 kernel |
| **V2 delivery and validation** | `load_runtime_package`, `adopt_runtime_release`, `validate_runtime_release`, `_runtime_package_valid`, `_runtime_field_valid`, `_valid_runtime_release_id`, `_valid_integral_nonnegative`, `validate_runtime_pointer`, `_check_runtime_pointer`, `runtime_pointer_rejection_reason`, `runtime_pointer_key_summary`, and the `RULES_RUNTIME_FILE` / `RULES_RUNTIME_TEMP_FILE` constants | the V3 staged-release path |
| **V1 event engine** | `advance_rule_event`, `new_rule_event_state`, `_event_rule_latched`, `_valid_event_rule_timing`, `event_history_values`, `build_rules_audit_record` | superseded twice over |
| **Superseded durable selection** | `build_durable_observation`, `durable_observation_reason`, `material_change_details`, `_material_change_detail`, `_numeric_material_change`, `_observation_path_value`, `_record_timestamp_prefix` | `build_durable_observation_v2`, `durable_field_states`, `durable_trigger_reasons` |
| **Superseded Shelly availability confirmation** | `new_shelly_availability_confirmation`, `shelly_availability_change_pending`, `acknowledge_shelly_availability_change` | `$availability` in the V3 acquisition |
| **Superseded ADC microvolt path** | `read_ads1110_microvolts`, `_read_ads1110_microvolts_once`, `trimmed_mean_microvolts`, `summarize_adc_samples`, `estimated_flow_gpm` | `read_ads1110_filtered_raw_count`; calibration moved from microvolts to raw counts |
| **Orphans** | `_finite_number`, `_v3_scalar`, `_wait_until`, `rules_v3_field_values` | — |

`rules_v3_field_values` is the odd one: it is V3, not old, and still unreachable.
Worth a second look before deleting in case it was written for something not yet
wired up.

**Tests go with the code.** `tests/test_tab5_observation_selection.py` (908
lines) is almost entirely V2 coverage; `tests/test_tab5_event_engine.py` (157
lines) is entirely V1. Both are candidates for deletion outright. The V2
references inside `test_tab5_v3_integration.py`, `test_tab5_v3_semantic_kernel.py`,
`test_tab5_hmi.py` and `test_tab5_pressure_flow.py` are narrower and need
trimming rather than removal.

**Method, so this is verifiable and not a judgement call.** The reachability
walk is a dozen lines of `ast`; it should be committed as
`tests/test_tab5_no_dead_code.py` and asserted to return empty. Then the
deletion is checkable, and the condition cannot silently return.

**Sequence.** D lands *before* A, B and C. Deleting first means the three
behaviour changes are made against a smaller file, and no reviewer wastes time
reading a V2 evaluator to decide whether A8 affects it. It is also the only
change here with no behavioural risk: unreachable code cannot alter behaviour,
and the walk proves unreachability rather than asserting it.

---

## 6. Test plan

Host suites, no hardware, no emulator.

**Change A**
1. A package with `UDF(Tab5IsLocked)` resolves; the same package with an
   undeclared UDF object still fails.
2. A components reply containing the boolean is read; one missing it, or
   containing it twice, rejects the whole acquisition.
3. `Boolean.Set` is issued with the id discovered this cycle, never a constant.
4. A second cycle at the same value issues no RPC (`observed-desired-state`).
5. A Shelly reboot zeroing the flag is repaired on the next cycle.
6. An unreachable Shelly issues nothing and reports it.

**Change B**
7. Every existing fixture package evaluates identically when all fields present.
8. `all` with one false and one absent → false, not unknown.
9. `any` with one true and one absent → true, not unknown.
10. `all`/`any` with only absent and true/false-inconclusive clauses → unknown.
11. E007 with an `any` close and the EM absent closes after its ten observations.

**Change C**
12. In Monitor, a non-monitor event neither opens nor closes.
13. In Monitor, a monitor-class event still closes when its condition qualifies.
14. Entering Monitor writes `Tab5IsLocked` false within one cycle.
15. Leaving a System Monitor with a still-open owner re-asserts within one cycle.
16. `M001` never closes; only a restart clears it.
17. The event board keeps showing events opened before Monitor engaged.

**Change D**
18. The reachability walk returns empty, committed as a test so the condition
    cannot silently return.
19. The full host suite passes with the deleted tests removed, and no remaining
    test imports a deleted name.

**Both branches promoted together.** Change A spans `tab5/pilot.py`,
`shelly1/anti-chatter.js` and the Pilot editor, so `tab5-working` and
`pilot-working` must move as a pair.

---

## 7. Questions for review

1. **A8 scope.** Reconciling every non-pump writable device target is more
   general than reconciling `Tab5IsLocked` by name. The general form is the same
   size and avoids a second hardcoded name, but it changes behaviour for any
   future `readWrite` device field. General, or named?
2. **B risk.** Three-valued logic is the only change here that touches every
   condition in the engine. Is a same-behaviour-when-present test across all
   fixtures sufficient evidence, or does it want its own release?
3. **C2 and the frozen board.** Owners are retained but not acted on. Is that
   the right reading of "retain event and ownership evidence", or should
   entering Monitor close the non-monitor events so the durable log records why?
4. **H001.** Under C it becomes a self-clearing System Monitor, which is safe.
   The Pilot analyser currently warns about any non-manual Monitor. That warning
   should be re-scoped to non-manual **and** `clearEvents`. Agreed?
5. **Boolean versus number.** A boolean flag is minimal. A number would leave
   room for a future hold count without another contract change. Worth the extra
   now, or add it when needed?
6. **Deletion scope.** Is 852 lines in one commit acceptable, or should D split
   by group so a bisect can land on one engine? My preference is one commit,
   because the groups are not independent — the V2 evaluator and its validation
   path only become unreachable together.
7. **`rules_v3_field_values`.** Unreachable but current. Delete, or was it
   written for something still pending?
