# Shelly 1 scripts

Device-side scripts for the Shelly 1 that holds RLY0 in the automation-controlled
G/B− loop. These run on the Shelly, not on Tab5. They are kept here because their
output is a Pilot–Tab5 interface, not because Tab5 executes them.

| File | Purpose | Status |
| --- | --- | --- |
| `anti-chatter.js` | Short-cycle protection. Sole writer of RLY0; declares `IsLocked`, `loCntr` and `Tab5IsLocked`. | Not yet run on hardware |
| `test-harness-attaching.js` | Stands in for `anti-chatter.js`. Declares nothing, attaches by name to the three components its `@meta` provisions. | Revised for the three-component contract |
| `test-harness-standalone.js` | Older bench tool that declares its own copies of two components. Superseded. | See below |
| `tools/shelly-cors-proxy/` | PC-side page and proxy: watch all five values live, play Tab5, play the pressure switch. | Revised for the three-component contract |

Neither harness reads or writes `switch:0` or `input:0`, so neither can move the
relay.

**Only one script may declare these names at a time.** `test-harness-standalone.js`
declares its own, so installing it beside `anti-chatter.js` gives Tab5 two
components called `IsLocked` and two called `loCntr`, and Tab5 rejects the entire
acquisition. It also declares no `Tab5IsLocked` at all, so Tab5 now rejects it on
its own with `missing-Tab5IsLocked`. It is superseded by the attaching harness and
kept only as a record.

`test-harness-attaching.js` is the one to use. It declares nothing and stands in
for `anti-chatter.js`: **stop that script and start this one**. `anti-chatter.js`
must stay installed, because its `@meta` is what provisions all three components —
stopped is enough, since a declaration provisions whether or not the script runs.

It no longer needs `Virtual.getHandle`, whose availability here was never proven.
`Shelly.getComponentStatus` reads any component by key, `Number.Set` and
`Boolean.Set` write one by id, and the components report their own id in
`config.id`, so nothing parses a key or hard-codes an id.

While the harness runs it ticks `IsLocked` down exactly as the real script would,
and **nothing manages RLY0**. With the device now powering on with the output off,
the relay stays wherever it was last left; move it from the Shelly panel.

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
rising SW level  pump started            → start run timer (ignored while locked)
falling SW level pump stopped            → if run < MinRuntime, infraction
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

### The fault this was written against

Owner diagnosis, 2026-09-14: the pressure tank bladder had moved across the outlet.
Any demand over about 3 GPM collapsed the pressure manifold, which called the
pressure switch ON; the pump started, its own output immediately restored manifold
pressure, the switch was satisfied, and the pump stopped. Demand was still there, so
it collapsed again. Rinse and repeat.

Two things follow. The cycle is driven by the pump's own output, so each run is a
few seconds — nowhere near the roughly 95 seconds a real 40→60 PSI fill took in
`docs/pressure-calibration/`. `MinRuntime = 60` sits in a very wide gap between the
two, which is why it discriminates cleanly rather than by fine tuning.

And the fault is mechanical. This script is protection against recurrence and a way
to see it happen in the log; it is not the repair.

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

  **Set on the device 2026-09-14** (owner, Shelly UI: *Action on power on* →
  *Turn OFF*). An earlier capture that day reported `initial_state: "on"`, which
  closed the relay at boot before any script could run. Equivalent by RPC:

  ```
  http://192.168.50.201/rpc/Switch.SetConfig?id=0&config={"initial_state":"off"}
  ```
