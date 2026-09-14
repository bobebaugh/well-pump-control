# Minimal Tab5Lock and Monitor implementation — design for review

Successor to `lock-coordination-design-proposal.md`. That document argued the
posture and the two-owned-flag shape. This one is the implementation plan:
the smallest set of edits that makes it real, using machinery already running.

**Governing constraint: minimum change.** The whole system is an optional
overlay on a well that worked without it. Every line added is a line that can
fail in the garage. Where a choice exists between reusing something proven and
building something better, this design reuses.

**Revision 3**, after a second review. Corrections are marked **[R2]** and
**[R3]** by the round that produced them.

R3's largest findings: the authored write shape fails the **schema**, not just
the support gate, so contract work is unavoidable; the rollout as written still
had two relay writers, and is reordered to remove the window entirely; and
`Boolean.Set` returns JSON `null` on success, which the dispatcher currently
classifies as `invalid-response`.

R2's were: the support gate was missed entirely; A8's reconcile would have
broken one-shot `transition` assignments; and `H001` cannot fire on the device,
because nothing produces internal occurrences.

Three changes: `A`, `B`, `C`. Dead-code removal has been **[R2]** moved out of
this plan into its own unit — it is not a prerequisite, and one file proposed
for deletion holds live V3 coverage.

All in `tab5/pilot.py` and `shelly1/anti-chatter.js` except one editor control,
one rules-package edit, and **[R3]** a contract change mirrored on both sides.
**No new field type and no counter.** The earlier claim of no schema change is
**withdrawn** — see §A5b. A package edit is required, and existing packages will
be rejected after this lands — see §7.

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
| parameters | `{"id": 0, "valueParameter": "on"}` | `{"valueParameter": "value"}` — **[R3]** needs a contract change, see A5b |
| normalValue | `true` | `false` |

**No component id appears in the authored package.** Ids are assigned at
creation and are not stable across a rebuild, so authoring one would be a latent
fault. The id comes from the name in the object string, resolved by this cycle's
discovery, and the dispatcher substitutes it. That is the whole answer to "how
does the discovered id replace the authored parameters": the package never
carries one.

**Pilot must mirror this.** The publication and support validation in
`cloud/netlify/lib/rules-engine-v3-*.js` carries the same constraint and has to
accept the second shape, or a package that Tab5 can run will not publish.

### A5b. The schema, and why the id cannot simply be authored — **[R3]**

`runtime-package-v3.schema.json`'s `write.parameters` is a closed object with
**both `id` and `valueParameter` required**:

```json
"parameters": { "additionalProperties": false,
  "required": ["id", "valueParameter"], ... }
```

So `{"valueParameter": "value"}` fails validation before any Tab5 code runs.
The claim that this change needs no contract work was wrong.

`Boolean.Set` does take an `id` — its parameters are `{id, value}` — so the
schema field is meaningful. The problem is narrower: **the id is assigned at
component creation and is not stable across a rebuild**, so an authored id is a
value that is correct until someone deletes and recreates the component, and
then silently addresses the wrong thing.

Two ways to resolve it:

| | Change | Cost |
| --- | --- | --- |
| **Author a placeholder id, override at dispatch** | none to the contract | the package carries a number that is ignored and wrong; the gate must accept any id; a reader cannot tell it is meaningless |
| **Contract change (recommended)** | `parameters` becomes a `oneOf`: the switch shape, or `{valueParameter}` with an optional `componentName`; `id` optional for non-`Switch.Set` methods | four files |

Take the contract change. The placeholder is the kind of quiet lie that costs a
day in eighteen months.

Four files move together: `interfaces/runtime-package-v3.schema.json`,
`contracts/rules-runtime-package-v3.schema.json`, Pilot's validator in
`cloud/netlify/lib/rules-engine-v3-contract.js`, and Tab5's `_v3_write` plus
`_rules_v3_runtime_supported`.

**Whether this needs a schemaVersion bump is a review question.** Old packages
still validate against the widened schema, so it is backward compatible in the
usual sense — but the cutover in §7 is already hard, so a bump costs little and
makes the incompatibility explicit rather than implied.

### A5c. What `Boolean.Set` actually returns — **[R3]**

Verified against the Shelly documentation rather than assumed: **`Boolean.Set`
returns JSON `null` on success.** No `was`, no `was_on`, no result object. Over
`GET /rpc/Boolean.Set?id=<n>&value=true` the body is the four characters `null`.

`issue_rules_v3_action` (1307) does:

```python
if not isinstance(data, dict):
    return 'invalid-response'
```

`null` parses to `None`, which is not a dict, so **a successful write would be
reported as a failure**. The consequence is worse than a bad status string: the
reconcile compares intent against the observation, sees the flag did change, and
stops — but any logic keyed to the outcome string sees a permanent failure, and
an implementation that retried on failure would write every cycle, destroying
the zero-writes-in-steady-state property that justifies the whole approach.

**The accepted success response, stated so it can be tested rather than
inferred:**

