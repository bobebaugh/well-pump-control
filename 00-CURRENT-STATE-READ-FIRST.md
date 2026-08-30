# 00 — WELL PUMP CURRENT STATE — READ FIRST

**This file is the current state of the project. Read it before anything else.**

**It is not a design authority.** It records verified state, decisions and their
rationale, open items, and which older records are superseded. The design authority
for V3 is `EVENT_V3_IMPLEMENTATION.md` — see §1 and §8. Where this file and the V3
authority disagree about *design*, the V3 authority wins and this file is wrong and
should be corrected.

**Last updated:** 2026-08-30
**Maintained by:** design-oversight session, updated every session
**Owner:** Bob Ebaugh (bob@ebaugh.net) — sole user and sole hardware authority

---

## 1. Session start protocol

1. Read this file completely.
2. Read the V3 design authority: **`EVENT_V3_IMPLEMENTATION.md`, from
   `agent/event-v3-contract` at `78ca53aff0998d87656016964838acc6881821e2` only.**
   Do not copy or fork it onto a checkpoint branch — `AGENTS.md` forbids a second
   authority. It is the same document as the Drive file
   `well-pump-event-actions-modes-and-recovery-design.md`.
3. Verify live SHAs with `git ls-remote origin refs/heads/<branch>`. A cached
   `origin/*` ref is not authoritative.
4. Confirm the worktree is clean.
5. Run that branch's baseline host tests before changing anything.
6. Work exactly one bounded unit. Report against the format in V3 §13.

Do not merge, deploy, promote, populate the device-upload mirror, or touch hardware
without explicit owner approval.

## 2. Production is two branches

| Line | Branch | SHA verified 2026-08-30 | Contents |
|---|---|---|---|
| Cloud / web | `pilot` | `d0b8a316` | Netlify functions, Firestore/RTDB, web HMI, JS tests |
| Device | `Tab5` | `67553473` | `tab5/` MicroPython upload tree + Python host tests |

`main` (`3a8b2f34`) exists but is **unused and deploys nothing** — its only unique
commit suppresses production builds. Do not target it. Repo docs still call it the
production branch; they are wrong.

### Active work branches

| Branch | SHA | State |
|---|---|---|
| `agent/event-v3-checkpoint2-delivery` | `f355c18b` | cloud side of checkpoint 2 — **completion unverified** |
| `agent/event-v3-checkpoint2-tab5-staging` | `a416034d` | device side of checkpoint 2 — **completion unverified** |
| `agent/event-v3-contract` | `78ca53af` | V3 contract work line |
| `agent/event-v3-runtime` | `554a6465` | V3 semantic runtime work line |
| `agent/event-command-reconciliation` | `3f2248f4` | reference only; superseded command concepts, not a V3 base |

22 fully-absorbed branches were deleted 2026-08-30; SHAs recorded in
`C:\Tab5\deleted-branches-2026-08-30.txt`. Four merged branches were held back as
under 48 hours old and can be cleared any time after 2026-09-01.

## 3. Local directories

| Path | What it is |
|---|---|
| `C:\Tab5\event-v3-checkpoint2-delivery` | cloud line checkout |
| `C:\Tab5\event-v3-checkpoint2-tab5-staging` | device line checkout |
| `C:\Tab5\pilot-micropython` | **device upload mirror — not a git repo.** Populate only when a candidate is approved for installation |
| `C:\Tab5\well-pump-control` | ESP-IDF checkout — **dead platform, see §7** |
| `C:\Tab5\*.bundle` | recovery bundles of the checkpoint 2 branches |

## 4. Decisions — 2026-08-30

**4.1 Monitor is the renamed inhibit-suppression behavior.**
Lineage: `Global Enable` → `System Override` → **`Monitor`**. Only the last is
current. It has two distinct uses:

- **Telemetry-failure Monitor** — a required source is not working.
- **Operator Monitor** — the user turns off app control of the well enable relay,
  usually locking it to full enable.

V3 §6.3 models both (health events own Monitor independently; operator Monitor opens
from the hard-coded control). They are treated identically for now.

**4.2 Restart clears the board, deliberately.**
A restart is the user's acknowledgment that they have investigated and fixed, or
confirmed improper activation. The app starts with a clean slate and **relocks if
conditions still merit it**. This applies to both Monitor uses and to latched
inhibits. It supersedes the older "System Override persists across restart" language
in the Architecture Baseline and the Aug 27 record. V3 §8 already accepts the
residual: an unexpected restart coincident with another failure is a second-failure
limitation.

