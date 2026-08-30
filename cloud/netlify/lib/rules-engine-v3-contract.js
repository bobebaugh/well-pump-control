"use strict";

const {
  validateAndCompile: validateAndCompileV2,
  _compileExpression: compileExpression,
  _valueMatchesField: valueMatchesField
} = require("./rules-engine-contract");
const { SUMMARY_OPERATIONS, TYPE_OPERATORS } = require("./rules-engine-defaults");

const V3_SCHEMA_VERSION = 3;
const V3_KIND = "well-pump-event-runtime-v3";
const MAX_DEVICES = 16;
const MAX_FIELDS_PER_DEVICE = 32;
const MAX_CALCULATIONS = 64;
const MAX_SYSTEM_FIELDS = 32;
const MAX_EVENTS = 64;
const MAX_CONDITION_CLAUSES = 16;
const MAX_ASSIGNMENTS = 32;
const MAX_GUARDED_GROUPS = 16;
const MAX_SUMMARY_AGGREGATES = 32;
const MAX_RUNTIME_BYTES = 65536;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

class RulesEngineV3ContractError extends Error {
  constructor(code, errors = []) { super(code); this.name = "RulesEngineV3ContractError"; this.code = code; this.errors = errors; }
}

function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function issue(path, code, message) { return { path, code, message }; }
function hasOnly(value, keys) { return isObject(value) && Object.keys(value).every(key => keys.has(key)); }
function sameValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.keys(value).sort().reduce((next, key) => { next[key] = canonical(value[key]); return next; }, {});
  return value;
}

function validateLogging(logging, path, field, errors) {
  const allowed = logging?.mode === "delta" ? new Set(["mode", "threshold"]) : new Set(["mode"]);
  if (!hasOnly(logging, allowed) || !["none", "delta", "change", "always"].includes(logging?.mode)) {
    errors.push(issue(path, "invalid_logging", "Logging must use none, delta, change, or always with no extra properties."));
    return;
  }
  if (logging.mode === "delta") {
    if (!["number", "integer"].includes(field.type)) errors.push(issue(`${path}.mode`, "invalid_delta_type", "Delta logging requires a numeric field."));
    if (typeof logging.threshold !== "number" || !Number.isFinite(logging.threshold) || logging.threshold <= 0) errors.push(issue(`${path}.threshold`, "invalid_delta_threshold", "Delta threshold must be greater than zero."));
  }
  if (logging.mode === "change" && field.type === "signal") errors.push(issue(`${path}.mode`, "invalid_signal_logging", "Signals use none or always logging."));
}

