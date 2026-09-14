# Minimal Tab5 lock and Monitor design — implementation handoff

Revision 4 — consolidated after three reviews, 2026-09-14.

**Status: design, not implemented.** This is the controlling handoff for the
proposed unit. It supersedes `lock-coordination-design-proposal.md` and revisions
1–3 of this file where they differ. Git history preserves the review discussion.
The browser simulator is an experimental proposal model, not a reference
implementation or proof of installed behavior.

The owner requested this consolidation for a fresh implementation session.
That session first conducts the bounded final review in §10. This document
does not itself authorize implementation, promotion, installation, publication
of a rules package, or hardware actions.

## 1. Goal and boundaries

Use two separately owned flags instead of a shared lock counter. Reuse the
existing event ownership, acquisition, dispatch, package staging and operator
command machinery. Keep ordinary steady-state I/O to one Shelly acquisition
request and no write when the flag is already correct.

Three coordinated changes:
- A: Tab5 writes its own Boolean inhibition flag; Shelly alone writes RLY0.
- B: conditions use three-valued all/any logic.
- C: Monitor suspends non-monitor event processing and releases Tab5's physical
  inhibition while retaining its event and ownership evidence.

Changes span Tab5, the Shelly script, Pilot authoring/support validation, mirrored
contracts and the revised rules package. This is a hard compatibility cutover.

Out of scope: shared counters, counter field types, dead-code removal, a durable
command queue, changes to restart-marker transport, new Clear Events/Monitor OFF
controls, ADC filtering changes, sample-period changes, and a general system-wide
coordination framework. Consolidating the Shelly acquisition is in scope; other
loop optimization is separate.

Mechanical and hardwired controls remain in place. The owner-selected posture
permits operation after a Shelly reboot until Tab5 reasserts an outstanding
inhibit. Power-on RLY0 stays ON/closed; no five-second startup hold is added.
Boot/recovery exposure is not bounded to one cycle during lost communication.

## 2. Fields and authority

| Field | Writer | Meaning |
| --- | --- | --- |
| `IsLocked` | Shelly script | -1 permanent, 0 clear, positive seconds remaining |
| `loCntr` | Shelly script | accumulated short-cycle strikes, not active ownership count |
| `Tab5IsLocked` | Tab5, apart from Shelly initialization | Boolean aggregate of Tab5's effective inhibition |
| RLY0 | Shelly script only in the new configuration | observed relay command state |

Use `Tab5IsLocked` consistently for the component name. Earlier proposal names
`Tab5Lock` and `LoRequestCnt` do not define additional components.

The Shelly script requests RLY0 closed exactly when:

```
IsLocked == 0 AND Tab5IsLocked == false
```

Otherwise it requests RLY0 open. Only issue a relay RPC when observed output
differs from this policy. RPC acceptance and firmware-reported output are not
proof of physical contact position.

The new Boolean is non-persisted, defaults false on Shelly reboot, and is read
by the script. A missing/unusable Boolean handle removes Tab5's contribution
only; it must never clear or override a nonzero Shelly lock.

Preserve the existing short-cycle algorithm and its settings in this unit unless
the owner separately authorizes their alteration. The script must not reset the
Boolean repeatedly after initialization.

**Power-on ON is not script-failure recovery.** If the script opens RLY0 and
stops, do not claim it will close automatically. Treat the relay as retaining
its last state until demonstrated otherwise. A Shelly reboot and the physical
bypass remain separate owner actions.

## 3. Acquisition and dispatch

### 3.1 Bindings and observation

Add the exact binding:

```python
'UDF(Tab5IsLocked)': ('boolean', None, 'readWrite')
```

Map it to `values.shelly1_tab5lock`. Change `RLY(0)` to read-only telemetry;
remove its authored write definition in the revised package. Conditions and
logging may still observe `PumpEnable`.

Discover `IsLocked` and `loCntr` as named number components and
`Tab5IsLocked` as a named Boolean component. Validate type, value, uniqueness
and component identity. Carry the discovered Boolean ID with that acquisition
for dispatch; never author or hard-code its dynamic ID.

The acquisition remains all-or-unavailable. A missing, duplicate, malformed or
incomplete required component rejects the acquisition and authorizes no flag
write. Include the new value in normal observation construction and existing
package-selected durable logging. Keep dynamic routing metadata separate from
the authored rule value.

### 3.2 One acquisition request in steady state

Consolidate the existing GetStatus/GetComponents pair into a filtered
GetComponents request containing switch:0, input:0 and the three named virtual
components' discovered keys, with configuration and status included.