**4.3 Two lockout sources, one per authority level.**

- **Shelly 1 script** — relay chatter / rapid cycling. Owns the relay. Standalone
  single-rule engine. Above Tab5 in authority.
- **Tab5** — excessive runtime, i.e. a leak (`P013` >360 s, `P014` >1800 s, both
  `recovery: "Manual reset after cause review"`). Plus the rest of the PumpSaver-class
  motor protection.

Tab5 always respects a Shelly lockout, short-term or permanent, and never overrides,
clears, or works around it.

**4.4 Shelly lockout reset paths — only two, both requiring a person.**

1. Cycle the wellhead circuit breaker.
2. Future programmatic reset, user-initiated only, from the web app or Tab5 screen.

Never automatic. Never from a rules package. Never from Tab5 restart, Clear Events,
or Monitor. When the programmatic reset is built it must be a hard-coded maintenance
command — **not** a writable field in `RUNTIME_DIRECT_BINDINGS`, or a rules package
could clear a lockout.

**4.5 `loCntr` may be volatile.**
It may reset with the lock on a breaker cycle. Single-owner system; someone who
repeatedly cycles the breaker instead of investigating is not a case worth designing
against. Keeps the script simpler — no Shelly-side persistent storage needed.

**4.6 V3's parameter-driven approach is affirmed.**
The justification is *not* extensibility. It is:

- the events (Strike, Strikeout, health, UI actions) were needed as records anyway, so
  carrying control flags on them is nearly free;
- calibration and thresholds change without reflashing a device that will be
  physically inaccessible;
- every durable observation carries `rulesVersion` + hash, which serves the system's
  stated primary purpose of correlating operational evidence.

The "compiler" name is accurate — it parses, resolves, dependency-sorts, type-checks,
and emits a bounded stack/RPN program. It is load-bearing for **safety**, not scale:
the simpler alternative is `eval()` of arbitrary text inside the one-second loop that
decides whether to inhibit a pump.

**4.7 Report in code, react in rules.**
Health and availability fields (`status.adc_available`, `status.cloud_available`,
`status.wifi_connected`, `$availability`, …) stay populated unconditionally by the
runtime. Rules decide what an outage *means*. This keeps the diagnostic floor intact
when a package is wrong or missing.

**4.8 Hard-code only what must be non-removable.**
The test is not "is this complex" but "do I want a published data file to be able to
delete this?" The frozen list:

1. evaluator and ownership mechanics;
2. bootstrap behavior when no valid package exists;
3. restart lifecycle (board starts empty);
4. safety interlocks — the Shelly enable gate, atomic record acceptance, never blind
   enable, no pump-start capability.

**4.9 Defend V3 §4's exclusion list.**
No scripts, variables, loops, delays, nested branches, transactions, rollback, or
direct event-to-event actions. Program variables are where pressure will arrive; the
frozen-snapshot rule is what stops them becoming order-dependent mutable state.

**4.10 Tab5 Strike/Strikeout events observe, they do not re-derive.**
They report the Shelly's state. Tab5 must never contain a second chatter
implementation that could disagree with the device holding the relay. V3 §14 already
lists this as a non-goal.

**4.11 Baseline document rewrite is deferred.**
Do not rewrite the Architecture Baseline or the Aug 27/28 records yet. Per the V3
doc's own instruction, replace them with documentation derived from the accepted
implementation once V3 is stable.

## 5. Open — blocking or unresolved

**5.1 WIRING — owner-owned, blocks the Shelly script.**
The sense wire is in the wrong place for the intended design. The relay must open
after every pump cycle for the enforced-idle ("God clause") behavior to work.
As wired, the first chatter strikes the pump. Not catastrophic in itself — the old
analog system already has a 3-second delay, which was anti-chatter V1 — but the
solution needs more thought. **Bob owns this. Do not design around it; wait for his
decision.**

The `IsLocked` flag contract is **stable regardless of wiring**. Only *when the script
sets each value* is wiring-dependent. Build Tab5 against the flag.

**5.2 `IsLocked` and `loCntr` are unreadable in the current runtime.**

| Field | `RUNTIME_DIRECT_BINDINGS` (pilot.py L93) | `RUNTIME_OBJECT_PATHS` (L570) |
|---|---|---|
| `UDF(IsLocked)` | declared | **absent** |
| `loCntr` | **absent** | **absent** |

