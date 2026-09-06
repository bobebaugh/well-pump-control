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

## Shared records

Pilot publishes an immutable runtime package and a pointer identifying its exact
bytes, hash, length, and download path. Tab5 validates and stages a package before
it can adopt it. Tab5 emits current observations, selected durable observations,
and event records for Pilot to retain and display.

Existing versioned record meanings do not change silently. An incompatible record
gets a new version.

## Work and acceptance

Work proceeds one bounded unit at a time on a reusable working branch. The owner
reviews behavior through the application and stored Firestore/RTDB data, supported
by the agent's tests and evidence. Promotion to an operating branch is a separate
owner decision.
