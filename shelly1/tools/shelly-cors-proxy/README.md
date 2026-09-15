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

`-ldflags="-s -w"` strips debug symbols, giving roughly 5.8 MB. `//go:embed
index.html` bakes the page into the binary at compile time — the compiler reads
the file during the build and copies its bytes into the executable, so the `.exe`
is the page plus the server and there is no second file to keep track of.

Rebuild after any change to `index.html`; the running binary holds a copy from
whenever it was last built.

## What it reaches on the device

Read-only unless a button is pressed:

- `Shelly.GetComponents` with `dynamic_only`, to resolve the script-declared
  components by name. Ids are assigned at creation and are not stable across a
  rebuild, so nothing here hard-codes one.
- `Shelly.GetStatus`, for `input:0` and `switch:0`.

Writes only what a button asks for, and never the relay.

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
