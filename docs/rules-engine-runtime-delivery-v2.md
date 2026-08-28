# Rules Engine runtime delivery v2

## Purpose

This contract replaces the provisional M6 59-row rules-package transport. That
transport demonstrated authenticated RTDB coordination and opaque Tab5 download
only; it is not a compatibility boundary for the Rules Engine runtime.

The synchronized unit is one immutable `well-pump-parameter-runtime` package
produced by the Rules Engine compiler. Firestore retains authoring drafts and
release history. RTDB carries only the desired immutable release identity.

## Desired-release pointer

The single RTDB location remains:

```text
v1/sites/well-main/rules/current
```

Its v2 contract is `contracts/rules-runtime-release-metadata-v2.schema.json`.
It contains the release ID, monotonic package version, runtime schema version,
SHA-256 hash, exact UTF-8 byte length, publication time, and the approved
device-authenticated download path.

The web delivery action accepts only the current immutable Firestore release.
It rechecks the stored release body, package/release identity, byte length, and
hash before it writes the RTDB pointer through the existing restricted
`netlify-rules-publisher` identity. Restoring an older release therefore never
moves RTDB backward: it must first be restored to the draft and republished as
the next package version.

## Validation responsibility

The web compiler is responsible for producing a valid runtime package. A normal
published release must be accepted by the matching Tab5 runtime. Tab5 will
still independently check transport integrity and resource-safe package
semantics before persistence and adoption. A rejection of intact web-published
bytes is an application-contract defect to reconcile, not ordinary operating
behavior.

Deliberate corrupt, truncated, oversized, hash-mismatched, and unsupported
schema candidates remain required negative tests.

## First device acceptance boundary

The first Tab5 v2 work will do only this:

1. Read the v2 pointer without interpreting package semantics on CPU B.
2. Download the exact body from `rules-engine-release` and verify hash/length.
3. Validate and atomically persist it on CPU A.
4. Reboot from the accepted package and report desired/adopted/rejected state.

No calculation, event, consequence, or device write is part of that acceptance
unit. With no valid v2 flash package, Tab5 presents a visible rules-unavailable
state while fixed safe behavior continues. A later adopted package starts with
a clear rule board; it does not migrate old event state.

## Deferred semantic bindings

Before the named-field and evaluator unit, the package defaults must be aligned
with actual Tab5 observation names and the reviewed Shelly-1 action mapping.
In particular, the present web `PressureADCCounts` and `PumpEnable` authoring
objects are not yet evidence that they bind to the current Tab5 observation or
the installed relay semantics. That reconciliation is deliberately separate
from the transport-only acceptance unit.
