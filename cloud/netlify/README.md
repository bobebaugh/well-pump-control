# Netlify beta backend

Functions serve public read-only monitoring/history, password-protected ingestion,
rules authoring/publication/downloads, and explicit operator controls. Firestore
holds durable data; RTDB holds current state and coordination. Server credentials
stay in Netlify; devices obtain scoped temporary Firebase credentials.

Pilot and Main are two application versions against the same live site/device.
There is no branch-specific data namespace. See [BETA](../../BETA.md) and
[DESIGN](../../DESIGN.md). Firebase rules/index publication and device/package
installation are separate from deploying functions. Tests use fixtures/emulators.