| Reply body | Outcome |
| --- | --- |
| `null` | `acknowledged` |
| `{}` or `{"result": null}` (envelope forms) | `acknowledged` |
| anything containing `error`, or `code` **and** `message` | `rpc-error` |
| a non-200 status, or a body that is not JSON | `invalid-response` |

Success for `Boolean.Set` is therefore **the absence of an error**, not the
presence of a field. `Switch.Set` keeps its existing `was_on` test unchanged.
Both are tested directly, with a recorded device reply, not a hand-written
fixture guess.

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

A missing or unreadable `Tab5IsLocked` reads as `false`, matching how
`hasHandle()` already degrades for the other two. **[R3]** That removes *Tab5's*
inhibition only — it is one input to the function, not an override. If
`IsLocked != 0` the script still holds RLY0 open, because that lock is its own
and a missing Tab5 flag is no evidence about short cycling.

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
- **Last-owner release.** `false` is emitted **in the same cycle's dispatch** as
  the removal of the last owner — **[R3]**, correcting R2's "on the following
  cycle". The reconcile runs after the event loop, so an owner removed by a
  close during that loop is already gone when the reconcile reads the owner set.
  Waiting a cycle would be a second, different behaviour.

#### Only one assignment shape is legal on this target — **[R3]**

Scoping the reconcile is not sufficient. The same problem survives *on the flag
itself*: a `transition` assignment writes `true`, the reconcile finds no owner
on the next pass, and writes `false` over it. The flag would flicker and the
inhibit would evaporate.

So constrain the target, in `_v3_assignment` alongside the existing
`operatingMode` rule (2493):

| Assignment to `Tab5IsLocked` | |
| --- | --- |
| `true`, `whileOpen` | the only accepted form |
| `true`, `transition` | **rejected at validation** |
| `false`, any ownership | **rejected at validation** |

Release is not something a rule expresses. It comes from the last owner going
away, or from entering Monitor. That makes the flag's lifetime a property of
the ownership set and nothing else, which is the only reason the reconcile can
be trusted as the single writer.

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
  acquisition when they disagree rather than treating a short page as absence.
  **[R3]** The consequence is on Tab5's side only: a rejected acquisition means
  Tab5 reads nothing and writes nothing that cycle. It does **not** reach the
  Shelly script, whose handle to its own component is local and unaffected by
  how a remote reply was paginated.
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

**Ordering — two decisions, not one — [R3].** The document previously conflated
them, which is why last-owner release read two different ways.

| Decision | Uses | Why |
| --- | --- | --- |
| **Which events evaluate** | the mode **carried in** from the previous cycle, resolved once before the loop | otherwise whether an event is processed depends on where it sits relative to the Monitor event in package order |
| **What the flag is written to** | the mode **resulting from** this cycle's evaluation, after the loop | otherwise entering Monitor takes a whole extra cycle to release, and the release time depends on event order again |

So a Monitor event opening on cycle *n* does not stop the other events on cycle
*n* — they were already selected — but it **does** release the flag on cycle
*n*'s dispatch. Suspension starts at *n+1*; release is immediate. That is the
behaviour the operator expects from a control whose whole purpose is to restore
water, and it removes the ordering dependence from both halves.

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
| `H001` Electrical source invalid | **condition**: `ShellyEMAvailable == false` — was internal | condition: `ShellyEMAvailable == true` | closes when the EM returns |

**The device set is the EM, not Shelly 1 — [R3].** R2 wrote `Shelly1Available`,
which was wrong on both counts: `H001` is *Electrical source invalid*, its
original internal occurrence was `ShellyEMUnavailable`, and the electrical
measurements it stands for come from the EM. Opening and closing are the exact
complement of each other on that one availability flag, which is decidable even
when the EM is gone — `$availability` is always true or false for an enabled
device, never absent — so unlike E007 this pair does not need Change B to close.

**Shelly 1 is deliberately not in the set.** Losing Shelly 1 is a different
failure with a different consequence, and it has its own informational event in
`S020`. If it should also suspend processing, that is a second Monitor event
and a separate decision, not an extra clause here.

**When Shelly 1 is unreachable, Monitor cannot clear the flag — [R3].** Entering
Monitor emits `Tab5IsLocked = false`, but a write only lands if the device
answers. If the LAN is down, the stored flag keeps its value on the Shelly and
the inhibit stands until communication returns and the reconcile writes again.
Monitor is a Tab5-side decision; it cannot reach across a broken link. The
sanctioned clear path in that state remains the breaker or HAND.

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

**[R3] Contract, response and cutover**
26. The widened `write.parameters` accepts both shapes; the switch shape is
    unchanged and still rejects an unknown property.
27. A `Boolean.Set` reply of `null` is `acknowledged`; `{}` and
    `{"result": null}` are too; a body carrying `error` is `rpc-error`; a
    non-JSON body is `invalid-response`. Recorded device replies, not guesses.
