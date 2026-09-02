# V3 Rules Engine design notes — Monitor, occurrences, latching, and recovery

**Status:** working design note for consolidation in a later design-manager session.

**Date:** 2026-08-31

**Purpose:** capture the current owner discussion before revisiting the larger Tab5 process tree, removing duplicates, reconciling older V3 material, and packaging implementation work units.

## Next-session consolidation handoff

The next design-manager session must begin with the Google Doc **`Well Pump V3 — Rules Engine Consolidation and Next Coding Steps`**:

https://docs.google.com/document/d/1nv1Bk2PQ2bn5pRvhaWlUHsdLs8znr9JHc7TlRb7CKsw

That handoff carries this note forward together with `V3-ISSUES.md`, the current source, older V3 authority/process records, and the broader `pilot.py` processing-tree concerns. It explicitly adds non-event runtime topics that must be reviewed before coding: package adoption, atomic device records, source-health versus event qualification, maintained values versus current evidence, calculations versus history-dependent Functions, durable observation selection/content, event records/summaries, snapshot ordering, action execution, CPU A/CPU B boundaries, one-second cadence, and RAM-state reset boundaries.

This note remains evidence of the owner discussion; do not treat any individual proposal here as implementation authority when the consolidation handoff calls for reconciliation first.

This file is intentionally placed beside `V3-ISSUES.md`. It is **not yet a replacement authority document**. Older V3 records may contradict parts of it and must be reconciled deliberately.

---

## 1. Rules Engine boundary

The Rules Engine should contain the user-configurable semantic behavior:

- fields and system fields;
- calculations;
- event triggers and qualification;
- event lifecycle;
- event-instance ownership;
- assignment selection and applicability;
- event records and summaries.

The following are **outside** the Rules Engine and are not considered undesirable hard-coded Rules Engine behavior:

- device adapters and protocol support;
- HMI implementation;
- hardware initialization;
- polling mechanics;
- CPU A / CPU B division;
- RTDB/cloud transport;
- reboot execution itself.

The loop may, however, accept a reboot request. Reboot is special: once accepted, the current cycle ends and the Tab5 restarts rather than processing reboot as an ordinary event.

---

## 2. Fixed code may inject named event occurrences

A small, explicit bridge is required between fixed runtime code and JSON-driven event processing.

The loop may inject a **named one-shot occurrence** when something happens that cannot originate inside the JSON package itself.

Current expected sources are limited to:

1. system/runtime facts such as bad or incomplete required data;
2. each user-programmed button or operator request.

The fixed code should report only the occurrence/fact. It should not encode the event meaning or consequence.

Example conceptual flow:

```text
polling/runtime detects incomplete required data
        -> emit named occurrence
        -> JSON decides which event opens
        -> event lifecycle / ownership / actions are generic

user presses programmed button
        -> emit named occurrence
        -> JSON decides which event opens
        -> event lifecycle / ownership / actions are generic
```

This is acceptable hard coding because the loop is only reporting an external fact into the Rules Engine. The package remains authoritative for what that fact means.

---

## 3. Functional operating requirements today

There are two functional operating states:

- **NORMAL**
- **MONITOR**

The desired design is to avoid a special Monitor event state machine in `pilot.py` if the behavior can be expressed through system fields, event ownership, and generic assignment applicability.

### 3.1 Candidate system fields

The current discussion favors separating the reporting causes from the effective state, for example:

- `NotAllDevicesReporting`
- `UserMonitorOnly`
- `MonitorMode` or equivalent effective operating-mode system field

The first two describe why Monitor may be needed. They are useful for reporting and for JSON event triggers.

The effective Monitor state should be easy for the engine to test through one system-field value, while still preserving independent ownership by multiple causes.

A numeric value may be useful for reporting, but it should preferably be **derived from event ownership** rather than incremented/decremented directly by JSON actions. Event-instance ownership already guarantees one add and one remove per event instance and avoids counter drift.

Conceptually:

```text
no Monitor owners      -> NORMAL
one or more owners     -> MONITOR
```

