# Shelly CORS proxy — bench test page

`shelly_cors_proxy.exe` is a single statically linked Go binary with two jobs: it
serves `index.html` at `http://localhost:8899/`, and it relays that page's RPC
calls to the Shelly at `/proxy/<shelly-host>/rpc/...`. The page and the relay
share one origin, so the browser never makes a cross-origin request and there is
nothing for CORS to block.

This is bench apparatus. It is not installed on the Shelly and it is not part of
the Tab5 or Pilot applications.

## Build

Go cross-compiles, so no Windows machine is needed:

```
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o shelly_cors_proxy.exe .
```

`shelly_cors_proxy.exe` **is committed**, deliberately. Git is this project's
transport between Windows machines, and a bench tool you cannot run when you are
standing at the panel is no use. The cost is that the page is baked in at compile
time, so the committed binary is only as current as the last rebuild — **rebuild
and recommit whenever `index.html` changes**, or the exe will silently serve an old
page.

The committed build: 2026-09-15, Go 1.24.7, PE32+ x86-64 console executable,
6.05 MB, rebuilt for the Diagnose panel. It is unsigned, so Windows will warn on
first run.

Before a build ships, the same source is built for Linux and run against a mock
device to confirm the `/proxy/` path parsing and the response relay - including
that a setter's bare `null` survives byte-for-byte - and that an unknown path, a
missing host, a POST and an unreachable device return 404, 400, 405 and a JSON
error.

`-ldflags="-s -w"` strips debug symbols, giving roughly 5.8 MB. `//go:embed
index.html` bakes the page into the binary at compile time — the compiler reads
the file during the build and copies its bytes into the executable, so the `.exe`
is the page plus the server and there is no second file to keep track of.

Rebuild after any change to `index.html`; the running binary holds a copy from
whenever it was last built.

## What it reaches on the device

Read-only unless a button is pressed:

- `Shelly.GetComponents` with `dynamic_only`, to resolve `IsLocked`, `loCntr` and
  `Tab5IsLocked` by name. Ids are assigned at creation and are not stable across a
  rebuild, so nothing here hard-codes one; the id travels in `config.id`, so the
  key is never parsed either.
- `Shelly.GetComponents` with a `keys` filter, for `input:0` and `switch:0`. The
  page used `Shelly.GetStatus` and it did not yield a usable `input:0` on this
  device. That reply has never been captured here, while the components envelope
  has — `status.state` on the input, `status.output` on the switch — and it is the
  request Tab5 itself makes. The unfiltered call is known to truncate on this
  device, which is the likeliest reason a whole-status read came back short.
- `Input.GetConfig`, to show whether `invert` has been left flipped.

Writes only what a button asks for, and **never the relay**. Move that from the
Shelly panel.

## Playing the pressure switch

`input:0` reflects the physical terminal and no RPC sets it. *Activate pump* and
*Deactivate pump* instead flip the input's `invert` config, which changes the state
the Shelly reports and should produce the same rising and falling edge a real
pressure switch would. The page computes the flip from what is currently reported
and what `invert` currently is, so it works whichever way the terminal is sitting
and whether or not `invert` was already on.

Two caveats. **This is unverified on the device** — if Activate does not change
Input(0) in the display, the Shelly does not generate an edge this way and a jumper
at the SW terminal is the only route. And each press **writes persisted config**,
so it is bench apparatus, not something to leave toggling. The current `invert` is
shown beside Input(0), and *Clear invert* puts it back to false.

The run timer starts on a fresh Activate. The elapsed value at Deactivate is what a
running `anti-chatter.js` measures against its own `MinRuntime`; the field beside
the buttons is a local reference copy for the verdict text, since that constant
lives in the script and is not published as a component.

## Playing Tab5

*Set Tab5IsLocked true* should open RLY0 within a second of a running
`anti-chatter.js` seeing it, and clearing it should close RLY0 provided `IsLocked`
is 0.

If Tab5 is running with an adopted rules package it will revert the flag within a
cycle or two — it reconciles that component against its own event ownership and
writes back what it wants. Stop Tab5, or run it with no adopted package, to drive
the flag by hand. `IsLocked` and `loCntr` are different: nothing in Tab5 writes
them, so a value set here stays until a script changes it.

## Diagnose

*Dump raw replies* issues the page's own requests and prints each reply verbatim
under the exact URL that fetched it. The URL matters: the page builds its query
through `URLSearchParams`, so a `keys` filter goes out percent-encoded, and a
hand-typed URL is not necessarily the same request. Six calls are made, all reads:
`Shelly.GetComponents` with `dynamic_only`, the same call filtered to
`switch:0` and `input:0`, that call filtered to `input:0` alone,
`Input.GetConfig`, `Input.GetStatus`, and `Shelly.GetStatus` — the last only so
its reply can be compared against the components envelope, never as a display
source. A call that fails is reported as `FAILED` and the dump continues.

The panel exists because `input:0` came back from the filtered call without a
boolean `status.state`, which the captured device response does carry. Two shapes
now explain themselves without the dump: an input whose `config.type` is not
`switch` holds no steady state (a button emits events instead, and flipping
`invert` cannot drive it), and an input with `enable: false` reports nothing.
Either way the entry is dumped as well, and a dash on Input(0) is labelled with
which of the three cases it is — absent, stateless, or simply inverted.

## Tests

```
node --test shelly1/tools/shelly-cors-proxy/index.test.js
```

Executes the page's real JavaScript against a fake Shelly with a DOM shim, driving
real button clicks and asserting on real fetch calls. It covers activate and
deactivate from every starting combination of terminal position and `invert`, the
run timer's short-cycle verdict, a bare-null reply not being reported as a failure,
a device without the boolean, discovery by name, that no control ever writes the
relay, and the Diagnose panel: that the URL it prints is the string actually
fetched, that a failing call does not abort the dump, and that a button-type or
disabled `input:0` is explained rather than dashed.

## Original verification

The Windows binary was not shipped unbuilt. A Linux build of identical source ran
against a mock HTTP server standing in for the Shelly, confirming the `/proxy/`
path parsing and response relay including a `Number.Set` write; and the page's
JavaScript was executed under Node with jsdom, driving real button clicks and
asserting on real fetch calls, before that HTML was embedded into the Windows
build.

The mock did not reproduce one thing the real device does: a virtual-component
setter answers a bare JSON `null`, and the page's `rpc()` helper dereferenced that
before checking it. See the git history for when that was corrected.