function validateSystemFields(systemFields, fields, writable, occurrences, errors) {
  if (!Array.isArray(systemFields)) { errors.push(issue("systemFields", "invalid_system_fields", "System fields must be an array.")); return; }
  if (systemFields.length > MAX_SYSTEM_FIELDS) errors.push(issue("systemFields", "system_fields_too_large", `A package may contain at most ${MAX_SYSTEM_FIELDS} system fields.`));
  const ids = new Set();
  let operatingModeCount = 0;
  for (let index = 0; index < systemFields.length; index += 1) {
    const field = systemFields[index]; const path = `systemFields[${index}]`;
    if (!isObject(field)) { errors.push(issue(path, "invalid_system_field", "System field must be an object.")); continue; }
    const source = field.source;
    const common = ["id", "systemName", "label", "source", "runtimeRole", "type", "unit", "logging"];
    const allowed = source === "session"
      ? new Set([...common, "initialValue", "assignmentTarget", ...(field.type === "enum" ? ["enumValues"] : [])])
      : new Set([...common, "occurrenceKey"]);
    if (!hasOnly(field, allowed)) errors.push(issue(path, "invalid_system_field_shape", "System field has properties appropriate to its declared source."));
    if (!ID_PATTERN.test(field.id || "")) errors.push(issue(`${path}.id`, "invalid_system_field_id", "System field ID is required."));
    else if (ids.has(field.id)) errors.push(issue(`${path}.id`, "duplicate_system_field_id", "System field IDs must be unique."));
    else ids.add(field.id);
    if (!NAME_PATTERN.test(field.systemName || "")) errors.push(issue(`${path}.systemName`, "invalid_system_name", "Use a letter-led system name."));
    else if (fields.has(field.systemName)) errors.push(issue(`${path}.systemName`, "duplicate_system_name", `${field.systemName} is already defined.`));
    if (typeof field.label !== "string" || !field.label.trim()) errors.push(issue(`${path}.label`, "missing_label", "Display label is required."));
    if (!(typeof field.unit === "string" || field.unit === null)) errors.push(issue(`${path}.unit`, "invalid_unit", "Unit must be a string or null."));
    if (!["number", "integer", "boolean", "enum", "signal"].includes(field.type)) errors.push(issue(`${path}.type`, "invalid_type", "System field type is unsupported."));
    if (!["session", "manualOccurrence", "internalOccurrence"].includes(source)) errors.push(issue(`${path}.source`, "invalid_system_field_source", "Source must be session, manualOccurrence, or internalOccurrence."));
    validateLogging(field.logging, `${path}.logging`, field, errors);

    if (source === "session") {
      if (field.runtimeRole === "operatingMode") {
        operatingModeCount += 1;
        if (field.type !== "enum" || !sameValue(field.enumValues, ["Normal", "Monitor"])) errors.push(issue(`${path}.enumValues`, "invalid_operating_mode_values", "Operating mode is the ordered enum Normal / Monitor."));
        if (field.initialValue !== "Normal") errors.push(issue(`${path}.initialValue`, "invalid_operating_mode_initial_value", "Operating mode starts at Normal."));
        if (field.assignmentTarget !== true) errors.push(issue(`${path}.assignmentTarget`, "missing_assignment_target", "Operating mode must be an assignment target."));
      } else if (field.runtimeRole === "working") {
        if (!["number", "integer", "boolean", "enum"].includes(field.type)) errors.push(issue(`${path}.type`, "invalid_working_field_type", "Working fields use number, integer, boolean, or enum."));
        if (field.type === "enum" && (!Array.isArray(field.enumValues) || field.enumValues.length < 2 || field.enumValues.length > 32 || field.enumValues.some(value => typeof value !== "string" || !value) || new Set(field.enumValues).size !== field.enumValues.length)) errors.push(issue(`${path}.enumValues`, "invalid_working_enum_values", "Enum working fields need two through 32 unique non-empty choices."));
        if (typeof field.assignmentTarget !== "boolean") errors.push(issue(`${path}.assignmentTarget`, "invalid_assignment_target", "Working field assignment eligibility must be true or false."));
      } else {
        errors.push(issue(`${path}.runtimeRole`, "invalid_session_role", "Session fields use operatingMode or working."));
      }
      if (!valueMatchesField(field.initialValue, field, "eq") || (field.type === "integer" && !Number.isInteger(field.initialValue))) errors.push(issue(`${path}.initialValue`, "invalid_initial_value", "Initial value must match the typed system field."));
      if (field.assignmentTarget === true) writable.set(field.systemName, { ...field, systemField: true });
    } else {
      if (field.runtimeRole !== "occurrence") errors.push(issue(`${path}.runtimeRole`, "invalid_occurrence_role", "Occurrence fields use runtimeRole occurrence."));
      if (field.type !== "signal") errors.push(issue(`${path}.type`, "invalid_occurrence_type", "Occurrence fields have signal type."));
      if (!NAME_PATTERN.test(field.occurrenceKey || "")) errors.push(issue(`${path}.occurrenceKey`, "invalid_occurrence_key", "Occurrence key must be a letter-led name."));
      else if (occurrences.has(field.occurrenceKey)) errors.push(issue(`${path}.occurrenceKey`, "duplicate_occurrence_key", "Occurrence keys must be unique."));
      else occurrences.set(field.occurrenceKey, { ...field, path });
    }
    if (field.systemName && !fields.has(field.systemName)) fields.set(field.systemName, { ...field, operators: TYPE_OPERATORS[field.type] || [] });
  }
  if (operatingModeCount !== 1) errors.push(issue("systemFields", "operating_mode_required", "Exactly one operatingMode session field is required."));
}