Discovery and recovery may require additional requests. Bound those exceptions;
do not hide retries inside every cycle. Verify the name/type mapping in the
reply, invalidate an obsolete mapping, and resume normal filtered reads only
after discovery succeeds. Do not write using a rejected mapping.

Handle pagination and `total` explicitly. Confirm the filtered endpoint's
actual count semantics and record a representative response. Do not interpret a
short page as valid absence. A remote acquisition failure does not make the
script's local virtual-component handle disappear.

One response reduces latency but is not a guaranteed simultaneous hardware
snapshot. Read-to-write races remain possible; later cycles reconcile them.

### 3.3 Boolean write and acknowledgment

Dispatch `Boolean.Set` using the ID from this cycle's accepted acquisition,
the existing configured Shelly target, GET-style RPC and bounded timeout:

```
/rpc/Boolean.Set?id=<discovered-id>&value=true|false
```

Compare the requested Boolean against this cycle's
`values.shelly1_tab5lock` first. Equal means no RPC. An unavailable acquisition
means no RPC. There is no immediate readback and no same-cycle retry.

For this HTTP GET path, require HTTP 200 and parsed JSON `null` for
`acknowledged`. Reject malformed/unrecognized responses; report structured
RPC errors separately. Do not accept arbitrary error-free JSON, `{}`, or an
invented envelope as success. Add another accepted representation only with
evidence from the supported transport.

Shelly's documented HTTP GET example returns `null`:
https://shelly-api-docs.shelly.cloud/gen2/DynamicComponents/Virtual/Boolean/

Keep acknowledgment distinct from subsequent observed flag state and relay
restoration. Preserve resource cleanup on success, parse failure and timeout.
Do not change existing operator command expiry, replay or restart semantics.

The old Switch.Set dispatcher may remain as unused compatibility code, but the
new accepted running configuration must provide no rule-driven RLY0 write path.
Its existing response handling need not be generalized.

## 4. Contract, validation and authoring

Use two exact, method-specific structural write shapes:

| Method | Parameters | Normal value for this supported target |
| --- | --- | --- |
| `Switch.Set` | `{"id":0,"valueParameter":"on"}` | true |
| `Boolean.Set` | `{"valueParameter":"value"}` | false |

The schema branches must be discriminated by method and remain closed to
unexpected properties. Do not make ID optional for arbitrary methods. Do not
add `componentName`: the object `UDF(Tab5IsLocked)` already supplies the name.

Preserve structural validation of the legacy switch shape, but the **new
runtime support gate** rejects RLY(0) as readWrite. Structural validity is not
runtime support.

Update all applicable schema copies, both branches' mirrored interfaces, Pilot
authoring/compiler/support checks, Tab5 `_v3_write`,
`_rules_v3_runtime_supported`, resolver and assignment checks. The file list
must be verified from actual callers rather than assumed complete from names.

**Version decision for this handoff:** retain runtime schema version 3 for this
narrow structural extension, with explicit new firmware/support requirements.
Do not describe this as old-firmware compatibility. Prove that old firmware
rejects the new package and new firmware rejects the legacy control package.
If those gates cannot reliably distinguish them, stop final review and propose
the smallest explicit version/capability change; do not silently weaken checks.

Allow the editor's Boolean write defaults only for the supported object, not
every Boolean UDF. The new flag's only legal rule assignment is:

```
onOpen: Tab5IsLocked = true, whileOpen
```

Reject true/transition, false with any ownership, and onClose assignments to
this target, including assignments inside guarded groups. Release is a
consequence of ownership/mode, not an explicit false assignment.

Resolve the target by its exact device/object binding, not merely its editable
system name. Ensure one unambiguous target represents this physical Boolean;
do not let aliases create competing per-target writes to the same component.

## 5. Ownership and three-valued conditions

### 5.1 Named reconciliation

After event processing, reconcile only the new lock target:

```
desired = false if resulting mode is Monitor
          else true if any event owns the flag
          else false
```

Two or more owners still produce one Boolean intent. Removing one owner does
not release another. Removing the last owner emits false in **that cycle's
final dispatch**. A fresh Tab5 runtime with no owners reconciles an old true
flag to false; conditions still present requalify normally.

Do not reconcile every writable device field to its normal value. That would
undo unrelated transition assignments. Preserve their existing semantics.

Use existing action collapse, but ensure no earlier inhibit action can defeat
Monitor release. The final selected flag action must agree with resulting
mode and ownership. No direct relay action may accompany it.

