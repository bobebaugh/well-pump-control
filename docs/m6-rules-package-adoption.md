# M6 rules package and adoption candidate

## Scope

This candidate introduces the versioned rules package, its shared v1 schema, CPU A validation, CPU B byte transport, and atomic last-known-good replacement. It does not evaluate a rule, open or close an operational event, request a Shelly relay change, add a pump consequence, or change the legacy telemetry path. Those remain M7 or later work.

The package is derived from the current authoritative workbook `well_pump_operational_rules_1.xlsx`: all 59 workbook rows are present, remain disabled as published, and carry their event name, severity, response, timing, conditions, reset/recovery text, notification flag, and commissioning state. The rule values are package data, not executable M6 logic.

## Release contract

- `contracts/rules-package-v1.schema.json` is the web/Tab5 package contract. Its `x-well-pump-completeness.orderedRuleIds` is an explicit part of validation, because ordinary JSON Schema cannot portably require that ordered 59-row list.
- `tab5/rules.json` is the checked-in, flash-shipped baseline. It is release `20260825000000-rules-v1`, rules version 1, schema version 1, and SHA-256 `ee0220eebdd0fa9b3b9751435180c17a16d3c93cb5f7325f1ab74d8d132e410a` over the exact UTF-8 file bytes.
- The M2 RTDB current pointer remains `v1/sites/well-main/rules/current`. It supplies `releaseId`, rules/schema versions, SHA-256, and the approved relative Netlify download path.
- CPU B may fetch only `https://pilot--well-pump-control.netlify.app` plus the approved `/.netlify/functions/rules-release/<safe-name>.json` path. It passes the exact response text and pointer to CPU A without parsing the package.

## CPU A adoption behavior

CPU A verifies the pointer, the exact response-byte SHA-256, supported schema, release identity, 59-rule ordered completeness, and every required rule field in RAM. Only then does it write `.rules.json.download` and atomically rename it over `rules.json`. A malformed, incomplete, unsupported, mismatched, or failed replacement leaves the prior valid file in service and is retried no faster than once per minute when a changed RTDB pointer remains available.

## Physical persistence evidence — 2026-08-25

After the device reported adoption of `20260825010000-rules-v1`, the installed `rules.json` was downloaded back from Tab5 flash. The downloaded file was 17,942 bytes and was byte-for-byte identical to the published Netlify release. Its SHA-256 was `93eca75b9fbf774c10350580a8e0c116a733af6f6cd5274bdd7b29a698e05a08`, distinct from the flash-shipped baseline hash `ee0220eebdd0fa9b3b9751435180c17a16d3c93cb5f7325f1ab74d8d132e410a`. This confirms that the cloud release was persisted to the installed flash file rather than adopted only in RAM.

The active release reference is placed on later durable observations. The installed baseline is checked before CPU A enters its device loop. There is therefore no ordinary offline state without a valid ruleset.

## Current delivery boundary

This is a Tab5 feature-branch candidate only. The deployed pilot does not yet expose a rules-release endpoint or a live RTDB current pointer, so the installed candidate will safely keep its packaged baseline until the separately reviewed cloud-side M6 release service is deployed. Adoption and rejection are queued as deterministic `rule-adoption` / `rule-rejection` audit records; the deployed M4 ingest endpoint does not yet accept those record types, so they are deliberately emitted only after a changed release is downloaded. The matching cloud candidate adds that acceptance. No upload or deployment is authorized by this candidate.

## Host evidence

`python -m py_compile tab5/pilot.py tab5/cloud.py` passed.

`python -m unittest tests/test_tab5_observation_selection.py tests/test_tab5_cloud_transport.py` passed 39/39. The coverage includes the reviewed baseline hash and 59-rule completeness, pointer identity/hash matching, invalid-release retention of the old file, approved-path-only CPU B fetch, and exact CPU B byte handoff. It does not prove UIFlow filesystem rename behavior, HTTPS, threading, RTDB, or field behavior.