- `switch:0` **`in_mode` set to `detached`**. This is the prerequisite the
  AUTHORITY paragraph in the script depends on and it was, until 2026-09-15, the
  one prerequisite this README never wrote down. In `follow` (the factory default)
  the firmware binds `input:0` straight to `switch:0` *beneath* the script: the
  relay tracks the input directly, so the script is no longer the sole writer of
  RLY0, `applyRelayPolicy` ends up arguing with the firmware over the output, and
  a lock cannot reliably hold the relay open while SW is high. Captured on
  2026-09-15 as `in_mode: "follow"` with `initial_state: "restore_last"`, both
  back at their factory values on a device where they had been set correctly the
  day before — so treat these two as things to re-check after any firmware
  update, factory reset, or re-add of the device, not as set-once. Equivalent by
  RPC:

  ```
  http://192.168.50.201/rpc/Switch.SetConfig?id=0&config={"in_mode":"detached"}
  ```

  **What detached costs, and what it does not.** It stops the physical SW terminal
  from operating RLY0. That is the point, not a side effect: SW is a *sense* line
  here, not a control input. It watches ground at the contactor *downstream of
  RLY0*, so letting it drive RLY0 wires the relay to its own consequence. What
  detached does **not** take away is any way you actually move the relay by hand -
  the toggle in the Shelly app and web panel, `Switch.Set` over RPC, and the
  script's own control all work exactly as before. Nor does it cost the script
  anything: `input:0` still reports `status.state` and still fires the status
  handler in detached, which is captured (2026-09-14, `in_mode: "detached"`,
  `"state": false`) and is the only thing the edge detector needs.

  Follow is not merely redundant, it is corrosive to the one job this script has.
  The firmware re-drives the output on **every input transition**, overriding
  whatever the script last decided - so a lock holds only until the next SW edge.
  (That it is transition-driven rather than continuous is visible in the
  2026-09-15 capture: `output: true` while `state: false`, which a level-enforcing
  follow could not produce.) On the bench it also makes the harness meaningless,
  because relay movement no longer proves the script decided anything - it may
  just be the firmware mirroring the input.

  The bench page checks both settings on every read and shows a banner naming
  whichever one is wrong.
- `input:0` in a mode that reports a level in `status.state`, since edges are taken
  from the status handler. `type: "switch"` does; `button` does not, reporting
  `state: null` and emitting events instead.
- The script set to **run on startup**. This is now load-bearing, not tidiness.
  With the power-on default off, the relay stays open until this script closes it,
  so a script that does not start means no water — from a syntax error, a failed
  save, a deleted script, or the enable-on-boot flag being off. HAND is the
  bypass, and the reason it must stay labelled at the panel.

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

## RPC command reference

Every command is a plain HTTP GET, so a browser address bar is a working client.
These are the **exact forms Tab5 issues** - the bracketed arguments are percent-
encoded because that is what `pilot.py` sends. The device also accepts literal
brackets typed by hand, but a hand-typed URL is not byte-for-byte the request
Tab5 makes, which has already cost one debugging session. Prefer these.

The ids below (`number:201`, `number:202`, `boolean:200`) are **this device as of
2026-09-15**. Component ids are assigned at creation and move when the components
are rebuilt - `IsLocked` has already been seen at both 202 and 201 - so read them
back before relying on them. Nothing in Tab5 or the bench page hard-codes one.

### Read: discover the components by name

Resolves every dynamic component and its id. This is `SHELLY_1_COMPONENTS_URL`.

```
http://192.168.50.201/rpc/Shelly.GetComponents?dynamic_only=true&include=%5B%22config%22%2C%22status%22%5D
```

`%5B%22config%22%2C%22status%22%5D` decodes to `["config","status"]`. Expect exactly three components -
`IsLocked`, `loCntr`, `Tab5IsLocked` - each with its id in `config.id`.

### Read: one filtered request for everything a cycle needs

This is `SHELLY_1_FILTERED_URL`, the steady-state acquisition. The unfiltered call
paginates and truncates, so it is never used for acquisition.

```
http://192.168.50.201/rpc/Shelly.GetComponents?keys=%5B%22switch%3A0%22%2C%22input%3A0%22%2C%22number%3A201%22%2C%22number%3A202%22%2C%22boolean%3A200%22%5D&include=%5B%22config%22%2C%22status%22%5D
```

`%5B%22switch%3A0%22%2C%22input%3A0%22%2C%22number%3A201%22%2C%22number%3A202%22%2C%22boolean%3A200%22%5D` decodes to
`["switch:0","input:0","number:201","number:202","boolean:200"]`.

The device **silently omits a key it does not have** - no error, no placeholder -
and `total` reports only what matched, so a missing component is indistinguishable
from a short page by the reply alone. Presence-check every key you asked for.
Components also come back out of order, so look them up by key, never by position.