A rule referencing `IsLocked` type-checks and then resolves to nothing.
`normalize_shelly1_status()` reads only `switch:0.output` and `input:0.state`, no UDF.
Both fields need a binding, an object path, and a reader before the V3 enable gate can
work on hardware.

**5.3 Checkpoint 2 completion is unverified.** The session that produced it was lost;
we have commit messages, not evidence. Establish this before step 3 begins removing
V2.

**5.4 `P009` classification depends on the wiring outcome.** If the capture period
does not inhibit, `IsLocked > 0` means lockout only and `P009`'s Red/Alert/notify is
right. If it does inhibit, `P009` fires on every normal pump stop and must become
informational. Also decides whether V3 §7's proposed `P009`/`P010` collapse is safe.

**5.5 V3 authority doc §1 is stale** — lists `pilot` at `9683db11` and does not name
the checkpoint branches. Refresh when convenient.

**5.6 Remaining Shelly contract questions** — see
`C:\Tab5\shelly1-islocked-contract-draft.md` §9.

## 6. Work sequence (owner's plan)

1. **Screen / compiler** — implemented, viewed, *not really tested*.
2. **Transport** — coded. Next: transmit web → RTDB → flash on Tab5, no engine
   processing. ← **current step; checkpoint 2 is this work**
3. **Pull V2, insert V3** in cloud and `pilot.py`; end-to-end testing. This is the
   missing protection engine.
4. **Shelly script** — only after step 3. Wiring determines its final rules wiring.
5. **Design tightening and baseline rewrite** — after the fact.

## 7. The ESP-IDF tree is history

`firmware/tab5/`, `docs/tab5-platform-runbook.md`, the `tools/*.ps1` helpers, and the
old `agent/tab5-*` branches are historical evidence. Do not build, flash, repair, or
extend them — `Tab5/tab5/AGENTS.md` says so explicitly. The live runtime is
interpreted MicroPython on the `Tab5` branch.

Its board facts remain valid hardware knowledge: antenna P0 LOW before C6 reset,
ADS1110 at `0x48` on GPIO 53/54, the 200 MHz PSRAM experimental-features gate.

## 8. Document map

| Record | Status |
|---|---|
| **This file** | current state — read first. Not a design authority |
| `EVENT_V3_IMPLEMENTATION.md` (repo, `agent/event-v3-contract` @ `78ca53af`) | **current design authority for V3.** Single-sourced: identical blob on `agent/event-v3-runtime`; absent from `pilot`, `Tab5`, and both checkpoint branches by design. Do not fork it |
| `well-pump-event-actions-modes-and-recovery-design.md` (Drive) | the same document as the above. Filename does not match its title (*V3 Implementation Authority*). If the two ever diverge, that is a defect — reconcile |
| `Well Pump Current Architecture Baseline` (Google Doc) | broader architecture; superseded on System Override naming and restart persistence |
| `well-pump-Tab5-event-control-and-hmi-integration.md` | Aug 27. Superseded on: System Override naming and persistence; event-override-during-timed-hold, now replaced by latched + Clear Events |
| `well-pump-rules-sync-tab5-engine-handoff.md` | Aug 28. Units 1–3 largely complete; its one-second cycle is superseded by V3 §2; its Unit numbering conflicts with V3 §12 |
| `well-pump-rules-engine-parameter-builder-pilot.md` | Aug 28. Historical record of built work at `98ad44a0` |
| `well_pump_operational_rules_1.xlsx` | candidate rule catalog, 59 rows. Not a commitment to implement or enable any row |
| `Well Automation Drawing V2.png` | wiring. **Owner-owned** |
| `C:\Tab5\shelly1-islocked-contract-draft.md` | DRAFT, not authority |

Note: the Architecture Baseline cites `well-pump-event-control-and-hmi-integration.md`;
the real filename contains `Tab5-`. Broken cross-reference.

## 9. Verified vs asserted

**Verified on hardware:** the V2 vertical flow end to end — author, publish, deliver
via RTDB, download, validate, adopt on Tab5, select durable observations, open a High
Voltage event, issue the STOP consequence. The relay changed `RLY(0)` ON→OFF; it was
**not connected to the pump control circuit**, so no actual pump inhibit occurred.

**Verified host tests:** Tab5 105/105 at the V3 doc's writing. Web 59/61, with two
files failing to load for lack of `firebase-admin` in that environment — a dependency
limitation, not assertion failures.

**Asserted but untested:** everything in V3 §§4–9. The V3 semantic kernel does not
exist yet.

**Never tested:** any Tab5 inhibit of a physically connected pump.
