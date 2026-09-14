"use strict";

// Scenario simulation for the Rules Engine screen.
//
// WHAT IT MODELS. The decision layer against the package loaded in the editor,
// and the Shelly script as designed. Everything starts NORMAL and stays normal
// until something is injected at a cycle. Injections are the whole input: an
// event opening, a device or the LAN going, a restart, a short cycle, demand.
//
// TARGET DESIGN, NOT INSTALLED CODE. Tab5 no longer writes RLY0. It writes
// Tab5Lock, the Shelly script owns the relay, and the relay closes only when
// IsLocked == 0 AND Tab5Lock == 0. An assignment of PumpEnable to its
// non-normal value is read as "Tab5 requests an inhibit", whatever the loaded
// package's write mapping says, because that mapping is what is being changed.
//
// TIME. Cycles, not seconds. Qualification is counted in observations. The
// Shelly's own timers are in seconds, so secondsPerCycle converts, and it is a
// knob because the measured loop period moves with load.
//
// FIDELITY. Behaviours reproduced deliberately from tab5/pilot.py:
//  1. A device record is accepted or rejected whole.
//  2. A condition is undecided on the FIRST absent field, before its mode is
//     applied. "any" does not rescue it.
//  3. An undecided closing condition leaves the event open and does not reset
//     its close count.
//  4. $availability is always true or false for an enabled device.
//  5. A write only lands if the target is reachable.
//  6. Every event in a cycle sees one frozen snapshot.
// And from shelly1/anti-chatter.js:
//  7. IsLocked counts itself down and reaches zero without help from Tab5.
//  8. A strike sets IsLocked; the MaxLOcntr-th strike makes it permanent (-1).
//  9. Nothing Tab5 does clears IsLocked or loCntr. Only a Shelly reboot does.
//
// NOT MODELLED, on purpose: the 3-second on-delay, the 6-minute runtime limit,
// the pressure sensor, the tank, the motor. Those are hardware that works.

const SIM_PUMP_TARGET = "PumpEnable";
const SIM_MAX_CYCLES = 120;
const SIM_INIT_LOCK_TIME = 90;   // seconds, matches the script constant
const SIM_MAX_LOCKOUT = 3;

function simDefaultScenario() {
  return { cycles: 60, secondsPerCycle: 2, transientRelease: 30, injections: [] };
}

// Injections that are not an event opening. Event openings are offered
// separately because they come from the loaded package.
function simFaultKinds() {
  return [
    ["lan", "LAN fails — both Shellys and the cloud"],
    ["power", "Utility power out — Shellys dead, Tab5 on battery"],
    ["em", "Shelly EM offline"],
    ["shelly1", "Shelly 1 offline"],
    ["restore", "Everything back to normal"],
    ["tab5restart", "Tab5 restarts"],
    ["shellyreboot", "Shelly 1 reboots"],
    ["shortcycle", "Short cycle — Shelly scores a strike"],
    ["hand", "HAND selected"],
    ["demandoff", "Pressure switch satisfied — no demand"],
    ["demandon", "Pressure switch calls for water"]
  ];
}

// Only events that can hold the pump are worth injecting for a timeline.
// Informational events neither inhibit nor release anything.
function simInjectableEvents(pkg) {
  return (pkg.events || []).filter(event => {
    if (event.enabled !== true) return false;
    if (event.eventClass === "monitor") return true;
    const assignments = (event.onOpen || {}).assignments || [];
    return assignments.some(item => item && item.target === SIM_PUMP_TARGET);
  }).map(event => ({
    id: event.id || event.systemName,
    label: event.displayName || event.systemName,
    eventClass: event.eventClass
  }));
}

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
    if (current === null || current === undefined) return null;   // fidelity 2
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

// The world starts normal. Only injections move it.
function simWorldAt(scenario, cycle) {
  const world = {
    utilityPower: true, lan: true, emUp: true, shelly1Up: true,
    demand: true, hand: false, tab5Restart: false, shellyReboot: false, strike: false
  };
  for (const injection of scenario.injections || []) {
    if (injection.kind === "event") continue;
    const at = Number(injection.atCycle);
    const sticky = cycle >= at, now = cycle === at;
    if (injection.kind === "restore" && sticky) {
      world.utilityPower = true; world.lan = true; world.emUp = true;
      world.shelly1Up = true; world.hand = false;
    }
    if (sticky && injection.kind === "lan") world.lan = false;
    if (sticky && injection.kind === "power") world.utilityPower = false;
    if (sticky && injection.kind === "em") world.emUp = false;
    if (sticky && injection.kind === "shelly1") world.shelly1Up = false;
    if (sticky && injection.kind === "hand") world.hand = true;
    if (sticky && injection.kind === "demandoff") world.demand = false;
    if (sticky && injection.kind === "demandon") world.demand = true;
    if (now && injection.kind === "tab5restart") world.tab5Restart = true;
    if (now && injection.kind === "shellyreboot") world.shellyReboot = true;
    if (now && injection.kind === "shortcycle") world.strike = true;
  }
  // The Shellys are mains powered and reached over the LAN. Tab5 has a battery,
  // which is why cutting the power no longer resets anything.
  if (!world.utilityPower || !world.lan) { world.emUp = false; world.shelly1Up = false; }
  return world;
}

