"use strict";

// Package analysis. Runs in the browser against the authoring draft, before
// validation and without contacting the server.
//
// Validation answers "will Tab5 accept this package". Analysis answers a
// different question: "if Tab5 runs this package, can the well end up off with
// no way back". Those are independent. A package can be perfectly valid and
// still latch the pump off until somebody drives to the panel.
//
// This is deliberately a static analyser, not a simulator. Every finding is
// derived from the package text alone, so it is fast, deterministic, and makes
// no claim about values it has not seen. What it cannot do is explore timing
// and interleaving; see analysisLimits() for the honest list.

const ANALYSIS_PUMP_TARGET = "PumpEnable";

function analysisLimits() {
  return [
    "Static only. It does not simulate cycles, so it cannot find a fault that needs a particular interleaving of two events.",
    "Qualification counts and minimumSeconds are not modelled. An event that qualifies slowly is treated the same as one that qualifies at once.",
    "Numeric reasoning covers lt/lte/gt/gte/eq/neq/between on one field. Contradictions spanning two fields are not detected.",
    "Calculated field expressions are not evaluated. Their outputs are treated as unconstrained values of their declared type.",
    "Absence of findings is not proof. It means nothing matched these checks."
  ];
}

function analysisClone(value) { return JSON.parse(JSON.stringify(value)); }

function analysisFieldIndex(pkg) {
  const fields = new Map();
  const devices = Array.isArray(pkg.devices) ? pkg.devices : [];
  for (const device of devices) {
    const availability = (device.fields || []).find(field => field.object === "$availability");
    for (const field of device.fields || []) {
      fields.set(field.systemName, {
        systemName: field.systemName, type: field.type, enumValues: field.enumValues || null,
        origin: "device", deviceId: device.id, deviceLabel: device.label || device.id,
        deviceEnabled: device.enabled === true, isAvailability: field.object === "$availability",
        availabilityField: availability ? availability.systemName : null,
        writable: field.access === "readWrite",
        normalValue: field.write ? field.write.normalValue : undefined
      });
    }
  }
  for (const calculation of pkg.calculatedFields || []) {
    const outputs = calculation.kind === "expression"
      ? [calculation.output] : (calculation.outputs || []);
    for (const output of outputs) {
      if (!output) continue;
      fields.set(output.systemName, {
        systemName: output.systemName, type: output.type, enumValues: output.enumValues || null,
        origin: "calculated", calculationId: calculation.id, writable: false,
        // A calculated field is only as available as the inputs behind it.
        availabilityField: null
      });
    }
  }
  for (const field of pkg.systemFields || []) {
    fields.set(field.systemName, {
      systemName: field.systemName, type: field.type, enumValues: field.enumValues || null,
      origin: "system", role: field.runtimeRole, source: field.source,
      initialValue: field.initialValue, maxValue: field.maxValue,
      writable: field.assignmentTarget === true, normalValue: field.initialValue,
      availabilityField: null
    });
  }
  return fields;
}

// Definite contradictions only. An undecided combination is reported as
// satisfiable, so a finding here is always a real one.
function analysisUnsatisfiable(condition, fields) {
  if (!condition || condition.mode !== "all" || !Array.isArray(condition.clauses)) return null;
  const byField = new Map();
  for (const clause of condition.clauses) {
    if (!clause || typeof clause.field !== "string") continue;
    if (!byField.has(clause.field)) byField.set(clause.field, []);
    byField.get(clause.field).push(clause);
  }
  for (const [name, clauses] of byField) {
    const field = fields.get(name);
    if (!field) continue;
    if (field.type === "boolean" || field.type === "enum") {
      const required = new Set(), refused = new Set();
      for (const clause of clauses) {
        if (clause.operator === "eq") required.add(JSON.stringify(clause.value));
        if (clause.operator === "neq") refused.add(JSON.stringify(clause.value));
      }
      if (required.size > 1) return `${name} is required to equal two different values`;
      for (const value of required) {
        if (refused.has(value)) return `${name} is required to both equal and not equal ${value}`;
      }
      continue;
    }
    if (field.type !== "number" && field.type !== "integer") continue;
    let low = -Infinity, lowOpen = false, high = Infinity, highOpen = false;
    const raise = (value, open) => {
      if (value > low || (value === low && open)) { low = value; lowOpen = open; }
    };
    const lower = (value, open) => {
      if (value < high || (value === high && open)) { high = value; highOpen = open; }
    };
    for (const clause of clauses) {
      const value = clause.value;
      if (clause.operator === "gt" && typeof value === "number") raise(value, true);
      else if (clause.operator === "gte" && typeof value === "number") raise(value, false);
      else if (clause.operator === "lt" && typeof value === "number") lower(value, true);
      else if (clause.operator === "lte" && typeof value === "number") lower(value, false);
      else if (clause.operator === "eq" && typeof value === "number") { raise(value, false); lower(value, false); }
      else if (clause.operator === "between" && Array.isArray(value) && value.length === 2) {
        raise(value[0], false); lower(value[1], false);
      }
    }
    if (low > high || (low === high && (lowOpen || highOpen))) {
      return `${name} is constrained to an empty range (${lowOpen ? ">" : ">="} ${low} and ${highOpen ? "<" : "<="} ${high})`;
    }
  }
  return null;
}

