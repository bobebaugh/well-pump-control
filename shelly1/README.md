# Shelly 1 scripts

Device-side scripts for the Shelly 1 that holds RLY0 in the automation-controlled
G/B− loop. These run on the Shelly, not on Tab5. They are kept here because their
output is a Pilot–Tab5 interface, not because Tab5 executes them.

| File | Purpose | Status |
| --- | --- | --- |
| `anti-chatter.js` | Short-cycle protection. Sole writer of RLY0; declares and publishes `IsLocked` and `loCntr`, and reads `Tab5IsLocked`. | Not yet run on hardware |
| `test-harness-standalone.js` | Bench tool that declares its own copies of the two components. | Known working on the device |
| `test-harness-attaching.js` | Same bench tool, declaring nothing and attaching to the components `anti-chatter.js` owns. | Unproven — see below |

Neither harness reads or writes `switch:0` or `input:0`, so neither can move the
relay.

**Only one script may declare these names at a time.** `test-harness-standalone.js`
declares its own, so installing it beside `anti-chatter.js` gives Tab5 two
components called `IsLocked` and two called `loCntr`, and its reader rejects the
entire acquisition. Use one or the other, not both.

`test-harness-attaching.js` exists to remove that restriction. It has no
declaration and no `Script.getVcHandle` — it discovers the components by name
through `Shelly.GetComponents` and attaches with `Virtual.getHandle`. Whether the
device permits that is untested. If it saves and runs, the two can coexist as long
as `anti-chatter.js` is paused first, since both tick `IsLocked` down once a second
and running them together halves every lock.

## Authority

Per `00-CURRENT-STATE-READ-FIRST.md` §4.3, the Shelly script owns relay chatter and
rapid cycling and sits **above** Tab5. Tab5 owns excessive runtime and the leak
class. Tab5 reads `IsLocked` and `loCntr` and never writes, clears, or works around
them, and must not contain a second chatter implementation (§4.10).

This script is now the **only** writer of RLY0. Tab5 no longer writes the relay at
all: it publishes its inhibition as `Tab5IsLocked` and this script decides the
relay from both holds together.

Nothing in this script can start a pump. RLY0 is one series element in the G/B−
loop, so the only available action is refusing to complete it. The pressure switch
on B+, the 3-second on-delay, the 6-minute max-runtime limit, and the HAND bypass
are all in front of it and unaffected.

## Published contract

Three components, discovered by Tab5 **by name**, never by id:

| Name | Type | Range | Writer | Meaning |
| --- | --- | --- | --- | --- |
| `IsLocked` | number | −1 … 86400 | this script | `0` normal, positive = seconds remaining, `−1` permanent |
| `loCntr` | number | 0 … 3 | this script | Infractions accumulated |
| `Tab5IsLocked` | boolean | — | Tab5 | Tab5's own inhibition request |

All three are `persisted: false`. Tab5 rejects the entire acquisition if any is
missing, out of range, wrong-typed, or duplicated, so do not add another component
using any of these names.

The script initializes `Tab5IsLocked` to `false`; after that seed, Tab5 owns its
normal updates. RLY0 remains open for the five-second startup delay, giving Tab5
time to reassert a hard lock before normal relay processing begins.

## Tuning values

The five settings are constants at the beginning of `anti-chatter.js`. They are
deliberately not virtual components and consume no component slots. Edit them in
the Shelly script editor when commissioning values need to change.

| Name | Default | Meaning |
| --- | --- | --- |
| `MinRuntime` | 60 s | A run shorter than this is an infraction |
| `InitLockTime` | 90 s | RLY0 held open per non-final infraction |
| `MaxLOcntr` | 3 | Infractions before the permanent lock |
| `TimeToResetLOcntr` | 3600 s | Clean period after which `loCntr` decays to 0 |
| `InitDelay` | 5 s | Startup hold-open window for Tab5 to reassert a hard lock |

`MinRuntime = 60` is set against measured behaviour, not guessed. The pressure
switch has cut-in/cut-out hysteresis, so a healthy cycle always runs the full
40→60 PSI sweep; the captured fill in `docs/pressure-calibration/` did it in about
95 seconds. Sixty seconds leaves roughly 35 seconds of margin while still catching
any stop with essentially no drawdown.

## Behaviour

```
script startup    Tab5IsLocked = false    → keep RLY0 open for InitDelay
after InitDelay   Tab5IsLocked false      → begin normal processing; close RLY0
                  Tab5IsLocked true       → begin normal processing; keep RLY0 open
rising SW edge   pump started            → start run timer (ignored while locked)
falling SW edge  pump stopped            → if run < MinRuntime, infraction
infraction       loCntr += 1
                 loCntr < MaxLOcntr      → IsLocked = InitLockTime, RLY0 open
                 loCntr >= MaxLOcntr     → IsLocked = -1,           RLY0 open
every second     IsLocked > 0            → decrement; at 0, RLY0 closes
                 clean for TimeToReset…  → loCntr = 0
```

