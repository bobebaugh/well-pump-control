# Minimal Tab5Lock and Monitor implementation — design for review

Successor to `lock-coordination-design-proposal.md`. That document argued the
posture and the two-owned-flag shape. This one is the implementation plan:
the smallest set of edits that makes it real, using machinery already running.

**Governing constraint: minimum change.** The whole system is an optional
overlay on a well that worked without it. Every line added is a line that can
fail in the garage. Where a choice exists between reusing something proven and
building something better, this design reuses.

**Revision 2**, after review. Seven findings accepted; the corrections are
marked **[R2]** where they change what was proposed. The largest are: the
support gate rejects the new write outright and was missed entirely; A8's
reconcile as written would have broken one-shot `transition` assignments; and
`H001` cannot fire on the device at all, because nothing produces internal
occurrences.

Three changes: `A`, `B`, `C`. Dead-code removal has been **[R2]** moved out of
this plan into its own unit — it is not a prerequisite, and one file proposed
for deletion holds live V3 coverage.

All in `tab5/pilot.py` and `shelly1/anti-chatter.js` except one editor control
and one rules-package edit. **No new field type, no counter, no schema version
bump.** A package edit **is** required, and existing packages will be rejected
after this lands — see §7.

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

### A5a. The support gate — **[R2]**, and the real blocker

`_rules_v3_runtime_supported` (2830) rejects a package before it resolves if any
`readWrite` field is not exactly:

```python
write.get('method') != 'Switch.Set' or
write.get('parameters') != {'id': 0, 'valueParameter': 'on'} or
write.get('normalValue') is not True
```

A boolean flag fails all three: different method, different parameters, and its
normal value is **false**. This gate, not the binding table, is what would have
stopped the change; the earlier revision missed it.

Add a second accepted shape rather than loosening the first:

| | Relay | Flag |
| --- | --- | --- |
| object | `RLY(0)` | `UDF(Tab5IsLocked)` |
| method | `Switch.Set` | `Boolean.Set` |
| parameters | `{"id": 0, "valueParameter": "on"}` | `{"valueParameter": "value"}` |
| normalValue | `true` | `false` |

**No component id appears in the authored package.** Ids are assigned at
creation and are not stable across a rebuild, so authoring one would be a latent
fault. The id comes from the name in the object string, resolved by this cycle's
discovery, and the dispatcher substitutes it. That is the whole answer to "how
does the discovered id replace the authored parameters": the package never
carries one.

**Acknowledgment is method-specific — [R2].** `issue_rules_v3_action`
(1312) accepts a write only when the reply carries `was_on`, which is a
`Switch.Set` reply field. `Boolean.Set` does not return it. The success test
must branch on method, and must not treat "no recognised field" as success.

**Pilot must mirror this.** The publication and support validation in
`cloud/netlify/lib/rules-engine-v3-*.js` carries the same constraint and has to
accept the second shape, or a package that Tab5 can run will not publish.

### A6. Editor

The write method is greyed to `Switch.Set`. Allow `Boolean.Set` when the object
matches `UDF(...)` and the type is boolean, and populate the parameter and
normal-value defaults from the table above rather than leaving them free text.

### A7. Shelly script

`shelly1/anti-chatter.js` declares a third component and its relay policy
becomes the two-input function from the proposal:

```
relay closed  ⟺  IsLocked == 0  AND  Tab5IsLocked == false
```

A missing or unreadable `Tab5IsLocked` reads as `false` and the relay closes,
matching how `hasHandle()` already degrades for the other two. Fail-open applies
to the script's own faults as well as everything else's.

#### Sole writer must be enforced, not intended — **[R2]**

The earlier revision said the script becomes the sole writer of RLY0 and, two
sections later, that `PumpEnable` "stays declared and functional". Those cannot
both hold. Any surviving or newly authored `PumpEnable` assignment recreates
exactly the two-writer conflict that `016ba5a`'s open-only rule was built to
avoid, and the script would now fight back once per second.

