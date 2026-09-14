# Shelly 1 / Tab5 lock coordination — design proposal

**Status:** proposal, not accepted. Supersedes the `LoRequestCnt` coordination plan.
**Branch:** `tab5-working`
**Reviewer decision needed on:** sections 2, 3 and 6. Sections 1 and 5 are owner-decided
and recorded here for context.

This revises an earlier plan after review found three gaps that would fail in service,
and after owner measurements on the installed hardware changed what is affordable. Each
change below records the reason, so a reviewer can disagree with the reason rather than
only the conclusion.

---

## 1. Failure posture — owner-decided

**The system is an optional overlay. If it fails without cause, it must fail to allow
water.**

The earlier plan set the Shelly's power-on relay state to OFF so a rebooting device could
never permit an unprotected start. That inverts the principle above and is rejected.

The trade is irreducible: "fail to allow water" means the relay is closed whenever the
script is not running; "no unprotected start after a reboot" means it is open whenever the
script is not running. Same condition, opposite required outcomes, and the relay cannot
distinguish *booting* from *broken*.

Failing open is not failing unprotected. Underneath everything sits the original
automation — pressure switch, 3-second on-delay, 6-minute max-runtime limit, HAND bypass —
hardware that ran the well for years and is untouched by a script fault. Failing back to
that is failing back to a working well. Failing closed is failing to something *worse than
not having installed the system*.

Two supporting arguments:

- Once the script has run stably, the remaining "script dead but relay works" slice is
  narrow. The failures that actually matter are Shelly failures — dead supply, failed
  relay, welded contacts, cooked firmware — and in every one of those the relay does what
  physics says and no configuration setting has a vote. Fail-closed pays a certain cost
  (any Shelly problem becomes a guaranteed water outage) for a shrinking benefit.
- A stuck-closed relay is undetectable from software. The script reads `switch:0.output`,
  which is the firmware's model, not the contacts. The Shelly was never a guaranteed
  inhibit; it is a usually-works inhibit over hardware that genuinely works.

**Consequences:** power-on relay state stays **ON**. The 5-second startup hold is removed —
its only job was to withhold permission until Tab5 registered, and in a fail-open design
permission is the default state. It would also mean opening the relay on script start,
which could interrupt a legitimately running pump and register as a short cycle the script
itself caused.

**Accepted exposure:** boot time plus one Tab5 cycle, during which the relay is closed and
the pump may start. Bounded by the 3-second on-delay in front of any start, and Tab5's
inhibits are slow-fault classes (P013 at 360 s, P014 at 1800 s). A few extra seconds during
a leak already six minutes old is not a meaningful increment.

---

## 2. Two owned flags, not a shared counter — **decision needed**

Replace `LoRequestCnt` with two fields, each written by exactly one party.

| Field | Owner | Range | Meaning |
| --- | --- | --- | --- |
| `IsLocked` | Shelly script | −1 … 86400 | `0` clear, positive = seconds remaining, `−1` permanent |
| `loCntr` | Shelly script | 0 … 3 | Accumulated short-cycle strikes. Tab5 reads, never writes. |
| `Tab5Lock` | Tab5 | 0 … 1 | Tab5 wants an inhibit. Tab5 writes, Shelly reads. |

**Relay closes only when `IsLocked == 0 AND Tab5Lock == 0`.**
**The Shelly script is the sole writer of RLY0.** Tab5 stops calling `Switch.Set`.

### Why not the shared counter

Three gaps found in the counter design, all the same underlying problem — two independent
writers coordinating on one resource by convention:

1. **Tab5 restart orphans or duplicates its contribution.** The plan covered
   Shelly-resets-while-Tab5-lives but not the reverse. Tab5's state is volatile by design,
   and restarting it is routine — one of three online controls, the only exit from User
   Monitor, and how packages are adopted. A restarted Tab5 either re-registers (double
   contribution) or does not (orphan). Both leave RLY0 open until a Shelly reboot, and
   neither is visible in a bare integer.
2. **The startup hold was invisible.** With `IsLocked = 0` and `LoRequestCnt = 0` during the
   hold, Tab5 reads "no lock, no requests" while the relay is open. `pilot.py:1299` gates
   closing on the lock alone, so Tab5 could close RLY0 during the hold and defeat it.
   (Moot now that the hold is removed, but it showed the shape of the problem.)
3. **The close condition reintroduced a bug fixed in `016ba5a`.** Making the Shelly close
   when both counters are zero, while Tab5 still writes the relay directly, means any Tab5
   inhibit that opens RLY0 without registering gets closed again every second.

A shared counter also cannot enforce "release only its own contribution" — it has no
ownership. That turns the standing rule that Tab5 never clears a Shelly lockout from a
structural property into a convention.

### What two owned flags fix, by construction

- The script cannot fight Tab5 — one writer, so contention is unrepresentable.
- Tab5 cannot release a Shelly lockout — it has no write to `IsLocked`.
- The Tab5-restart orphan disappears — Tab5 holds no state about an action on a shared
  resource, because it never takes one. It writes intent; intent is idempotent.