function analysisConditionFields(condition) {
  if (!condition || !Array.isArray(condition.clauses)) return [];
  return condition.clauses.map(clause => clause && clause.field).filter(name => typeof name === "string");
}

function analysisAssignments(event, phase) {
  const block = event[phase] || {};
  const direct = Array.isArray(block.assignments) ? block.assignments : [];
  const guarded = (Array.isArray(block.guardedGroups) ? block.guardedGroups : [])
    .flatMap(group => Array.isArray(group.assignments) ? group.assignments : []);
  return direct.concat(guarded);
}

// Every way an event can stop holding what it holds. This is the "how do I get
// water back" question, answered per event rather than per package.
function analysisEscape(event, fields) {
  const closing = event.closing || {};
  if (closing.policy === "immediate") {
    return { kind: "immediate", text: "Closes on the next cycle." };
  }
  if (closing.policy === "clearEvents") {
    return {
      kind: "restart",
      text: "Closes only on Clear Events. Clear Events is not implemented, so in practice this closes only when Tab5 restarts."
    };
  }
  if (closing.policy !== "condition") {
    return { kind: "unknown", text: `Unrecognised closing policy "${closing.policy}".` };
  }
  const names = analysisConditionFields(closing.condition);
  const blocking = [];
  for (const name of names) {
    const field = fields.get(name);
    if (!field || field.origin !== "device") continue;
    if (field.isAvailability) blocking.push({ name, deviceLabel: field.deviceLabel, explicit: true });
    else blocking.push({ name, deviceLabel: field.deviceLabel, explicit: false });
  }
  return {
    kind: "condition",
    text: `Closes when ${names.join(", ") || "its closing condition"} qualifies.`,
    blocking
  };
}

function analysisFinding(level, code, path, message) {
  return { level, code, path, message };
}

