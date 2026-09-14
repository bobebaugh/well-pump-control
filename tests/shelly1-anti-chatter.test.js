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

function startScript(options = {}) {
  const declared = options.declared ?? Object.keys(META.vc);
  const clock = { now: 1_000_000 };
  const calls = [];
  const prints = [];
  const values = {};
  for (const [key, spec] of Object.entries(META.vc)) values[key] = spec.config.default_value;

  // null is a meaningful value here (unreadable output), so ?? would swallow it.
  const relay = { output: options.relayOutput === undefined ? true : options.relayOutput };
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
  vm.runInContext(SOURCE, sandbox, { filename: "anti-chatter.js" });

  const api = {
    calls, prints, values, relay, clock,
    tick: () => tick(),
    advance: ms => { clock.now += ms; },
    // The contactor follows RLY0: SW can only be high while the relay is closed.
    edge: state => {
      input.state = state;
      statusHandler({ component: "input:0", delta: { state } });
    },
    setTab5: value => { values.tab5IsLocked = value; },
    relayWrites: () => calls.filter(c => c.method === "Switch.Set"),
    lock: () => values.isLocked,
    strikes: () => values.lockoutCount,
  };
  return api;
}

// A pump run: relay closed, SW rises, time passes, SW falls.
function runPump(s, seconds, betweenStartAndStop) {
  s.edge(true);
  s.advance(seconds * 1000);
  if (betweenStartAndStop) betweenStartAndStop();
  s.edge(false);
}

test("startup leaves the relay closed and writes no relay call when already closed", () => {
  const s = startScript({ relayOutput: true });
  assert.equal(s.relayWrites().length, 0);
  assert.equal(s.relay.output, true);
  assert.equal(s.lock(), 0);
});

test("steady state with both holds clear issues no relay call", () => {
  const s = startScript({ relayOutput: true });
  for (let i = 0; i < 5; i += 1) { s.advance(1000); s.tick(); }
  assert.equal(s.relayWrites().length, 0);
});

test("Tab5 inhibition opens the relay once and release closes it once", () => {
  const s = startScript({ relayOutput: true });
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
  const s = startScript({ relayOutput: true });
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
  const s = startScript({ relayOutput: true });
  for (let i = 0; i < 3; i += 1) {
    runPump(s, 15, () => { s.setTab5(true); s.tick(); });
    s.setTab5(false);
    s.advance(1000); s.tick();
  }
  assert.equal(s.strikes(), 0);
  assert.notEqual(s.lock(), -1);
});

test("a genuine short cycle still scores a strike and holds the relay open", () => {
  const s = startScript({ relayOutput: true });
  runPump(s, 20);
  assert.equal(s.strikes(), 1);
  assert.equal(s.lock(), META.vc.initLockTime.config.default_value);
  assert.equal(s.relay.output, false);
});

test("a run at or beyond MinRuntime scores nothing", () => {
  const s = startScript({ relayOutput: true });
  runPump(s, 60);
  assert.equal(s.strikes(), 0);
  assert.equal(s.lock(), 0);
});

test("a genuine short cycle scores even while Tab5 intends an inhibit it has not applied", () => {
  // The distinction a bare level check would lose: Tab5's flag is set, but the
  // script has not ticked, so it did not cause this stop.
  const s = startScript({ relayOutput: true });
  runPump(s, 20, () => { s.setTab5(true); });
  assert.equal(s.strikes(), 1, "an unapplied intent must not excuse a real short cycle");
});

test("intent withdrawn before the falling edge is processed still suppresses the strike", () => {
  // The latch has to outlive the intent that caused it.
  const s = startScript({ relayOutput: true });
  s.edge(true);
  s.advance(20_000);
  s.setTab5(true);
  s.tick();                 // script opens RLY0 for Tab5
  s.setTab5(false);         // Tab5 withdraws before the contactor edge lands
  s.edge(false);
  assert.equal(s.strikes(), 0, "the stop was still caused by this script applying Tab5 intent");
});

test("three genuine short cycles reach the permanent lockout", () => {
  const s = startScript({ relayOutput: true });
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
    const s = startScript({ relayOutput: true });
    s.values.isLocked = item.lock;
    s.setTab5(item.tab5);
    s.advance(1000); s.tick();
    assert.equal(s.relay.output, item.closed, item.label);
  }
});

test("local lock expiry with Tab5 still held keeps the relay open", () => {
  const s = startScript({ relayOutput: true });
  s.values.isLocked = 2;
  s.setTab5(true);
  for (let i = 0; i < 4; i += 1) { s.advance(1000); s.tick(); }
  assert.equal(s.lock(), 0, "the local lock counted down");
  assert.equal(s.relay.output, false, "Tab5's hold survives the local expiry");
});

test("a missing Tab5IsLocked handle never clears the local lock", () => {
  const declared = Object.keys(META.vc).filter(k => k !== "tab5IsLocked");
  const s = startScript({ relayOutput: true, declared });
  s.values.isLocked = 90;
  s.advance(1000); s.tick();
  assert.equal(s.relay.output, false, "IsLocked still opens the relay");
  assert.equal(s.lock(), 89, "the local lock still counts down");
  assert.ok(s.prints.some(p => p.includes("Tab5IsLocked handle unavailable")));
});

test("a missing Tab5IsLocked handle leaves the relay closed when nothing else holds it", () => {
  const declared = Object.keys(META.vc).filter(k => k !== "tab5IsLocked");
  const s = startScript({ relayOutput: true, declared });
  s.advance(1000); s.tick();
  assert.equal(s.relay.output, true, "the agreed fail-permissive posture");
});

test("the script never writes Tab5IsLocked", () => {
  const s = startScript({ relayOutput: true });
  s.setTab5(true);
  for (let i = 0; i < 5; i += 1) { s.advance(1000); s.tick(); }
  assert.equal(s.values.tab5IsLocked, true, "Tab5 owns this component");
  runPump(s, 10);
  assert.equal(s.values.tab5IsLocked, true);
});

test("an unreadable relay output produces no relay call", () => {
  const s = startScript({ relayOutput: null });
  s.setTab5(true);
  s.advance(1000); s.tick();
  assert.equal(s.relayWrites().length, 0, "unknown evidence is not a mismatch");
});

test("an edge seen while a hold is applied does not begin a run", () => {
  const s = startScript({ relayOutput: true });
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
  assert.equal(Object.keys(META.vc).length, 7);
  assert.ok(Object.keys(META.vc).length <= 10, "ten virtual-component slots on this device");
  const names = Object.values(META.vc).map(v => v.config.name);
  assert.equal(new Set(names).size, names.length, "duplicate names break Tab5 discovery");
  assert.equal(META.vc.tab5IsLocked.config.persisted, false);
  assert.equal(META.vc.tab5IsLocked.config.default_value, false);
});
