# 00 — WELL PUMP CURRENT STATE — READ FIRST

**This file is the current state of the project. Read it before anything else.**

**It is not a design authority.** It records verified state, decisions and their
rationale, open items, and which older records are superseded. The design authority
for V3 is `EVENT_V3_IMPLEMENTATION.md` — see §1 and §8. Where this file and the V3
authority disagree about *design*, the V3 authority wins and this file is wrong and
should be corrected.

**Last updated:** 2026-08-30 (second pass — Gate 1 emulator suite executed; see §5.8)
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

**The SHAs below are a dated snapshot, not a pin.** They go stale on the next commit —
including the commit that updates this file. Always verify live tips with
`git ls-remote` per §1 step 3. Treat a mismatch here as this file being behind, not as
the stop-condition described for a task-specified starting SHA.

| Line | Branch | SHA snapshot 2026-08-30 | Contents |
|---|---|---|---|
| Cloud / web | `pilot` | `de07543f` | Netlify functions, Firestore/RTDB, web HMI, JS tests |
| Device | `Tab5` | `59bdcdb0` | `tab5/` MicroPython upload tree + Python host tests |

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

**Re-verified 2026-08-30 from `origin/Tab5` (`ffae79ab`), with the failure mode traced
end to end.** `UDF(IsLocked)` occurs exactly once in `tab5/pilot.py` — the declaration,
now at **line 104**, not L93. `loCntr` occurs **zero** times in the whole 3061-line file.

The consequence is narrower and worse than "the gate cannot work" — it is a **silent
no-op**, and it is fail-safe in the conservative direction:

1. `runtime_direct_field_values()` looks `UDF(IsLocked)` up in `RUNTIME_OBJECT_PATHS`,
   gets `None`, and — because the miss is not an error path — assigns `values[name] =
   None` and continues. No raise, no log.
2. `evaluate_runtime_program()` returns `None` for a `field` instruction whose value is
   not a number.
