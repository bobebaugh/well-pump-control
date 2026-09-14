"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const sim = require(path.join(root, "web", "rules-engine-simulator.js"));
const { simulateScenario, simCondition, simWorldAt, simInjectableEvents,
  SIM_INIT_LOCK_TIME } = sim;

const backup = JSON.parse(fs.readFileSync(
  path.join(root, "tests", "fixtures", "rules-authoring-backup-2026-09-14.json"), "utf8"));

const run = scenario => simulateScenario(backup, scenario).steps;
const at = (steps, cycle) => steps[cycle - 1];

test("nothing injected means a well that simply works", () => {
  const steps = run({ cycles: 40 });
  assert.ok(steps.every(step => step.pumpRuns), "a normal start must stay normal");
  assert.ok(steps.every(step => step.tab5Lock === 0 && step.isLocked === 0 && step.loCntr === 0));
});

test("only events that can hold the pump are offered for injection", () => {
  const offered = simInjectableEvents(backup.authoringPackage).map(item => item.id);
  assert.deepEqual(offered.sort(), ["E007", "H001", "M001"]);
  // S010 and S020 are informational: they observe, they do not control.
  assert.ok(!offered.includes("S010"));
  assert.ok(!offered.includes("S020"));
  // E002 holds the pump but is disabled, so it cannot be injected either.
  assert.ok(!offered.includes("E002"));
});

test("a transient event releases after the configured number of cycles", () => {
  const steps = run({ cycles: 60, transientRelease: 30, injections: [{ kind: "event", eventId: "E007", atCycle: 5 }] });
  assert.equal(at(steps, 4).pumpRuns, true);
  assert.equal(at(steps, 10).pumpRuns, false);
  assert.deepEqual(at(steps, 10).holders, ["E007"]);
  assert.equal(at(steps, 10).tab5Lock, 1);
  // Held for the injected span, then its own closing condition qualifies.
  assert.equal(at(steps, 34).pumpRuns, false);
  assert.equal(steps.at(-1).pumpRuns, true);
  assert.equal(steps.at(-1).tab5Lock, 0);
});

test("the transient release span is a variable, not a constant", () => {
  const short = run({ cycles: 60, transientRelease: 5, injections: [{ kind: "event", eventId: "E007", atCycle: 5 }] });
  const long = run({ cycles: 60, transientRelease: 50, injections: [{ kind: "event", eventId: "E007", atCycle: 5 }] });
  const stoppedFor = steps => steps.filter(step => !step.pumpRuns).length;
  assert.ok(stoppedFor(short) < stoppedFor(long));
  assert.equal(short.at(-1).pumpRuns, true);
  assert.equal(long.at(-1).pumpRuns, false, "a 50-cycle hold has not released by cycle 60");
});

test("a latched event never releases on its own", () => {
  // M001 is monitor-class and closes only on clearEvents.
  const steps = run({ cycles: 50, injections: [{ kind: "event", eventId: "M001", atCycle: 5 }] });
  assert.equal(steps.at(-1).monitor, true);
  assert.ok(steps.slice(6).every(step => step.monitor), "Monitor is terminal");
  const restarted = run({ cycles: 50, injections: [
    { kind: "event", eventId: "M001", atCycle: 5 }, { kind: "tab5restart", atCycle: 30 }] });
  assert.equal(at(restarted, 31).monitor, false, "only a restart clears it");
});

test("the Shelly scores a strike, holds its own lock, and counts itself down", () => {
  const steps = run({ cycles: 60, secondsPerCycle: 2, injections: [{ kind: "shortcycle", atCycle: 5 }] });
  assert.equal(at(steps, 5).isLocked, SIM_INIT_LOCK_TIME);
  assert.equal(at(steps, 5).loCntr, 1);
  assert.equal(at(steps, 5).pumpRuns, false);
  assert.equal(at(steps, 5).tab5Lock, 0, "this lock is the Shelly's, not Tab5's");
  assert.equal(at(steps, 6).isLocked, SIM_INIT_LOCK_TIME - 2);
  assert.equal(steps.at(-1).isLocked, 0);
  assert.equal(steps.at(-1).pumpRuns, true);
  assert.equal(steps.at(-1).loCntr, 1, "the strike stands after the lock expires");
});

test("seconds per cycle changes how long a Shelly lock takes to clear", () => {
  const slow = run({ cycles: 40, secondsPerCycle: 2, injections: [{ kind: "shortcycle", atCycle: 2 }] });
  const fast = run({ cycles: 40, secondsPerCycle: 8, injections: [{ kind: "shortcycle", atCycle: 2 }] });
  assert.ok(fast.filter(step => step.pumpRuns).length > slow.filter(step => step.pumpRuns).length);
});

test("the third strike is permanent and only a reboot clears it", () => {
  const injections = [{ kind: "shortcycle", atCycle: 2 }, { kind: "shortcycle", atCycle: 55 }, { kind: "shortcycle", atCycle: 108 }];
  const steps = run({ cycles: 120, injections });
  assert.equal(steps.at(-1).isLocked, -1);
  assert.equal(steps.at(-1).loCntr, 3);
  assert.equal(steps.at(-1).pumpRuns, false);
  const rebooted = run({ cycles: 120, injections: injections.concat([{ kind: "shellyreboot", atCycle: 115 }]) });
  assert.equal(rebooted.at(-1).isLocked, 0);
  assert.equal(rebooted.at(-1).loCntr, 0);
  assert.equal(rebooted.at(-1).pumpRuns, true);
});

