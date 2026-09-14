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

// Tab5's inhibition is applied through this object; the Shelly script owns the
// relay. Resolved by binding so a renamed system name is still recognised, and an
// alias cannot hide a second writer from the analysis.
const ANALYSIS_INHIBITION_OBJECT = "UDF(Tab5IsLocked)";
const ANALYSIS_PUMP_TARGET = "Tab5IsLocked";

function analysisInhibitionTarget(pkg) {
  const devices = Array.isArray(pkg.devices) ? pkg.devices : [];
  let firstWritable = null;
  for (const device of devices) {
    for (const field of device.fields || []) {
      if (field.access !== "readWrite") continue;
      if (field.object === ANALYSIS_INHIBITION_OBJECT) return field.systemName;
      if (!firstWritable) firstWritable = field.systemName;
    }
  }
  // A package predating the inhibition binding still deserves analysis, so fall
  // back to whatever device field it does write.
  return firstWritable || ANALYSIS_PUMP_TARGET;
}

function analysisLimits() {
  return [
    "Static only. It does not simulate cycles, so it cannot find a fault that needs a particular interleaving of two events.",
    "Qualification counts and minimumSeconds are not modelled. An event that qualifies slowly is treated the same as one that qualifies at once.",
    "Numeric reasoning covers lt/lte/gt/gte/eq/neq/between on one field. Contradictions spanning two fields are not detected.",
    "Calculated field expressions are not evaluated. Their outputs are treated as unconstrained values of their declared type.",
    "Devices are grouped into two failure domains, local and network. Anything with a routable address is treated as sharing one radio, access point and router with everything else remote, including the cloud.",
    "Absence of findings is not proof. It means nothing matched these checks."
  ];
}

// Device failures are not independent. Everything Tab5 reaches over the network
// hangs off one radio, one access point and one router, so the realistic failure
// is not "the EM died" but "the network went", which takes every remote device,
// the cloud, and with the cloud every online recovery control, at the same
// instant. Devices are grouped accordingly: "local" is inside the Tab5 case,
// everything with a routable address is one shared domain.
function analysisDomainOf(device) {
  const address = typeof device.address === "string" ? device.address.trim().toLowerCase() : "";
  return (!address || address === "local" || address === "localhost") ? "local" : "network";
}

function analysisFailureDomains(pkg) {
  const domains = { local: [], network: [] };
  for (const device of pkg.devices || []) {
    if (device.enabled !== true) continue;
    domains[analysisDomainOf(device)].push(device.label || device.id);
  }
  return domains;
}

function analysisReferencedFields(pkg) {
  const used = new Set();
  const walk = value => {
    if (!value || typeof value !== "object") return;
    if (typeof value.field === "string") used.add(value.field);
    if (typeof value.target === "string") used.add(value.target);
    for (const child of Object.values(value)) walk(child);
  };
  walk(pkg.events || []);
  walk(pkg.calculatedFields || []);
  return used;
}