The fixed code may set/emit facts such as `NotAllDevicesReporting`; JSON events decide whether those facts create Monitor ownership.

---

## 4. Monitor behavior

Current owner requirement:

### NORMAL

Tab5 event consequences may control the Shelly relay subject to applicable device/local protections.

### MONITOR

Monitoring continues normally:

- polling continues;
- calculations continue;
- logging continues;
- event evaluation continues;
- events may open and close;
- ownership bookkeeping continues.

Relay behavior differs by event consequence:

- **ordinary/transient Tab5 pump-disable consequences are not applied while Monitor is active**;
- **latched/locking Tab5 consequences remain effective and may still disable the pump while Monitor is active**.

This is the revised requirement. It supersedes the earlier idea that Monitor suppresses every Tab5 pump-disable assignment.

### 4.1 Entering Monitor

When Monitor becomes effective, if the relay is currently open because of a Tab5 ordinary/transient inhibit, the normal mechanical-control path should be restored by setting the relay closed **only if Shelly-local protection permits that write**.

Monitor must not be interpreted as a pump-start demand. Closing the relay merely restores the normal mechanical pressure-switch control path.

### 4.2 While Monitor is active

New transient/ordinary inhibit events may continue to open and retain ownership, but their pump-disable assignments are not effective during Monitor.

A newly opening latched/locking event remains effective and may disable the pump even in Monitor.

### 4.3 Leaving Monitor

When the final Monitor owner disappears, NORMAL resumes. Any still-open transient inhibit ownership that was retained during Monitor becomes effective again naturally.

The preferred architecture is for this to fall out of generic assignment applicability rather than explicit `Normal -> Monitor` and `Monitor -> Normal` Python branches.

---

## 5. Avoid Monitor-specific kernel hard coding

The current V3 Python contains special Monitor semantics. The target design is to remove those Well-Pump-specific checks from the semantic kernel if a generic rule can express the same behavior.

A useful generic primitive may be **conditional applicability of a held assignment**.

Conceptually:

```text
Transient inhibit:
    hold PumpEnable = false while event is open
    assignment applicable only when Monitor is not active

Latched inhibit:
    hold PumpEnable = false while event is open
    assignment remains applicable regardless of Monitor
```

The engine would generically retain ownership even when an assignment is temporarily inapplicable. When the applicability condition later becomes true again, the held assignment becomes effective without a special transition state machine.

This is a general-purpose Rules Engine capability, not a Monitor-specific feature.

Example outside the well-pump application:

```text
hold ValveOpen = false
while event is open
when MaintenanceMode == false
```

The exact JSON/UI representation remains to be designed.

---

## 6. Pump / Shelly authority also needs review

Current V3 Python contains application-specific handling for `PumpEnable` and `IsLocked`, including special release/re-enable logic.

This should be reviewed with the same objective as Monitor: determine whether the required behavior can be represented by generic field/assignment eligibility or guard semantics instead of literal Well-Pump-specific kernel code.

For the current well-pump installation, Shelly-local protection remains authoritative unless the design is deliberately changed later.

Today's operational requirement is that Tab5 must not close/enable the relay unless current Shelly evidence permits it.

The architecture should not unnecessarily prevent a future application from defining different authority relationships. The generic engine should ideally enforce declarative write eligibility rather than permanently embedding one device hierarchy.

The current `IsLocked=0` fabrication used when Shelly answers is temporary commissioning scaffolding and is not a desired final semantic rule.

---

## 7. Latched events require a close review

`latched` remains an important **functional concept** today: it means a serious condition requiring user intervention rather than automatic recovery.

However, it is not yet clear that `latched` needs to remain a distinct runtime implementation concept in the Tab5 kernel.

Possible final meaning:

```text
latched event opens
    -> event remains open
    -> ownership/consequence remains held
    -> ordinary recovery does not close it
    -> reset/reboot clears the Tab5 event board
```

If that is all the actual Tab5 rules require, `latched` may be implemented entirely through ordinary lifecycle/closing semantics and may survive only as a Rules Engine UI label/preset.