**Make `RLY(0)` read-only in the binding table.** Change its entry in
`RUNTIME_DIRECT_BINDINGS['shelly-gen4-switch']` from `readWrite` to `read`.

The support gate then rejects any package that assigns `PumpEnable`, at adopt,
with no new check to write. Enforcement falls out of machinery that already
exists, which is the whole reason to do it there.

This is a **hard cutover**, and it is the reason §7 exists: every currently
published package assigns `PumpEnable`, so every one of them stops adopting the
moment this Tab5 build runs. There is no overlap window and no fallback path.
That is deliberate — a soft cutover is precisely the state in which two writers
can coexist.

#### What the power-on default does and does not guarantee — **[R2]**

`switch:0` power-on state stays **ON**, per proposal §1. That covers one case
only: the device powers up and the script never runs, so nothing opens the
relay.

It does **not** guarantee that a relay already held open closes when the script
stops. The power-on default applies at power-on. A script that opens RLY0 and
then dies leaves it open until the device is power-cycled, and no configuration
setting changes that.

Proposal §8 test 8 asserts this behaviour and has **not been run on hardware**.
Until it has, "the script dying releases the relay" is an assumption, not an
escape path, and the sanctioned clear paths remain the breaker and the online
restart.

### A8. Ownership dispatch for the lock flag

`whileOpen` on a device target records an owner and emits nothing. The only
thing that turns ownership into a write is bespoke code keyed to `pump_target`,
which is the hardcoded name `PumpEnable`.

Add a per-cycle reconcile in `advance_rules_v3_kernel`, after the event loop,
**for `UDF(Tab5IsLocked)` alone**:

```
if any event owns the flag:  emit true
otherwise:                   emit false
```

Roughly ten lines, purely additive. All pump and `releasePending` machinery is
untouched.

**Scoped to the one target, not to every writable device field — [R2].** The
general form is wrong, not merely broader. Reconciling any unowned writable
target back to its normal value would silently undo a one-shot `transition`
assignment on the very next cycle: the write lands, no owner exists, and the
reconcile writes the normal value back over it. That breaks `transition`
semantics for every target it touches, which is a behaviour change dressed as a
generalisation. This answers the earlier open question — **named, not general.**

Two cases the implementation must handle explicitly, both testable without
hardware:

- **Multiple owners.** Two events holding the flag is one `true`. The flag stays
  true while any owner remains.
- **Last-owner release.** `false` is emitted on the cycle after the last owner
  is removed, not on the removal of the first.

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
- **From the loop read — [R2], which narrows the claim.** The decision uses this
  cycle's observation, and if the acquisition was rejected `shelly1_available` is
  false and nothing is issued. That is not the same as "a stale write is
  impossible": the device can change between the read and the write, so the
  guarantee is only that Tab5 never acts on an *older* cycle's evidence. A write
  racing a concurrent change is still possible and is corrected on the next
  cycle by the same reconcile.

A Shelly reboot that zeroes `Tab5IsLocked` is therefore repaired on the next
cycle with exactly one write, which is proposal test 7.

**Separately: the acquisition itself is still two RPCs.** `read_shelly1` (653)
calls `Shelly.GetStatus` then `Shelly.GetComponents`, measured at 708 ms
together. Proposal §6.1 covers collapsing them into one `Shelly.GetComponents`
with a `keys` filter — `dynamic_only=true` is what currently excludes
`switch:0`, which is why two calls were needed. That consolidation is a
prerequisite for "one read per cycle".

Three qualifications the earlier revision skipped — **[R2]**:

- **One response is not a simultaneous snapshot.** The device assembles the
  reply field by field; two values in one response were not necessarily true at
  the same instant. The reconcile must not assume a coherent cross-component
  state, which it does not: it compares one field.