function analyzeAuthoringPackage(input) {
  const pkg = input && input.authoringPackage ? input.authoringPackage : input;
  const findings = [];
  if (!pkg || typeof pkg !== "object") {
    return { findings: [analysisFinding("error", "analysis_no_package", "", "No package to analyse.")], holds: [], limits: analysisLimits() };
  }
  const fields = analysisFieldIndex(pkg);
  const events = Array.isArray(pkg.events) ? pkg.events : [];
  const holds = [];

  const seen = new Map();
  for (const [name, field] of fields) {
    const key = name.toLowerCase();
    if (seen.has(key) && seen.get(key) !== name) {
      findings.push(analysisFinding("warning", "analysis_name_collision", `fields.${name}`,
        `${name} and ${seen.get(key)} differ only by case. Tab5 matches names exactly, so one of them is probably a typo.`));
    }
    seen.set(key, name);
    if (field.origin !== "system") continue;
    if (field.role === "counter") {
      if (field.initialValue !== 0) {
        findings.push(analysisFinding("error", "analysis_counter_initial", `systemFields.${name}`,
          `Counter ${name} must start at 0. A counter that starts loaded holds on the first cycle of every session, including the session after a restart meant to clear it.`));
      }
      if (!(typeof field.maxValue === "number" && field.maxValue > 0)) {
        findings.push(analysisFinding("error", "analysis_counter_max", `systemFields.${name}`,
          `Counter ${name} needs a positive maxValue. Without a ceiling a rule can preset a hold longer than anyone will wait out.`));
      }
      if (field.type !== "integer") {
        findings.push(analysisFinding("error", "analysis_counter_type", `systemFields.${name}`,
          `Counter ${name} must be an integer. Counters are measured in cycles, and a cycle is not divisible.`));
      }
    }
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const path = `events[${index}]`;
    const label = `${event.id || event.systemName || path}`;
    const opening = (event.opening || {}).trigger || {};
    const closing = event.closing || {};
    const enabled = event.enabled === true;

    for (const [phase, condition] of [["opening", opening.condition], ["closing", closing.condition]]) {
      for (const name of analysisConditionFields(condition)) {
        if (!fields.has(name)) {
          findings.push(analysisFinding("error", "analysis_unknown_field", `${path}.${phase}`,
            `${label} tests ${name}, which no device, calculated field or system field defines.`));
        }
      }
      const contradiction = analysisUnsatisfiable(condition, fields);
      if (contradiction) {
        findings.push(analysisFinding("error", `analysis_${phase}_unsatisfiable`, `${path}.${phase}`,
          phase === "opening"
            ? `${label} can never open: ${contradiction}.`
            : `${label} can never close: ${contradiction}. Anything it holds is held until Tab5 restarts.`));
      }
    }

    const assignments = analysisAssignments(event, "onOpen").concat(analysisAssignments(event, "onClose"));
    for (const assignment of assignments) {
      if (!assignment || typeof assignment.target !== "string") continue;
      const target = fields.get(assignment.target);
      if (!target) {
        findings.push(analysisFinding("error", "analysis_unknown_target", `${path}.assignments`,
          `${label} assigns ${assignment.target}, which is not defined.`));
        continue;
      }
      if (!target.writable) {
        findings.push(analysisFinding("error", "analysis_target_not_writable", `${path}.assignments`,
          `${label} assigns ${assignment.target}, which is not an assignment target.`));
        continue;
      }
      if (target.role === "counter") {
        const value = assignment.value;
        if (!Number.isInteger(value) || value < 0) {
          findings.push(analysisFinding("error", "analysis_counter_preset", `${path}.assignments`,
            `${label} presets counter ${assignment.target} to ${JSON.stringify(value)}. A preset must be a whole number of cycles, zero or more.`));
        } else if (typeof target.maxValue === "number" && value > target.maxValue) {
          findings.push(analysisFinding("error", "analysis_counter_overflow", `${path}.assignments`,
            `${label} presets counter ${assignment.target} to ${value}, above its maxValue of ${target.maxValue}.`));
        }
        if (assignment.ownership === "whileOpen") {
          findings.push(analysisFinding("info", "analysis_counter_while_open", `${path}.assignments`,
            `${label} holds counter ${assignment.target} at ${assignment.value} for as long as it is open, then lets it run down over ${assignment.value} more cycles. That is the self-releasing form: if this event closes, or Tab5 stops running it, the hold expires on its own.`));
        }
        continue;
      }
      // Anything driven away from its normal value is a hold on real hardware.
      if (target.normalValue !== undefined && assignment.value !== target.normalValue) {
        const escape = analysisEscape(event, fields);
        holds.push({
          eventId: event.id || event.systemName, eventLabel: event.displayName || event.systemName,
          enabled, target: assignment.target, value: assignment.value,
          ownership: assignment.ownership, escape, path
        });
      }
    }

    const pumpHolds = holds.filter(hold => hold.eventId === (event.id || event.systemName) &&
      hold.target === ANALYSIS_PUMP_TARGET);
    if (pumpHolds.length) {
      // A disabled rule carries the same defect; it is simply not armed. Report
      // it a level down rather than not at all, so enabling it is not a surprise.
      const level = enabled ? "error" : "warning";
      const latent = enabled ? "" : " This event is disabled, so the fault is latent until it is enabled.";
      const escape = analysisEscape(event, fields);
      if (escape.kind === "restart") {
        findings.push(analysisFinding(level, "analysis_inhibit_until_restart", path,
          `${label} holds ${ANALYSIS_PUMP_TARGET} off and closes only on Clear Events, which is not implemented. Once this opens there is no water until Tab5 is restarted.${latent}`));
      }
      const explicit = (escape.blocking || []).filter(item => item.explicit);
      if (explicit.length) {
        findings.push(analysisFinding(level, "analysis_inhibit_needs_availability", path,
          `${label} holds ${ANALYSIS_PUMP_TARGET} off, and its closing condition requires ${explicit.map(item => item.name).join(", ")} to be true. If ${explicit[0].deviceLabel} goes offline while this event is open, the condition can never qualify and the pump stays off until ${explicit[0].deviceLabel} returns or Tab5 restarts. A device failure becomes a water outage.${latent}`));
      } else {
        const implicit = (escape.blocking || []);
        if (implicit.length) {
          findings.push(analysisFinding(enabled ? "warning" : "info", "analysis_inhibit_close_depends_on_device", path,
            `${label} holds ${ANALYSIS_PUMP_TARGET} off and closes on ${implicit.map(item => item.name).join(", ")}, read from ${implicit[0].deviceLabel}. While that device is unavailable those clauses cannot be evaluated, so the event cannot close and the hold stays on.${latent}`));
        }
      }
    }

    if (event.eventClass === "monitor") {
      if (opening.type !== "manual") {
        findings.push(analysisFinding("warning", "analysis_monitor_not_manual", path,
          `${label} is a Monitor event opened by ${opening.type || "an automatic"} trigger. If Monitor becomes a terminal stop, an automatic trigger can suspend the controller without anyone asking, and only a restart brings it back.`));
      }
      if (closing.policy === "clearEvents") {
        findings.push(analysisFinding("info", "analysis_monitor_terminal", path,
          `${label} closes only on Clear Events, so it is terminal: once engaged, the exit is a Tab5 restart. That is the intended shape for the operator Monitor.`));
      }
    }

    if (!enabled) {
      findings.push(analysisFinding("warning", "analysis_event_disabled", path,
        `${label} is disabled and does nothing. A disabled protective rule is invisible on the device beyond the enabled-rule count.`));
    }
  }

  const pumpHolds = holds.filter(hold => hold.target === ANALYSIS_PUMP_TARGET && hold.enabled);
  if (!pumpHolds.length) {
    findings.push(analysisFinding("info", "analysis_no_pump_inhibit", "events",
      `No enabled event can hold ${ANALYSIS_PUMP_TARGET} off. Tab5 contributes no inhibit in this package; the Shelly script and the original automation are the only protection running.`));
  }

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return { findings, holds, limits: analysisLimits() };
}

if (typeof module === "object" && module.exports) {
  module.exports = { analyzeAuthoringPackage, analysisUnsatisfiable, analysisFieldIndex, analysisLimits, ANALYSIS_PUMP_TARGET };
}