A rule-by-rule review of the real Tab5 package is required before deciding whether to keep, simplify, or remove the distinct runtime concept.

### 7.1 Latched interaction with Monitor

Revised owner requirement:

- latched/locking Tab5 events do **not** become ineffective merely because Monitor is active;
- a latched event may still disable the pump while in Monitor;
- Monitor does not clear a latched event;
- if a latched rule is erroneous, the user may disable/inactivate that rule in the Rules Engine and then reset/reboot to start with an empty Tab5 board;
- this preserves logging and monitoring of other events while giving the user a recovery path.

A Tab5 latch is still distinct from a Shelly-local latch in persistence. Tab5 event state is intentionally lost on reboot; Shelly-local protection is independent of the Tab5 board.

---

## 8. Clear Events user request is no longer required

Current design direction removes **Clear Events as a user-generated command**.

The intended user recovery model is instead:

1. use Monitor when continued observation/logging is desired without ordinary/transient Tab5 pump disables;
2. diagnose or repair the well/system;
3. if a rule itself is the problem, disable/inactivate it in the Rules Engine;
4. reset/reboot the Tab5 when ready to establish a fresh board;
5. fresh observations determine which enabled events reopen naturally.

This makes reset/reboot the deliberate recovery boundary for Tab5 event state.

Any older authority or implementation material that treats Clear Events as the user mechanism for clearing latched events or operator Monitor must be revisited during consolidation.

---

## 9. Restart / reset semantics

The accepted direction remains:

- restart creates a new Tab5 session;
- the Tab5 event board starts empty;
- prior open Tab5 event instances are not restored;
- ownership/qualification/latch memory is not restored;
- current enabled rules evaluate again from fresh observations;
- an event whose rule has been disabled before restart cannot reopen;
- an accidental reboot therefore has no memory of a prior Tab5 latch.

That loss of Tab5 latch memory is understood and accepted in the current design direction.

---

## 10. Remaining Rules Engine hard-coding review

Restricting the question to **user/business semantics inside the Rules Engine path**, the current focused review list is:

1. **Monitor semantics**
   - remove special Well-Pump-specific Monitor state-machine behavior from `pilot.py` if generic assignment applicability can replace it.

2. **PumpEnable / Shelly protection authority**
   - remove or generalize literal `PumpEnable` / `IsLocked` semantic handling if generic write eligibility/guard rules can express the requirement.

3. **Latched event semantics**
   - inspect actual Tab5 rules closely and determine whether `latched` needs any distinct runtime support at all.

Named occurrence injection from fixed code is considered an acceptable Rules Engine interface, provided fixed code only reports the occurrence and JSON defines the meaning/consequence.

---

## 11. Relationship to the larger Tab5 process tree

Do **not** immediately rewrite the larger process tree from this note alone.

A later design-manager session should:

1. read this note beside `V3-ISSUES.md` and the current V3 authority/process records;
2. identify contradictions and duplicate concepts;
3. review the actual current Tab5 JSON/rules, especially all latched rules;
4. decide the minimum generic Rules Engine primitives needed;
5. update the larger observation-cycle/process tree accordingly;
6. remove superseded Clear Events and old Monitor assumptions;
7. package the resulting implementation into bounded work units with explicit acceptance tests.

No implementation, merge, deployment, promotion, or hardware action is authorized by this note itself.

---

## 12. Key questions for the consolidation session

- What exact generic JSON structure should express conditional applicability of a held assignment?
- Can that same primitive eliminate both Monitor-specific Python and PumpEnable/IsLocked special handling?
- Should `OperatingMode` remain an enum for reporting while effective Monitor state is derived from ownership?
- What exact named occurrences are permitted from fixed code, and how are user-programmed buttons mapped to them?
- Which current Tab5 events truly require latched behavior?
- Does `eventClass: latched` remain useful as a UI preset even if the runtime no longer branches on it?
- What old Clear Events code, UI, JSON, and documentation must be removed?
- What existing V3 issue entries become obsolete or contradictory after these decisions?
- How should the revised design be split into the smallest coherent implementation units and user/hardware acceptance tests?
