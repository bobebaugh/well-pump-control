# Minimal Tab5 lock and Monitor design — implementation handoff

Revision 5 — implemented, 2026-09-14. Revision 4 was the pre-implementation
handoff; this revision records the corrections agreed at the bounded review and
the behavior actually built.

**Status: implemented on `pilot-working` and `tab5-working`; not installed and
not deployed.** This supersedes `lock-coordination-design-proposal.md` and
revisions 1–4 of this file where they differ. Git history preserves the review
discussion. The browser simulator is an experimental proposal model, not a
reference implementation or proof of installed behavior.

Source publication does not install Tab5 files, publish or deliver a rules
package, change Firebase, or operate hardware. Each remains a separate owner
action.

### Corrections agreed at review and carried into this revision

- **Short-cycle scoring (§2).** Deliberate Tab5 inhibition drops the contactor
  and produces a falling pump-input edge. The script must not score that as a
  short cycle; three would otherwise reach the permanent lockout only a person
  can clear. The suppression is driven by a latched cause recorded when the
  script opens RLY0, not by a level read of the flag at edge time.
- **Authoritative reconciliation (§5.1).** The final named reconciliation removes
  every competing action for the inhibition target before appending its value.
  The ordinary action collapse prefers a non-normal value, and the flag's normal
  value is `false`, so appending a release beside an inhibit would silently keep
  the inhibit.
- **Unknown versus invalid (§5.2).** Absent evidence and an unevaluable clause are
  distinct. Unknown participates in three-valued all/any; a structurally invalid
  or unsupported clause still rejects the whole condition and is never outvoted
  by a definite sibling.
- **Ownership checks after RLY0 becomes read-only (§6).** `pumpTarget` no longer
  resolves. Operator handling, relay diagnostics and observation status read the
  inhibition target instead, so User Monitor still reports restoration honestly
  rather than inferring "not needed" from an absent target.
- **Command attribution (§6).** System Monitor holds the same mode target as User
  Monitor. Command completion is tied to the user's own Monitor event instance,
  never to effective mode, and pending result state is resolved through
  completion or failure.
- **Monitor evaluation (§6).** In Monitor, non-monitor events are not evaluated at
  all; their state and qualification counts are carried untouched, neither
  advanced nor reset. Monitor-class events continue to run so System Monitor can
  exit and logging-only monitor events keep highlighting conditions.
- **Qualification values (§7).** Transient-disable qualification is authored
  configuration. The intended package clears E007 on ten reads; thirty is an
  acceptable maximum. No count is hard-coded and no new validation ceiling is
  added — the tests read the authored value from the package.
- **Maintenance interruption (§8).** A Shelly reboot physically drops its relay
  and can interrupt a running pump. That interruption is accepted. No manual
  relay-close procedure is added, and no Shelly lock is ever overridden.

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

Mechanical and hardwired controls remain in place. RLY0's power-on default is
OFF/open. The script initializes `Tab5IsLocked` false and holds RLY0 open for five
seconds, during which Tab5 may reassert an outstanding hard lock. If it does not,
the script closes RLY0 and starts normal processing when the delay expires.

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

The new Boolean is non-persisted and defaults false. The script writes that false
seed during initialization, then polls the value once a second for Tab5 changes.
The five-second hold-open window lets Tab5 reassert a hard lock before false may
close RLY0. A missing/unusable Boolean handle removes Tab5's contribution only; it
must never clear or override a nonzero Shelly lock.

Preserve the existing short-cycle algorithm. `MinRuntime`, `InitLockTime`,
`MaxLOcntr`, `TimeToResetLOcntr`, and `InitDelay` are constants at the beginning of
the script so the owner can edit them in the Shelly script editor. Only
`IsLocked`, `loCntr`, and `Tab5IsLocked` are declared in `@meta`.