**This script is the sole writer of RLY0.** Once a second it evaluates both inputs:
Shelly's anti-cycle state has first priority, followed by `Tab5IsLocked`. It opens
RLY0 if either hold is active and closes it only when both are clear. A definite
observed match costs no `Switch.Set` call.

Correcting `IsLocked` by hand in the Shelly UI still clears a lock, because the
release is driven by the script's own hold rather than by an event edge.

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

A third, which is a consequence of the design rather than a sanctioned control:
restarting the script clears `IsLocked` and `loCntr`, including a permanent
strikeout. The lockout is deliberately not preserved — it is reactive, so if the
underlying fault is still there the next short cycle re-arms it, and the
initialization delay stops that happening immediately. It matters because the five
tuning values are script constants now, so changing one means an edit and a
restart.

Restarting the script while the pump is mid-fill also interrupts the run. The pump
resumes when the delay ends, and if the tank then fills in under `MinRuntime` that
counts as a short cycle and costs one `InitLockTime` lockout. Self-clearing, and
cheaper than the extra state it would take to suppress.

`IsLocked` and `loCntr` are not persisted, so either path returns both to zero.
Clearing is never automatic, never from a rules package, and never a consequence of
a Tab5 restart, Clear Events, or Monitor.

## Device prerequisites

Not set by the script — configure these on the Shelly before installing:

- **Exactly one script may declare these names.** Components declared in `@meta`
  are owned by the declaring script. Two scripts declaring the same names create
  two sets, and Tab5's `normalize_shelly1_components` rejects any name it finds
  twice — rejecting the **entire acquisition**, so the device reads as unavailable
  rather than as an obvious duplicate fault. Exactly three should exist, one per
  interface name.
- **Mind the ten-component budget.** This script uses three of the device's ten
  slots; its five tuning settings are constants in the script.
- `switch:0` power-on default **off**, so RLY0 starts open. The script preserves
  that state through its five-second initialization delay.

  **The device is not set this way yet.** An owner capture on 2026-09-14 reported
  `initial_state: "on"`, which closes the relay at boot before any script runs.
  Change it before installing this script:

  ```
  http://192.168.50.201/rpc/Switch.SetConfig?id=0&config={"initial_state":"off"}
  ```

  Until it is changed, the 3-second on-delay in front of RLY0 is the only thing
  preventing a pump start in the gap between boot and script start. That is a
  dependency, not a design.
- `input:0` in a mode that reports a level in `status.state`, since edges are taken
  from the status handler.
- The script set to **run on startup**.

### The `@meta` line

It must be the **first line of the file**. It is what declares the three virtual
components; anywhere else and `Script.getVcHandle` returns `undefined` for every
one of them. The script guards against that and logs a warning rather than
throwing, but nothing is published to Tab5 until it is fixed.

### Removing components

Components declared in `@meta` are **owned by the declaring script** and cannot be
deleted from the web UI.

The Shelly documentation says they are "created automatically when the script
starts... and removed when the script is deleted." **On this device that is wrong
about the trigger.** Owner-observed: with neither script set to auto-run, a device
restart recreates every declared component. The declaration provisions them,
whether or not the script ever runs.

The practical consequence, and the cause of duplicates that keep returning:
deleting a component by hand does not stick. Any `@meta` still declaring it
recreates it at the next restart. Removing it for good means removing the
declaration:

1. Delete the script — all its components go with it.
2. Remove that role from the `@meta` line — only that component goes.

Because provisioning does not depend on execution, a declaration-only script needs
no enable-on-boot flag. It only has to exist.

Components created instead through the `Virtual.Add` RPC belong to no script, are
deletable from the UI, and stay deleted. Leftovers that could be removed by hand
came from that route; ones that cannot be, or that return after a restart, are
declared in some script's `@meta`.

### Other scripts using these components

A second script must **not** re-declare the names — that is what produces
duplicates. It attaches to the existing components instead:

```javascript
let lock = Virtual.getHandle("number:202");   // resolve the id by name first
lock.setValue(0);
```

Handles expose `getValue`, `setValue`, `getStatus`, `getConfig`, `setConfig`, `on`
and `off`. Resolve the id by matching `config.name`, the same way Tab5 does and for
the same reason — the numeric id is assigned at creation and is not stable across a
rebuild. This script adopts external writes to `IsLocked` and `loCntr` deliberately,
so a utility written this way keeps working.

## Status

**Not installed and not hardware-tested.** Written against the qualified contract
and the Rev2 interface drawing; no bench or live run has been performed. The prior
occupant of these two components was a test harness that only counted `IsLocked`
down and never touched `switch:0` or `input:0`.

Two electrical assumptions are worth metering before trusting it: that a falling SW
edge always corresponds to the contactor de-energizing, and that `Shelly.call` on
`switch:0` is not contended by any other script or schedule on the device.

`tests/shelly1-anti-chatter.test.js` runs this file in a stubbed Shelly runtime and
covers the five-second startup delay, hard-lock reassertion, relay truth table,
commanded-stop suppression, genuine short cycles, the strikeout path, the exact
three-component declaration, and a missing `Tab5IsLocked` handle. It proves the
script's decisions, not the device's RPC shapes or the physical relay.