- The relay becomes a pure function of two inputs rather than a history of interleaved
  writes. The state space is enumerable on paper instead of requiring interleaving
  simulation.
- When the relay is open you can see **who** is holding it.

### Reconciliation: compare-and-correct, not periodic, not an event

Tab5 already fetches every dynamic component each cycle. It reads back `Tab5Lock`,
compares against intent, and writes only on disagreement.

- Zero extra reads, zero writes in steady state.
- Corrects within one cycle, so a Shelly reboot is repaired in ~2 s.
- Self-heals any cause — reboot, dropped write, manual edit, component recreated.

**This belongs in code, not in the rules package.** §4.8's test is "do I want a published
data file to be able to delete this?" and its frozen list names *the Shelly enable gate*
explicitly. Re-establishing a forgotten inhibit is that gate. As a package event it is
deletable, and its absence is silent — `enabled_rule_count()` counts rules regardless.

An event should still **observe** the reconciliation and record it, per §4.7 and §4.10.
Rules react and record; they do not do the work.

This also dissolves the open question in the earlier plan about distinguishing registration
from duplicate registration. That question existed because a level-shaped requirement was
being driven from an edge-shaped mechanism. With an idempotent set there are no edges.

**Latency note:** Tab5's inhibit now takes effect on the Shelly's next evaluation rather
than immediately. Harmless — the 3-second on-delay covers it — and it can be made
near-zero, since the virtual handle supports `on("change")` and the script can react on
write rather than on tick.

**Naming:** `LoRequestCnt` described a shared count. With owned flags there is no shared
count and Tab5's field is not a count, so `Tab5Lock` replaces it.

---

## 3. Three virtual components, four constants — **decision needed**

Only three fields cross the Shelly/Tab5 boundary. The rest become constants in the first
lines of the script, editable by the owner without tooling.

| Component | Keep | Reason |
| --- | --- | --- |
| `IsLocked` | yes | Enable gate; `normalize_shelly1_components` rejects the whole acquisition without it |
| `loCntr` | yes | Same hard contract; removing it means changing installed Python |
| `Tab5Lock` | yes | New; the only field Tab5 writes |
| `MinRuntime` | no → constant | Shelly-internal; no Tab5 code reads it, no rule can reference it |
| `InitLockTime` | no → constant | Same |
| `MaxLOcntr` | no → constant | Same |
| `TimeToResetLOcntr` | no → constant | Same |

Six to three. All three are non-persisted, which collapses the persisted/volatile split
into one rule — *nothing on the Shelly survives a reboot* — matching §4.5.

**Cost:** tuning requires editing, saving and restarting the script, which resets all three
and momentarily releases any hold. Commissioning-time only.

**Note:** `loCntr` is read and displayed but is **not** rule-addressable — absent from both
`RUNTIME_DIRECT_BINDINGS` and `RUNTIME_OBJECT_PATHS`. Evidence only. It would need a
binding if a rule should ever gate on strike count.

---

## 4. Shelly script behaviour — unchanged from `016ba5a` except as noted

```
rising SW edge   pump started            → start run timer (ignored while locked)
falling SW edge  pump stopped            → if run < MinRuntime, infraction
infraction       loCntr += 1
                 loCntr < MaxLOcntr      → IsLocked = InitLockTime, RLY0 open
                 loCntr >= MaxLOcntr     → IsLocked = -1,           RLY0 open
every second     IsLocked > 0            → decrement
                 IsLocked == 0 and Tab5Lock == 0 → RLY0 closed
                 otherwise                        → RLY0 open
                 clean for TimeToResetLOcntr      → loCntr = 0
```

Changes from the installed version: the close condition now includes `Tab5Lock`, and the
script becomes the sole relay writer rather than only ever opening. That is safe *because*
Tab5 no longer writes the relay — the open-only rule existed precisely to avoid fighting a
second writer.

Constants: `MinRuntime` 60 s, `InitLockTime` 90 s, `MaxLOcntr` 3, `TimeToResetLOcntr` 3600 s.

`MinRuntime = 60` is set against measured behaviour. The pressure switch has cut-in/cut-out
hysteresis, so a healthy cycle always runs the full 40→60 PSI sweep; the captured fill in
`docs/pressure-calibration/` did it in ~95 s. Sixty seconds leaves ~35 s of margin while
still catching any stop with essentially no drawdown.

HAND needs no handling: the loop is hard-wired, SW never falls, no run is evaluated.

---

## 5. Measured cycle overrun — owner-observed

From the device HMI:

```
WORK LAST 1731 ms    INTERVAL 1732 ms
ADC 304 ms   EM 270 ms   S1 708 ms   V3 CALC/EVENT 26 ms
```

Named total 1308 ms; **423 ms (24%) unaccounted** — HMI render, observation build, durable
assembly, cloud submit, GC. `SAMPLE_PERIOD_MS` is 1000.

**Consequence not previously connected:** `INTERVAL ≈ WORK` means the loop never sleeps.
`sleep_until` is already past when the tail loop is reached, so the 50 ms touch-polling loop
**never executes**. Its own comment says it exists because polling touch once per second
"left 19 of every 20 touch polls reading a stale snapshot, which is what made taps feel
unresponsive." The overrun has silently reverted that fix.