function validateQualifier(condition, path, errors) {
  if (!Number.isInteger(condition?.observationCount) || condition.observationCount < 1 || condition.observationCount > 86400) errors.push(issue(`${path}.observationCount`, "invalid_observation_count", "Observation count must be an integer from 1 through 86400."));
  if (typeof condition?.minimumSeconds !== "number" || !Number.isFinite(condition.minimumSeconds) || condition.minimumSeconds < 0 || condition.minimumSeconds > 86400) errors.push(issue(`${path}.minimumSeconds`, "invalid_minimum_seconds", "Minimum seconds must be from 0 through 86400."));
}

function validateCondition(condition, path, fields, errors, qualified) {
  const allowed = qualified ? new Set(["mode", "clauses", "observationCount", "minimumSeconds"]) : new Set(["mode", "clauses"]);
  if (!hasOnly(condition, allowed) || !["all", "any"].includes(condition?.mode)) {
    errors.push(issue(path, "invalid_condition_shape", qualified ? "Qualified conditions use mode, clauses, observationCount, and minimumSeconds." : "Guards use mode and clauses."));
    return;
  }
  if (!Array.isArray(condition.clauses) || condition.clauses.length < 1 || condition.clauses.length > MAX_CONDITION_CLAUSES) errors.push(issue(`${path}.clauses`, "invalid_condition_clauses", `A condition needs one through ${MAX_CONDITION_CLAUSES} clauses.`));
  else condition.clauses.forEach((clause, index) => {
    const clausePath = `${path}.clauses[${index}]`;
    if (!hasOnly(clause, new Set(["field", "operator", "value"]))) { errors.push(issue(clausePath, "invalid_clause_shape", "Clause uses field, operator, and value only.")); return; }
    const field = fields.get(clause.field);
    if (!field) { errors.push(issue(`${clausePath}.field`, "unknown_condition_field", `${clause.field || "Field"} is not defined.`)); return; }
    const operators = field.operators || TYPE_OPERATORS[field.type] || [];
    if (!operators.includes(clause.operator)) errors.push(issue(`${clausePath}.operator`, "invalid_operator", `${clause.operator} is not valid for ${field.type}.`));
    else if (!valueMatchesField(clause.value, field, clause.operator)) errors.push(issue(`${clausePath}.value`, "invalid_condition_value", "Comparison value does not match the selected field."));
  });
  if (qualified) validateQualifier(condition, path, errors);
}

function validateTrigger(trigger, path, fields, occurrences, errors) {
  if (!isObject(trigger) || typeof trigger.type !== "string") { errors.push(issue(path, "invalid_open_trigger", "Opening trigger type is required.")); return; }
  if (trigger.type === "condition") {
    if (!hasOnly(trigger, new Set(["type", "condition"]))) errors.push(issue(path, "invalid_open_trigger", "Condition trigger uses type and condition only."));
    validateCondition(trigger.condition, `${path}.condition`, fields, errors, true);
    return;
  }
  if (!["manual", "internal"].includes(trigger.type)) { errors.push(issue(`${path}.type`, "invalid_open_trigger", "Opening trigger must be condition, manual, or internal.")); return; }
  if (!hasOnly(trigger, new Set(["type", "occurrenceField", "qualification"]))) errors.push(issue(path, "invalid_open_trigger", "Occurrence trigger uses type, occurrenceField, and qualification only."));
  const field = fields.get(trigger.occurrenceField);
  const expected = trigger.type === "manual" ? "manualOccurrence" : "internalOccurrence";
  if (!field || field.source !== expected || field.runtimeRole !== "occurrence" || field.type !== "signal") errors.push(issue(`${path}.occurrenceField`, "invalid_trigger_source", `${trigger.type} trigger must reference a matching signal occurrence field.`));
  validateQualifier(trigger.qualification, `${path}.qualification`, errors);
}

