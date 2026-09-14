# Current status — Tab5 line

## Now — M6.38 Tab5IsLocked and Monitor unit awaiting owner review

The coordinated inhibition unit is implemented on `tab5-working` and
`pilot-working` but is not installed, delivered or deployed. Tab5 no longer writes
RLY0. It publishes its own inhibition as the `Tab5IsLocked` Boolean on the Shelly 1,
and the Shelly script becomes the sole writer of the relay, closing it exactly when
`IsLocked == 0 AND Tab5IsLocked == false`. A commanded stop that applies Tab5's
inhibition no longer scores a short-cycle strike; the script latches why it opened
the relay so a genuine short cycle coinciding with an unapplied intent still scores.
RLY0 now powers on open. The script seeds `Tab5IsLocked` false, holds the relay open
for five seconds so Tab5 can reassert a hard lock, and then begins normal one-second
processing. Its `@meta` declares only the three interface fields; the five tuning
values are owner-editable constants at the beginning of the script.

Conditions are three-valued across clauses: one definite false decides an `all`
and one definite true decides an `any`, whatever is unknown beside it. Absent
evidence stays unknown and advances or resets nothing. A structurally invalid or
unsupported clause still rejects the whole condition and is never outvoted.

Both User and System Monitor reach Monitor by owning the operating-mode target. In
Monitor, non-monitor events are not evaluated at all and their qualification
freezes; monitor-class events keep running so System Monitor can exit. The final
named reconciliation of the inhibition flag is authoritative: competing actions for
that target are removed before its value is appended, because the ordinary collapse
prefers a non-normal value and this target's normal value is `false`. Operator
command completion is tied to the user's own Monitor event instance, not to
effective mode, so a System Monitor cannot complete a user request.

Steady-state Shelly acquisition is one filtered `Shelly.GetComponents` request.
Discovery by name is a bounded exception on the first cycle and after the mapping
is contradicted. Acceptance requires every requested component to be present and
verified; no rule depends on `total`.

## Verification

- 215 Tab5 host tests pass, including 27 new cutover, authoring, three-valued and
  Monitor-timeline regressions. Coverage includes mutual rejection of the revised
  and legacy control packages in both directions, no-runtime staging and reload,
  rejection of any re-introduced relay write, alias and renamed-target resolution
  by binding, the illegal inhibition assignment forms, the combined H001/E007
  freeze/reassert/close sequence, E007's authored missing-EM close with H001
  disabled, two Monitor owners, unavailable evidence producing no write, and a
  fresh runtime reconciling an old true flag to false.
- 21 Shelly script tests pass. `tests/shelly1-anti-chatter.test.js` runs
  `shelly1/anti-chatter.js` in a stubbed Shelly runtime: five-second startup hold,
  hard-lock reassertion, exact three-component declaration, relay truth table,
  commanded-stop suppression, intent withdrawn before the edge, a genuine short
  cycle coinciding with an unapplied intent, the strikeout path, lock expiry with
  Tab5 still held, and a missing Boolean handle never clearing the local lock.
- Dispatch coverage: HTTP 200 with a bare JSON `null` is the only accepted
  acknowledgement; `{}`, arbitrary error-free JSON, non-200, RPC errors, malformed
  bodies and timeouts are all rejected. No readback, no same-cycle retry, at most
  one flag write per cycle, and none at all when the device already agrees.
- Qualification counts are read from the authored package in tests rather than
  restated. The intended package clears E007 on ten reads; nothing hard-codes it
  and no validation ceiling was added.
- Host tests prove decisions, not device answers. They do not establish Shelly
  response shapes, installed reset behavior, relay motion or cycle latency.

## Next

Owner review of the coordinated M6.38 source and test sequence, then the cutover in
§8 of `docs/minimal-tab5lock-and-monitor-design.md`. Installation, restart, Pilot
deployment, package delivery/adoption and branch promotion remain separate
synchronized owner actions.

A filtered `keys=[...]` reply has now been captured from the device and is
recorded in `tests/fixtures/shelly1-getcomponents-documentation.json` as
`capturedFilteredResponse`. It establishes that the filter works and returns
`switch:0`, that `total` under the filter is the matched count rather than the
device-wide count, that `switch:0` and `input:0` carry `status.output` and
`status.state` in the components envelope, and that components are not returned in
the requested order. Acceptance remains presence-checked and consults no count.

Two further captures closed the remaining acquisition questions. A filtered request
naming a key the device does not have returns that key **silently omitted** - no RPC
error, four components and `total` 4 for a five-key request - so an unknown key is
indistinguishable from a truncated page by the reply alone, which is why acceptance
presence-checks every requested key and consults no count. And
`GET /rpc/Number.Set?id=201&value=0` answered a bare JSON `null` on the device,
corroborating the acknowledgement the dispatcher requires from the sibling
`Boolean.Set`.

Acceptance evidence still to be captured, none of it fabricated here: a reply showing
`Tab5IsLocked` as a `boolean:<id>` component with `config.name` and a Boolean
`status.value`, and a `Boolean.Set` reply confirming the bare `null` for that exact
method; and observed relay behavior across a Shelly reboot with an inhibition
outstanding.

The owner accepts that pump permission may be interrupted during the maintenance
interval: a Shelly reboot physically drops its relay, and between stopping the old
Tab5 files and starting the new script nothing is in a position to close RLY0. No
manual relay-close step is added and no Shelly lock is overridden.

## Later / unresolved

- Battery charging: retain current 75/80 policy until new limits are chosen.
  Owner finds percentage misleading and expects higher thresholds; input power
  versus charging current remains unexplained. Supported UIFlow interfaces only.
- System Monitor automatic actuation remains deferred under issue #6. Missing
  telemetry does not release inhibits or advance clearing qualification. There is
  no Clear Events or Monitor OFF control in M6.37.
- Shelly script-health monitoring (issue #5) remains separate; resolve by script
  name, not assumed ID. Shelly-local lockouts/protections remain authoritative.
- S020 startup sensitivity, brief Cloud-yellow with a pending record, and potential
  two-second polling remain separate questions, not approved changes here.
- Rules editor Tab5 status-read failure remains parked by owner.
- Never fabricate unavailable values, physical action success or exact inferred
  close time. Runtime packages adopt only on restart with an empty event board.

## Boundaries

Source promotion does not install Tab5 files or publish Firebase rules. New coding,
deployment, package delivery and hardware operations require their applicable owner
authorization. Preserve mechanical/hardwired/Shelly-local protection; CPU A remains
sole local event/control authority. No routine flash/SD logging or durable outbox.
GitHub is the portable source of truth. Keep environment setup bounded. The
restart marker's atomic write/removal and reset linkage are host-simulated;
installed-device filesystem and reset behavior remain owner acceptance evidence.
