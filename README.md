# Well Pump Control

A staged monitoring and supervisory-control project for a private well system.

## Current status

The current pilot is **observational only**. It uses the installed Gen-1 Shelly EM as its sole physical input and proves this vertical slice:

```text
Shelly EM local API -> Tab5 -> authenticated Netlify function -> Firestore
                              |                         |
                           Tab5 HMI                 Web HMI
```

The pilot must not start, stop, inhibit, or otherwise control the pump.

## Safety boundary

- Existing mechanical and hardwired well controls remain authoritative.
- Tab5 must never gain pump-start authority.
- Netlify and Firestore are not part of immediate pump protection.
- No existing protection may be removed or weakened until a replacement has been separately designed, tested, accepted, installed, and documented.
- Never commit Wi-Fi credentials, bearer tokens, Firebase credentials, or other secrets.

## Branches

- `main` — stable future production branch
- `pilot` — current integration branch and Netlify branch-deploy source
- short feature branches merge into `pilot`; accepted pilot work later merges into `main`

## Repository layout

- `firmware/tab5/` — ESP-IDF application for the M5Stack Tab5
- `cloud/netlify/` — authenticated ingestion functions and cloud configuration
- `web/` — remote HMI
- `contracts/` — versioned cross-component schemas and examples
- `tests/` — contract and application tests
- `docs/` — development, build, flash, and deployment instructions

Google Drive contains the authoritative project and as-installed records. This repository is authoritative for software, executable schemas, automated tests, and developer instructions.

## Development model

Firmware is compiled and flashed from the Windows development PC using VS Code and ESP-IDF v5.4.2. GitHub stores and versions source; it does not physically program the Tab5. See `docs/development-workflow.md` once the initial scaffold is complete.