function validatePhase(phase, path, fields, writable, errors, opening) {
  const assignments = [];
  if (!hasOnly(phase, new Set(["assignments", "guardedGroups"]))) { errors.push(issue(path, "invalid_phase_shape", "Phase uses assignments and guardedGroups only.")); return assignments; }
  const validateAssignment = (assignment, assignmentPath) => {
    if (!hasOnly(assignment, new Set(["target", "value", "ownership"]))) { errors.push(issue(assignmentPath, "invalid_assignment_shape", "Assignment uses target, value, and ownership only.")); return; }
    const target = writable.get(assignment.target);
    if (!target) errors.push(issue(`${assignmentPath}.target`, "assignment_target_not_writable", `${assignment.target || "Target"} is not an assignment target.`));
    else if (!valueMatchesField(assignment.value, target, "eq")) errors.push(issue(`${assignmentPath}.value`, "assignment_value_type", "Assignment value does not match its target."));
    if (!["transition", "whileOpen"].includes(assignment.ownership)) errors.push(issue(`${assignmentPath}.ownership`, "invalid_ownership", "Ownership is transition or whileOpen."));
    if (!opening && assignment.ownership === "whileOpen") errors.push(issue(`${assignmentPath}.ownership`, "close_cannot_hold_assignment", "Only onOpen may create while-open ownership."));
    assignments.push({ ...assignment, targetField: target, path: assignmentPath });
  };
  if (!Array.isArray(phase?.assignments) || phase.assignments.length > MAX_ASSIGNMENTS) errors.push(issue(`${path}.assignments`, "invalid_assignments", `Assignments must contain at most ${MAX_ASSIGNMENTS} entries.`));
  else phase.assignments.forEach((assignment, index) => validateAssignment(assignment, `${path}.assignments[${index}]`));
  if (!Array.isArray(phase?.guardedGroups) || phase.guardedGroups.length > MAX_GUARDED_GROUPS) errors.push(issue(`${path}.guardedGroups`, "invalid_guarded_groups", `Guarded groups must contain at most ${MAX_GUARDED_GROUPS} entries.`));
  else phase.guardedGroups.forEach((group, index) => {
    const groupPath = `${path}.guardedGroups[${index}]`;
    if (!hasOnly(group, new Set(["guard", "assignments"]))) { errors.push(issue(groupPath, "invalid_guarded_group", "Guarded group uses guard and assignments only.")); return; }
    validateCondition(group.guard, `${groupPath}.guard`, fields, errors, false);
    if (!Array.isArray(group.assignments) || group.assignments.length < 1 || group.assignments.length > MAX_ASSIGNMENTS) errors.push(issue(`${groupPath}.assignments`, "invalid_group_assignments", "Guarded group needs a bounded non-empty assignment list."));
    else group.assignments.forEach((assignment, assignmentIndex) => validateAssignment(assignment, `${groupPath}.assignments[${assignmentIndex}]`));
  });
  const targets = new Set();
  assignments.forEach(assignment => {
    if (targets.has(assignment.target)) errors.push(issue(assignment.path, "ambiguous_phase_target", "A phase may assign a target once."));
    targets.add(assignment.target);
  });
  return assignments;
}

function validateSummaryOutput(output, path, names, errors) {
  if (!hasOnly(output, new Set(["systemName", "label", "type", "unit", "logging"]))) { errors.push(issue(path, "invalid_summary_output_shape", "Summary output uses systemName, label, type, unit, and logging only.")); return; }
  if (!NAME_PATTERN.test(output.systemName || "")) errors.push(issue(`${path}.systemName`, "invalid_system_name", "Use a letter-led system name."));
  else if (names.has(output.systemName)) errors.push(issue(`${path}.systemName`, "duplicate_system_name", `${output.systemName} is already defined.`));
  else names.set(output.systemName, { ...output, operators: TYPE_OPERATORS[output.type] || [] });
  if (typeof output.label !== "string" || !output.label.trim()) errors.push(issue(`${path}.label`, "missing_label", "Display label is required."));
  if (!["number", "integer"].includes(output.type)) errors.push(issue(`${path}.type`, "summary_output_type", "Summary output must be numeric."));
  if (!(typeof output.unit === "string" || output.unit === null)) errors.push(issue(`${path}.unit`, "invalid_unit", "Unit must be a string or null."));
  validateLogging(output.logging, `${path}.logging`, output, errors);
}