---

## 6. Tab5 changes — **decision needed**

### 6.1 One Shelly 1 read instead of two

`read_shelly1()` currently issues `Shelly.GetStatus` **and** `Shelly.GetComponents` — 708 ms
combined. Consolidate using the `keys` filter, which filters before paging:

```
/rpc/Shelly.GetComponents?keys=["switch:0","input:0","number:<IsLocked>","number:<loCntr>","number:<Tab5Lock>"]&include=["config","status"]
```

Saves ~354 ms, the largest single win available. It also makes the record a **real
simultaneous snapshot**, which retires the DESIGN.md caveat that the Shelly 1 read "joins
two sequential RPC responses… intentionally not described as a simultaneous hardware
snapshot."

Verified on the device:

- `input:0` returns `{"id":0,"state":false}` with `config.type:"switch"` — the boolean
  `state` Tab5 needs, in the right mode.
- The **unfiltered** call is paginated and truncates: `"total":20` with 12 returned, and
  `switch:0` was **not** in the first page. Dropping `dynamic_only` without a `keys` filter
  would silently lose components.
- Component ids are **not stable**: `IsLocked` moved from `number:202` to `number:201`
  across a rebuild.

So the `keys` list must be built from ids resolved by name, not hard-coded. Keep
`include=["config","status"]` so every response carries `config.name` and Tab5 verifies the
mapping in-band. On a name mismatch, fall back to one `dynamic_only=true` call to
re-resolve, then resume.

### 6.2 Guard against a truncated page

`normalize_shelly1_components` does not look at `total`. A short page missing `loCntr`
currently falls through to "name not found" and rejects the acquisition — fail-safe, but it
presents as a device fault rather than a paging artifact. Compare the returned array length
against `total` and report incompleteness distinctly.

### 6.3 `ADC_FILTER_SAMPLE_COUNT` 5 → 3

Saves ~122 ms and *improves* accuracy on a moving signal.

- **Noise:** the electrical-zero test recorded 309 of 310 conversions at exactly 34 counts,
  σ ≈ 0.057 count — about 0.0003 PSI, against a reference gauge readable to ±0.3–0.5 PSI.
  Averaging five reduces negligible noise by √5. There is nothing to average away.
- **Smear:** the captured fill moved ~15,000 counts in 95 s, ~158 counts/sec. Sampling for
  304 ms averages ~48 counts — roughly 0.23 PSI of *real change* — into one reading. Three
  samples at 182 ms cuts that to ~0.14 PSI.
- **Filter still works:** `trimmed_mean_microvolts` discards one high and one low, so at
  three it becomes a **median of three** — which rejects exactly the single 35-among-34s the
  zero test showed. `sum(ordered[1:-1]) // (3-2)` is the middle value.
- **Do not use 2** — `ADC_FILTER_SAMPLE_COUNT - 2` divides by zero.

### 6.4 `SAMPLE_PERIOD_MS` 1000 → 2000

```
1731 ms  now
1377 ms  after consolidating S1
1255 ms  after also cutting ADC to 3
```

**One Hertz is not reachable.** The remaining 423 ms is diffuse with no single win left.
Two seconds gives ~750 ms of genuine slack, makes timing deterministic instead of "whatever
it takes," and restores the touch-polling loop. Already an open question in CURRENT.md;
the measurements settle it.

### 6.5 Write `Tab5Lock`, stop writing the relay

Add a `Number.Set` write on the resolved `Tab5Lock` id, over the same GET-style RPC Tab5
already uses. Remove the direct `Switch.Set` calls in `issue_rules_v3_action` and
`issue_runtime_stop`; those paths set intent instead.

---

## 7. Not decided / not covered

- Whether an observing event for reconciliation is added this round, or deferred.
- `on("change")` versus tick evaluation in the script for the `Tab5Lock` latency.
- The 423 ms unaccounted cycle time is unexplained and not attacked here.
- Nothing in this proposal has run on hardware.

---

## 8. Test plan

Simulate Tab5 contributions first; the installed Tab5 does not yet write `Tab5Lock`.

1. Steady state, unlocked, relay closed → **zero** `Switch.Set` calls over many ticks.
2. `Tab5Lock` set to 1 by hand → relay opens; set to 0 → relay closes.
3. Short cycle → strike, `IsLocked = 90`, relay opens; expiry → relay closes.
4. Third strike → `IsLocked = -1`, relay stays open; reboot clears.
5. `Tab5Lock = 1` while a Shelly lock is active → relay stays open through lock expiry.
6. **Tab5 restart while holding** — new session writes intent; no orphan, no duplicate.
7. **Shelly reboot while Tab5 holds** — `Tab5Lock` resets to 0, Tab5 rewrites within one
   cycle, relay reopens.
8. Script stopped → relay stays closed (fail-open confirmed).
9. Consolidated read returns `switch:0`, `input:0` and all three numbers, with `total`
   matching the array length.
10. Cycle time re-measured after 6.1, 6.3 and 6.4.