**A commanded stop is not a short cycle.** Applying Tab5's inhibition opens RLY0,
which de-energizes the contactor and produces a falling SW edge indistinguishable
in shape from a real short cycle. Scoring it would let ordinary protective action
accumulate strikes toward the permanent lockout. The script therefore latches why
it opened the relay at the moment it issues the call, and a stop that follows its
own Tab5-applied open scores nothing.

The latch, not a level read, is what makes this correct in both directions. Tab5's
intent may be withdrawn before the contactor edge is processed, so the reason has
to outlive the intent. Equally, a genuine short cycle that merely coincides with
an intent the script has not yet applied still scores, because the latch is false.
The relay policy is evaluated against the observed output, so steady state costs
no `Switch.Set` call and each transition costs exactly one; an unreadable output
is not a mismatch and produces no call.

After a commanded stop the run timer restarts when the relay recloses, so a Tab5
inhibition grants a fresh `MinRuntime` allowance. That follows from preserving the
existing algorithm unchanged and is accepted in this unit.

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

The GetStatus/GetComponents pair is replaced by a single filtered GetComponents
request naming switch:0, input:0 and the three named virtual components'
discovered keys, with configuration and status included. A known mapping costs
exactly one request per cycle and no GetStatus at all.

Discovery is a bounded exception, not a retry hidden inside every cycle: it runs
on the first cycle and after the mapping is invalidated, and costs one extra
request on those cycles only. The name and type mapping is verified in every
reply; a reply that contradicts it discards the mapping so the next cycle
rediscovers by name.

A remote acquisition failure does not prove the components moved or disappeared,
so a transport failure keeps the mapping while a contradicting reply discards it.

**Acceptance is presence-checked, not derived from `total`.** Every requested key
must be present and verified; anything missing rejects the acquisition. The owner
captured the unfiltered call paginating — `offset` 0, `total` 20, twelve
components returned, `switch:0` absent from the first page — which is why the
keys filter is required rather than merely faster. What `total` means under that
filter is not yet established by a captured response, and presence-checking is
correct under either meaning, so no acceptance rule depends on it.

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

Discovery matches a `boolean:<id>` entry whose `config.name` is exactly
`Tab5IsLocked`, requires `status.value` to be a Boolean, and takes the id from the
key. Missing, duplicate, wrong-typed and malformed matches all reject the mapping.
The id is never authored or hard-coded; the owner observed `IsLocked` move between
ids across a rebuild. Host tests use a clearly labeled documentation-based fixture
(`tests/fixtures/shelly1-getcomponents-documentation.json`); a captured
`Shelly.GetComponents` response confirming the boolean shape is an installation
acceptance check recorded before cutover step 4 is accepted, not a prerequisite
for the parser.

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

**The reconciliation is authoritative, not a peer.** Every other action for this
target is removed before the reconciled value is appended, so the flag never
reaches the ordinary collapse with a competitor. This is not belt-and-braces: the
collapse prefers a non-normal value, and this target's normal value is `false`, so
a release appended beside an inhibit would be the one discarded. The authoring
restriction in §4 is then defence in depth rather than the only defence. The final
selected flag action agrees with the resulting mode and ownership, and no direct
relay action may accompany it.

An action is emitted only when this cycle's observed flag differs from the desired
value, so a correct steady state produces no write. Absent evidence produces no
action at all: reconciliation resumes when communication returns rather than
writing blind.

### 5.2 Three-valued all/any

Evaluate valid clauses to true, false or unknown:

- all: any false means false; otherwise any unknown means unknown; otherwise true.
- any: any true means true; otherwise any unknown means unknown; otherwise false.

Missing evidence stays unknown; it is never replaced with a normal measurement.
This applies to opening, closing and guarded conditions.

**Unknown and invalid are different results.** Unknown means the evidence is
absent this cycle — the field has no value, or a changes-type clause has no prior
value. Invalid means the runtime cannot evaluate the clause at all: an unsupported
operator, a malformed comparison, or a declared number that arrived as something
else. Unknown participates in the aggregation above. Invalid rejects the whole
condition exactly as before, in any clause position and in either mode, and is
never outvoted by a definite sibling. A clause that could not be read must not be
rescued by one that could.

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
1. Mode carried into the cycle selects evaluation: in Monitor, non-monitor events
   are not evaluated at all. Their active state, instance, owners and
   qualification counts are carried untouched — neither advanced nor reset — so a
   condition arising during Monitor cannot open one, and one open on entry is
   neither closed nor erased.
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