// Is an injected event being held true this cycle?
//
//  - A manual trigger is an occurrence, not a condition. It fires once, at the
//    injected cycle, and never again. A Tab5 restart therefore does not
//    re-engage an operator Monitor that somebody asked for twenty cycles ago.
//  - A latched event holds forever: its condition is the thing that latched.
//  - A transient event holds for transientRelease cycles, then lets the
//    package's own closing condition take over.
function simInjectedOpen(scenario, event, id, cycle) {
  const triggerType = ((event.opening || {}).trigger || {}).type;
  for (const injection of scenario.injections || []) {
    if (injection.kind !== "event" || injection.eventId !== id) continue;
    const at = Number(injection.atCycle);
    if (cycle < at) continue;
    if (triggerType === "manual") return cycle === at;
    if (event.eventClass === "latched" || event.eventClass === "monitor") return true;
    return cycle < at + Number(scenario.transientRelease);
  }
  return false;
}

function simNominalSnapshot(pkg, world, shelly) {
  const snapshot = {};
  for (const device of pkg.devices || []) {
    if (device.enabled !== true) continue;
    const up = device.driver === "tab5-runtime" ? true
      : device.driver === "shelly-gen1-em" ? world.emUp : world.shelly1Up;
    for (const field of device.fields || []) {
      if (field.object === "$availability") { snapshot[field.systemName] = up; continue; }
      if (!up) continue;
      const object = field.object;
      if (object === "emeter/0.voltage") snapshot[field.systemName] = 245;
      else if (object === "emeter/0.power") snapshot[field.systemName] = world.pumpRunning ? 2400 : 0;
      else if (object === "emeter/0.pf") snapshot[field.systemName] = 0.92;
      else if (object === "RLY(0)") snapshot[field.systemName] = shelly.rly0;
      else if (object === "SW(0)") snapshot[field.systemName] = world.pumpRunning === true;
      else if (object === "UDF(IsLocked)") snapshot[field.systemName] = shelly.isLocked;
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

function simNewKernel() { return { events: {}, owners: {}, counters: {}, tick: 0, previous: {} }; }

// The Shelly as designed: it owns the relay, counts its own lock down, and
// nothing Tab5 does can clear a lock it set.
function simShellyTick(shelly, world, secondsPerCycle) {
  if (world.shellyReboot) { shelly.isLocked = 0; shelly.loCntr = 0; shelly.tab5Lock = 0; }
  if (world.strike && shelly.isLocked === 0) {
    shelly.loCntr = Math.min(SIM_MAX_LOCKOUT, shelly.loCntr + 1);
    shelly.isLocked = shelly.loCntr >= SIM_MAX_LOCKOUT ? -1 : SIM_INIT_LOCK_TIME;
  } else if (shelly.isLocked > 0) {
    shelly.isLocked = Math.max(0, shelly.isLocked - secondsPerCycle);
  }
  shelly.rly0 = shelly.isLocked === 0 && shelly.tab5Lock === 0;
  return shelly;
}

function simulateScenario(input, scenarioInput) {
  const pkg = input && input.authoringPackage ? input.authoringPackage : input;
  const scenario = Object.assign(simDefaultScenario(), scenarioInput || {});
  const total = Math.max(1, Math.min(SIM_MAX_CYCLES, Number(scenario.cycles) || 1));
  const seconds = Math.max(1, Number(scenario.secondsPerCycle) || 2);
  const events = (pkg.events || []).filter(event => event.enabled === true);

  let kernel = simNewKernel();
  let shelly = { isLocked: 0, loCntr: 0, tab5Lock: 0, rly0: true };
  let monitor = false;
  const steps = [];

  for (let cycle = 1; cycle <= total; cycle += 1) {
    const world = simWorldAt(scenario, cycle);
    world.pumpRunning = steps.length ? steps[steps.length - 1].pumpRuns : false;
    if (world.tab5Restart) { kernel = simNewKernel(); monitor = false; }
    kernel.tick += 1;
    const notes = [];

    shelly = simShellyTick(shelly, world, seconds);

    const snapshot = simNominalSnapshot(pkg, world, shelly);
    for (const [name, expiry] of Object.entries(kernel.counters)) {
      snapshot[name] = Math.max(0, expiry - kernel.tick);
    }

    // Monitor as designed: event processing stops and Tab5 stops writing. The
    // only exit is a restart, and the only way to clear a lock it leaves behind
    // is a Shelly reboot.
    const frozen = monitor;
    if (frozen) notes.push("Monitor is engaged. Event processing is stopped and Tab5 writes nothing. Exit is a Tab5 restart.");

    const opened = [], closed = [];
    if (!frozen) {
      for (const event of events) {
        const id = event.id || event.systemName;
        const held = kernel.events[id] || { open: false, openCount: 0, closeCount: 0 };
        const trigger = (event.opening || {}).trigger || {};
        const closing = event.closing || {};
        const injected = simInjectedOpen(scenario, event, id, cycle);
        if (!held.open) {
          let openValue = injected ? true : null;
          if (!injected && trigger.type === "condition") {
            openValue = simCondition(trigger.condition, snapshot, kernel.previous);
          } else if (!injected && trigger.type === "internal") {
            openValue = world.emUp === false;
          } else if (!injected && trigger.type === "manual") {
            openValue = false;
          }
          const need = ((trigger.condition || {}).observationCount) ||
            ((trigger.qualification || {}).observationCount) || 1;
          if (openValue === true) held.openCount += 1;
          else if (openValue === false) held.openCount = 0;
          if (openValue === true && held.openCount >= need) {
            held.open = true; held.since = cycle; held.closeCount = 0; opened.push(id);
            if (event.eventClass === "monitor") monitor = true;
            for (const assignment of simAssignments(event, "onOpen")) {
              if (assignment.ownership !== "whileOpen") continue;
              kernel.owners[assignment.target] = kernel.owners[assignment.target] || {};
              kernel.owners[assignment.target][id] = assignment.value;
            }
          }
        } else {
          let closeValue = false;
          if (injected) closeValue = false;
          else if (closing.policy === "condition") closeValue = simCondition(closing.condition, snapshot, kernel.previous);
          else if (closing.policy === "immediate") closeValue = true;
          else if (closing.policy === "clearEvents") closeValue = false;
          const need = ((closing.condition || {}).observationCount) || 1;
          if (closeValue === true) held.closeCount += 1;
          else if (closeValue === false) held.closeCount = 0;
          if (closeValue === null) notes.push(`${id} cannot close: its closing condition reads a field that is not present.`);
          if (closeValue === true && held.closeCount >= need) {
            held.open = false; held.closeCount = 0; closed.push(id);
            for (const owned of Object.values(kernel.owners)) delete owned[id];
          }
        }
        kernel.events[id] = held;
      }
    }

    const holders = Object.keys(kernel.owners[SIM_PUMP_TARGET] || {});
    const intent = frozen ? 0 : (holders.length ? 1 : 0);
    let wrote = null, landed = false;
    if (!frozen && intent !== shelly.tab5Lock) {
      wrote = intent;
      if (world.shelly1Up) { shelly.tab5Lock = intent; landed = true; }
      else notes.push(`Tab5 wanted Tab5Lock = ${intent} but Shelly 1 is unreachable. The old value stands.`);
    } else if (frozen && shelly.tab5Lock !== 0) {
      notes.push(`Tab5Lock is still ${shelly.tab5Lock} and Tab5 has stopped writing. Only a Shelly 1 reboot clears it.`);
    }
    shelly.rly0 = shelly.isLocked === 0 && shelly.tab5Lock === 0;

    const pumpRuns = world.utilityPower && world.demand && (world.hand || shelly.rly0);
    const reasons = [];
    if (!world.utilityPower) reasons.push("Utility power is out.");
    else if (!world.demand) reasons.push("The pressure switch is satisfied. No demand.");
    else if (world.hand) reasons.push("HAND hard-wires the ground loop past the automation and the relay.");
    else if (shelly.isLocked !== 0) reasons.push(`The Shelly holds the relay open: IsLocked = ${shelly.isLocked}${shelly.isLocked === -1 ? " (permanent until reboot)" : ""}, loCntr = ${shelly.loCntr}.`);
    else if (shelly.tab5Lock !== 0) reasons.push(`Tab5Lock = 1${holders.length ? `, held by ${holders.join(", ")}` : " with nobody holding it"}.`);
    else reasons.push("IsLocked = 0 and Tab5Lock = 0, so the ground loop is complete.");
    if (shelly.tab5Lock === 1 && !holders.length && !frozen) {
      notes.push("Tab5Lock is set but no event holds the pump. It is stranded until Tab5 can write again.");
    }

    kernel.previous = Object.assign({}, snapshot);
    steps.push({
      cycle, pumpRuns, reasons, notes, opened, closed,
      tab5Lock: shelly.tab5Lock, isLocked: shelly.isLocked, loCntr: shelly.loCntr, rly0: shelly.rly0,
      intent, wrote, landed, monitor: frozen,
      blind: !world.emUp, mute: !world.shelly1Up, cloud: world.lan,
      power: world.utilityPower, hand: world.hand, demand: world.demand,
      openEvents: Object.entries(kernel.events).filter(([, held]) => held.open).map(([id]) => id),
      holders: holders.slice(),
      counters: Object.fromEntries(Object.entries(kernel.counters)
        .map(([name, expiry]) => [name, Math.max(0, expiry - kernel.tick)]))
    });
  }
  return { steps, scenario };
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    simulateScenario, simCondition, simWorldAt, simInjectedOpen, simShellyTick,
    simDefaultScenario, simFaultKinds, simInjectableEvents,
    SIM_PUMP_TARGET, SIM_MAX_CYCLES, SIM_INIT_LOCK_TIME, SIM_MAX_LOCKOUT
  };
}