- **Pagination.** `Shelly.GetComponents` returns `total` alongside the array,
  and an owner-run query has already been observed returning 12 of 20. The
  reader must compare `total` against the returned length and reject the
  acquisition when they disagree rather than treating a short page as absence —
  otherwise a truncated reply reads as a missing component, which under A7's
  fail-open rule closes the relay.
- **"One read" is a steady-state goal, not an invariant.** Component discovery
  after a Shelly reboot, and recovery from a rejected acquisition, may cost an
  extra call. Those exceptions should be named and bounded rather than pretended
  away.

### Authoring shape

```
onOpen:  Tab5IsLocked = true,  while open
```

No `onClose` assignment. The owner is dropped at close and the reconcile writes
`false` on the next cycle.

`PumpEnable` becomes **read-only telemetry — [R2]**. It stays declared so the
relay's observed state is still read, logged and testable in conditions, but it
can no longer be an assignment target. Rules move their assignment to
`Tab5IsLocked`. Reverting means reverting the Tab5 build, not editing the
package.

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

### C3. Suppress on entry — **[R2]**, replacing "delete the filter"

Removing the pump-action filter at 3534-3535 is not enough on its own, and the
earlier revision was wrong to present it as a tidy-up.

**Ordering.** Resolve the effective mode **once, at the top of the cycle, from
kernel state carried in**, before any event is evaluated. Do not recompute it
mid-loop. Otherwise whether an event is processed depends on whether it happens
to sit before or after the Monitor event in package order, which is not a
property anyone should have to reason about.

**Scope on entry.** On the Normal → Monitor boundary, suppress *both*:

- the ownership reconcile of A8, so the flag is released rather than re-asserted;
- any inhibit actions already emitted this cycle, before collapse, so an event
  that opened earlier in the same cycle cannot leave a write behind it.

The existing filter at 3534 stays until `RLY(0)` is read-only, because until
then a legacy package can still emit a pump action. Delete it in the same change
that makes the binding read-only, not before.

### C4. System Monitor now releases the inhibition — **[R2]**, a deliberate change

Under the earlier design System Monitor explicitly did **not** clear existing
latched lockouts; unavailable telemetry merely stopped the affected rules
evaluating. Under C it does clear them, because the freeze plus the A8 reconcile
releases the flag regardless of which Monitor engaged.

That is a real reversal and is called out rather than absorbed. It is the right
one under the fail-open posture — an inhibit whose evidence has gone is an
assertion Tab5 can no longer support — but it means a brief telemetry excursion
now releases a hold that previously persisted. The counter-argument from the
earlier review, that a short excursion should not release a real lockout, is not
answered by this design; it is accepted as the cost of not hanging.

### User versus System — the shape is right, `H001` is not — **[R2]**

The distinction needs no new concept. It is `clearEvents` versus a closing
condition, and no mode enum, user/system flag or second code path is required.

But **`H001` cannot fire on the device**, and the earlier revision assumed it
could. The loop builds exactly one occurrence map, from the manual operator
Monitor request (`pilot.py` 5309, passed in at 5362). **Nothing anywhere
produces an internal occurrence.** An internal-trigger event can never open.

So System Monitor does not exist today in any form, and this design cannot lean
on it. The fix is a **rules-package edit**, not code: give `H001` an ordinary
condition trigger on availability, with a recovery close.

| | Trigger | Closing policy | Exit |
| --- | --- | --- | --- |
| `M001` Operator Monitor | manual occurrence | `clearEvents` | never closes → **Restart Tab5** |
| `H001` Electrical source invalid | **condition** on `Shelly1Available == false` — was internal | condition on availability restored | closes when the device returns |

Two consequences:

- The package edit is part of this change, not a follow-on. Until it is made,
  engaging Monitor is only possible by operator request.
- The simulator on `pilot-working` modelled internal triggers as firing on
  device loss, which made a LAN failure appear to suspend the controller by
  itself. That was fiction and has been corrected (`f5e6afc`); the test now
  asserts the device's actual behaviour and says why.