28. A steady-state cycle with the flag already correct issues no RPC, proven by
    counting calls across many cycles — the property `null`-as-failure would
    have destroyed.
29. `Tab5IsLocked = true, transition` is rejected at validation; so is
    `Tab5IsLocked = false` with any ownership; `true, whileOpen` is accepted.
30. Entering Monitor releases the flag **in that cycle's dispatch**, and the
    last owner closing releases it in that cycle's dispatch too.
31. Mutual rejection, tested both ways: the new build refuses the old package,
    and the old build refuses the revised one. This is the interlock §7 rests
    on and must be proven before the first install.
32. `H001` opens on `ShellyEMAvailable == false` and closes on `true`, with no
    dependence on Change B.
33. With Shelly 1 unreachable, entering Monitor leaves the stored flag unchanged
    and the write is retried once communication returns.

---

## 7. Rollout — **[R3]**, reordered to remove the two-writer window

R2's sequence installed the Shelly script while the old Tab5 was still running
its old package. That Tab5 keeps writing RLY0 and the new script reverses it,
once a second: exactly the conflict `016ba5a`'s open-only rule existed to
prevent. Reordering removes the window rather than shortening it.

**The interlock that makes this work:** once the new Tab5 build makes `RLY(0)`
read-only, the old package fails `_rules_v3_runtime_supported` and does not
adopt. `adopt_rules_v3_staged_package` returns `None`, there is no V3 runtime,
`run_rules_v3_cycle` is never called, and Tab5 issues **no device writes at
all** — the dead `issue_runtime_stop` path is unreachable and the operator
controls do not touch the relay. Tab5 is inert by construction, not by
intention.

### Cutover

| | Step | Writers of RLY0 |
| --- | --- | --- |
| 1 | Install the new Tab5 build. **Restart.** The old package no longer adopts; Tab5 runs with no rules runtime and writes nothing. | old script only |
| 2 | Install the new Shelly script. It declares `Tab5IsLocked` and takes the relay. | new script only |
| 3 | Verify by name that all three components exist and read back. | new script only |
| 4 | **Publish and Deliver** the revised package. Refresh *Tab5 — last reported package identities* and confirm it is **staged**. | new script only |
| 5 | **Restart Tab5.** It adopts and begins writing the flag. | new script only |
| 6 | Confirm `values.shelly1_tab5lock` is in the observation, and that one deliberate inhibit moves it once and back. | new script only |

There is no step at which two things write the relay.

**Delivery, corrected — [R3].** "Publish but do not deliver" cannot lead to
adoption; the editor's control is *Publish and Deliver*, and delivery only
requests a download. Staging is confirmed separately on the device-status panel,
and adoption happens on the **next restart** after staging is confirmed. Steps 4
and 5 are two distinct operator actions with a check between them, not one.

**Between steps 1 and 5 Tab5 contributes no protection** — it has no rules
package. Mechanical protection is unaffected throughout: pressure switch,
3-second on-delay, 6-minute limit, HAND, and from step 2 the Shelly's own
chatter lock. Keep the window short and do it in daylight.

### Rollback

Symmetric, and it **must restore the old script — [R3]**. Leaving the new script
running under the old Tab5 recreates the same two-writer conflict in the
opposite direction, because the old package assigns `PumpEnable` again.

| | Step | Writers of RLY0 |
| --- | --- | --- |
| 1 | Install the old Tab5 build. **Restart.** The revised package fails the *old* gate — `UDF(Tab5IsLocked)` is not in its binding table — so again no runtime and no writes. | new script only |
| 2 | Restore the previous Shelly script (`016ba5a`), which is open-only. | old script only |
| 3 | Deliver the previous package; confirm staged. | old script only |
| 4 | Restart Tab5. | old script + Tab5, as before |

Each build refuses the other's package, in both directions. That mutual
rejection is the safety property the whole sequence rests on, and it is worth
testing before the first install rather than discovering on the night.

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
| **[R3]** Contract work | **Included.** The schema requires both parameter fields, so there is no no-contract path. Placeholder-id rejected as a quiet lie — §A5b. |
| **[R3]** `schemaVersion` bump | **Open.** Backward compatible, but the cutover is already hard. Cheap to bump, and it makes the incompatibility explicit. |
| **[R3]** Flag assignment shapes | **`true, whileOpen` only.** Transition and explicit false rejected at validation — §A8. |
| **[R3]** Mode decisions | **Two.** Carried-in mode selects events; resulting mode selects the write. Suspension at *n+1*, release at *n* — §C3. |
| **[R3]** System Monitor device set | **The EM.** `ShellyEMAvailable`, complementary open and close. Shelly 1 is a separate decision — §"User versus System". |
| Shared counter, dead-code cleanup | Closed. Not reopened. |

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
4. **`schemaVersion` bump — [R3].** See the table above. A decision, not a
   discovery.
5. **The step 1-5 gap — [R3].** Tab5 contributes no protection while it has no
   adoptable package. The sequence makes that window explicit and short, but it
   does not remove it, and nothing in this design can.
