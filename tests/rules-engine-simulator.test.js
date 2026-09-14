"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const { simulateScenario, simCondition, simWorld } = require(path.join(root, "web", "rules-engine-simulator.js"));

const backup = JSON.parse(fs.readFileSync(
  path.join(root, "tests", "fixtures", "rules-authoring-backup-2026-09-14.json"), "utf8"));

const run = scenario => simulateScenario(backup, scenario).steps;
const settled = scenario => run(scenario).at(-1);

test("a condition is undecided on the first absent field, in any mode", () => {
  const all = { mode: "all", clauses: [{ field: "V", operator: "lte", value: 266 }, { field: "A", operator: "eq", value: true }] };
  const any = { mode: "any", clauses: all.clauses };
  assert.equal(simCondition(all, { V: 240, A: true }), true);
  assert.equal(simCondition(any, { V: 300, A: true }), true);
  // "any" must not rescue a condition that mentions an absent field. This is
  // the behaviour that makes an availability guard inert.
  assert.equal(simCondition(all, { A: true }), null);
  assert.equal(simCondition(any, { A: true }), null);
});

test("losing utility power takes the mains-powered Shellys with it, not Tab5", () => {
  const world = simWorld({ disruption: "power", disruptionAt: 3, utilityPower: true, pressureCalling: true }, 5);
  assert.equal(world.utilityPower, false);
  assert.equal(world.emUp, false);
  assert.equal(world.shelly1Up, false);
});

test("a healthy well runs whenever the pressure switch calls", () => {
  const step = settled({ supplyVoltage: 245, cycles: 10 });
  assert.equal(step.pumpRuns, true);
  assert.deepEqual(step.owners, []);
});

test("overvoltage stops the pump and the inhibit is released when volts recover", () => {
  const high = run({ supplyVoltage: 270, cycles: 6 });
  assert.equal(high[0].pumpRuns, true, "E007 needs two observations before it qualifies");
  assert.equal(high.at(-1).pumpRuns, false);
  assert.deepEqual(high.at(-1).owners, ["E007"]);
  const recovered = settled({ supplyVoltage: 245, cycles: 20 });
  assert.equal(recovered.pumpRuns, true);
});

test("the same LAN failure gives opposite outcomes two cycles apart", () => {
  // This is the finding the static analyser can only describe. Before the
  // inhibit lands, the relay freezes closed and the pump runs at 270 V for as
  // long as the network is down. After it lands, it freezes open and there is
  // no water. Nothing about the rule decides which.
  const early = settled({ supplyVoltage: 270, disruption: "lan", disruptionAt: 2, cycles: 30 });
  const late = settled({ supplyVoltage: 270, disruption: "lan", disruptionAt: 4, cycles: 30 });
  assert.equal(early.pumpRuns, true);
  assert.equal(late.pumpRuns, false);
  for (const step of [early, late]) {
    assert.equal(step.mute, true, "Tab5 cannot reach Shelly 1");
    assert.equal(step.cloud, false, "the cloud goes with the LAN");
    assert.equal(step.landed, false);
  }
});

test("losing the EM alone freezes the inhibit open exactly as losing the LAN does", () => {
  const em = settled({ supplyVoltage: 270, disruption: "em", disruptionAt: 4, cycles: 30 });
  assert.equal(em.pumpRuns, false);
  assert.deepEqual(em.owners, ["E007"]);
  assert.ok(em.notes.some(note => /cannot close/.test(note)));
});

test("restarting Tab5 clears the board and releases the inhibit", () => {
  const steps = run({ supplyVoltage: 270, disruption: "tab5restart", disruptionAt: 10, cycles: 14 });
  assert.equal(steps[8].pumpRuns, false, "held before the restart");
  assert.deepEqual(steps[9].owners, [], "the fresh board owns nothing");
  // The condition is still true, so it re-qualifies and takes hold again.
  assert.equal(steps.at(-1).pumpRuns, false);
  assert.deepEqual(steps.at(-1).owners, ["E007"]);
});

test("HAND runs the pump whatever the rules and the relay are doing", () => {
  const step = settled({ supplyVoltage: 270, hand: true, shellyLock: 90, cycles: 12 });
  assert.equal(step.pumpRuns, true);
  assert.deepEqual(step.owners, ["E007"], "the inhibit is still held; HAND simply bypasses it");
  assert.match(step.reasons.join(" "), /hard-wires/);
});

test("a Shelly script lock holds the relay open and refuses Tab5's close", () => {
  const step = settled({ supplyVoltage: 245, shellyLock: 90, cycles: 10 });
  assert.equal(step.pumpRuns, false);
  assert.equal(step.relayEffective, false);
  assert.match(step.reasons.join(" "), /Shelly script lock reads 90/);
});

test("the authored Monitor keeps evaluating; the proposed Monitor stops", () => {
  const authored = settled({ supplyVoltage: 270, disruption: "usermonitor", disruptionAt: 5, cycles: 12 });
  const proposed = settled({ supplyVoltage: 270, disruption: "usermonitor", disruptionAt: 5, cycles: 12, monitorStopsProcessing: true });
  // Both restore water, which is what the operator asked for.
  assert.equal(authored.pumpRuns, true);
  assert.equal(proposed.pumpRuns, true);
  // The difference is the board. The authored one keeps opening events on it.
  assert.equal(authored.frozen, false);
  assert.equal(proposed.frozen, true);
  assert.ok(authored.openEvents.length > proposed.openEvents.length,
    "a frozen board stops accumulating events; that is the evidence the operator is reading");
});

test("no demand means no pump, whatever else is true", () => {
  const step = settled({ pressureCalling: false, supplyVoltage: 245, cycles: 8 });
  assert.equal(step.pumpRuns, false);
  assert.match(step.reasons.join(" "), /pressure switch is satisfied/);
});

test("the cycle count is bounded and every step is reported", () => {
  assert.equal(run({ cycles: 999 }).length, 60);
  assert.equal(run({ cycles: 0 }).length, 1);
  const steps = run({ cycles: 7 });
  assert.deepEqual(steps.map(step => step.cycle), [1, 2, 3, 4, 5, 6, 7]);
});

test("the browser wires the simulator without making the editor depend on it", () => {
  const html = fs.readFileSync(path.join(root, "web", "rules-engine.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "web", "rules-engine.js"), "utf8");
  assert.match(html, /rules-engine-simulator\.js/);
  for (const id of ["sim-disruption", "sim-at", "sim-cycles", "sim-volts", "sim-lock",
    "sim-power", "sim-pressure", "sim-hand", "sim-freeze", "sim-inspect",
    "sim-verdict", "sim-timeline", "sim-detail"]) {
    assert.ok(html.includes(`id="${id}"`), `missing control ${id}`);
  }
  // The editor must still load if the simulator script is missing.
  assert.match(source, /typeof simDisruptions === "function"/);
  assert.match(source, /typeof simulateScenario !== "function"/);
});