function validateSummary(summary, path, fields, names, errors) {
  if (!hasOnly(summary, new Set(["durationOutput", "aggregates"])) || !Array.isArray(summary?.aggregates)) { errors.push(issue(path, "invalid_summary_shape", "Summary uses durationOutput and aggregates.")); return; }
  if (summary.aggregates.length > MAX_SUMMARY_AGGREGATES) errors.push(issue(`${path}.aggregates`, "summary_aggregates_too_large", `A summary may contain at most ${MAX_SUMMARY_AGGREGATES} aggregates.`));
  if (summary.durationOutput !== null) {
    validateSummaryOutput(summary.durationOutput, `${path}.durationOutput`, names, errors);
    if (summary.durationOutput?.type !== "number" || summary.durationOutput?.unit !== "s") errors.push(issue(`${path}.durationOutput`, "invalid_duration_output", "Duration output must be a number in seconds."));
  }
  summary.aggregates.forEach((aggregate, index) => {
    const aggregatePath = `${path}.aggregates[${index}]`;
    if (!hasOnly(aggregate, new Set(["source", "operation", "scale", "output"]))) { errors.push(issue(aggregatePath, "invalid_summary_aggregate_shape", "Summary aggregate uses source, operation, scale, and output only.")); return; }
    const source = fields.get(aggregate.source);
    if (!source) errors.push(issue(`${aggregatePath}.source`, "unknown_summary_source", `${aggregate.source || "Source"} is not defined.`));
    else if (!["number", "integer"].includes(source.type)) errors.push(issue(`${aggregatePath}.source`, "summary_source_type", "Summary source must be numeric."));
    if (!Object.hasOwn(SUMMARY_OPERATIONS, aggregate.operation)) errors.push(issue(`${aggregatePath}.operation`, "invalid_summary_operation", "Unsupported standard summary operation."));
    if (typeof aggregate.scale !== "number" || !Number.isFinite(aggregate.scale)) errors.push(issue(`${aggregatePath}.scale`, "invalid_summary_scale", "Summary scale must be finite."));
    validateSummaryOutput(aggregate.output, `${aggregatePath}.output`, names, errors);
  });
}

function validateWeb(web, path, errors) {
  if (!hasOnly(web, new Set(["notifyOnOpen", "notifyOnClose", "openMessage", "closeMessage"]))) { errors.push(issue(path, "invalid_notification_policy", "Web policy has open/close choices and messages only.")); return; }
  if (typeof web.notifyOnOpen !== "boolean" || typeof web.notifyOnClose !== "boolean") errors.push(issue(path, "invalid_notification_policy", "Open and close notification choices are required."));
  if (web.notifyOnOpen && !web.openMessage?.trim()) errors.push(issue(`${path}.openMessage`, "missing_open_message", "Open notification message is required."));
  if (web.notifyOnClose && !web.closeMessage?.trim()) errors.push(issue(`${path}.closeMessage`, "missing_close_message", "Close notification message is required."));
}