### 5.2 Three-valued all/any

Evaluate valid clauses to true, false or unknown:

- all: any false means false; otherwise any unknown means unknown; otherwise true.
- any: any true means true; otherwise any unknown means unknown; otherwise false.

Missing evidence stays unknown; it is never replaced with a normal measurement.
This applies to opening, closing and guarded conditions. Preserve validation of
unsupported/malformed clauses and existing qualification policy.

Unknown does not advance or reset an observation count. Definite false resets
the relevant count; definite true advances it. Preserve existing minimumSeconds
and previous-value semantics unless a separate reviewed change is necessary.
A changes-type clause can be unknown even when current measurements are present,
because previous evidence is absent.

An explicit closing condition can now express:

```
any [ SupplyVoltage <= 266, ShellyEMAvailable == false ]
```

Keep the existing rule that an opening condition still true prevents a
condition-based close. Test this interaction rather than bypassing it.

## 6. Monitor semantics

Effective mode comes from ownership of the operating-mode target. A
monitor-class event does not engage Monitor merely because of its class.

- User Monitor: manual M001 owns Monitor, closes only on clearEvents; no
  exposed Clear Events operation exists, so exit remains Restart Tab5.
- System Monitor: H001 opens on `ShellyEMAvailable == false`, closes on
  `ShellyEMAvailable == true`, with explicitly authored qualification.
  It owns Monitor while open.
- Shelly 1 availability is not part of H001. S020 remains informational.
- Logging-only monitor-class events with no mode assignment remain valid and
  continue evaluating in Monitor.

Two cycle decisions remove event-order dependence:
1. Mode carried into the cycle selects evaluation: in Monitor skip non-monitor
   events, retaining their state and owners.
2. Mode after evaluation selects the final flag write.

Monitor opening on cycle n releases the flag at n's dispatch; non-monitor
suspension starts at n+1. On System Monitor exit, resulting Normal mode can
reassert retained ownership in that exit cycle's dispatch; non-monitor
evaluation resumes on the following cycle.

Both Monitor kinds suppress Tab5's physical inhibition. System Monitor doing
so is a deliberate change from the older design. Retained latched events are
not erased or closed by this suppression. If User and System Monitor both own
mode, System recovery alone cannot exit User Monitor.

Observation, calculation and transport continue. New non-monitor events are
not evaluated/recorded during suspension; monitor-class logging flags continue.
Do not fabricate event closures, acknowledgment or relay restoration.

If Shelly 1 is unreachable, the release write cannot land. Its stored Boolean
remains as observed/unknown, and reconciliation resumes when communication
returns. A mode change is not proof of restored water.

**Combined H001/E007 behavior:** once H001 engages Monitor, E007's closing
qualification freezes. It does not keep collecting its ten clearing reads.
H001 releases physical inhibition while retaining E007. On H001 recovery,
retained ownership can reassert before E007 resumes and qualifies closed.
Test this exact sequence. Test E007's ten-read missing-EM close separately with
H001 disabled; it is not the expected combined-package timeline.

Preserve the operator-control result contract. Review existing local/online
mode and relay-restoration reporting so a System Monitor is not falsely
reported as a user-issued command completion. General Monitor display wording
may need updating; do not add a new command protocol for this.

## 7. Focused verification

Run the relevant existing host suites, preserving live V3 staging, acquisition,
operator-control and durable-record coverage. No broad dead-code deletion or
test-count reduction is part of this unit.

Required regressions:
- New authoring package compiles, passes both sides' validators, stages and
  reloads; legacy switch schema shape remains structurally valid.
- Mutual runtime rejection of old/new control packages. No accepted new package
  can dispatch RLY0 writes. Flag aliases and illegal assignment forms reject.
- Named Boolean discovery, changing IDs, duplicate/missing/wrong-type fields,
  incomplete pages and recovery. No write with rejected acquisition metadata.
- HTTP 200/null acknowledgment; RPC errors, non-200, malformed JSON,
  unexpected JSON and timeout. No fabricated physical confirmation.
- Correct steady state produces zero writes; mismatch produces at most one
  flag write per cycle. No readback RPC. Retry only from a subsequent cycle.
- Multiple owners, last-owner same-cycle release, guarded true/false/unknown,
  Shelly reboot while held, and Tab5 restart with an old true Boolean.
- Unrelated transition assignments retain their established behavior.
- Three-valued truth tables with unknown first/middle/last, previous-value
  absence, qualification transitions and minimumSeconds preservation.