### Consequence to accept

While Monitor is engaged **no new non-monitor events are recorded — [R2]**. A
leak or an excessive runtime starting during Monitor produces no event, only
logged observations. Monitor-class events are exempt from the freeze and keep
running, so the logging-only flags of C1a continue to mark condition sets
throughout — which is the whole reason they are exempt.

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
- Dead-code removal. **[R2]** Moved out — see §5a.

---

## 5a. Dead code (deferred) — a finding, not part of this change — **[R2]**

The earlier revision made deletion `Change D` and landed it first. **Withdrawn
as a prerequisite**, on two grounds, both correct:

- **It is not a prerequisite.** Unreachable code cannot affect A, B or C. The
  argument for going first was reviewer convenience, which is not worth
  coupling a 900-line deletion to a behaviour change.
- **One proposed deletion was wrong.** `tests/test_tab5_observation_selection.py`
  is not V2-only. It holds **current V3 coverage** — staging pointer identity,
  closed-schema rejection, atomic staging and offline reload without V2 state,
  the checkpoint-1 fixture, and the running/staged/execution state report. That
  file must be trimmed, never deleted. `test_tab5_event_engine.py` (157 lines,
  V1) is the only wholesale candidate.

The finding stands and is worth its own unit: a reachability walk from module
scope reports **47 top-level functions, 852 of 5528 lines**, that the running
application never reaches — the V2 rules runtime and its delivery path, the V1
event engine, superseded durable selection, the old Shelly availability
confirmation, and the ADC microvolt path left behind when calibration moved to
raw counts. Every one is referenced by a test, which is why none looked unused.

**The walk is evidence, not proof — [R2].** A static AST walk cannot see a call
made through a callback, a dispatch table, `getattr`, or a string. It is a
candidate list that each entry must be argued off individually, not a licence to
bulk-delete. `rules_v3_field_values` is the standing example: unreachable, but
current V3 rather than old, so it may have been written for something still
pending.

Recorded here so the inventory is not lost. It should move to its own document
and its own branch.

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

**Change B** — **[R2]** fully populated fixtures are not sufficient evidence
7. Every existing fixture package evaluates identically when all fields present.
8. `all` with one false and one absent → false, not unknown.
9. `any` with one true and one absent → true, not unknown.
10. `all`/`any` with only absent and inconclusive clauses → unknown.
11. **Clause order does not matter**: the absent field first, last, and in the
    middle all give the same result.
12. **Unknown transitions**: true → unknown → true, and false → unknown → false,
    across cycles.
13. **Qualification counts**: an unknown neither advances nor resets an open or
    close count, and a definite result resumes from where it left off.
14. **Guards**: a guarded group whose guard goes unknown contributes no
    assignments, and does not fail the phase.
15. E007 with an `any` close and the EM absent closes after its ten observations.

**Change C**
16. In Monitor, a non-monitor event neither opens nor closes.
17. In Monitor, a monitor-class event still closes when its condition qualifies.
18a. Entering Monitor writes `Tab5IsLocked` false within one cycle.
19a. Leaving a System Monitor with a still-open owner re-asserts within one cycle.
20a. `M001` never closes; only a restart clears it.
21a. The event board keeps showing events opened before Monitor engaged.

**Integration — [R2], the cases the earlier revision had no tests for**
18. A package assigning `PumpEnable` is rejected by the support gate once
    `RLY(0)` is `read`, and the rejection names the field.
19. A package with the `Boolean.Set` shape passes the gate; one with
    `normalValue: true`, or a method the gate does not know, does not.
20. A `Boolean.Set` reply without `was_on` is treated as success; a reply with
    an `error` is not, and neither is a reply with no recognised field.
21. Two events owning the flag write `true` once; releasing one keeps it `true`;
    releasing the last writes `false` on the following cycle.