test("nothing Tab5 does clears a Shelly lock", () => {
  const steps = run({ cycles: 40, injections: [
    { kind: "shortcycle", atCycle: 3 }, { kind: "tab5restart", atCycle: 10 }] });
  assert.ok(at(steps, 11).isLocked > 0, "a Tab5 restart is not a clear path for the Shelly");
  assert.equal(at(steps, 11).pumpRuns, false);
});

test("Tab5Lock is stuck where it was when Shelly 1 is unreachable", () => {
  const steps = run({ cycles: 60, transientRelease: 5, injections: [
    { kind: "event", eventId: "E007", atCycle: 3 }, { kind: "shelly1", atCycle: 6 }] });
  const stuck = steps.at(-1);
  assert.equal(stuck.tab5Lock, 1);
  assert.equal(stuck.mute, true);
  assert.equal(stuck.pumpRuns, false, "the inhibit outlives the reason for it");
  assert.ok(steps.some(step => step.notes.some(note => /old value stands/.test(note))));
});

test("a LAN failure engages Monitor on its own through the internal-trigger event", () => {
  // This is the hazard analysis_monitor_not_manual describes, demonstrated.
  const steps = run({ cycles: 40, injections: [{ kind: "lan", atCycle: 10 }] });
  assert.equal(at(steps, 9).monitor, false);
  assert.equal(steps.at(-1).monitor, true, "H001 opens on EM loss and suspends the controller");
  assert.equal(steps.at(-1).cloud, false, "and the cloud is gone, so nobody can undo it remotely");
  assert.ok(steps.at(-1).notes.some(note => /Exit is a Tab5 restart/.test(note)));
});

test("HAND runs the pump whatever the rules and both locks are doing", () => {
  const steps = run({ cycles: 40, injections: [
    { kind: "shortcycle", atCycle: 3 }, { kind: "event", eventId: "E007", atCycle: 3 }, { kind: "hand", atCycle: 6 }] });
  const step = steps.at(-1);
  assert.equal(step.pumpRuns, true);
  assert.ok(step.isLocked !== 0 || step.tab5Lock === 1, "a lock is still asserted underneath");
  assert.match(step.reasons.join(" "), /hard-wires/);
});

test("losing utility power takes the mains-powered Shellys, not Tab5", () => {
  const world = simWorldAt({ injections: [{ kind: "power", atCycle: 3 }] }, 5);
  assert.equal(world.utilityPower, false);
  assert.equal(world.emUp, false);
  assert.equal(world.shelly1Up, false);
  assert.equal(run({ cycles: 10, injections: [{ kind: "power", atCycle: 3 }] }).at(-1).pumpRuns, false);
});

test("restore puts the world back so a recovery can be watched", () => {
  const steps = run({ cycles: 60, injections: [
    { kind: "lan", atCycle: 5 }, { kind: "restore", atCycle: 20 }, { kind: "tab5restart", atCycle: 22 }] });
  assert.equal(at(steps, 10).cloud, false);
  assert.equal(at(steps, 25).cloud, true);
  assert.equal(steps.at(-1).pumpRuns, true);
  assert.equal(steps.at(-1).monitor, false);
});

test("no demand means no pump whatever else is true", () => {
  const steps = run({ cycles: 20, injections: [{ kind: "demandoff", atCycle: 5 }] });
  assert.equal(at(steps, 4).pumpRuns, true);
  assert.equal(steps.at(-1).pumpRuns, false);
  assert.match(steps.at(-1).reasons.join(" "), /pressure switch is satisfied/);
});

test("a condition is undecided on the first absent field, in any mode", () => {
  const clauses = [{ field: "V", operator: "lte", value: 266 }, { field: "A", operator: "eq", value: true }];
  assert.equal(simCondition({ mode: "all", clauses }, { V: 240, A: true }), true);
  assert.equal(simCondition({ mode: "any", clauses }, { V: 300, A: true }), true);
  assert.equal(simCondition({ mode: "all", clauses }, { A: true }), null);
  assert.equal(simCondition({ mode: "any", clauses }, { A: true }), null);
});

test("the run is bounded and every cycle is reported", () => {
  assert.equal(run({ cycles: 9999 }).length, 120);
  assert.deepEqual(run({ cycles: 5 }).map(step => step.cycle), [1, 2, 3, 4, 5]);
});

test("the browser exposes injection controls and the designed flags", () => {
  const html = fs.readFileSync(path.join(root, "web", "rules-engine.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "web", "rules-engine.js"), "utf8");
  for (const id of ["sim-kind", "sim-kind-at", "sim-add", "sim-clear", "sim-injections",
    "sim-cycles", "sim-transient", "sim-seconds", "sim-verdict", "sim-timeline",
    "sim-inspect", "sim-detail"]) {
    assert.ok(html.includes(`id="${id}"`), `missing control ${id}`);
  }
  for (const flag of ["Tab5Lock", "IsLocked", "loCntr", "RLY0"]) {
    assert.ok(source.includes(flag), `the detail panel must show ${flag}`);
  }
  assert.match(html, /Tab5 writes <code>Tab5Lock<\/code>/);
  // The editor must still load if the simulator script is missing.
  assert.match(source, /typeof simFaultKinds === "function"/);
  assert.match(source, /typeof simulateScenario !== "function"/);
});