3. `runtime_condition_value()` returns `None` (it is correctly tri-state: "True, False,
   or None when a required field is unavailable" — it does **not** fabricate `False`).
4. `advance_rule_event()` on `condition_result is None` returns before the phase
   machine: a `confirming` rule reverts to `inactive`, a `clearing` rule reverts to
   `active`, and no transition is emitted.

So an `IsLocked` rule **can never open**, and an already-active protective event can
never be cleared by missing evidence. Nothing spuriously enables the pump. But there is
**no diagnostic anywhere** — grep finds no unresolved/unbound/missing-field reporting —
and `enabled_rule_count()` counts the rule as enabled regardless. A published package
referencing `IsLocked` therefore adopts cleanly, displays as an enabled rule, and does
nothing forever. Treat that as the requirement: the fix is a binding, an object path,
and a reader **plus** a visible unresolved-field diagnostic, or the same class of
silent dead rule can recur for any future field.

**5.3 RESOLVED — checkpoint 2 / Gate 1 is verified.** See §6.1.

**5.7 The protected-baseline test fails for a line-ending reason, not a content
reason. Fix the repo, not the test expectations.**

`tests/contract-schemas.test.js` pins sha256 digests for seven protective-path files
and reads them with `readFileSync`. Verified 2026-08-30: the git blob content of
`ingest-power.js`, `current-power.js`, and `power-contract.js` matches the expected
baselines **exactly**.

**Upgraded from asserted to VERIFIED, 2026-08-30 (second pass, Linux).** Two gaps in
the first pass are now closed. First, **all seven** guarded files were checked, not
three: every one matches its expected digest exactly in the committed blob, and every
one contains **zero** CR bytes in git. Second, the "would pass in Linux CI" prediction
was actually executed rather than reasoned about — `node --test
tests/contract-schemas.test.js` on an LF checkout passes **9/9, including the
protected-baseline test**. The guarded content is provably unmodified and the diagnosis
is confirmed: the CRs exist only in a Windows working tree via `core.autocrlf`, never
in the repository. The on-disk copies do not, because `core.autocrlf=true` and
`.gitattributes` carries no `text`/`eol` rule — only an LVGL whitespace exception.
`ingest-power.js` has 211 CR characters on disk.

So the test fails on any Windows checkout and would pass in Linux CI. The guarded
content is provably unmodified.

**RESOLVED ON `pilot` 2026-08-30 — owner approved.** `.gitattributes` on `pilot` now
carries `* text=auto eol=lf`, with the vendored LVGL tree excluded
(`firmware/tab5/components/lvgl/** -whitespace -text`) so upstream bytes stay exactly
as shipped. Verified inert before committing: `git add --renormalize .` rewrites **no**
file, because no blob committed on `pilot` contains a CR. The tripwire now holds for
every checkout regardless of `core.autocrlf`. `npm test` 103/103 on `pilot` after the
change.

**DEFERRED ON `Tab5` — deliberately, do not "finish the job" without reading this.**
The same one-line change is **not** inert on `Tab5`. Five files are committed there
with CRLF: `tab5/BASELINE.md`, `tab5/device_secrets.example.py`, `tab5/main.py`,
`tab5/webrepl.py`, and **`tab5/pilot.py`** — the device runtime. Applying
`* text=auto eol=lf` on `Tab5` would renormalize all five, rewriting every one of
`pilot.py`'s 3061 lines. `agent/event-v3-checkpoint2-tab5-staging` is in flight against
that exact file (+623 lines) and carries the same CRLF, so the renormalization would
collide head-on with unaccepted Gate 1 device work and destroy the reviewable diff.

Do it as its own dedicated commit **after** checkpoint 2 is accepted and merged, when
no branch is in flight against `tab5/`. Nothing on `Tab5` depends on the digest
tripwire, so there is no urgency. Until then `Tab5` keeps no `.gitattributes`.

**This is worth fixing rather than filing.** The test is a tripwire for unauthorized
changes to the protective telemetry path. Permanently red for an unrelated reason, it
has already been normalized as a known failure and can no longer detect a real change.
Fix in `.gitattributes` (`* text=auto eol=lf`, or scoped to the guarded files) so it
holds for every checkout, rather than per-machine `core.autocrlf`. Never "fix" it by
updating the expected digests.

**5.8 BLOCKING — Gate 1's own RTDB rules deny the V3 writes they are meant to allow.**

Found 2026-08-30 by running the emulator suite that had never been run. On
`agent/event-v3-checkpoint2-delivery` (`f355c18b`), `npm run test:rtdb-rules` gives
**9 tests, 7 pass, 2 fail**. The seven passing are the pre-existing V2 tests. **The two
failing are exactly the two tests Gate 1 added** — the V3 staging pointer and the V3
staging state. Both fail `PERMISSION_DENIED` on their *first* `assertSucceeds`, i.e.
the legitimate write is refused.

The failure direction is **fail-closed**, so nothing unsafe is reachable; but Gate 1 as
published does not function — a V3 pointer cannot be written and a device cannot report
staging state. Two independent root causes, both confirmed by patching a scratch copy
and re-running (the published file was restored and re-verified byte-identical):

1. **`"$other": {".validate": false}` denies every scalar field.** It is applied to
   `rules/v3/current`, `rulesV3State`, `desired`, `staged`, and `rejected` — none of
   which name their permitted children. In RTDB, `$other` matches *every* child that is
   not explicitly named, so it rejects `schemaVersion`, `kind`, `releaseId`, and the
   rest — the very fields the parent `.validate` demands via `hasChildren`. The V2
   `rules/current` node, which has no `$other`, passes. Removing the five `$other`
   clauses lets both valid writes through — and then the negative assertions
   (`unreviewed: true`, `extra: true`) start passing when they must fail. So `$other`
   is doing double duty and **deletion is not the fix**: the rules need an explicit
   named-child validator layer *beneath* `$other`.
2. **`hasChildren` requires children the valid payload sets to `null`.**
   `rulesV3State.validate` requires `[... 'staged', 'rejected']`, but the contract's own
   valid state writes `rejected: null`, and a null child does not exist in RTDB. A
   legitimate "nothing rejected" state is therefore unwritable. Confirmed: dropping
   `staged`/`rejected` from `hasChildren` lets the valid write through.

**Gate 1 must not be accepted or promoted in this state.** This is the next bounded
unit — see §6.1.

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
   processing. ← **current step; checkpoint 2 / Gate 1 is this work**

### 6.1 Gate 1 status — independently verified 2026-08-30

Published and verified from GitHub, not from the implementer's report:

| Branch | SHA | vs its base | Files |
|---|---|---|---|
| `agent/event-v3-checkpoint2-delivery` | `f355c18b` | 2 ahead of `d0b8a316`, 0 behind, merge base correct | 17 changed, +599/−19 |
| `agent/event-v3-checkpoint2-tab5-staging` | `a416034d` | 1 ahead of `67553473`, 0 behind | 6 changed, +1133/−2 |

Verified independently:

- **`executionEnabled: false` is enforced at four layers** — `"const": false` in three
  JSON schemas, the V3 store, a throw in the delivery lib
  (`execution_must_remain_disabled`), and the RTDB security rules (`.val() == false`).
- **V2 is preserved in the shared endpoint.** In `rules-engine-release.js`, `v3` gates
  on `version === "3"` and every V2 branch falls through to the identical original
  pattern, store, and verifier. The only V2-visible delta is an error check that also
  catches `RulesEngineV3ReleaseError`, which no V2 path can throw.
- `ingest-power.js` and the protected-hash expectations were not touched by Gate 1.

Tests reported: Tab5 host 112/112; V3 Node 10/10; V3 contract selection 23/23; full
Node suite 78 passed / 7 blocked — the blocks being missing `firebase-admin` and the
line-ending issue in §5.7. Firebase emulator suite could not run.

### 6.1a Second verification pass — 2026-08-30, Linux cloud session

Run against the live published branches, not a report. Branch identity re-confirmed:
`delivery` = `f355c18b`, `tab5-staging` = `a416034d`, merge bases `d0b8a316` and
`67553473` exactly as the table states. `agent/event-v3-contract` is still at the
pinned `78ca53af`, so the §1 authority pin is live, not stale.

**The environment blocks were environmental, and they are gone.** With dependencies
installed on an LF checkout:

| Suite | Result |
|---|---|
| Node host suite, delivery branch | **110 pass / 0 fail / 0 blocked** |
| `tests/contract-schemas.test.js` incl. protected baseline | **9/9 pass** |
| Tab5 host suite, staging branch (`unittest discover`) | **112/112 OK** |
| **Firebase RTDB emulator suite** | **9 tests, 7 pass, 2 FAIL** |

The first three close out the previously reported blocks: the "7 blocked" were missing
`firebase-admin` plus the CRLF artifact, nothing more. The reported 112/112 is
confirmed independently.

**The emulator suite is no longer a coverage gap — it is a failure.** Running it was
the one thing standing between Gate 1 and acceptance, and it does not pass. The two
failures are precisely the two tests Gate 1 added. Root causes are diagnosed in
**§5.8**.

**Gate 1 acceptance status: BLOCKED on a real defect, not on missing coverage.** The
earlier "emulator coverage is the one real remaining blocker" line above is superseded.

Environment note, durable: the emulator suite **does** run in a Linux container with
Java 21 present, but the Firebase CLI must be invoked with the proxy variables unset
(`env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u JAVA_TOOL_OPTIONS`).
Left set, the CLI's loopback rules upload receives a proxy error body and fails with a
misleading `Unable to parse JSON: ... "refusing t"...`, which looks like a corrupt rules
file but is not — `firebase/rtdb.rules.json` parses as valid JSON. Do not chase that
error as a content bug.

**Both Gate 1 branches are 3 commits behind their bases — not 2.** The doc's own
"Record Gate 1 verification" commit (`ecea6fd` on `pilot`, `ffae79a` on `Tab5`) landed
after that sentence was written and made it stale immediately. Verified counts:
delivery 2 ahead / **3** behind; staging 1 ahead / **3** behind. All three behind-commits
touch only `00-CURRENT-STATE-READ-FIRST.md` and `AGENTS.md`, insertions only, zero code
files — so "no conflict risk" is confirmed, and a rebase or merge is trivial.

### 6.1b Next bounded unit — fix the V3 RTDB rules

Scope: `firebase/rtdb.rules.json` on `agent/event-v3-checkpoint2-delivery` only.
Make `tests/emulator/rtdb-rules.test.js` pass 9/9 without weakening any negative
assertion. Both defects in §5.8 must be fixed together, because fixing either alone
flips the other set of assertions:

- add an explicit named-child validator layer under `rules/v3/current`, `rulesV3State`,
  `desired`, `staged`, and `rejected`, so `$other` can keep rejecting unreviewed fields
  while the contract's own fields validate;
- stop requiring `hasChildren` for children the contract legitimately writes as `null`
  (`staged`, `rejected`), without allowing an arbitrary shape in their place.

Non-goals: no change to `executionEnabled: false` enforcement at any of the four
layers, no change to any V2 path, no schema or function changes, no `.gitattributes`
work in the same unit. Acceptance: `npm test` stays 110/110 and
`npm run test:rtdb-rules` reaches 9/9.

### 6.2 Deploy footprint to date

`pilot` was pushed 2026-08-30 to carry this document, which fired a Netlify branch
deploy. Blast radius verified: only `00-CURRENT-STATE-READ-FIRST.md` and `AGENTS.md`
changed — **zero files under `web/`, `cloud/`, `contracts/`, or `firebase/`** — so the
deploy republished functionally identical content. **No Gate 1 or V3 code is
deployed.** `main` has never been moved.

### 6.3 Note for Gate 2

Gate 1 removed the `v3_delivery_not_available` 409 and set `deliveryAvailable: true`.
Correct for this gate, but once the web branch deploys, a V3 `deliver` action will
write an RTDB pointer. The Gate 2 "stop for approval before any RTDB pointer write"
control is therefore **procedural, not technical**. Low risk — the pointer is
execution-disabled and no Tab5 carries a V3 runtime — but do not assume code prevents
it.
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

**Re-verified 2026-08-30 (Linux, dependencies installed), on the Gate 1 branches:**
Node host suite **110/110**, Tab5 host suite **112/112**, protected-baseline test
**passing**. These were executed, not reported. The Firebase RTDB emulator suite was
executed for the first time and **fails 2 of 9** — see §5.8. That failure is verified,
not asserted.

**Asserted but untested:** everything in V3 §§4–9. The V3 semantic kernel does not
exist yet.

**Never tested:** any Tab5 inhibit of a physically connected pump.
