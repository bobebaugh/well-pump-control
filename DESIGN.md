# Operating design

## Two applications, one local system

The project has two coordinated applications:

- **Pilot** owns the browser HMI, authoring, Netlify functions, Firebase/Firestore
  records, and publication of immutable runtime packages.
- **Tab5** owns local observation, calculation, event evaluation, package
  validation/adoption, device-facing behavior, and outbound records.

They remain separate product lines. They communicate only through the versioned
records in `interfaces/`.

## Safety boundary

Mechanical and hardwired controls remain authoritative. Tab5 must never create
ordinary pump demand. Pilot, Netlify, Firebase, RTDB, and network availability are
never required for immediate protection.

Unavailable or incomplete evidence remains unavailable. It is never converted into
a safe value or an unlocked control state.

One deliberate, owner-selected exception is scoped to Tab5's own inhibition intent:
a missing or unusable `Tab5IsLocked` component removes Tab5's contribution rather
than holding the relay open, and the flag defaults false on a Shelly reboot until
Tab5 reasserts an outstanding inhibit. This is fail-permissive for Tab5's intent
only. It never clears, overrides or substitutes for the Shelly's own `IsLocked`
protection, which continues to hold RLY0 open on its own authority, and it never
converts unavailable measurement evidence into a value.

V3 is the target and is progressively replacing V2. Once V3 owns event evaluation
and device writes, the normal loop must not execute V2 events or silently fall back
to V2 authority.

The Shelly 1 script is the sole writer of RLY0. Tab5 publishes its inhibition as
the `Tab5IsLocked` Boolean and writes nothing else on that device. The script
closes RLY0 exactly when `IsLocked == 0 AND Tab5IsLocked == false` and opens it
otherwise, acting only when the observed output differs. Withdrawing Tab5's flag
states only that Tab5 is done inhibiting; it is not gated on the Shelly lock,
because a nonzero or unavailable lock still holds the relay open on the script's
own authority. Fresh, valid `islocked = 0` evidence remains required where it
still governs a claim about physical state: confirming a Shelly restart, and
confirming relay restoration after a User Monitor request. A commanded stop that
applies Tab5's inhibition is not a short cycle and scores no strike.

## Shared records

Pilot publishes an immutable runtime package and a pointer identifying its exact
bytes, hash, length, and download path. Tab5 validates and stages a package before
it can adopt it. Tab5 emits current and selected durable observations plus a
complete sparse current-event board. Pilot derives and retains v2 open/close
history from accepted boards. Event browsing and summaries remain later work.

Existing versioned record meanings do not change silently. An incompatible record
gets a new version.

The runtime package schema stays at version 3 for the inhibition write, with
method-discriminated write shapes and strict runtime-support gates rather than a
version bump. The gates make old and new control packages mutually incompatible:
a build rejects any package whose declared device objects or write shapes it
cannot execute, so the previous build refuses the revised package and this build
refuses a package that writes RLY0. That mutual rejection is the interlock the
coordinated cutover and both rollback paths depend on.

Tab5 writes exactly one device field: the `Tab5IsLocked` Boolean on the Shelly 1,
through `Boolean.Set` on an id discovered by name. RLY(0) is observed, never
written; the Shelly script is the relay's sole writer. Authoring, the compiler,
the runtime-support gate and the static analysis all resolve that target by its
device binding rather than by its editable system name, so renaming it is safe and
an alias cannot create a second writer. Its only legal rule assignment is a held
opening request set to true; release is a consequence of ownership and mode.

The operator-control transport is a single replaceable RTDB slot, not a durable
queue. Command v2 carries a non-empty no-arguments payload marker so the complete
closed record survives an RTDB write/read round trip. The authenticated web
endpoint targets the latest device presence session and gives each request a unique
browser identity, command identity, monotonic sequence, and 45-second lifetime.
Forty-five seconds covers multiple passes of the 10-second coordination poll
without making an outage-delayed request useful. CPU B queue admission and CPU A
execution each reject a sequence at or below their current session high-water
mark; a stale request cannot replace a newer pending request. Tab5 also checks the
exact boot session, synchronized UTC expiry, and duplicate identity. A reconnect
cannot make an expired or old-session request execute. The stored result
distinguishes not delivered, accepted, confirmed completed, failed, and unknown.
A timeout after possible execution is unknown and is never automatically retried.
Online Tab5 restart persists the exact accepted request before reset, and the new
session reports completion from that marker. A session change without the matching
result remains unknown; it never confirms an old request.