**Command attribution.** The operator-control result contract is unchanged, but
its inputs are. System Monitor now holds the same mode target as User Monitor, so
effective mode no longer identifies who asked. Completion is tied to the live
instance of the user's own manual Monitor event; a request that is accepted but
whose event does not open is failed explicitly rather than left pending for
something else to satisfy later. Relay restoration is reported only for the
user's own request, and still requires fresh physical evidence — a fresh
`islocked = 0` with RLY0 observed on. An accepted Monitor never proves RLY0 moved.

Observation status reports the two separately: `user_monitor_active` is the user's
own Monitor instance, and `monitor_mode_active` is the effective mode from any
owner. No new command protocol is added.

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

**Pump permission may be interrupted during the interval, and that is accepted.**
Restarting the Shelly physically drops its relay open, which stops a running pump.
Between stopping the old Tab5 files and starting the new script, RLY0 also keeps
whatever state it was last left in, and no software is in a position to close it.
No manual relay-close step is added to avoid this, and no Shelly lock is ever
overridden to shorten it. Mechanical and hardwired controls, the pressure switch,
the on-delay, the max-runtime limit and the HAND bypass all remain in front of the
relay throughout.

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

Before rollout, the owner accepts the maintenance interval, the possible
interruption of a running pump, and the deliberate System Monitor release
posture, including H001/E007 reassertion on recovery. The script-stopped relay
behavior remains unproven; no automatic release claim depends on it.

Two device observations remain acceptance checks rather than source evidence, and
neither is fabricated in the repository: a captured `Shelly.GetComponents`
response showing the `Tab5IsLocked` boolean in the documented shape, and a
captured `Boolean.Set` HTTP GET response confirming the bare `null`
acknowledgement. Host tests use a clearly labeled documentation-based fixture and
prove the parser's decisions, not the device's answers.

This handoff chooses Boolean, named reconciliation, schema v3 with strict support
gates, same-cycle dispatch, retained ownership, and separate cleanup. Do not
reopen those choices without a concrete implementation blocker.

**Where Shelly lock evidence is now required.** Under the previous design Tab5
re-closed RLY0 itself and refused without a fresh `islocked = 0`. Tab5 no longer
writes the relay, so withdrawing its flag states only that Tab5 is done
inhibiting; it is not gated on the Shelly lock, and a nonzero or unavailable lock
still holds RLY0 open because the script enforces it. The fresh-evidence
requirement is unchanged where it still applies: confirming a Shelly restart, and
confirming relay restoration for a User Monitor request.

## 10. Implementation record

The bounded review in revision 4 §10 was completed and its findings are carried
into the sections above. The unit is implemented on `pilot-working` and
`tab5-working`.

What remains owner-directed and is not done by this unit: promotion to `pilot`
and `Tab5`, Pilot deployment, publication and delivery of the revised rules
package, Firebase changes, installation of Tab5 files, device restarts, and any
hardware operation.

Outstanding acceptance evidence, to be recorded before the cutover is accepted:

- a captured `Shelly.GetComponents` reply showing `Tab5IsLocked` as a
  `boolean:<id>` component with `config.name` and a Boolean `status.value`;
- a captured filtered `keys=[...]` reply, which also settles what `total` means
  under that filter (no acceptance rule depends on it either way);
- a captured `Boolean.Set` HTTP GET reply confirming the bare `null`
  acknowledgement;
- observed relay behavior across a Shelly reboot with an inhibition outstanding.

Host tests prove decisions, not device answers. They do not establish actual
Shelly response shapes, installed reset behavior, relay motion, or cycle latency.
