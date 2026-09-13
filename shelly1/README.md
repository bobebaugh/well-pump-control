# Shelly 1 scripts

Device-side scripts for the Shelly 1 that holds RLY0 in the automation-controlled
G/B− loop. These run on the Shelly, not on Tab5. They are kept here because their
output is a Pilot–Tab5 interface, not because Tab5 executes them.

| File | Purpose |
| --- | --- |
| `anti-chatter.js` | Short-cycle protection. Owns RLY0, publishes `IsLocked` and `loCntr`. |

## Authority

Per `00-CURRENT-STATE-READ-FIRST.md` §4.3, the Shelly script owns relay chatter and
rapid cycling and sits **above** Tab5. Tab5 owns excessive runtime and the leak
class. Tab5 reads `IsLocked` and `loCntr` and never writes, clears, or works around
them, and must not contain a second chatter implementation (§4.10).

Nothing in this script can start a pump. RLY0 is one series element in the G/B−
loop, so the only available action is refusing to complete it. The pressure switch
on B+, the 3-second on-delay, the 6-minute max-runtime limit, and the HAND bypass
are all in front of it and unaffected.

## Published contract

Two virtual number components, discovered by Tab5 **by name**:

| Name | Range | Meaning |
| --- | --- | --- |
| `IsLocked` | −1 … 86400 | `0` normal, positive = seconds remaining, `−1` permanent |
| `loCntr` | 0 … 3 | Infractions accumulated |

Both are `persisted: false`. Tab5 rejects the entire acquisition if either is
missing, out of range, or duplicated, so do not add another component using either
name.

## Tuning values

Four more virtual numbers, `persisted: true`, editable from the Shelly UI. Tab5
ignores them — its reader only matches the two names above.

| Name | Default | Meaning |
| --- | --- | --- |
| `MinRuntime` | 60 s | A run shorter than this is an infraction |
| `InitLockTime` | 90 s | RLY0 held open per non-final infraction |
| `MaxLOcntr` | 3 | Infractions before the permanent lock |
| `TimeToResetLOcntr` | 3600 s | Clean period after which `loCntr` decays to 0 |

`MinRuntime = 60` is set against measured behaviour, not guessed. The pressure
switch has cut-in/cut-out hysteresis, so a healthy cycle always runs the full
40→60 PSI sweep; the captured fill in `docs/pressure-calibration/` did it in about
95 seconds. Sixty seconds leaves roughly 35 seconds of margin while still catching
any stop with essentially no drawdown.

## Behaviour

```
rising SW edge   pump started            → start run timer (ignored while locked)
falling SW edge  pump stopped            → if run < MinRuntime, infraction
infraction       loCntr += 1
                 loCntr < MaxLOcntr      → IsLocked = InitLockTime, RLY0 open
                 loCntr >= MaxLOcntr     → IsLocked = -1,           RLY0 open
every second     IsLocked > 0            → decrement; at 0, RLY0 closes
                 clean for TimeToReset…  → loCntr = 0
```

RLY0 is driven from `IsLocked` on every tick rather than from the event that set
it, so the relay and the published state can never disagree. A side effect worth
knowing: correcting `IsLocked` by hand in the Shelly UI is therefore also a working
clear path.

This is **reactive, not pre-emptive**. The first short cycle reaches the pump;
everything after it is blocked, because `InitLockTime` is far longer than any
enforced idle would have been. Adding an unconditional idle after every stop would
buy nothing and would delay legitimate heavy demand.

### HAND mode

HAND hard-wires the G/B− loop, so SW sits high continuously and never produces a
falling edge. No run is ever evaluated and no strike can be scored. No special
handling is needed, and none is present.

### The momentary start button

A brief jog of the MOM ON switch is electrically indistinguishable from a real
short cycle and will score a strike. Hold it at least `MinRuntime`, or select HAND.
A label at the panel is worth more than a note in a repository.

### Clearing a lockout

Two sanctioned paths, both requiring a person (§4.4):

1. Power cycle the wellhead breaker — also the only way to clear the original
   6-minute lockout.
2. The online Restart Shelly 1 request, which reboots the device.

`IsLocked` and `loCntr` are not persisted, so either path returns both to zero.
Clearing is never automatic, never from a rules package, and never a consequence of
a Tab5 restart, Clear Events, or Monitor.

## Device prerequisites

Not set by the script — configure these on the Shelly before installing:

- **Delete leftover components by hand, not just the old script.** Virtual
  components outlive the script that declared them and survive a reboot, so
  removing a previous script leaves its `IsLocked` and `loCntr` behind. Check
  Settings → User-defined components and delete every duplicate before installing.
  Tab5's `normalize_shelly1_components` rejects any name it finds twice, and it
  rejects the **entire acquisition** — so a duplicate makes the device read as
  unavailable rather than as an obvious duplicate fault. Exactly six components
  should remain, one per name.
- **Only one script may declare these names.** A second script sharing them
  produces the duplicates above, and two scripts would both tick `IsLocked` down.
  Setting values from the UI, an RPC call, or an external tool is fine — the script
  adopts external writes deliberately.
- **Mind the ten-component budget.** This script uses six of the device's ten
  slots. If leftovers have accumulated, delete them before installing or the
  declaration will fail partway, leaving some handles undefined. If slots get
  tight, `MaxLOcntr` and `TimeToResetLOcntr` are the two least likely to need
  field tuning and could become constants in the script.
- `switch:0` power-on default **on**, so RLY0 closes on boot and a script failure
  leaves the pump able to run.
- `input:0` in a mode that reports a level in `status.state`, since edges are taken
  from the status handler.
- The script set to **run on startup**.

### The `@meta` line

It must be the **first line of the file**. It is what declares the six virtual
components; anywhere else and `Script.getVcHandle` returns `undefined` for every
one of them. The script guards against that and logs a warning rather than
throwing, but nothing is published to Tab5 until it is fixed.

## Status

**Not installed and not hardware-tested.** Written against the qualified contract
and the Rev2 interface drawing; no bench or live run has been performed. The prior
occupant of these two components was a test harness that only counted `IsLocked`
down and never touched `switch:0` or `input:0`.

Two electrical assumptions are worth metering before trusting it: that a falling SW
edge always corresponds to the contactor de-energizing, and that `Shelly.call` on
`switch:0` is not contended by any other script or schedule on the device.