Durable observation v2 contains a small identity/time/release header and the fixed
set of every logging-enabled Device, Calculated, and System field in the running
package. Unavailable selected fields stay present with a reason. Change and Delta
compare with the last available value in a successfully admitted RAM record;
Include never independently triggers and None is excluded. Field, event-boundary,
session-start, and ten-minute reasons coalesce into one pre-dispatch record per
cycle. Schema-v1 ingestion remains valid during rollout.

CPU A publishes a complete sparse current-event board from committed kernel state
after first evaluation, changes, and about every 30 seconds. CPU B transports one
replaceable latest board independently of the 100-record / 384-KiB oldest-first
observation FIFO. Pilot immediately reconciles strictly newer complete boards in a
Firestore transaction and derives deterministic v2 open/close history. Silence
never closes; inferred and restart ends have unknown device close time. A monotonic
accepted-board revision prevents delayed RTDB mirrors from overwriting newer state.
Neither channel acknowledges or controls the local kernel, and neither guarantees
delivery of the other.

For the initial real-world V3 pilot, package adoption is restart-only. A successful
download stages the next package atomically and does not replace the running
kernel. Restart validates and adopts the last valid staged file with fresh event,
ownership, and calculation state. Reports keep running and staged identities
distinct and describe execution according to the running source behavior.

Validation of a downloaded candidate includes runtime support and package
resolution before it may replace the staged file. Schema validity alone is not
enough; unsupported drivers, bindings, calculations, or event behavior preserve
the previous staged bytes and identity.

A device RPC acknowledgement means only that the request received a recognized
success response. It is not evidence that the requested physical state was
observed. Each bounded cycle compares the desired state with its fresh observation
and retries while ownership and lock rules still authorize the action.

Operational numeric evidence and calculation results must be finite. Raw ADC data
may remain available for diagnosis, but it cannot establish operational pressure
or flow unless ADC validity and pressure-sensor commissioning are both true.
Invalid pressure evidence breaks calculation history; recovery uses fresh history.

Pilot validates current and prospective publication state before any V3 delivery
pointer or state write. Legacy publication state is not silently upgraded during
delivery; the owner must publish again under the current schema.

The Shelly 1 read record comes from one filtered `Shelly.GetComponents` request
naming every component the cycle needs. Discovery by name is a bounded exception
on the first cycle and after the mapping is contradicted, not a retry inside every
cycle. Acceptance requires every requested component to be present and verified;
a short page is never read as valid absence, and no acceptance rule depends on
`total`, whose meaning under a keys filter is not yet established by a captured
response. Dynamic components are discovered by name and their ids are never
authored; Tab5 reads the script's numbers and never resets or manipulates them,
and writes only its own `Tab5IsLocked` Boolean.

One response reduces latency but is still not a guaranteed simultaneous hardware
snapshot; read-to-write races remain possible and later cycles reconcile them.

## Work and acceptance

Work proceeds one bounded unit at a time on a reusable working branch. The owner
reviews behavior through the application and stored Firestore/RTDB data, supported
by the agent's tests and evidence. Promotion to an operating branch is a separate
owner decision.

## Local diagnostics

Shelly read diagnostics identify the request and failure stage without creating
new runtime fields. A diagnostic failure does not retain stale operational evidence
or alter acquisition acceptance. Repeated failures are counted with bounded print
output and recovery is reported. Relay diagnostics observe existing kernel and
snapshot decisions; they never create an action or change pending release state.

## Acquisition availability and lock logging

`$availability` represents Tab5's complete acquisition result, not a measurement
supplied by the remote device. For each enabled device declaring it, that Boolean
remains available to V3 conditions even when all device measurements are rejected.
Rejected or absent measurement evidence never supplies a default lock or relay
state. Existing Boolean health events can therefore qualify failure and recovery;
this does not introduce internal occurrence generation.

