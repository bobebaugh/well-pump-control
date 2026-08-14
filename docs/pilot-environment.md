# Pilot environment

This file records non-secret deployment identifiers only.

## GitHub

- Repository: `bobebaugh/well-pump-control`
- Production branch: `main`
- Netlify branch-deploy source: `pilot`
- Deploy previews: disabled

## Netlify

- Site/project name: `well-pump-control`
- Production builds from `main` are intentionally suppressed by the main-only `netlify.toml`.
- The `pilot` branch contains the deployable HMI and functions configuration.

## Firebase / Firestore

- Firebase project ID: `well-pump-control`
- Firebase project number: `247391040778`
- Firestore database ID: `(default)`
- Firestore location: `us-east1` (South Carolina)
- Client security rules: deny all
- Pilot access path: authenticated Netlify server function using IAM; no browser-direct Firestore access

Do not add service-account JSON, private keys, bearer tokens, Wi-Fi credentials, or Netlify environment values to this file.
