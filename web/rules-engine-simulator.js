"use strict";

// Scenario simulation for the Rules Engine screen.
//
// WHERE THE LINE IS. This simulates the decision layer — event opening and
// closing, ownership, what Tab5 tries to write and whether the write lands —
// against the package actually loaded in the editor. Everything else is an
// input you set, not a thing it models: the Shelly's own lock timer, the
// pressure sensor, the tank, the motor. Simulating those would mean writing a
// plant model, and a plant model that drifts from the well is worse than no
// plant model at all.
//
// Time is measured in CYCLES, never seconds. Qualification in this engine is
// counted in observations, the loop period moves with load, and minimumSeconds
// is not modelled at all. A cycle is roughly two seconds on the current build.
//
// FIDELITY. These are the behaviours that produce the surprises, taken from
// tab5/pilot.py and reproduced deliberately:
//
//  1. A device record is accepted or rejected whole. A rejected device
//     contributes no fields at all rather than partial ones.
//  2. rules_v3_condition_value returns None on the FIRST absent field, before
//     the condition's mode is applied. "any" does not rescue a condition that
//     mentions an absent field.
//  3. An undecided closing condition is neither true nor false: the event stays
//     open and its close count is not reset.
//  4. $availability is always true or false, never absent, for an enabled
//     device. It cannot itself make a condition undecided.
//  5. A write only lands if the target device is reachable this cycle.
//  6. Closing the relay additionally requires the Shelly lock to read zero.
//  7. Every event in a cycle sees one frozen snapshot.
//
// It is a model of the documented contract, not of the installed code.

const SIM_PUMP_TARGET = "PumpEnable";
const SIM_MAX_CYCLES = 60;

function simDefaultScenario() {
  return {
    cycles: 30, utilityPower: true, hand: false, pressureCalling: true,
    supplyVoltage: 245, pumpWatts: 2400, shellyLock: 0,
    disruption: "none", disruptionAt: 10, monitorStopsProcessing: false
  };
}

function simDisruptions() {
  return [
    ["none", "Nothing fails"],
    ["lan", "LAN fails (both Shellys and the cloud)"],
    ["power", "Utility power out (Shellys dead, Tab5 on battery)"],
    ["em", "Shelly EM alone goes offline"],
    ["shelly1", "Shelly 1 alone goes offline"],
    ["tab5restart", "Tab5 restarts"],
    ["shellyreboot", "Shelly 1 reboots"],
    ["usermonitor", "Operator engages Monitor"],
    ["pressure", "Pressure switch closes (tank calls for water)"]
  ];
}

// What the world looks like on a given cycle, given one scheduled disruption.
function simWorld(scenario, cycle) {
  const hit = scenario.disruption !== "none" && cycle >= Number(scenario.disruptionAt);
  const now = scenario.disruption !== "none" && cycle === Number(scenario.disruptionAt);
  const world = {
    utilityPower: scenario.utilityPower !== false,
    lan: true, emUp: true, shelly1Up: true,
    pressureCalling: scenario.pressureCalling !== false,
    tab5Restarted: false, shellyRebooted: false, monitorEngaged: false
  };
  if (hit && scenario.disruption === "lan") { world.lan = false; }
  if (hit && scenario.disruption === "power") { world.utilityPower = false; }
  if (hit && scenario.disruption === "em") { world.emUp = false; }
  if (hit && scenario.disruption === "shelly1") { world.shelly1Up = false; }
  if (now && scenario.disruption === "tab5restart") { world.tab5Restarted = true; }
  if (now && scenario.disruption === "shellyreboot") { world.shellyRebooted = true; }
  if (hit && scenario.disruption === "usermonitor") { world.monitorEngaged = true; }
  if (hit && scenario.disruption === "pressure") { world.pressureCalling = true; }
  // The Shellys are mains powered. Losing utility power takes them with it;
  // Tab5 keeps running on its battery, which is the whole reason the old
  // "cut the power and count to two" reset stopped working.
  if (!world.utilityPower) { world.emUp = false; world.shelly1Up = false; }
  if (!world.lan) { world.emUp = false; world.shelly1Up = false; }
  return world;
}

