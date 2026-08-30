# V3 issues list — working document

**Status:** end-to-end V3 works on hardware, including event processing (2026-08-30).
This tracks what is broken or unfinished, split by which GPT session takes it.

**How to use.** Owner reports a symptom, an entry gets added here. Entries are batched,
not committed one at a time. `ONLINE-n` is cloud/web work on `pilot`; `TAB5-n` is device
work on `Tab5`. Anything marked **unconfirmed** is a report not yet reproduced.

Reference branch state when this list opened: `pilot` `8e6207d`, `Tab5` `4a0199c`,
live engine on `claude/v3-engine-live` `0b0eb66`.

---

## TAB5 — device session (`Tab5` branch, `tab5/pilot.py`)

### TAB5-1 — System-field assignments are sent to the device executor · CONFIRMED
`OperatingMode` is an `assignmentTarget` system field, so `resolve_rules_v3_package()`
puts it in `writableTargets` alongside `PumpEnable`. It has no `write` block and
therefore no `method`, so `issue_rules_v3_action()` returns `unsupported-method:None`.

Because that is not `issued`, the action is never recorded in `rules_v3_last_actions`,
so it is retried and logged **every cycle** for as long as Monitor is active.

Fix: the executor should only handle targets that came from a device field with a
`write` block. System-field assignments are internal state and must not reach it.
Carry a marker through `resolve_rules_v3_package()` (e.g. `'device': True`) and skip the
rest. Introduced with the live wiring.

### TAB5-2 — Only one issued action is remembered between cycles · CONFIRMED
`rules_v3_last_actions = [signature]` replaces the whole list with a single entry
(`tab5/pilot.py` ~4187). If a cycle issues writes to two different targets, only the
last is remembered, so the other re-issues every cycle.

Fix: accumulate per target, e.g. a dict keyed by target holding the last issued value.
Clear an entry when that target no longer appears in the selected set. Introduced with
the live wiring.

### TAB5-3 — `IsLocked` is a placeholder, not a real reading · BY DESIGN, TEMPORARY
The loop sets `observation['values']['shelly1_lock'] = 0` whenever the Shelly answered.
There is no Shelly lockout script yet, so there is genuinely nothing to read, and
without this the kernel can never re-enable — the relay would open and never close.

This must be replaced with a real `UDF(IsLocked)` read when the Shelly script exists.
Until then the enable gate is not actually testing anything. Marked in the source.

### TAB5-4 — `loCntr` does not exist anywhere · OPEN
Referenced by two rule conditions in the workbook, declared in neither
`RUNTIME_DIRECT_BINDINGS` nor `RUNTIME_OBJECT_PATHS`, and absent from `pilot.py`
entirely. Any rule using it resolves to nothing. Blocked on the Shelly script contract.

### TAB5-5 — No diagnostic for an unresolved field · OPEN
A package can reference a field that resolves to `None` forever. It adopts cleanly,
`enabled_rule_count()` counts it, the HMI shows it as enabled, and it silently never
fires. There is no log line, no counter, no status.

Fix: at adoption, log every declared field that has no object path, and surface a count.
This is the trap that hid TAB5-3 and TAB5-4 for weeks.

### TAB5-6 — Boyle tank outputs are permanently `None` · KNOWN TBD
`evaluate_runtime_calculations()` sets every `kind: "function"` output to `None`.
`TankWaterGallons`, `PressureSlopePSIPerMinute`, `TankNetFlowGPM`, `PumpOffDemandGPM`,
`TankFlowQuality`. No enabled rule reads them today. Deferred work unit, not a defect.

### TAB5-7 — Executor retries are unbounded · OPEN
A failed write is retried every cycle with no backoff and no attempt ceiling. If the
Shelly is unreachable this is one HTTP attempt per second indefinitely.

Fix: bounded retry with backoff, and a log line when giving up.

### TAB5-8 — `tab5/pilot.py` line endings are mixed · OPEN, DEFERRED
241 of 4123 lines carry CRLF. Harmless to MicroPython; it makes digest comparison
awkward when mirroring. Deferred until nothing is in flight against `tab5/`; do it as
its own commit with `.gitattributes`.

---

## ONLINE — cloud and web session (`pilot` branch)

### ONLINE-1 — RTDB pointer is written before the Firestore record · CONFIRMED
In the `deliver` path, `publishPointer()` writes the RTDB pointer, then
`markDelivered()` records it in Firestore. A failure between them leaves RTDB saying
delivered and Firestore saying not. This happened during the first live delivery: the
UI showed `rules_v3_state_invalid` while the device had already received the pointer.

Fix: reorder, or make the pointer write recoverable/idempotent so the two cannot
disagree.

### ONLINE-2 — No migration for state documents written before the V3 state schema · CONFIRMED
`contracts/rules-v3-state-v1.schema.json` requires `kind` and `executionEnabled`.
Documents written by the pre-Gate-1 code have neither, and `markDelivered()` spreads the
stored document, so validation fails with `rules_v3_state_invalid`.

Republishing produces a valid document and is the accepted remedy. Only worth code if it
recurs — do not patch the schema.

### ONLINE-3 — Deliver button is disabled by an unrelated draft edit · CONFIRMED
`markDirty()` disables `#engine-deliver`. Delivery targets the *published* release, not
the draft, so editing the draft should not block delivering what is already published.
Reload or publish re-enables it.

Fix: leave the deliver button governed by `state.current` alone.

### ONLINE-4 — No V3 event display · OPEN (V3 §12 Unit 4)
Nothing in the web app shows current or historical V3 events. All evidence is on the
device console. This is the largest remaining gap now that the engine runs.

### ONLINE-5 — RTDB security rules deploy by hand · OPEN
No workflow runs `firebase deploy --only database`. Netlify publishes functions and web
only. The rules going undeployed produced `pointer_read_failed`, which cost a debugging
cycle.

Fix: automate it, or document it as a required step beside the deploy.

### ONLINE-6 — V2 parameter engine has no UI · WON'T FIX
`web/rules-engine.js` hardcodes `version=3`; nothing reaches the V2 parameter engine.
Preserved at the endpoint, unreachable from the browser. V2 is being deleted, so this is
recorded for context only.

---

## Reported but not yet reproduced

*(nothing yet — add symptoms here as they come in, with the raw log lines)*