22. A one-shot `transition` assignment to any other target is **not** undone on
    the next cycle.
23. `GetComponents` returning fewer entries than `total` rejects the whole
    acquisition rather than reading as a missing component.
24. Entering Monitor in the same cycle an inhibit opened leaves no pending write.
25. Mode is resolved once per cycle: reordering the events in the package does
    not change which events are processed.

---

## 7. Rollout — **[R2]**, promotion is not installation

Promoting two branches does not coordinate three installations. Making `RLY(0)`
read-only is a hard cutover: the moment the new Tab5 build runs, every currently
published package fails the support gate and does not adopt.

There is no configuration in which old and new are both correct, so the sequence
matters and every step is a person doing something:

1. **Publish the revised package first, do not deliver it.** It assigns
   `Tab5IsLocked`, not `PumpEnable`, and carries `H001` on a condition trigger.
   The current Tab5 build will not adopt it — the object is unknown to it —
   which is the intended interlock, not a failure.
2. **Install the Shelly script.** It declares `Tab5IsLocked` and takes sole
   ownership of RLY0. Until Tab5 writes the flag it stays false, so the relay
   closes exactly as before. This step is independently safe and reversible.
3. **Verify the component exists and reads back**, by name, before going further.
   Tab5 rejects the whole acquisition if it is missing.
4. **Install the Tab5 build, then restart.** Adoption is restart-only. The new
   package now adopts; the old one would not.
5. **Confirm `values.shelly1_tab5lock` is present** in the observation and that
   a deliberate inhibit moves it, once, and moves it back.

**Between steps 2 and 4 the system is unprotected by Tab5** — the flag exists,
nothing writes it, and the old package no longer adopts. Mechanical protection
is unaffected throughout: pressure switch, 3-second on-delay, 6-minute limit,
HAND, and the Shelly's own chatter lock. Keep the window short and do it in
daylight.

**Rollback** is reinstalling the previous Tab5 build and re-delivering the
previous package. The Shelly script can stay: with nothing writing `Tab5IsLocked`
it holds false and the relay behaves as it does today.

Both branches still promote together — Change A spans `tab5/pilot.py`,
`shelly1/anti-chatter.js` and the Pilot editor — but promotion is step zero, not
the deployment.

---

## 8. Review outcomes

Settled in review; recorded so they are not reopened.

| Question | Outcome |
| --- | --- |
| Reconcile general or named | **Named.** The general form breaks `transition` semantics — §A8. |
| Three-valued truth tables | **Agreed.** No separate release needed, but fully populated fixtures are not sufficient evidence: clause order, unknown transitions, qualification counts and guards all need cases — tests 7-15. |
| Boolean versus number | **Boolean.** No speculative counter. |
| Frozen board | **Retain** events and ownership evidence, as proposed. |
| Analyser warning | **Distinguish** automatic-recoverable Monitor from restart-only. Do not call a recoverable configuration safe without checking that its recovery condition can actually qualify — a condition that reads the device it is recovering from cannot, which is Change B's whole point. |
| Deletion scope | **Out of this change.** Separate unit; one file proposed for deletion holds live V3 coverage — §5a. |
| `rules_v3_field_values` | Deferred with the rest of §5a. Unreachable but current, so argue it individually. |

## 9. Still open

1. **Proposal §8 test 8 is unrun.** "Script stopped → relay stays closed" has
   never been executed on hardware, and the power-on default does not imply it.
   Until it is run, treat script death as leaving the relay wherever it was.
2. **The step 2-4 window.** Whether the unprotected interval is acceptable as
   written, or wants a staged package that assigns neither target so the gap
   closes from both ends.
3. **Short-excursion release.** §C4 accepts that a brief telemetry loss now
   releases a hold that previously persisted. If that is wrong for the leak
   classes specifically, it needs a mechanism this design does not contain.
