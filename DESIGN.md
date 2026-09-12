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

V3 is the target and is progressively replacing V2. Once V3 owns event evaluation
and device writes, the normal loop must not execute V2 events or silently fall back
to V2 authority. Script-supplied Shelly lock evidence is required before any V3
re-enable write; absence or invalidity cannot authorize that write.

## Shared records

Pilot publishes an immutable runtime package and a pointer identifying its exact
bytes, hash, length, and download path. Tab5 validates and stages a package before
it can adopt it. Tab5 emits current and selected durable observations. V3 event transitions are
currently printed locally; durable V3 event production/retention/browser work is
still incomplete. The event-record interface is not proof of that integration.

Existing versioned record meanings do not change silently. An incompatible record
gets a new version.

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

The Shelly 1 read record joins two sequential RPC responses from one acquisition
cycle. It is intentionally not described as a simultaneous hardware snapshot.
Dynamic script number components are discovered by name; Tab5 reads but never
resets or manipulates them.

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

The runtime package's named logging policies govern script lock/count values.
Their raw observation aliases do not independently select every value change.
Other material changes, confirmed acquisition-availability transitions and the
maximum durable interval can still select records containing the current values.
Delta comparisons retain the existing previous-durable-observation baseline.

## Event meaning and remaining mode integration

Closing policies are independent owner choices, not automatically the inverse of
opening conditions. S010 is an informational alarm for relay ON while locked and
remains open until relay ON with lock zero. It never takes relay ownership.

Normal and Monitor are the two kernel modes. Intended Monitor continues observation,
calculation, logging, event evaluation and ownership bookkeeping while suppressing
Tab5 inhibit application. Operator and required-source owners must be reconciled;
operator Normal must not clear a bad-source owner. Web requests, Clear Events and
required-source occurrence inputs remain incomplete, and require separate design
review before integration. System Override is removed from the intended design.

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
