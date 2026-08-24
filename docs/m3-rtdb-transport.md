# M3 CPU B RTDB transport candidate

## Scope

This nondeploying candidate adds the Firebase custom-token bootstrap and the
least-privilege RTDB rules needed by CPU B. The interpreted device candidate is
kept separately on `agent/m3-tab5-rtdb-transport`; no runtime file is copied
into this cloud history.

M3 transports disposable current observations, addressed pending commands,
device presence/sync state, Global Enable coordination, and rules-release
metadata. It does not store durable observations/events, evaluate or adopt
rules, apply commands, operate hardware, add web surfaces, or implement M4 and
later milestones.

## Candidate cloud behavior

`device-sync` authenticates the established device request with the existing
`X-Pilot-Key`, reuses the configured `well-pump-netlify` service-account key to
sign two purpose-separated Firebase custom tokens for `tab5-well-main`. It
exchanges the one-time probe token through Firebase Auth and reads the device's
approved RTDB coordination paths under Security Rules. The response returns the
distinct, unconsumed transport token for CPU B to exchange itself. No administrative
credential is returned or placed on the device.

The service account retains Cloud Datastore User only. The RTDB reads are made
with the temporary device identity and therefore do not require an RTDB IAM
role.

The required Netlify configuration is:

- existing `FIREBASE_SERVICE_ACCOUNT_JSON`
- existing `FIREBASE_PROJECT_ID=well-pump-control`
- existing `PILOT_INGEST_TOKEN`
- `FIREBASE_WEB_API_KEY` for the approved Firebase project
- `FIREBASE_RTDB_URL` for that project's Realtime Database

`firebase/rtdb.rules.json` is a review candidate only. It was not deployed. It
denies all access by default, grants `tab5-well-main` writes only to its current
observation, presence, and sync state, and grants reads only to its addressed
commands, Global Enable coordination, and the current rules pointer.

## Compatibility

`ingest-power`, `current-power`, `monitor-session`, `firebase-status`, and
`health` are unchanged. The verified legacy telemetry files remain protected
by byte-hash tests. CPU B continues the existing Netlify publication path even
when bootstrap, token refresh, or RTDB operations fail; those failures use a
bounded retry schedule.

The M3 device candidate uses a conspicuously named pre-M6 transport-only rules
reference solely because the accepted `device-sync-v1` request requires
`appliedRules` before M6 supplies a real validated package. CPU B does not open,
validate, adopt, or evaluate a rules file, and `pilot.py` is untouched. M6 must
replace this bridge with CPU A's actual applied rules reference.

Durable event canonicalization does not exist until M4/M8. During M3,
`device-sync` preserves the device-declared open-event identifiers in the
round-trip rather than inventing durable records or reconciliation behavior.

## Verification boundary

Host tests cover contract validation, custom-token exchange wiring, scoped RTDB
paths and rules, bounded retry calculations, temporary-token refresh,
complete-message preservation, and sequence/stale-command filtering. They do
not prove Firebase configuration, deployed Security Rules, UIFlow HTTPS/TLS,
real token refresh, network recovery timing, cross-core behavior, or physical
Tab5 operation.
