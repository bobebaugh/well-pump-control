# V3 issues list — working document

**Status:** end-to-end V3 works on hardware, including event processing (2026-08-30).
This tracks what is broken or unfinished, split by which GPT session takes it.

## Read before using proposed fixes

Before selecting or implementing another V3 work unit, read the Google Doc **`Well Pump V3 — Rules Engine Consolidation and Next Coding Steps`**:

https://docs.google.com/document/d/1nv1Bk2PQ2bn5pRvhaWlUHsdLs8znr9JHc7TlRb7CKsw

This issue list remains valuable defect/evidence history, but **its suggested fixes are not automatically current design authority**. Several entries predate the newer owner decisions captured in `V3-RULES-ENGINE-DESIGN-NOTES.md` and the consolidation handoff. In particular, TAB5-9's proposed state-preserving live-adoption fix conflicts with the newer intended package-transition boundary that closes old-package events, finishes local records/summaries, discards old semantic state, and starts the new package with an empty kernel. Do not implement that old remedy without reconciliation.

The consolidation handoff also requires review of non-event `pilot.py` processing that interacts with these issues: atomic device records, source-health versus event qualification, maintained values versus current evidence, calculations versus history-dependent Functions, durable-observation policy/content, event summaries, snapshot ordering, action execution, CPU A/CPU B transport boundaries, one-second cadence, and RAM-state reset boundaries.

**How to use.** Owner reports a symptom, an entry gets added here. Entries are batched,
not committed one at a time. `ONLINE-n` is cloud/web work on `pilot`; `TAB5-n` is device
work on `Tab5`. Anything marked **unconfirmed** is a report not yet reproduced.

Reference branch state when this list opened: `pilot` `8e6207d`, `Tab5` `4a0199c`,
live engine on `claude/v3-engine-live` `0b0eb66`.

---

## TAB5 — device session (`Tab5` branch, `tab5/pilot.py`)

### TAB5-9 — A delivered package is written to flash but never adopted · CONFIRMED · TOP PRIORITY
Owner-reported and confirmed in the source. `resolve_rules_v3_package()` and
`new_rules_v3_kernel()` are called **only** in the boot block (`tab5/pilot.py` ~3856).
The live staging path (~3962) writes the new release to flash and updates
`rules_v3_staged_reference`, but never re-resolves or rebuilds the kernel. The running
engine therefore keeps evaluating the **previous** package until the Tab5 is rebooted
and reloads from flash.

Effect: every deliver → test cycle needs a reboot. This is the main friction in the
iteration loop right now.

**Design status of the proposed fix below: SUPERSEDED FOR REVIEW, NOT APPROVED FOR IMPLEMENTATION.**
The defect remains open, but the newer owner process-tree direction requires package
adoption to be an explicit transition boundary with old-package closes/records completed
locally, old semantic state discarded, and a fresh new-package kernel. Preserve the text
below as historical evidence only until the consolidation session replaces it with a
reconciled work unit.

Historical proposed fix: in the staging block, immediately after `rules_v3_staged_reference =
staged_v3['reference']`, re-resolve and re-base the kernel. `staged_v3['package']` is
already in hand there, so no re-read of flash is needed:

```python
_next = resolve_rules_v3_package(staged_v3['package'])
if _next is None:
    log('V3 ADOPT FAILED: staged package did not resolve; keeping previous')
else:
    rules_v3_kernel_state = _copy_rules_v3_kernel(rules_v3_kernel_state, _next)
    rules_v3_resolved = _next
    rules_v3_last_actions = []
    log('V3 ADOPTED LIVE: release={} version={}'.format(
        _next['releaseId'], _next['packageVersion']))
```

The earlier proposal used `_copy_rules_v3_kernel()` rather than `new_rules_v3_kernel()`
to preserve event state and owners across edits. **That preservation assumption is the
specific part now in conflict with the newer design direction.**

Note this interacts with TAB5-2: action/executor memory still must be deliberately reset
or reconciled on adoption, but its exact treatment belongs in the new package-transition work unit.

### TAB5-10 — Event records are produced, then thrown away · CONFIRMED · TOP PRIORITY
Owner-reported: the high-voltage test opened the relay but no event record was written.
Confirmed. `advance_rules_v3_kernel()` returns `records` correctly — that is why the
event opened and the relay moved — but in the loop wiring `v3_records` appears in
exactly three places: initialised, assigned, and passed to `log()`. **Nothing builds a
durable record and nothing submits one.** The console line is the only trace, and it
dies with the session.

The surrounding machinery is in better shape than that suggests:

- `cloud.submit_durable_record()` already exists as a bounded, non-blocking queue.
- `contracts/event-record-v1.schema.json` already exists and is fully specified.
- `cloud/netlify/functions/ingest-record.js` already routes any non-observation record
  into an `eventRecords` Firestore collection.

So the transport and the cloud side are largely built. Two device-side gaps block it:

**(a) No record builder.** The kernel emits its own internal shape
`{'type': 'open'|'close', 'eventId': 'E007', 'eventInstanceId': ..., 'reason': ...,
'atMs': ...}`. The contract wants `recordType: "event-open"|"event-close"`, a generated
`recordId` and `eventId` matching strict patterns, plus `siteId`, `deviceId`,
`sessionId`, `sequence`, `observedAt`, `ruleId`, `rulesRelease`, `condition`, `actor` —
and on open, `severity`, `latched`, `consequence`; on close, `closeReason`. A translator
is needed. Note the contract's `ruleId` is the rule (`E007`) while its `eventId` is the
instance identifier — the kernel's `eventId` is the rule, so the names do not line up
and must be mapped deliberately, not passed through.