function validateEvents(events, fields, writable, occurrences, errors) {
  if (!Array.isArray(events)) { errors.push(issue("events", "invalid_events", "Events must be an array.")); return; }
  if (events.length > MAX_EVENTS) errors.push(issue("events", "events_too_large", `A package may contain at most ${MAX_EVENTS} events.`));
  const ids = new Set(); const names = new Set(); const owners = new Map(); const summaryNames = new Map(fields);
  events.forEach((event, index) => {
    const path = `events[${index}]`;
    if (!hasOnly(event, new Set(["id", "systemName", "displayName", "severity", "enabled", "eventClass", "opening", "closing", "onOpen", "onClose", "summary", "web"]))) { errors.push(issue(path, "invalid_event_shape", "V3 event contains an unsupported property.")); return; }
    if (!ID_PATTERN.test(event.id || "")) errors.push(issue(`${path}.id`, "invalid_event_id", "Event ID is required."));
    else if (ids.has(event.id)) errors.push(issue(`${path}.id`, "duplicate_event_id", "Event IDs must be unique.")); else ids.add(event.id);
    if (!NAME_PATTERN.test(event.systemName || "")) errors.push(issue(`${path}.systemName`, "invalid_event_name", "Event system name is required."));
    else if (names.has(event.systemName)) errors.push(issue(`${path}.systemName`, "duplicate_event_name", "Event system names must be unique.")); else names.add(event.systemName);
    if (typeof event.displayName !== "string" || !event.displayName.trim()) errors.push(issue(`${path}.displayName`, "missing_display_name", "Display name is required."));
    if (!["Info", "Yellow", "Red"].includes(event.severity)) errors.push(issue(`${path}.severity`, "invalid_severity", "Severity must be Info, Yellow, or Red."));
    if (typeof event.enabled !== "boolean") errors.push(issue(`${path}.enabled`, "invalid_enabled", "Enabled must be true or false."));
    if (!["transient", "latched", "monitor"].includes(event.eventClass)) errors.push(issue(`${path}.eventClass`, "invalid_event_class", "Event class must be transient, latched, or monitor."));
    if (!hasOnly(event.opening, new Set(["trigger"]))) errors.push(issue(`${path}.opening`, "invalid_opening", "Opening contains one trigger."));
    validateTrigger(event.opening?.trigger, `${path}.opening.trigger`, fields, occurrences, errors);
    if (!isObject(event.closing) || typeof event.closing.policy !== "string") errors.push(issue(`${path}.closing`, "invalid_close_policy", "Closing policy is required."));
    else if (event.closing.policy === "condition") { if (!hasOnly(event.closing, new Set(["policy", "condition"]))) errors.push(issue(`${path}.closing`, "invalid_close_policy", "Condition close uses policy and condition.")); validateCondition(event.closing.condition, `${path}.closing.condition`, fields, errors, true); }
    else if (["clearEvents", "immediate"].includes(event.closing.policy)) { if (!hasOnly(event.closing, new Set(["policy"]))) errors.push(issue(`${path}.closing`, "invalid_close_policy", "This close policy has no extra properties.")); }
    else errors.push(issue(`${path}.closing.policy`, "invalid_close_policy", "Closing policy is condition, clearEvents, or immediate."));
    const openAssignments = validatePhase(event.onOpen, `${path}.onOpen`, fields, writable, errors, true);
    validatePhase(event.onClose, `${path}.onClose`, fields, writable, errors, false);
    validateSummary(event.summary, `${path}.summary`, fields, summaryNames, errors);
    validateWeb(event.web, `${path}.web`, errors);
    if (event.eventClass === "transient" && !["condition", "immediate"].includes(event.closing?.policy)) errors.push(issue(`${path}.closing.policy`, "transient_close_policy", "Transient events close by condition or immediate policy."));
    if (event.eventClass === "latched" && event.closing?.policy !== "clearEvents") errors.push(issue(`${path}.closing.policy`, "latched_close_policy", "Latched events close only through Clear Events."));
    if (event.eventClass === "monitor" && event.closing?.policy === "immediate") errors.push(issue(`${path}.closing.policy`, "monitor_close_policy", "Monitor events close by condition or Clear Events."));
    if (event.eventClass === "monitor") {
      const monitorOwnership = openAssignments.some(assignment => assignment.targetField?.runtimeRole === "operatingMode" && assignment.value === "Monitor" && assignment.ownership === "whileOpen");
      if (!monitorOwnership) errors.push(issue(`${path}.onOpen`, "monitor_ownership_required", "Monitor events hold the declared operatingMode field at Monitor while open."));
    }
    openAssignments.filter(assignment => assignment.ownership === "whileOpen" && assignment.targetField).forEach(assignment => {
      const held = owners.get(assignment.target);
      if (held && !sameValue(held.value, assignment.value)) errors.push(issue(assignment.path, "ownership_value_conflict", `${assignment.target} has incompatible while-open values.`));
      else owners.set(assignment.target, assignment);
    });
  });
}

function baseFields(base) {
  const fields = new Map(); const writable = new Map();
  base.runtimePackage.devices.forEach(device => device.fields.forEach(field => {
    const model = { ...field, operators: TYPE_OPERATORS[field.type] || [] };
    fields.set(field.systemName, model);
    if (field.access === "readWrite") writable.set(field.systemName, model);
  }));
  base.runtimePackage.calculations.forEach(calculation => (calculation.output ? [calculation.output] : calculation.outputs).forEach(field => fields.set(field.systemName, { ...field, operators: TYPE_OPERATORS[field.type] || [] })));
  return { fields, writable };
}

