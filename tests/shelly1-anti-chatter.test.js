"use strict";

// Focused regression for shelly1/anti-chatter.js.
//
// Loads the installed script into a stubbed Shelly runtime so the relay policy and
// the short-cycle scoring are exercised as written rather than as described. The
// device itself is not contacted; this proves the script's decisions, not the RPC
// shapes or the physical relay.
//
// Run: node --test tests/shelly1-anti-chatter.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "shelly1", "anti-chatter.js"), "utf8");
const META = JSON.parse(/^\/\/ @meta (.*)$/m.exec(SOURCE.split("\n")[0])[1]);
function setting(name) {
  return Number(new RegExp(`let ${name} = (\\d+);`).exec(SOURCE)[1]);
}
const INIT_DELAY = setting("InitDelay");
const INIT_LOCK_TIME = setting("InitLockTime");
const RESET_WINDOW = setting("TimeToResetLOcntr");

function startScriptFrom(source, options = {}) {
  return startScript(options, source);
}

function startScript(options = {}, source = SOURCE) {
  const declared = options.declared ?? Object.keys(META.vc);
  const clock = { now: 1_000_000 };
  const calls = [];
  const prints = [];
  const values = {};
  for (const [key, spec] of Object.entries(META.vc)) values[key] = spec.config.default_value;

  // null is a meaningful value here (unreadable output), so ?? would swallow it.
  const relay = { output: options.relayOutput === undefined ? false : options.relayOutput };
  const input = { state: options.inputState ?? false };

  const handles = {};
  for (const key of declared) {
    handles[key] = {
      getValue: () => values[key],
      setValue: value => { values[key] = value; },
    };
  }

  let tick = null;
  let statusHandler = null;

  const sandbox = {
    print: message => prints.push(String(message)),
    Date: { now: () => clock.now },
    Math,
    Script: { getVcHandle: key => handles[key] },
    Timer: { set: (_ms, _repeat, fn) => { tick = fn; } },
    Shelly: {
      getComponentStatus: key => {
        if (key === "switch:0") return relay.output === null ? null : { id: 0, output: relay.output };
        if (key === "input:0") return { id: 0, state: input.state };
        return null;
      },
      call: (method, params) => {
        calls.push({ method, params });
        if (method === "Switch.Set" && params.id === 0) relay.output = params.on;
      },
      addStatusHandler: fn => { statusHandler = fn; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "anti-chatter.js" });

  const api = {
    calls, prints, values, relay, clock,
    tick: () => tick(),
    advance: ms => { clock.now += ms; },
    // The script counts seconds from its own tick, so elapsed time only passes
    // when the timer actually fires. Drive it the way the device does.
    runFor: seconds => {
      for (let i = 0; i < seconds; i += 1) { clock.now += 1000; tick(); }
    },
    // The contactor follows RLY0: SW can only be high while the relay is closed.
    edge: state => {
      input.state = state;
      statusHandler({ component: "input:0", delta: { state } });
    },
    // Moves the terminal WITHOUT any notification, which is the case the device
    // appears to present: the level changes and no status event ever arrives.
    level: state => { input.state = state; },
    notify: event => statusHandler(event),
    setTab5: value => { values.tab5IsLocked = value; },
    relayWrites: () => calls.filter(c => c.method === "Switch.Set"),
    lock: () => values.isLocked,
    strikes: () => values.lockoutCount,
  };
  return api;
}

function startNormal(options = {}) {
  const s = startScript(options);
  for (let i = 0; i < INIT_DELAY; i += 1) {
    s.advance(1000);
    s.tick();
  }
  s.calls.length = 0;
  return s;
}

// A pump run: relay closed, SW rises, time passes, SW falls.
function runPump(s, seconds, betweenStartAndStop) {
  s.edge(true);
  s.runFor(seconds);
  if (betweenStartAndStop) betweenStartAndStop();
  s.edge(false);
}

test("startup initializes Tab5IsLocked false and holds the relay open for five seconds", () => {
  const s = startScript({ relayOutput: false });
  assert.equal(s.values.tab5IsLocked, false);
  for (let i = 1; i < INIT_DELAY; i += 1) {
    s.advance(1000); s.tick();
    assert.equal(s.relay.output, false, `relay remains open at ${i}s`);
  }
  s.advance(1000); s.tick();
  assert.equal(s.relay.output, true, "no Tab5 hard lock, so normal processing closes at 5s");
  assert.equal(s.lock(), 0);
});

test("startup corrects an unexpectedly closed relay to open immediately", () => {
  const s = startScript({ relayOutput: true });
  assert.deepEqual(s.relayWrites().map(c => c.params.on), [false]);
  assert.equal(s.relay.output, false);
});

test("Tab5 can reassert a hard lock during initialization", () => {
  const s = startScript({ relayOutput: false });
  s.advance(2000); s.tick();
  s.setTab5(true);
  for (let i = 1; i < INIT_DELAY; i += 1) { s.advance(1000); s.tick(); }
  assert.equal(s.values.tab5IsLocked, true);
  assert.equal(s.relay.output, false, "Tab5 hard lock keeps RLY0 open after the delay");
});

test("steady state with both holds clear issues no relay call", () => {
  const s = startNormal();
  for (let i = 0; i < 5; i += 1) { s.advance(1000); s.tick(); }
  assert.equal(s.relayWrites().length, 0);
});

test("Tab5 inhibition opens the relay once and release closes it once", () => {
  const s = startNormal();
  s.setTab5(true);
  s.advance(1000); s.tick();
  assert.deepEqual(s.relayWrites().map(c => c.params.on), [false]);
  s.advance(1000); s.tick();
  assert.equal(s.relayWrites().length, 1, "no repeat call while the policy already matches");

  s.setTab5(false);
  s.advance(1000); s.tick();
  assert.deepEqual(s.relayWrites().map(c => c.params.on), [false, true]);
  s.advance(1000); s.tick();
  assert.equal(s.relayWrites().length, 2);
});

test("a stop caused by Tab5 inhibition scores no strike", () => {
  const s = startNormal();
  runPump(s, 20, () => {
    // Tab5 asserts, the script applies it, and the contactor drops.
    s.setTab5(true);
    s.tick();
  });
  assert.equal(s.strikes(), 0, "a commanded stop is not chatter");
  assert.equal(s.lock(), 0, "no lockout from a commanded stop");
  assert.ok(s.prints.some(p => p.includes("applied Tab5 inhibition")));
});

test("three Tab5 inhibitions never reach the permanent lockout", () => {
  const s = startNormal();
  for (let i = 0; i < 3; i += 1) {
    runPump(s, 15, () => { s.setTab5(true); s.tick(); });
    s.setTab5(false);
    s.advance(1000); s.tick();
  }
  assert.equal(s.strikes(), 0);
  assert.notEqual(s.lock(), -1);
});

test("a genuine short cycle still scores a strike and holds the relay open", () => {
  const s = startNormal();
  runPump(s, 20);
  assert.equal(s.strikes(), 1);
  assert.equal(s.lock(), INIT_LOCK_TIME);
  assert.equal(s.relay.output, false);
});

test("a run at or beyond MinRuntime scores nothing", () => {
  const s = startNormal();
  runPump(s, 60);
  assert.equal(s.strikes(), 0);
  assert.equal(s.lock(), 0);
});

test("a genuine short cycle scores even while Tab5 intends an inhibit it has not applied", () => {
  // The distinction a bare level check would lose: Tab5's flag is set, but the
  // script has not ticked, so it did not cause this stop.
  const s = startNormal();
  runPump(s, 20, () => { s.setTab5(true); });
  assert.equal(s.strikes(), 1, "an unapplied intent must not excuse a real short cycle");
});

test("intent withdrawn before the falling edge is processed still suppresses the strike", () => {
  // The latch has to outlive the intent that caused it.
  const s = startNormal();
  s.edge(true);
  s.runFor(20);
  s.setTab5(true);
  s.tick();                 // script opens RLY0 for Tab5
  s.setTab5(false);         // Tab5 withdraws before the contactor edge lands
  s.edge(false);
  assert.equal(s.strikes(), 0, "the stop was still caused by this script applying Tab5 intent");
});

test("three genuine short cycles reach the permanent lockout", () => {
  const s = startNormal();
  for (let i = 0; i < 3; i += 1) {
    s.values.isLocked = 0;   // stand in for the lock expiring between attempts
    runPump(s, 10);
  }
  assert.equal(s.strikes(), 3);
  assert.equal(s.lock(), -1);
});

test("relay truth table", () => {
  const cases = [
    { lock: 0, tab5: false, closed: true, label: "both clear" },
    { lock: 90, tab5: false, closed: false, label: "local lock only" },
    { lock: 0, tab5: true, closed: false, label: "Tab5 only" },
    { lock: 90, tab5: true, closed: false, label: "both held" },
  ];
  for (const item of cases) {
    const s = startNormal();
    s.values.isLocked = item.lock;
    s.setTab5(item.tab5);
    s.advance(1000); s.tick();
    assert.equal(s.relay.output, item.closed, item.label);
  }
});

test("local lock expiry with Tab5 still held keeps the relay open", () => {
  const s = startNormal();
  s.values.isLocked = 2;
  s.setTab5(true);
  for (let i = 0; i < 4; i += 1) { s.advance(1000); s.tick(); }
  assert.equal(s.lock(), 0, "the local lock counted down");
  assert.equal(s.relay.output, false, "Tab5's hold survives the local expiry");
});

test("a missing Tab5IsLocked handle never clears the local lock", () => {
  const declared = Object.keys(META.vc).filter(k => k !== "tab5IsLocked");
  const s = startNormal({ declared });
  s.values.isLocked = 90;
  s.advance(1000); s.tick();
  assert.equal(s.relay.output, false, "IsLocked still opens the relay");
  assert.equal(s.lock(), 89, "the local lock still counts down");
  assert.ok(s.prints.some(p => p.includes("Tab5IsLocked handle unavailable")));
});

test("a missing Tab5IsLocked handle leaves the relay closed when nothing else holds it", () => {
  const declared = Object.keys(META.vc).filter(k => k !== "tab5IsLocked");
  const s = startNormal({ declared });
  s.advance(1000); s.tick();
  assert.equal(s.relay.output, true, "the agreed fail-permissive posture");
});

test("the script seeds Tab5IsLocked false, then preserves Tab5 updates", () => {
  const s = startNormal();
  assert.equal(s.values.tab5IsLocked, false);
  s.setTab5(true);
  for (let i = 0; i < 5; i += 1) { s.advance(1000); s.tick(); }
  assert.equal(s.values.tab5IsLocked, true, "normal polling does not overwrite Tab5");
  runPump(s, 10);
  assert.equal(s.values.tab5IsLocked, true);
});

test("an unreadable relay output produces no relay call", () => {
  const s = startNormal({ relayOutput: null });
  s.setTab5(true);
  s.advance(1000); s.tick();
  assert.equal(s.relayWrites().length, 0, "unknown evidence is not a mismatch");
});

test("an edge seen while a hold is applied does not begin a run", () => {
  const s = startNormal();
  s.setTab5(true);
  s.advance(1000); s.tick();
  s.edge(true);            // cannot happen physically; must not arm a run either
  s.advance(5000);
  s.setTab5(false);
  s.tick();
  s.edge(false);
  assert.equal(s.strikes(), 0);
});

test("the declared component set stays inside the device budget", () => {
  assert.deepEqual(Object.keys(META.vc), ["isLocked", "lockoutCount", "tab5IsLocked"]);
  assert.ok(Object.keys(META.vc).length <= 10, "ten virtual-component slots on this device");
  const names = Object.values(META.vc).map(v => v.config.name);
  assert.equal(new Set(names).size, names.length, "duplicate names break Tab5 discovery");
  assert.equal(META.vc.tab5IsLocked.config.persisted, false);
  assert.equal(META.vc.tab5IsLocked.config.default_value, false);
});

test("anti-cycle tuning remains editable as constants at the beginning of the script", () => {
  assert.equal(setting("MinRuntime"), 60);
  assert.equal(setting("InitLockTime"), 90);
  assert.equal(setting("MaxLOcntr"), 3);
  assert.equal(setting("TimeToResetLOcntr"), 3600);
  assert.equal(setting("InitDelay"), 5);
  for (const removed of ["minRuntime", "initLockTime", "maxLockoutCount", "lockoutResetTime"]) {
    assert.equal(META.vc[removed], undefined, `${removed} must not consume a component slot`);
  }
});

test("a wall-clock step does not affect a run measurement", () => {
  // The device steps its clock when SNTP lands, which is shortly after boot -
  // exactly when this script starts. Run length is counted from the tick instead.
  for (const step of [120_000, -120_000]) {
    const s = startNormal();
    s.edge(true);
    s.runFor(20);
    s.advance(step);          // clock jumps, no time actually passes
    s.edge(false);
    assert.equal(s.strikes(), 1, `short cycle still scored across a ${step}ms step`);
  }
});

test("a wall-clock step does not forgive accumulated strikes", () => {
  const s = startNormal();
  runPump(s, 20);
  assert.equal(s.strikes(), 1);
  s.values.isLocked = 0;                       // lock cleared by hand
  s.advance(RESET_WINDOW * 1000 + 1000);       // clock jumps past the decay window
  s.tick();
  assert.equal(s.strikes(), 1, "the window is real elapsed time, not clock arithmetic");
  s.runFor(RESET_WINDOW);
  assert.equal(s.strikes(), 0, "and it does decay once that time actually passes");
});

test("hand-edited settings are clamped to usable ranges", () => {
  // The virtual components enforced these in the UI; plain constants do not.
  const over = name => {
    const patched = SOURCE.replace(new RegExp(`let ${name} = \\d+;`), `let ${name} = 0;`);
    return patched;
  };
  // MinRuntime 0 would make "ranS < MinRuntime" unsatisfiable: nothing could score.
  const s = startScriptFrom(over("MinRuntime"));
  for (let i = 0; i < INIT_DELAY; i += 1) { s.advance(1000); s.tick(); }
  s.edge(true);
  s.edge(false);
  assert.equal(s.strikes(), 1, "MinRuntime clamped up, so detection still works");
});

// The status handler's event shape is an assumption about the firmware that has
// never been confirmed on the device. These cover the reported symptom: the
// level moves, no notification arrives, and nothing is detected.

test("a run seen only as a level change still scores a strike", () => {
  const s = startNormal();
  s.level(true);
  s.runFor(1);            // the tick polls the level and starts the run
  s.runFor(10);
  s.level(false);
  s.runFor(1);            // the tick polls the level and ends it
  assert.equal(s.strikes(), 1, "a short cycle no notification reported still scores");
  assert.equal(s.lock(), 90);
});

test("a long run seen only as a level change scores nothing", () => {
  const s = startNormal();
  s.level(true);
  s.runFor(70);
  s.level(false);
  s.runFor(1);
  assert.equal(s.strikes(), 0);
  assert.equal(s.lock(), 0);
});

test("an edge reported by both the handler and the poll counts once", () => {
  const s = startNormal();
  runPump(s, 10);         // handler-driven, level left consistent
  s.runFor(1);            // the poll sees the same level and must not re-fire
  assert.equal(s.strikes(), 1, "one short cycle, one strike");

  s.runFor(200);          // let the lock expire
  runPump(s, 10);
  s.runFor(1);
  assert.equal(s.strikes(), 2, "the second is counted, and only once");
});

test("three short cycles reach the permanent lockout with no notifications at all", () => {
  const s = startNormal();
  for (let i = 0; i < 3; i += 1) {
    s.level(true);
    s.runFor(5);
    s.level(false);
    s.runFor(1);
    s.runFor(200);        // outlast the lock so the next run is observed
  }
  assert.equal(s.strikes(), 3);
  assert.equal(s.lock(), -1, "the strikeout is reachable without the status handler");
});

test("a level already high when initialization completes does not begin a run", () => {
  // SW high at startup means a pump already running, whose start was not seen.
  // Counting it would measure a run from the wrong instant.
  const s = startScript({ inputState: true });
  for (let i = 0; i < 5; i += 1) { s.advance(1000); s.tick(); }
  s.level(false);
  s.runFor(1);
  assert.equal(s.strikes(), 0, "no strike from a run this script never saw start");
});

test("an unreadable input level is not mistaken for an edge", () => {
  const s = startNormal();
  s.level(true);
  s.runFor(2);
  assert.equal(s.strikes(), 0);
  s.level(null);          // getComponentStatus reports no boolean state
  s.runFor(3);
  s.level(true);          // still the same real level; must not have been an edge
  s.runFor(1);
  s.level(false);
  s.runFor(1);
  assert.equal(s.strikes(), 1, "one run, ended once, despite the unreadable gap");
});

test("a malformed or foreign status event is ignored without throwing", () => {
  const s = startNormal();
  for (const event of [null, undefined, {}, { component: "switch:0", delta: { output: true } },
                       { component: "input:0" }, { component: "input:0", delta: null },
                       { component: "input:0", delta: { state: "true" } }]) {
    assert.doesNotThrow(() => s.notify(event), `event ${JSON.stringify(event)}`);
  }
  assert.equal(s.strikes(), 0);
  // The script must still be working afterwards.
  s.level(true); s.runFor(1); s.level(false); s.runFor(1);
  assert.equal(s.strikes(), 1);
});