- Monitor entry/exit independent of event order; no pending inhibit defeats
  release; logging-only monitor events never engage mode.
- Retained board/owners through Monitor, simultaneous User/System owners,
  unreachable Shelly release, H001's complementary availability conditions,
  and the combined H001/E007 timeline.
- With no adoptable runtime, acquisition/cloud staging and required restart
  controls remain usable while no rule-driven device write occurs.
- Shelly relay truth table: both clear, either held, both held, local lock
  expiry with Tab5 still held, and missing Boolean with a local lock retained.
- Existing Pilot save/validate/publish/deliver, observation logging and operator
  results remain correct.

Use recorded supported-device responses where available; label documentation
fixtures versus owner-captured evidence honestly. Host tests do not prove actual
Shelly response shape, installed reset behavior, relay motion or cycle latency.
Hardware acceptance is a separate owner-run step, not an automatic agent action.

## 8. Rollout and rollback

Branch promotion is not installation. Deploy the compatible Pilot authoring/
validation changes before publishing the revised package. Prepare and retain
the exact prior Tab5 files, installed Shelly script, and prior authoring/runtime
package identities. Do not assume a previously reviewed script commit is the
one currently installed.

### Cutover

1. Install new Tab5 files and restart. Verify the old control package is
   rejected, no rules runtime is active, and no rule-driven RLY0 writes occur.
2. Install/start the new Shelly script; confirm old scripts that can write the
   relay are stopped. Verify all three virtual components by name and type.
3. Publish and Deliver the revised package through the compatible Pilot.
   Confirm its exact identity is staged on Tab5.
4. Restart Tab5 to adopt. Verify matching running identity, the new Boolean
   observation, one deliberate inhibit/release, and retained Shelly protection.

Until adoption, Tab5 contributes no rule protection. The owner must accept this
maintenance interval and control hardware testing. Mechanical controls remain.

A stopped/inert Tab5 is the interlock preventing two relay writers during
changes. If no-runtime staging does not pass its regression, do not improvise
this sequence on hardware.

### Rollback after completed cutover

1. Install old Tab5 files and restart only after confirming that the on-disk
   revised package is rejected by that old build. Confirm no rules runtime.
   When that state is uncertain, keep Tab5 stopped instead.
2. Stop the new Shelly script and restore the exact previous compatible script
   and component setup.
3. Restore/deliver the compatible previous package and confirm staging using
   the compatible Pilot workflow; restore Pilot support code if required.
4. Restart Tab5 and verify the previous running identity and behavior.

### Rollback during partial cutover

Do not assume the revised package is already on disk. Restarting old Tab5 may
immediately adopt an old package and resume RLY0 writes.

Keep Tab5 stopped until the previous compatible Shelly script is restored and
the new relay-writing script is stopped. Then restore the matching Tab5/package
combination and verify it. Do not leave the new script alongside old direct
relay control.

## 9. Documentation and remaining owner decisions

Update CURRENT.md and DESIGN.md on both affected product lines with actual
implemented behavior and verified state, not the older pending-deployment
narrative. Keep the simulator explicitly experimental until separately aligned.

Before rollout, the owner accepts the maintenance interval and the deliberate
System Monitor release posture, including H001/E007 reassertion on recovery.
The script-stopped relay behavior remains unproven; no automatic release claim
depends on it.

This handoff chooses Boolean, named reconciliation, schema v3 with strict support
gates, same-cycle dispatch, retained ownership, and separate cleanup. Do not
reopen those choices without a concrete implementation blocker.

## 10. Fresh-session final review and implementation entry

Read AGENTS.md, CURRENT.md, DESIGN.md and this file on the current working
branches. Verify branch tips once and preserve newer authorized work. Do not
reconstruct old conversations or use the simulator as the implementation oracle.

Before coding, perform one bounded review of:
- the exact contract/compiler/resolver path and mutual support rejection;
- absence of rule-driven relay writes after cutover;
- no-runtime staging/restart behavior and both rollback cases;
- final-mode reconciliation and the combined Monitor timeline.

Report only concrete blockers or contradictions. If none remain, say the plan
is ready and wait for the owner's implementation authorization, unless the
session's opening instruction already grants it. Ordinary implementation choices
within the authorized unit do not need repeated confirmation.

Develop on pilot-working and tab5-working under the existing one-process
workflow. Publish tested working-branch commits with concise evidence.
Promotion, rules-package publication, file installation, restarts and hardware
tests remain separately owner-directed.
