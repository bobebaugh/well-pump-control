# Current status — Tab5 line

## Now — M6.39 cadence and ADC reduction, awaiting upload

**M6.38 is live.** The coordinated inhibition unit is deployed: the cloud side
from `pilot-working`, a new rules package published and running, `anti-chatter.js`
installed on the Shelly, and M6.38 `pilot.py` on Tab5.

**M6.39 is on `tab5-working` and not yet uploaded.** It is `pilot.py` only. It
moves the observation cadence to 2000ms and derives `STALE_AFTER_MS` and the
regression `SAMPLE_GAP` limit from it rather than leaving them as literals that
silently change meaning; cuts the ADC filter from five conversions to three, a
median, saving about 135ms a cycle; reports a regression window the cadence
cannot fill at adoption instead of letting it pin at `INSUFFICIENT_HISTORY` in
silence; and labels the keys-filtered Shelly read in diagnostics, which until now
logged as a generic `Shelly.read` with no reason classified.

**Open against M6.39:** the shipped `calc-tank` asks for 8 samples in a 10s
window, which a 2000ms cadence cannot supply. It needs a wider window (20s keeps
8 samples and improves the fit) or a lower count, and that is a `pilot-working`
republish. Tab5 logs `V3 CADENCE STARVED` at adoption until it is done. The
calculation is not in use yet, and there is no way to deactivate a calculated
field without deleting it and losing its calibration, so it stays.

The unit itself, as designed: Tab5 no longer writes
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

Tab5 liveness is settled as out of scope for the Shelly script. The seed makes Tab5
assert an outstanding inhibition rather than inherit a stale true; it cannot detect
an absent Tab5, and nothing is built on the idea that it can. A dead Tab5 leaves the
installation better protected than a standard well rather than worse, so the relay
closing when the initialization delay ends is the right outcome. Supervising CPU B
and Pilot is future Tab5 work.

The device prerequisites are met. The owner set `switch:0` to power-on off on
2026-09-14, so the relay now starts open and the script's initialization delay
holds it there; input mode Switch and output type Detached were already correct.
That makes enable-on-boot load-bearing rather than tidy: with the relay starting
open, a script that fails to start means no water until someone uses HAND.

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