function validateAndCompileV3(draft) {
  if (!isObject(draft) || draft.schemaVersion !== V3_SCHEMA_VERSION) throw new RulesEngineV3ContractError("invalid_v3_draft", [issue("schemaVersion", "invalid_schema", "V3 authoring draft schemaVersion 3 is required.")]);
  const errors = [];
  if (!hasOnly(draft, new Set(["schemaVersion", "devices", "calculatedFields", "systemFields", "events"]))) errors.push(issue("", "unsupported_root_property", "V3 draft contains an unsupported root property."));
  if (Array.isArray(draft.devices) && draft.devices.length > MAX_DEVICES) errors.push(issue("devices", "devices_too_large", `A package may contain at most ${MAX_DEVICES} devices.`));
  if (Array.isArray(draft.devices)) draft.devices.forEach((device, index) => { if (Array.isArray(device?.fields) && device.fields.length > MAX_FIELDS_PER_DEVICE) errors.push(issue(`devices[${index}].fields`, "device_fields_too_large", `A device may expose at most ${MAX_FIELDS_PER_DEVICE} fields.`)); });
  if (Array.isArray(draft.calculatedFields) && draft.calculatedFields.length > MAX_CALCULATIONS) errors.push(issue("calculatedFields", "calculations_too_large", `A package may contain at most ${MAX_CALCULATIONS} calculations.`));
  if (errors.length) return { valid: false, errors, warnings: [], runtimePackage: null };

  const base = validateAndCompileV2({ schemaVersion: 2, devices: draft.devices, calculatedFields: draft.calculatedFields, events: [] });
  errors.push(...base.errors.map(error => ({ ...error, code: `base_${error.code}` })));
  if (errors.length) return { valid: false, errors, warnings: [], runtimePackage: null };
  const { fields, writable } = baseFields(base);
  const occurrences = new Map();
  validateSystemFields(draft.systemFields, fields, writable, occurrences, errors);
  validateEvents(draft.events, fields, writable, occurrences, errors);
  if (errors.length) return { valid: false, errors, warnings: [], runtimePackage: null };
  return {
    valid: true,
    errors: [],
    warnings: [],
    runtimePackage: {
      schemaVersion: V3_SCHEMA_VERSION,
      kind: V3_KIND,
      adoption: { runtimeSchemaVersion: V3_SCHEMA_VERSION, legacyPackagePolicy: "reject" },
      lifecycle: { qualification: { observationCount: "consecutive", minimumSeconds: "continuous", countAndTimeBothRequired: true, missingEvidence: "freezes_qualification" }, ownership: "event_instance_set", monitor: { resource: "declared_operating_mode" } },
      devices: base.runtimePackage.devices,
      calculations: base.runtimePackage.calculations,
      systemFields: draft.systemFields,
      // Notification policy remains authoring/reopen data. It is not a Tab5
      // runtime concern and V2 already omits it from runtime event bytes.
      events: draft.events.map(({ web, ...event }) => event)
    }
  };
}

function compileV3Release(draft, releaseId, packageVersion) {
  const result = validateAndCompileV3(draft);
  if (!result.valid) return { ...result, warnings: [], runtimeBody: null, contentHash: null };
  if (!/^[0-9]{14}-event-v3-v[1-9][0-9]*$/.test(releaseId || "")) throw new RulesEngineV3ContractError("invalid_release_id", [issue("releaseId", "invalid_release_id", "V3 release ID must be server-minted and bounded.")]);
  if (!Number.isInteger(packageVersion) || packageVersion < 1) throw new RulesEngineV3ContractError("invalid_package_version", [issue("packageVersion", "invalid_package_version", "Package version must be a positive integer.")]);
  const runtimePackage = canonical({ ...result.runtimePackage, releaseId, packageVersion });
  const runtimeBody = `${JSON.stringify(runtimePackage, null, 2)}\n`;
  if (Buffer.byteLength(runtimeBody, "utf8") > MAX_RUNTIME_BYTES) return { valid: false, errors: [issue("runtimePackage", "runtime_package_too_large", `Runtime package exceeds ${MAX_RUNTIME_BYTES} bytes.`)], warnings: [], runtimePackage: null, runtimeBody: null };
  return { valid: true, errors: [], warnings: [], runtimePackage, runtimeBody };
}

module.exports = {
  MAX_RUNTIME_BYTES,
  RulesEngineV3ContractError,
  V3_KIND,
  V3_SCHEMA_VERSION,
  _canonical: canonical,
  _compileExpression: compileExpression,
  compileV3Release,
  validateAndCompileV3
};
