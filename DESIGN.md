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
it can adopt it. Tab5 emits current observations, selected durable observations,
and event records for Pilot to retain and display.

Existing versioned record meanings do not change silently. An incompatible record
gets a new version.

For the initial real-world V3 pilot, package adoption is restart-only. A successful
download stages the next package atomically and does not replace the running
kernel. Restart validates and adopts the last valid staged file with fresh event,
ownership, and calculation state. Reports keep running and staged identities
distinct and describe execution according to the running source behavior.

The Shelly 1 read record joins two sequential RPC responses from one acquisition
cycle. It is intentionally not described as a simultaneous hardware snapshot.
Dynamic script number components are discovered by name; Tab5 reads but never
resets or manipulates them.

## Work and acceptance

Work proceeds one bounded unit at a time on a reusable working branch. The owner
reviews behavior through the application and stored Firestore/RTDB data, supported
by the agent's tests and evidence. Promotion to an operating branch is a separate
owner decision.
