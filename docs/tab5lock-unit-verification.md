# Tab5IsLocked / Monitor unit — device verification record

**Releases covered:** M6.38 through M6.41, plus the revised `shelly1/anti-chatter.js`.
**Verified by:** owner, on the installed hardware, 2026-09-15.
**Status:** unit closed. Pressure sensor remains uncommissioned; the extracted
qualification utility's capture runs remain unexercised since extraction.

This records what was confirmed **on the device**. It is the counterpart to the
automated suites, which prove decisions rather than hardware, and to
`docs/pressure-calibration/`, which holds the sensor measurement evidence.

## Shelly 1 Gen4 — `anti-chatter.js`

| What | Result |
| --- | --- |
| Short-cycle detection | Scores a strike; `loCntr` increments |
| Relay response to `Tab5IsLocked` | RLY0 opens on true, closes on false when `IsLocked == 0` |
| Owner's own combinations | "Ran all the combos I can think of" |
| Reboot with an inhibition outstanding | Behaved as designed, with `InitDelay` raised to 10s for observation. Run against the harness script, not `anti-chatter.js` |
| `Boolean.Set` acknowledgement | Bare JSON `null`, captured and recorded in the fixture |

Detection was **not** working when first installed: with the status handler as
the only path into `pumpStarted`, nothing was detected and `loCntr` stayed at 0
through genuine short cycles. The polled-level backstop fixed it, and the
increments above are from the corrected build. See *How an edge is detected* in
`shelly1/README.md`.

## Tab5 — the cutover

| What | Result |
| --- | --- |
| Transient event | Opens and closes as authored |
| Latched event (`T040 Test Is Locked Latched`) | Latches and holds |
| Relay under inhibition | The Shelly holds RLY0 open until Tab5 clears |
| Monitor mode against a held latch | Monitor **released the hold** while the event stayed open |

Both test events were authored against `UDF(IsLocked)`, which the owner can set
to any value over HTTP, giving a controllable trigger without waiting on the
site's unpredictable 246–253 V supply.

The Monitor result is the designed behaviour and the subtlest part of the unit:
the inhibition is released when the last owning event closes **or while Monitor
is engaged**, never by an authored false. The event remaining open while the
hold releases is correct, not a failure to close.

### Package review warnings

Three events report `input_not_connected`. Reviewed and accepted: the code fires
for two unrelated shapes — an event opening on an occurrence, or closing via
Clear Events — and its message names three inputs regardless of which applies.
Operator occurrences **are** connected; Clear Events is not (`CURRENT.md`).
`T040` therefore closes only via Monitor release or a restart, which is
understood and worked around.

## Tab5 — M6.40 startup acquisition gate

Availability events on every reboot: **stopped**. This was the defect the gate
was written for — CPU B holds network traffic while CPU A is already cycling, and
the skipped polls were reported as unavailable rather than not-yet-attempted, so
H001 opened at `observationCount: 1` and drove Monitor on each boot.

## Tab5 — M6.41 extraction

| What | Result |
| --- | --- |
| Normal boot | Unaffected |
| `ADC AVAILABLE` on the System page | Confirmed, so the counts-only ADC rewiring and the move of the ADS1110 stack into `main.py` both hold |
| Pressure qualification branch | Entered successfully — which also proves the utility's `__main__` bindings resolve |
| CPU A / CPU B during the utility | Neither started |

## Follow-ups

Collected in [issue #10](https://github.com/bobebaugh/well-pump-control/issues/10).
Architectural items remain in `V3-ISSUES.md` as TAB5-13, TAB5-14 and TAB5-15.

## Not verified

- **The qualification utility's capture runs.** `GAUGE CALIBRATION` and `FILL RUN`
  have not executed since the extraction. Entering the branch proves the imports
  and bindings; it does not prove the capture paths. Their components are unit
  tested. Do not let an unattended recalibration be the first real run.
- **Pressure commissioning.** `PRESSURE_SENSOR_COMMISSIONED` is still `False`, so
  `PressurePSI` is not produced by the rules engine and `TankFlowQuality` reads
  `PRESSURE_INVALID`. The fit itself is qualified; only the flag is unset.
- **The pump.** Not yet connected to the automation. Every result above was taken
  with the pump out of the loop.
