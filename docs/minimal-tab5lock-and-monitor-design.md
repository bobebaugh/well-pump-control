# Minimal Tab5Lock and Monitor implementation — design for review

Successor to `lock-coordination-design-proposal.md`. That document argued the
posture and the two-owned-flag shape. This one is the implementation plan:
the smallest set of edits that makes it real, using machinery already running.

**Governing constraint: minimum change.** The whole system is an optional
overlay on a well that worked without it. Every line added is a line that can
fail in the garage. Where a choice exists between reusing something proven and
building something better, this design reuses.

Three changes, `A`, `B`, `C`. All in `tab5/pilot.py` and `shelly1/anti-chatter.js`
except one editor control. **No new field type, no counter, no schema version
bump, no rules-package migration.**

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

This is §2's compare-and-correct reconciler, and it arrives free: collapse
already allows one write per target per cycle, and `issue_rules_v3_action`
already returns `observed-desired-state` without calling the device when the
value already matches. **Steady state costs zero writes.** A Shelly reboot that
zeroes `Tab5IsLocked` is repaired on the next cycle, which is proposal test 7.

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

Monitor-class events **must** keep evaluating, or a System Monitor could never
close and would be terminal too. That single exception is what makes the whole
thing work.

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