The running package's named logging policies govern durable content and field
selection for Device, Calculated, and System fields, including script lock/count
values. Raw observation aliases and legacy material/availability tests do not
independently select records. Change and Delta compare against the last available
value in a successfully admitted durable observation; missing or recovery alone
does not trigger. Session start, event boundaries, and the maximum interval are
the only additional selection reasons.

## Event meaning and operator mode

Closing policies are independent owner choices, not automatically the inverse of
opening conditions. S010 is an informational alarm for relay ON while locked and
remains open until relay ON with lock zero. It never takes relay ownership.

Normal and Monitor are the two kernel modes, and both User Monitor and System
Monitor reach Monitor by owning the same operating-mode target. Monitor continues
observation, calculations, logging and ownership bookkeeping while releasing
Tab5's physical inhibition.

In Monitor, non-monitor events are not evaluated at all: their active state,
instance, owners and qualification counts are carried untouched, neither advanced
nor reset. A condition arising during Monitor cannot open one, and one open on
entry is neither closed nor erased. Monitor-class events continue to run, so
System Monitor can exit and logging-only monitor events keep highlighting
conditions. Two cycle decisions remove event-order dependence: the mode carried
into the cycle selects what is evaluated, and the mode after evaluation selects
the final flag value. Monitor opening on a cycle releases at that cycle's
dispatch; on exit, retained ownership can reassert in the exit cycle before
non-monitor evaluation resumes on the next.

User Monitor is entered through the package's manual Monitor occurrence. Entry
does not wait for the triggering condition to recover and does not close the
inhibiting event. Because System Monitor holds the same mode target, a user
command's completion is tied to the user's own Monitor event instance rather than
to effective mode, and relay restoration is reported only for that request and
only from fresh physical evidence. An accepted Monitor request does not prove
RLY0 moved. User Monitor lasts until an actual Tab5 restart. There is no Monitor
OFF or Clear Events control in this unit.

Tab5 restart uses the supported whole-device reset, so CPU A and CPU B begin a new
session and V3 starts with a fresh event/owner/calculation board. Conditions may
qualify again. A different valid staged package may be adopted by the existing
restart-only path; configuration, staged bytes, credentials, and unrelated
persistent state are not erased. Shelly 1 restart uses its supported `Shelly.Reboot`
RPC through the same operator-command architecture. Acknowledgement is only
accepted; confirmed completion requires a later fresh `islocked = 0` acquisition.
Full (`-1`), temporary (positive seconds), normal (`0`), and missing/invalid
(unknown) lock evidence remain distinct, and `locntr` is reported separately.
Restart creates no ordinary pump demand and no anti-short-cycle algorithm is
implemented here.

System Monitor automatic actuation remains deferred under issue #6. Missing
telemetry neither releases a latched inhibit nor proves or advances recovery.
Existing closing conditions and explicit availability fields remain unchanged;
no internal occurrence generation or timeout-based release is added.

An event closes only while open. Subsequent relay restoration/confirmation is
separate kernel/dispatch work, subject to current lock evidence and other owners.
Do not infer repeated closing-condition evaluation from a delayed relay write.

## Configuration backup and publication workflow

A versioned complete authoring backup is the long-term recovery source. One Load
popup offers Seed, Last saved, the 10 most recent published versions, and Backup
JSON. All sources replace browser working rules only. Load → Last saved discards
unsaved work; Save Draft atomically replaces all four saved sections with revision
checks regardless of the load source. Loading/Validate never save. Saving a backup
can initialize an empty V3 authoring store without seeding. Structural invalidity
blocks load/save; complete unfinished authoring remains editable but cannot publish.
AI additions use a revised complete backup, not additive merge. Runtime JSON is
not an authoring backup. Showing 10 versions does not introduce retention/deletion.

Publish and Deliver validates working rules, asks about warnings, saves, and
creates a new immutable version on every deliberate publication, even if unchanged.
Retry delivery reuses the current version. Interrupted publication attempts are
reconciled by readback, never blindly retried. Online validation targets M6.33;
existing Tab5 integrity/support checks remain. Publication, delivery request and
last-reported desired/staged/running remain distinct; restart activates a package.
Status reads distinguish missing, invalid, timeout, configuration, denied and other
read failures without fabricating identities. No exchanged schema, mode input,
Firebase rules or installed Tab5 change is introduced by this workflow.