// Reproduces rules_v3_condition_value, including the early return on the first
// absent field. Returns true, false, or null for undecided.
function simCondition(condition, snapshot, previous, occurrences) {
  if (!condition || !Array.isArray(condition.clauses) || !condition.clauses.length) return null;
  if (condition.mode !== "all" && condition.mode !== "any") return null;
  const results = [];
  for (const clause of condition.clauses) {
    if (!clause) return null;
    const name = clause.field;
    const expected = clause.value;
    if (clause.operator === "occurs") { results.push((occurrences || {})[name] === true); continue; }
    const current = Object.prototype.hasOwnProperty.call(snapshot, name) ? snapshot[name] : null;
    if (current === null || current === undefined) return null;   // fidelity note 2
    let result;
    if (clause.operator === "eq") result = current === expected;
    else if (clause.operator === "neq") result = current !== expected;
    else if (clause.operator === "between" || clause.operator === "outside") {
      if (!Array.isArray(expected) || expected.length !== 2) return null;
      const inside = expected[0] <= current && current <= expected[1];
      result = clause.operator === "between" ? inside : !inside;
    } else if (clause.operator === "changes" || clause.operator === "changes_from" || clause.operator === "changes_to") {
      const was = (previous || {})[name];
      if (was === undefined || was === null) return null;
      if (clause.operator === "changes") result = current !== was;
      else if (clause.operator === "changes_from") result = was === expected && current !== was;
      else result = current === expected && was !== current;
    } else if (typeof current !== "number" || typeof expected !== "number") return null;
    else if (clause.operator === "lt") result = current < expected;
    else if (clause.operator === "lte") result = current <= expected;
    else if (clause.operator === "gt") result = current > expected;
    else if (clause.operator === "gte") result = current >= expected;
    else return null;
    results.push(result);
  }
  return condition.mode === "all" ? results.every(Boolean) : results.some(Boolean);
}

// The device fields present this cycle. A rejected device contributes nothing.
function simSnapshot(pkg, scenario, world, relayClosed) {
  const snapshot = {};
  for (const device of pkg.devices || []) {
    if (device.enabled !== true) continue;
    const up = device.driver === "tab5-runtime" ? true
      : device.driver === "shelly-gen1-em" ? world.emUp : world.shelly1Up;
    for (const field of device.fields || []) {
      if (field.object === "$availability") { snapshot[field.systemName] = up; continue; }  // note 4
      if (!up) continue;                                                                    // note 1
      const object = field.object;
      if (object === "emeter/0.voltage") snapshot[field.systemName] = Number(scenario.supplyVoltage);
      else if (object === "emeter/0.power") snapshot[field.systemName] = Number(scenario.pumpWatts);
      else if (object === "RLY(0)") snapshot[field.systemName] = relayClosed;
      else if (object === "SW(0)") snapshot[field.systemName] = world.contactorEnergized === true;
      else if (object === "UDF(IsLocked)") snapshot[field.systemName] = Number(scenario.shellyLock);
      else if (object === "status.wifi_connected") snapshot[field.systemName] = world.lan;
      else if (object === "status.cloud_available") snapshot[field.systemName] = world.lan;
      else if (field.type === "boolean") snapshot[field.systemName] = true;
      else if (field.type === "number" || field.type === "integer") snapshot[field.systemName] = 0;
    }
  }
  for (const field of pkg.systemFields || []) {
    if (Object.prototype.hasOwnProperty.call(field, "initialValue")) {
      snapshot[field.systemName] = field.initialValue;
    }
  }
  return snapshot;
}

function simAssignments(event, phase) {
  const block = event[phase] || {};
  return (Array.isArray(block.assignments) ? block.assignments : []).concat(
    (Array.isArray(block.guardedGroups) ? block.guardedGroups : [])
      .flatMap(group => Array.isArray(group.assignments) ? group.assignments : []));
}

function simNewKernel() {
  return { events: {}, owners: {}, counters: {}, tick: 0, previous: {} };
}