The kernel's close reasons (`closing_qualified`, `rule_disabled`, `rules_updated`) also
need mapping onto the contract's `closeReason` enum (`condition-cleared`,
`rules-updated`, `rule-disabled`, `user-request`, `rule-removed`,
`restart-reconciliation`).

**(b) The queue rejects the record type.** `submit_durable_record()` in `tab5/cloud.py`
hard-rejects any `recordType` outside `('observation', 'rule-adoption',
'rule-rejection')` and returns `False` silently. Event records must be added to that
whitelist, and they should outrank observations in the discard policy the same way
adoption records already do — an event record is the evidence of a consequence and must
not be dropped to make room for telemetry.

Reconcile this work with the new handoff's requirements for event summaries, package-transition closes, CPU-B queue priority, and ONLINE-7 ingest verification before coding.

### TAB5-11 — `build_rules_audit_record()` is defined but never called · CONFIRMED
Same pattern as TAB5-10, found while checking whether V2 already wrote event records.
`build_rules_audit_record()` (`tab5/pilot.py` ~1314) builds `rule-adoption` /
`rule-rejection` records, and `cloud.submit_durable_record()` explicitly whitelists both
types and even protects them from being discarded ahead of observations. **Nothing
calls it.** The only caller of `submit_durable_record()` passes
`build_durable_observation()`.

So no rules adoption or rejection has ever been recorded to cloud either, despite the
transport being built and defended for exactly that purpose.

Correction to an earlier assumption in this list: **V2 never wrote event records
either.** `event-open` / `event-close` appear nowhere under `tab5/`, and the V2
transition handler only calls `log()`, with a source comment stating that event records
remain a later work unit. TAB5-10 is therefore not a V3 regression — the device has
never written an event record. There is no working V2 path to reuse, only a
well-specified contract and a ready transport.

### TAB5-12 — No memory instrumentation · LOW PRIORITY (RAM concern measured and closed)
**Measured 2026-08-30 on the device, after the engine was running:**

```
gc.mem_free()  = 23,308,688   (~23.3 MB)
gc.mem_alloc() =    272,112   (~272 KB)
```

PSRAM is active and there is roughly **86x headroom**. The 272 KB allocated already
includes the parsed 192 KB `pilot.py`. **The RAM concern raised before the first load
was unfounded — do not re-raise it.** Growth of `pilot.py` at this scale is not a
constraint, and no work should be shaped around it.

The remaining item is only that `gc` is not imported and nothing reports memory, so a
*trend* (a slow leak over days) would still be invisible. Worth adding when convenient,
not now: `import gc`, log `gc.mem_free()` once at end of boot and on a slow cadence
(every N cycles). Do not call `gc.collect()` inside the one-second loop.

### TAB5-1 — System-field assignments are sent to the device executor · CONFIRMED
`OperatingMode` is an `assignmentTarget` system field, so `resolve_rules_v3_package()`
puts it in `writableTargets` alongside `PumpEnable`. It has no `write` block and
therefore no `method`, so `issue_rules_v3_action()` returns `unsupported-method:None`.

Because that is not `issued`, the action is never recorded in `rules_v3_last_actions`,
so it is retried and logged **every cycle** for as long as Monitor is active.

Fix direction must be reconciled with the new generic design: internal system-field
assignments must be distinguished from physical device writes, but do not merely add a
Monitor-specific exception. Carry the distinction through the generic resolver/executor contract.

### TAB5-2 — Only one issued action is remembered between cycles · CONFIRMED
`rules_v3_last_actions = [signature]` replaces the whole list with a single entry
(`tab5/pilot.py` ~4187). If a cycle issues writes to two different targets, only the
last is remembered, so the other re-issues every cycle.

Fix direction: treat this as generic per-target executor state and reconcile reset
behavior at package adoption/reboot. Do not solve it only for today's single Shelly target.

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

Reconcile any fix with the new package validation/adoption and current-evidence model;
do not let maintained/default values masquerade as fresh evidence.

### TAB5-6 — Boyle tank outputs are permanently `None` · KNOWN TBD
`evaluate_runtime_calculations()` sets every `kind: "function"` output to `None`.
`TankWaterGallons`, `PressureSlopePSIPerMinute`, `TankNetFlowGPM`, `PumpOffDemandGPM`,
`TankFlowQuality`. No enabled rule reads them today. Deferred work unit, not a defect.

Review this as part of the generic Functions/history design in the consolidation handoff:
simple calculations use the current frozen snapshot; history-dependent logic belongs in
approved bounded Functions with explicit history consumers and reset boundaries.

### TAB5-7 — Executor retries are unbounded · OPEN
A failed write is retried every cycle with no backoff and no attempt ceiling. If the
Shelly is unreachable this is one HTTP attempt per second indefinitely.

Fix belongs in the generic executor: bounded retry/backoff and clear failure status,
without blocking the one-second semantic cycle.

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

### ONLINE-7 — Verify the ingest path accepts V3 event records end to end · OPEN
Pairs with TAB5-10. `ingest-record.js` already writes any non-observation record to an
`eventRecords` collection, and `contracts/event-record-v1.schema.json` is fully
specified, so this may need nothing beyond confirmation. Worth checking before the
device work lands, so the device session is not writing against an untested receiver:

- does `ingest-record.js` validate against `event-record-v1` for `event-open` /
  `event-close`, or does it only validate observations?
- are there Firestore security rules on `eventRecords`?
- does anything read that collection today?

Do this **first** if both sessions run in parallel — the device record shape depends on
the answer.

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