### Write: Tab5's inhibition flag

This is `SHELLY_1_BOOLEAN_SET_URL`. `value` is `true` or `false`.

```
http://192.168.50.201/rpc/Boolean.Set?id=200&value=true
```

**The reply must be a bare JSON `null`.** `_issue_boolean_set` accepts HTTP 200
with a body of exactly `null` and nothing else - not `{}`, not an error-free
object. Anything else returns `invalid-response`, no retry is made that cycle, and
the inhibition silently never applies.

### Write: the lock and the strike count

```
http://192.168.50.201/rpc/Number.Set?id=201&value=0     # IsLocked, -1..86400
http://192.168.50.201/rpc/Number.Set?id=202&value=0     # loCntr, 0..3
```

Captured answering a bare `null` on this device. **Tab5 never issues these** - it
reads `IsLocked` and `loCntr` and never writes, clears, or works around them.
They are here for bench use and for the sanctioned hand-clear path.

### Config: the two device prerequisites

See *Device prerequisites* above for `in_mode` and `initial_state`, and why both
need re-checking after a firmware update or factory reset.

### Capturing the Boolean.Set acceptance reply

The one outstanding acceptance check. Tab5 short-circuits on
`if observed is value`, so it only ever writes a genuine change - which makes a
false-to-true transition the only shape worth capturing:

1. Restart `anti-chatter.js`. Its startup seeds `Tab5IsLocked` false.
2. Run the discovery call above and read `Tab5IsLocked`'s current `config.id`.
   Do not reuse an id from an earlier session.
3. `Boolean.Set?id=<that id>&value=true`, and record the reply **verbatim**.
4. Re-run discovery to confirm `status.value` is now `true`.

## Status

**Not installed and not hardware-tested.** Written against the qualified contract
and the Rev2 interface drawing; no bench or live run has been performed. The prior
occupant of these two components was a test harness that only counted `IsLocked`
down and never touched `switch:0` or `input:0`.

Two electrical assumptions are worth metering before trusting it: that a falling SW
edge always corresponds to the contactor de-energizing, and that `Shelly.call` on
`switch:0` is not contended by any other script or schedule on the device.

### How an edge is detected

Two sources, funnelled through one function that acts only on a change from the
level it last acted on, so an edge reported by both is still counted once:

- **The status handler**, the fast path. It catches a run shorter than the tick.
- **The once-a-second tick**, the backstop. It reads `input:0`'s level directly and
  compares it with the last level acted on.

The backstop exists because on 2026-09-15 the device did not detect pump starts at
all: `loCntr` stayed at 0 through genuine short cycles, which is what a status
handler that never fires looks like from the outside. The handler's event shape
(`{component: "input:0", delta: {state}}`) was always an assumption about the
firmware, and the stubbed tests could not catch it being wrong because the stub
hands the script exactly that shape. A polled level is not an assumption, so the
handler is no longer load-bearing: if it never fires, detection now degrades to
one-second resolution instead of failing silently.

One-second resolution is enough for everything here — `MinRuntime` is 60 and the
shortest interesting run is many seconds — but a sub-second cycle seen by neither
source would still be missed, which is why the handler is kept rather than removed.

A level that reads as unreadable (no boolean `status.state`) is never treated as an
edge, and a level that is already high when the startup delay ends is tracked but
not acted on, since the start of that run was never observed and measuring it from
the wrong instant could score an undeserved strike.

`tests/shelly1-anti-chatter.test.js` runs this file in a stubbed Shelly runtime and
covers the five-second startup delay, hard-lock reassertion, relay truth table,
commanded-stop suppression, genuine short cycles, the strikeout path, the exact
three-component declaration, and a missing `Tab5IsLocked` handle. It also covers
the polled backstop: a run detected with no notification at all, an edge reported
by both sources counting once, the strikeout reached without the status handler,
an unreadable level not being mistaken for an edge, and malformed events being
ignored without stopping the script. It proves the script's decisions, not the
device's RPC shapes or the physical relay.