function analysisFieldIndex(pkg) {
  const fields = new Map();
  const devices = Array.isArray(pkg.devices) ? pkg.devices : [];
  for (const device of devices) {
    const availability = (device.fields || []).find(field => field.object === "$availability");
    for (const field of device.fields || []) {
      fields.set(field.systemName, {
        systemName: field.systemName, type: field.type, enumValues: field.enumValues || null,
        origin: "device", deviceId: device.id, deviceLabel: device.label || device.id,
        domain: analysisDomainOf(device),
        deviceEnabled: device.enabled === true, isAvailability: field.object === "$availability",
        availabilityField: availability ? availability.systemName : null,
        writable: field.access === "readWrite",
        isInhibition: field.object === ANALYSIS_INHIBITION_OBJECT,
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
// An availability flag reads false while its device is unavailable, so a clause
// asking for exactly that is decidable at the moment the measurements vanish.
function analysisTrueWhenUnavailable(clause) {
  if (!clause) return false;
  if (clause.operator === "eq") return clause.value === false;
  if (clause.operator === "neq") return clause.value === true;
  return false;
}

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
  const clauses = Array.isArray(closing.condition && closing.condition.clauses)
    ? closing.condition.clauses : [];
  const mode = (closing.condition && closing.condition.mode) || "all";
  const blocking = [];
  for (const clause of clauses) {
    const name = clause && clause.field;
    const field = fields.get(name);
    if (!field || field.origin !== "device") continue;
    blocking.push({ name, deviceLabel: field.deviceLabel, domain: field.domain,
      explicit: field.isAvailability === true, clause });
  }
  return {
    kind: "condition",
    mode,
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
  const inhibitTarget = analysisInhibitionTarget(pkg);
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
      for (const name of analysisConditionFields(condition)) {
        const field = fields.get(name);
        if (field && field.origin === "device" && field.deviceEnabled === false) {
          findings.push(analysisFinding("error", `analysis_${phase}_disabled_device`, `${path}.${phase}`,
            `${label} tests ${name}, which comes from ${field.deviceLabel}. That device is disabled, so ${name} is never present and this condition can never be decided.`));
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
      hold.target === inhibitTarget);
    if (pumpHolds.length) {
      // A disabled rule carries the same defect; it is simply not armed. Report
      // it a level down rather than not at all, so enabling it is not a surprise.
      const level = enabled ? "error" : "warning";
      const latent = enabled ? "" : " This event is disabled, so the fault is latent until it is enabled.";
      const escape = analysisEscape(event, fields);
      if (escape.kind === "restart") {
        findings.push(analysisFinding(level, "analysis_inhibit_until_restart", path,
          `${label} holds ${inhibitTarget} and closes only on Clear Events, which is not implemented. Once this opens there is no water until Tab5 is restarted.${latent}`));
      }
      // A measured device field is absent from the snapshot when its device is
      // rejected. Conditions are three-valued across clauses, so what that costs
      // depends on the mode. In "all", every clause must be true to close, and an
      // absent measurement can never be true: the event stays open. In "any", one
      // definitely-true clause closes it, and an availability flag is always True
      // or False - so a clause satisfied BY the device being unavailable is a real
      // escape from exactly the failure that removed the measurement.
      const blocking = escape.blocking || [];
      const measured = blocking.filter(item => !item.explicit);
      const explicit = blocking.filter(item => item.explicit);
      const escapesOnLoss = escape.mode === "any" &&
        explicit.some(item => analysisTrueWhenUnavailable(item.clause));
      if (measured.length && !escapesOnLoss) {
        findings.push(analysisFinding(level, "analysis_inhibit_evidence_loss", path,
          `${label} holds ${inhibitTarget} and can only close by reading ${measured.map(item => item.name).join(", ")} from ${measured[0].deviceLabel}. If ${measured[0].deviceLabel} goes offline while this event is open, those clauses cannot be evaluated, the closing condition never qualifies, and the pump stays off until the device returns or Tab5 restarts. The evidence that would release the inhibit is the same evidence that vanished.${latent}`));
      }
      // The systemic case. If the target lives on the far side of the same
      // network as the evidence, one failure removes both the grounds to
      // release and the ability to act, and takes the cloud with it, so every
      // online recovery control is gone at the same moment.
      const targetField = fields.get(inhibitTarget);
      const sameDomain = targetField && targetField.domain === "network" &&
        blocking.some(item => item.domain === "network");
      if (sameDomain) {
        findings.push(analysisFinding(level, "analysis_inhibit_frozen_by_domain", path,
          `${label} holds ${inhibitTarget} on ${targetField.deviceLabel} and closes on evidence from ${measured.length ? measured[0].deviceLabel : blocking[0].deviceLabel}. Both are reached over the network, so one Wi-Fi, access point or router failure removes the evidence and Tab5's ability to write its inhibition at the same instant. The flag then stays wherever it happened to be, and the Shelly script holds the relay accordingly: open if the inhibit had landed, closed if it had not. The outcome is decided by timing, not by the rule. That failure also takes the cloud, so Monitor, Restart Tab5 and Restart Shelly 1 are unavailable exactly when they are needed.${latent}`));
      }
      if (explicit.length && measured.length && !escapesOnLoss) {
        findings.push(analysisFinding("warning", "analysis_inert_availability_clause", path,
          `${label} also tests ${explicit.map(item => item.name).join(", ")} in its closing condition, which cannot rescue it. Every clause of an "all" condition must be true to close, and ${measured[0].name} is absent whenever ${explicit[0].deviceLabel} is unavailable, so the condition can never be true while that device is gone. An "any" condition with a clause satisfied by the device being unavailable would close instead.`));
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

  // Package-level. These are properties of the whole design, not of any one
  // event, and are the ones a per-event reading cannot see.
  const domains = analysisFailureDomains(pkg);
  if (domains.network.length > 1) {
    findings.push(analysisFinding("warning", "analysis_shared_failure_domain", "devices",
      `${domains.network.length} enabled devices are reached over the network: ${domains.network.join(", ")}. They do not fail independently. One radio, access point or router failure removes all of them, and the cloud with them, in the same instant. Any rule written as though one device can fail on its own is being analysed against a failure that is less likely than the one that actually happens.`));
  }
  const referenced = analysisReferencedFields(pkg);
  const unusedHealth = [];
  for (const [name, field] of fields) {
    if (field.origin !== "device" || field.domain !== "local") continue;
    if (referenced.has(name)) continue;
    if (/wifi|cloud|available|connected|clock/i.test(name)) unusedHealth.push(name);
  }
  if (unusedHealth.length) {
    findings.push(analysisFinding("warning", "analysis_unused_health_signal", "devices",
      `${unusedHealth.join(", ")} are declared and logged but no event reads them. These are the signals that would let a rule notice the systemic failure — the network or the cloud going away — rather than inferring it one device at a time. Nothing in this package reacts to losing them.`));
  }

  const pumpHolds = holds.filter(hold => hold.target === inhibitTarget && hold.enabled);
  if (!pumpHolds.length) {
    findings.push(analysisFinding("info", "analysis_no_pump_inhibit", "events",
      `No enabled event can hold ${inhibitTarget}. Tab5 contributes no inhibit in this package; the Shelly script and the original automation are the only protection running.`));
  }

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return { findings, holds, limits: analysisLimits() };
}

if (typeof module === "object" && module.exports) {
  module.exports = { analyzeAuthoringPackage, analysisUnsatisfiable, analysisFieldIndex, analysisFailureDomains, analysisReferencedFields, analysisLimits, ANALYSIS_PUMP_TARGET, ANALYSIS_INHIBITION_OBJECT, analysisInhibitionTarget };
}
