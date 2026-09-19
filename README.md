# Well Pump Control

A staged monitoring and supervisory-control project for a private well system.

## Current status

The current pilot is **observational**. It reads three physical inputs:

- the Gen-1 **Shelly EM** (house side) — pump watts, supply voltage, power factor, load ratio
- a **Shelly 1** (wellhead) — contactor state and control-circuit status
- a **pressure transducer** on the Tab5's own ADC — system pressure

```text
Shelly EM + Shelly 1 + pressure ADC -> Tab5 -> authenticated Netlify function -> Firestore
                                         |                          |
                                      Tab5 HMI                   Web HMI
```

## Control authority, as built

Stated plainly, because the wiring permits more than the software currently does.

The contactor coil has two gated legs:

- **+24 VDC leg** — gated by the garage WELL ENABLE wall switch and the mechanical pressure switch, in series. Nothing in this project touches this leg.
- **0 V / ground leg** — gated by the automation: the wellhead maximum-runtime timer contact and the Shelly 1 relay contact, in series, when the selector is in **Auto**.

**HAND** (and the center `0` position) hard-grounds the coil return, removing both the original timer and the Shelly 1 from the circuit entirely. Pressure-switch and wall-switch control remain. This is the fallback when an automation component fails.

What follows from that:

- This project has **no pump-start authority in any selector position.** It cannot close the +24 VDC leg, so it cannot start the pump.
- In **Auto**, the Shelly 1 relay sits in series in the 0 V leg and **is physically capable of inhibiting the pump.** This is a deliberate provision for later phases, not an oversight.
- **The Shelly 1 relay leads are presently disconnected for testing.** The device is powered and reporting, and its SW input senses contactor state, but its relay contacts are not in the circuit. Reconnecting them restores the inhibit capability described above.

## Owner responsibility

This is a privately owned well system. The owner specified, wired, and commissioned it, and the owner operates it.

The owner is responsible for:

- deciding what authority, if any, this software is given over the pump, and physically wiring that decision
- verifying the state of the Shelly 1 relay leads before treating any run as unattended
- setting and verifying the start delay (`t1`) and maximum runtime (`t2`)
- all testing, commissioning, and acceptance of changes to the control circuit
- conformance with applicable electrical and plumbing practice

No AI assistant, code review, automated test, or document in this repository carries that responsibility or can discharge it. Nothing here is a safety device. Treat every output as advisory and verify it against the installed system.

## Engineering boundary

- Existing mechanical and hardwired well controls remain authoritative.
- Netlify and Firestore are not part of immediate pump protection.
- No existing protection may be removed or weakened until a replacement has been separately designed, tested, accepted, installed, and documented by the owner.
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