function simulateScenario(input, scenarioInput) {
  const pkg = input && input.authoringPackage ? input.authoringPackage : input;
  const scenario = Object.assign(simDefaultScenario(), scenarioInput || {});
  const total = Math.max(1, Math.min(SIM_MAX_CYCLES, Number(scenario.cycles) || 1));
  const events = (pkg.events || []).filter(event => event.enabled === true);
  const monitorTarget = (pkg.systemFields || [])
    .find(field => field.runtimeRole === "operatingMode");

  let kernel = simNewKernel();
  let relayClosed = true;          // power-on default ON, per the fail-open posture
  let monitorLatched = false;
  const steps = [];

  for (let cycle = 1; cycle <= total; cycle += 1) {
    const world = simWorld(scenario, cycle);
    if (world.shellyRebooted) relayClosed = true;
    if (world.tab5Restarted) { kernel = simNewKernel(); monitorLatched = false; }
    if (world.monitorEngaged) monitorLatched = true;
    kernel.tick += 1;

    const notes = [];
    const snapshot = simSnapshot(pkg, scenario, world, relayClosed);
    if (monitorTarget) snapshot[monitorTarget.systemName] = monitorLatched ? "Monitor" : "Normal";
    for (const [name, expiry] of Object.entries(kernel.counters)) {
      snapshot[name] = Math.max(0, expiry - kernel.tick);
    }

    const frozen = monitorLatched && scenario.monitorStopsProcessing === true;
    if (frozen) notes.push("Event processing is stopped. The board is frozen as it was.");

    const opened = [], closed = [];
    if (!frozen) {
      for (const event of events) {
        const id = event.id || event.systemName;
        const held = kernel.events[id] || { open: false, openCount: 0, closeCount: 0, since: null };
        const trigger = (event.opening || {}).trigger || {};
        const closing = event.closing || {};
        if (!held.open) {
          let openValue = null;
          if (trigger.type === "condition") openValue = simCondition(trigger.condition, snapshot, kernel.previous);
          else if (trigger.type === "manual") openValue = monitorLatched && !held.everOpened;
          else if (trigger.type === "internal") openValue = world.emUp === false;
          const need = ((trigger.condition || {}).observationCount) ||
            ((trigger.qualification || {}).observationCount) || 1;
          if (openValue === true) held.openCount += 1;
          else if (openValue === false) held.openCount = 0;
          if (openValue === true && held.openCount >= need) {
            held.open = true; held.everOpened = true; held.since = cycle;
            held.closeCount = 0; opened.push(id);
            for (const assignment of simAssignments(event, "onOpen")) {
              if (assignment.ownership === "whileOpen") {
                kernel.owners[assignment.target] = kernel.owners[assignment.target] || {};
                kernel.owners[assignment.target][id] = assignment.value;
              }
            }
          }
        } else {
          let closeValue = false;
          if (closing.policy === "condition") closeValue = simCondition(closing.condition, snapshot, kernel.previous);
          else if (closing.policy === "immediate") closeValue = true;
          else if (closing.policy === "clearEvents") closeValue = false;  // never, in practice
          const need = ((closing.condition || {}).observationCount) || 1;
          if (closeValue === true) held.closeCount += 1;
          else if (closeValue === false) held.closeCount = 0;
          // closeValue === null leaves closeCount alone: fidelity note 3.
          if (closeValue === null) {
            notes.push(`${id} cannot close: its closing condition reads a field that is not present.`);
          }
          if (closeValue === true && held.closeCount >= need) {
            held.open = false; held.closeCount = 0; closed.push(id);
            for (const owned of Object.values(kernel.owners)) delete owned[id];
          }
        }
        kernel.events[id] = held;
      }
    }

    const ownersOfPump = Object.keys(kernel.owners[SIM_PUMP_TARGET] || {});
    let desired = ownersOfPump.length ? false : true;
    // The authored Monitor filters pump writes but keeps evaluating events.
    if (monitorLatched && !frozen && ownersOfPump.length) {
      desired = true;
      notes.push("Monitor is active, so the pump inhibit is not written.");
    }
    if (frozen) desired = true;

    let wrote = null, landed = false;
    if (desired !== relayClosed) {
      if (!world.shelly1Up) {
        notes.push(`Tab5 wanted to set the relay ${desired ? "closed" : "open"} but Shelly 1 is unreachable. Nothing was written.`);
        wrote = desired;
      } else if (desired === true && Number(scenario.shellyLock) !== 0) {
        notes.push("Tab5 wanted to close the relay but the Shelly lock is not zero. Refused.");
        wrote = desired;
      } else { relayClosed = desired; wrote = desired; landed = true; }
    }

    const relayEffective = relayClosed && Number(scenario.shellyLock) === 0;
    const pumpRuns = world.utilityPower && world.pressureCalling &&
      (scenario.hand === true || relayEffective);
    world.contactorEnergized = pumpRuns;

    const reasons = [];
    if (!world.utilityPower) reasons.push("Utility power is out. Nothing can run.");
    else if (!world.pressureCalling) reasons.push("The pressure switch is satisfied. No demand.");
    else if (scenario.hand === true) reasons.push("HAND hard-wires the ground loop past the automation and the relay.");
    else {
      if (!relayClosed) reasons.push(`RLY0 is open${ownersOfPump.length ? ` (held by ${ownersOfPump.join(", ")})` : ""}.`);
      if (Number(scenario.shellyLock) !== 0) reasons.push(`The Shelly script lock reads ${scenario.shellyLock}, so it holds RLY0 open.`);
      if (relayEffective) reasons.push("The ground loop is complete.");
    }

    kernel.previous = Object.assign({}, snapshot);
    steps.push({
      cycle, world, pumpRuns, relayClosed, relayEffective, desired, wrote, landed,
      blind: !world.emUp || !world.shelly1Up, mute: !world.shelly1Up,
      cloud: world.lan, monitor: monitorLatched, frozen,
      openEvents: Object.entries(kernel.events).filter(([, held]) => held.open).map(([id]) => id),
      owners: ownersOfPump.slice(), opened, closed, notes, reasons,
      counters: Object.fromEntries(Object.entries(kernel.counters)
        .map(([name, expiry]) => [name, Math.max(0, expiry - kernel.tick)]))
    });
  }
  return { steps, scenario };
}

if (typeof module === "object" && module.exports) {
  module.exports = { simulateScenario, simCondition, simWorld, simDefaultScenario, simDisruptions, SIM_PUMP_TARGET, SIM_MAX_CYCLES };
}
