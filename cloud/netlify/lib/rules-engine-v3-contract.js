"use strict";

// V3 is intentionally isolated from the deployed V2 compiler.  V2 bytes are
// accepted only by the V2 adopter; V3 requires its own kind and schema version.
const { validateAndCompile: validateAndCompileV2, _compileExpression: compileExpression, _valueMatchesField } = require("./rules-engine-contract");
const { DEVICE_DRIVERS, FUNCTION_CATALOG, TYPE_OPERATORS } = require("./rules-engine-defaults");

const V3_SCHEMA_VERSION = 3;
const V3_KIND = "well-pump-event-runtime-v3";
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const RELEASE_ID_PATTERN = /^[0-9]{14}-event-v3-v[1-9][0-9]*$/;
const MAX_DEVICES = 16;
const MAX_FIELDS_PER_DEVICE = 32;
const MAX_CALCULATIONS = 64;
const MAX_EVENTS = 64;
const MAX_CONDITION_CLAUSES = 16;
const MAX_PHASE_ASSIGNMENTS = 32;
const MAX_GUARDED_GROUPS = 16;
const MAX_ASSIGNMENTS_PER_GROUP = 16;
const MAX_PACKAGE_BYTES = 65536;
const MAX_ENUM_VALUES = 32;

class RulesEngineV3ContractError extends Error {
  constructor(code, errors = []) { super(code); this.name = "RulesEngineV3ContractError"; this.code = code; this.errors = errors; }
}

function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function issue(path, code, message) { return { path, code, message }; }
function hasOnly(object, allowed) { return Object.keys(object).every(key => allowed.has(key)); }
function equalValue(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function isFiniteNumber(value) { return typeof value === "number" && Number.isFinite(value); }

function validateLoggingShape(logging, path, errors) {
  if (!isObject(logging) || typeof logging.mode !== "string") { errors.push(issue(path, "invalid_logging_shape", "Logging must be an object with a mode.")); return; }
  const allowed = logging.mode === "delta" ? new Set(["mode", "threshold"]) : new Set(["mode"]);
  if (!hasOnly(logging, allowed) || !["none", "delta", "change", "always"].includes(logging.mode)) errors.push(issue(path, "invalid_logging_shape", "Logging uses a supported mode and no extra properties."));
  if (logging.mode === "delta" && !isFiniteNumber(logging.threshold)) errors.push(issue(`${path}.threshold`, "invalid_logging_shape", "Delta logging requires a finite threshold."));
}

function validateCalculatedFieldShape(field, path, errors) {
  const allowed = new Set(["systemName", "label", "type", "unit", "enumValues", "logging"]);
  if (!isObject(field) || !hasOnly(field, allowed)) { errors.push(issue(path, "invalid_calculated_field_shape", "A calculated field has only systemName, label, type, unit, enumValues, and logging.")); return; }
  for (const required of ["systemName", "label", "type", "unit", "logging"]) if (!Object.hasOwn(field, required)) errors.push(issue(`${path}.${required}`, "missing_calculated_field_property", `${required} is required.`));
  if (!NAME_PATTERN.test(field.systemName || "")) errors.push(issue(`${path}.systemName`, "invalid_system_name", "Use a letter-led system name."));
  if (typeof field.label !== "string" || !field.label.trim() || field.label.length > 160) errors.push(issue(`${path}.label`, "invalid_field_label", "Field label is required and bounded."));
  if (!["number", "integer", "boolean", "enum", "signal"].includes(field.type)) errors.push(issue(`${path}.type`, "invalid_type", "Field type is unsupported."));
  if (!(typeof field.unit === "string" || field.unit === null)) errors.push(issue(`${path}.unit`, "invalid_unit", "Unit must be a string or null."));
  if (field.type === "enum" && (!Array.isArray(field.enumValues) || field.enumValues.length < 2 || field.enumValues.length > MAX_ENUM_VALUES || !field.enumValues.every(value => typeof value === "string"))) errors.push(issue(`${path}.enumValues`, "invalid_enum", "Enum fields require two through 32 string values."));
  if (field.enumValues !== undefined && field.type !== "enum") errors.push(issue(`${path}.enumValues`, "invalid_enum", "Only enum fields may declare enumValues."));
  validateLoggingShape(field.logging, `${path}.logging`, errors);
}

function validateWriteShape(write, path, errors) {
  if (!isObject(write) || !hasOnly(write, new Set(["method", "parameters", "normalValue"]))) { errors.push(issue(path, "invalid_write_shape", "Write mappings use method, parameters, and normalValue only.")); return; }
  for (const required of ["method", "parameters", "normalValue"]) if (!Object.hasOwn(write, required)) errors.push(issue(`${path}.${required}`, "missing_write_property", `${required} is required.`));
  if (typeof write.method !== "string" || !write.method || write.method.length > 80) errors.push(issue(`${path}.method`, "invalid_write_method", "Write method is required and bounded."));
  if (!isObject(write.parameters) || !hasOnly(write.parameters, new Set(["id", "valueParameter"]))) errors.push(issue(`${path}.parameters`, "invalid_write_parameters_shape", "Write parameters use id and valueParameter only."));
  else {
    if (!Number.isInteger(write.parameters.id) || write.parameters.id < 0 || write.parameters.id > 255) errors.push(issue(`${path}.parameters.id`, "invalid_write_parameter_id", "Write id must be an integer from 0 through 255."));
    if (!NAME_PATTERN.test(write.parameters.valueParameter || "")) errors.push(issue(`${path}.parameters.valueParameter`, "invalid_write_value_parameter", "Write valueParameter must be a letter-led name."));
  }
}

function validateDirectFieldShape(field, path, errors) {
  const allowed = new Set(["systemName", "label", "object", "type", "unit", "enumValues", "access", "logging", "write"]);
  if (!isObject(field) || !hasOnly(field, allowed)) { errors.push(issue(path, "invalid_direct_field_shape", "A direct field contains only its binding, type, access, logging, and optional write mapping.")); return; }
  for (const required of ["systemName", "label", "object", "type", "unit", "access", "logging"]) if (!Object.hasOwn(field, required)) errors.push(issue(`${path}.${required}`, "missing_direct_field_property", `${required} is required.`));
  validateCalculatedFieldShape(Object.fromEntries(Object.entries(field).filter(([key]) => key !== "object" && key !== "access" && key !== "write")), path, errors);
  if (typeof field.object !== "string" || !field.object || field.object.length > 128) errors.push(issue(`${path}.object`, "invalid_device_object", "Device object is required and bounded."));
  if (!["read", "readWrite"].includes(field.access)) errors.push(issue(`${path}.access`, "invalid_access", "Access must be read or readWrite."));
  if (field.access === "readWrite") validateWriteShape(field.write, `${path}.write`, errors);
  else if (field.write !== undefined) errors.push(issue(`${path}.write`, "read_field_write_mapping", "Read-only fields may not have a write mapping."));
}

function validateProgramShape(expression, program, path, errors) {
  if (!Array.isArray(program) || program.length > 128) { errors.push(issue(path, "invalid_expression_program", "Expression program must be a bounded token array.")); return; }
  program.forEach((token, index) => {
    const tokenPath = `${path}[${index}]`;
    if (!Array.isArray(token) || token.length !== 2 || !["number", "field", "operator"].includes(token[0])) { errors.push(issue(tokenPath, "invalid_expression_program_token", "Program token must be a two-item number, field, or operator token.")); return; }
    if ((token[0] === "number" && !isFiniteNumber(token[1])) || (token[0] === "field" && !NAME_PATTERN.test(token[1] || "")) || (token[0] === "operator" && !["+", "-", "*", "/", "neg"].includes(token[1]))) errors.push(issue(tokenPath, "invalid_expression_program_token", "Program token value is invalid."));
  });
  try {
    if (!equalValue(compileExpression(expression).program, program)) errors.push(issue(path, "expression_program_mismatch", "Expression program must exactly match the compiled expression."));
  } catch { errors.push(issue(path, "invalid_expression_program", "Expression program cannot be validated for this expression.")); }
}

function validateCalculationShape(calculation, path, errors) {
  if (!isObject(calculation) || typeof calculation.kind !== "string") { errors.push(issue(path, "invalid_calculation_shape", "Calculation kind is required.")); return; }
  if (calculation.kind === "expression") {
    const allowed = new Set(["id", "label", "kind", "expression", "output", "program"]);
    if (!hasOnly(calculation, allowed)) errors.push(issue(path, "invalid_calculation_shape", "Expression calculations contain only id, label, kind, expression, output, and optional program."));
    for (const required of ["id", "label", "kind", "expression", "output"]) if (!Object.hasOwn(calculation, required)) errors.push(issue(`${path}.${required}`, "missing_calculation_property", `${required} is required.`));
    if (typeof calculation.expression !== "string" || calculation.expression.length > 512) errors.push(issue(`${path}.expression`, "invalid_expression_shape", "Expression must be a bounded string."));
    validateCalculatedFieldShape(calculation.output, `${path}.output`, errors);
    if (calculation.program !== undefined) validateProgramShape(calculation.expression, calculation.program, `${path}.program`, errors);
  } else if (calculation.kind === "function") {
    const allowed = new Set(["id", "label", "kind", "functionId", "inputs", "parameters", "outputs"]);
    if (!hasOnly(calculation, allowed)) errors.push(issue(path, "invalid_calculation_shape", "Function calculations contain only id, label, kind, functionId, inputs, parameters, and outputs."));
    for (const required of ["id", "label", "kind", "functionId", "inputs", "parameters", "outputs"]) if (!Object.hasOwn(calculation, required)) errors.push(issue(`${path}.${required}`, "missing_calculation_property", `${required} is required.`));
    const spec = FUNCTION_CATALOG[calculation.functionId];
    if (!spec) errors.push(issue(`${path}.functionId`, "unknown_function", "Calculation function is not in the runtime catalog."));
    if (!isObject(calculation.inputs) || (spec && (!hasOnly(calculation.inputs, new Set(Object.keys(spec.inputs))) || Object.keys(calculation.inputs).length !== Object.keys(spec.inputs).length)) || !Object.values(calculation.inputs || {}).every(value => NAME_PATTERN.test(value || ""))) errors.push(issue(`${path}.inputs`, "invalid_function_inputs_shape", "Function inputs must exactly match the catalog."));
    if (!isObject(calculation.parameters) || (spec && (!hasOnly(calculation.parameters, new Set(Object.keys(spec.parameters))) || Object.keys(calculation.parameters).length !== Object.keys(spec.parameters).length))) errors.push(issue(`${path}.parameters`, "invalid_function_parameters_shape", "Function parameters must exactly match the catalog."));
    if (!Array.isArray(calculation.outputs) || !calculation.outputs.length || calculation.outputs.length > 16) errors.push(issue(`${path}.outputs`, "invalid_function_outputs_shape", "Function outputs must be a bounded non-empty array."));
    else calculation.outputs.forEach((output, index) => validateCalculatedFieldShape(output, `${path}.outputs[${index}]`, errors));
  } else errors.push(issue(`${path}.kind`, "invalid_calculation_kind", "Calculation kind must be expression or function."));
  if (!ID_PATTERN.test(calculation.id || "")) errors.push(issue(`${path}.id`, "invalid_calculation_id", "Calculation ID is required."));
  if (typeof calculation.label !== "string" || !calculation.label.trim() || calculation.label.length > 160) errors.push(issue(`${path}.label`, "invalid_calculation_label", "Calculation label is required and bounded."));
}

function validateBaseShapes(draft, errors) {
  if (!Array.isArray(draft.devices)) { errors.push(issue("devices", "invalid_devices_shape", "Devices must be an array.")); return; }
  draft.devices.forEach((device, index) => {
    const path = `devices[${index}]`;
    if (!isObject(device) || !hasOnly(device, new Set(["id", "label", "driver", "address", "enabled", "fields"]))) { errors.push(issue(path, "invalid_device_shape", "A device contains only id, label, driver, address, enabled, and fields.")); return; }
    for (const required of ["id", "label", "driver", "address", "enabled", "fields"]) if (!Object.hasOwn(device, required)) errors.push(issue(`${path}.${required}`, "missing_device_property", `${required} is required.`));
    if (!ID_PATTERN.test(device.id || "")) errors.push(issue(`${path}.id`, "invalid_device_id", "Device ID is required."));
    if (typeof device.label !== "string" || !device.label.trim() || device.label.length > 160) errors.push(issue(`${path}.label`, "invalid_device_label", "Device label is required and bounded."));
    if (!Object.hasOwn(DEVICE_DRIVERS, device.driver)) errors.push(issue(`${path}.driver`, "unknown_driver", "Device driver is not in the runtime catalog."));
    if (typeof device.address !== "string" || !device.address.trim() || device.address.length > 256) errors.push(issue(`${path}.address`, "invalid_address", "Device address is required and bounded."));
    if (typeof device.enabled !== "boolean") errors.push(issue(`${path}.enabled`, "invalid_enabled", "Enabled must be boolean."));
    if (!Array.isArray(device.fields) || !device.fields.length) errors.push(issue(`${path}.fields`, "invalid_device_fields_shape", "Device fields must be a non-empty array."));
    else device.fields.forEach((field, fieldIndex) => validateDirectFieldShape(field, `${path}.fields[${fieldIndex}]`, errors));
  });
  if (!Array.isArray(draft.calculatedFields)) errors.push(issue("calculatedFields", "invalid_calculations_shape", "Calculated fields must be an array."));
  else draft.calculatedFields.forEach((calculation, index) => validateCalculationShape(calculation, `calculatedFields[${index}]`, errors));
}

function validateQualifier(value, path, errors) {
  if (!Number.isInteger(value?.observationCount) || value.observationCount < 1 || value.observationCount > 86400) errors.push(issue(`${path}.observationCount`, "invalid_observation_count", "Observation count must be an integer from 1 through 86400."));
  if (typeof value?.minimumSeconds !== "number" || !Number.isFinite(value.minimumSeconds) || value.minimumSeconds < 0 || value.minimumSeconds > 86400) errors.push(issue(`${path}.minimumSeconds`, "invalid_minimum_seconds", "Minimum seconds must be finite and from 0 through 86400."));
}

function validateClauses(condition, path, fields, errors, { qualifier }) {
  if (!isObject(condition) || !hasOnly(condition, qualifier ? new Set(["mode", "clauses", "observationCount", "minimumSeconds"]) : new Set(["mode", "clauses"]))) {
    errors.push(issue(path, "invalid_condition_shape", "Conditions use only mode, clauses, and (where qualifying) observationCount and minimumSeconds."));
    return;
  }
  if (!["all", "any"].includes(condition.mode)) errors.push(issue(`${path}.mode`, "invalid_condition_mode", "Condition mode must be all or any."));
  if (!Array.isArray(condition.clauses) || condition.clauses.length < 1) errors.push(issue(`${path}.clauses`, "missing_clauses", "At least one condition clause is required."));
  else if (condition.clauses.length > MAX_CONDITION_CLAUSES) errors.push(issue(`${path}.clauses`, "condition_too_large", `A condition may contain at most ${MAX_CONDITION_CLAUSES} clauses.`));
  else condition.clauses.forEach((clause, index) => {
    const clausePath = `${path}.clauses[${index}]`;
    if (!isObject(clause) || !hasOnly(clause, new Set(["field", "operator", "value"]))) { errors.push(issue(clausePath, "invalid_clause_shape", "A clause uses field, operator, and value only.")); return; }
    const field = fields.get(clause.field);
    if (!field) { errors.push(issue(`${clausePath}.field`, "unknown_condition_field", `${clause.field || "Field"} is not defined.`)); return; }
    if (!field.operators.includes(clause.operator)) errors.push(issue(`${clausePath}.operator`, "invalid_operator", `${clause.operator} is not valid for ${field.type}.`));
    else if (!_valueMatchesField(clause.value, field, clause.operator)) errors.push(issue(`${clausePath}.value`, "invalid_condition_value", "Comparison value does not match the selected field."));
  });
  if (qualifier) validateQualifier(condition, path, errors);
}

function validateOpening(opening, path, fields, errors) {
  if (!isObject(opening) || !hasOnly(opening, new Set(["trigger"]))) { errors.push(issue(path, "invalid_opening", "Opening must contain one trigger.")); return null; }
  const trigger = opening.trigger;
  if (!isObject(trigger) || typeof trigger.type !== "string") { errors.push(issue(`${path}.trigger`, "invalid_open_trigger", "Opening trigger type is required.")); return null; }
  if (trigger.type === "condition") {
    if (!hasOnly(trigger, new Set(["type", "condition"]))) errors.push(issue(`${path}.trigger`, "invalid_open_trigger", "A condition trigger uses type and condition only."));
    validateClauses(trigger.condition, `${path}.trigger.condition`, fields, errors, { qualifier: true });
  } else if (trigger.type === "manual") {
    if (!hasOnly(trigger, new Set(["type", "request", "qualification"]))) errors.push(issue(`${path}.trigger`, "invalid_open_trigger", "A manual trigger uses type, request, and qualification only."));
    if (!NAME_PATTERN.test(trigger.request || "")) errors.push(issue(`${path}.trigger.request`, "invalid_manual_request", "Manual request must be a letter-led name."));
    validateQualifier(trigger.qualification, `${path}.trigger.qualification`, errors);
  } else if (trigger.type === "internal") {
    if (!hasOnly(trigger, new Set(["type", "occurrence", "qualification"]))) errors.push(issue(`${path}.trigger`, "invalid_open_trigger", "An internal trigger uses type, occurrence, and qualification only."));
    if (!NAME_PATTERN.test(trigger.occurrence || "")) errors.push(issue(`${path}.trigger.occurrence`, "invalid_internal_occurrence", "Internal occurrence must be a letter-led name."));
    validateQualifier(trigger.qualification, `${path}.trigger.qualification`, errors);
  } else errors.push(issue(`${path}.trigger.type`, "invalid_open_trigger", "Opening trigger must be condition, manual, or internal."));
  return trigger?.type || null;
}

function validateClosing(closing, path, fields, errors) {
  if (!isObject(closing) || typeof closing.policy !== "string") { errors.push(issue(path, "invalid_close_policy", "Closing policy is required.")); return null; }
  if (closing.policy === "condition") {
    if (!hasOnly(closing, new Set(["policy", "condition"]))) errors.push(issue(path, "invalid_close_policy", "A condition close policy uses policy and condition only."));
    validateClauses(closing.condition, `${path}.condition`, fields, errors, { qualifier: true });
  } else if (closing.policy === "clearEvents" || closing.policy === "immediate") {
    if (!hasOnly(closing, new Set(["policy"]))) errors.push(issue(path, "invalid_close_policy", `${closing.policy} has no condition or extra settings.`));
  } else errors.push(issue(`${path}.policy`, "invalid_close_policy", "Closing policy must be condition, clearEvents, or immediate."));
  return closing.policy;
}

function validateAssignment(assignment, path, writable, errors, phase, assignments) {
  if (!isObject(assignment) || !hasOnly(assignment, new Set(["target", "value", "ownership"]))) { errors.push(issue(path, "invalid_assignment", "An assignment uses target, value, and ownership only.")); return; }
  const target = writable.get(assignment.target);
  if (!target) errors.push(issue(`${path}.target`, "action_target_not_writable", `${assignment.target || "Target"} is not a writable device field.`));
  else if (!_valueMatchesField(assignment.value, target, "eq")) errors.push(issue(`${path}.value`, "action_value_type", "Assignment value does not match its target."));
  if (!["transition", "whileOpen"].includes(assignment.ownership)) errors.push(issue(`${path}.ownership`, "invalid_ownership", "Ownership must be transition or whileOpen."));
  if (phase === "onClose" && assignment.ownership === "whileOpen") errors.push(issue(`${path}.ownership`, "close_cannot_hold_assignment", "Only onOpen may create whileOpen ownership."));
  assignments.push({ ...assignment, path, field: target });
}

function validatePhase(phase, path, writable, errors, phaseName) {
  const assignments = [];
  if (!isObject(phase) || !hasOnly(phase, new Set(["assignments", "guardedGroups"]))) { errors.push(issue(path, "invalid_phase", "A phase uses assignments and guardedGroups only.")); return assignments; }
  if (!Array.isArray(phase.assignments)) errors.push(issue(`${path}.assignments`, "invalid_assignments", "Assignments must be an array."));
  else if (phase.assignments.length > MAX_PHASE_ASSIGNMENTS) errors.push(issue(`${path}.assignments`, "phase_too_large", `A phase may contain at most ${MAX_PHASE_ASSIGNMENTS} assignments.`));
  else phase.assignments.forEach((assignment, index) => validateAssignment(assignment, `${path}.assignments[${index}]`, writable, errors, phaseName, assignments));
  if (!Array.isArray(phase.guardedGroups)) errors.push(issue(`${path}.guardedGroups`, "invalid_guarded_groups", "Guarded groups must be an array."));
  else if (phase.guardedGroups.length > MAX_GUARDED_GROUPS) errors.push(issue(`${path}.guardedGroups`, "phase_too_large", `A phase may contain at most ${MAX_GUARDED_GROUPS} guarded groups.`));
  else phase.guardedGroups.forEach((group, groupIndex) => {
    const groupPath = `${path}.guardedGroups[${groupIndex}]`;
    if (!isObject(group) || !hasOnly(group, new Set(["guard", "assignments"]))) { errors.push(issue(groupPath, "invalid_guarded_group", "A guarded group uses guard and assignments only.")); return; }
    if (!Array.isArray(group.assignments) || group.assignments.length < 1) errors.push(issue(`${groupPath}.assignments`, "missing_group_assignments", "A guarded group needs at least one assignment."));
    else if (group.assignments.length > MAX_ASSIGNMENTS_PER_GROUP) errors.push(issue(`${groupPath}.assignments`, "group_too_large", `A guarded group may contain at most ${MAX_ASSIGNMENTS_PER_GROUP} assignments.`));
    else group.assignments.forEach((assignment, assignmentIndex) => validateAssignment(assignment, `${groupPath}.assignments[${assignmentIndex}]`, writable, errors, phaseName, assignments));
  });
  const targets = new Set();
  assignments.forEach(assignment => {
    if (targets.has(assignment.target)) errors.push(issue(assignment.path, "ambiguous_phase_target", "A phase may assign each target at most once because multiple guards may qualify together."));
    targets.add(assignment.target);
  });
  return assignments;
}

// validatePhase needs both the full readable field map for guards and the
// writable subset for assignments. Keep the public implementation concise by
// applying guard validation in this small second pass.
function validatePhaseWithFields(phase, path, fields, writable, errors, phaseName) {
  const assignments = validatePhase(phase, path, writable, errors, phaseName);
  if (isObject(phase) && Array.isArray(phase.guardedGroups)) phase.guardedGroups.forEach((group, index) => {
    if (isObject(group)) validateClauses(group.guard, `${path}.guardedGroups[${index}].guard`, fields, errors, { qualifier: false });
  });
  return assignments;
}

function validateEvents(events, fields, writable, errors) {
  if (!Array.isArray(events)) { errors.push(issue("events", "invalid_events", "Events must be an array.")); return; }
  if (events.length > MAX_EVENTS) errors.push(issue("events", "events_too_large", `A package may contain at most ${MAX_EVENTS} events.`));
  const ids = new Set();
  const names = new Set();
  const held = new Map();
  const openTransitions = [];
  const closeAssignments = [];
  events.forEach((event, index) => {
    const path = `events[${index}]`;
    if (!isObject(event) || !hasOnly(event, new Set(["id", "systemName", "displayName", "severity", "enabled", "eventClass", "opening", "closing", "onOpen", "onClose"]))) { errors.push(issue(path, "invalid_event_shape", "V3 event contains an unsupported property.")); return; }
    if (!ID_PATTERN.test(event.id || "")) errors.push(issue(`${path}.id`, "invalid_event_id", "Event ID is required."));
    else if (ids.has(event.id)) errors.push(issue(`${path}.id`, "duplicate_event_id", "Event IDs must be unique."));
    else ids.add(event.id);
    if (!NAME_PATTERN.test(event.systemName || "")) errors.push(issue(`${path}.systemName`, "invalid_event_name", "Event system name is required."));
    else if (names.has(event.systemName)) errors.push(issue(`${path}.systemName`, "duplicate_event_name", "Event system names must be unique."));
    else names.add(event.systemName);
    if (typeof event.displayName !== "string" || !event.displayName.trim() || event.displayName.length > 160) errors.push(issue(`${path}.displayName`, "invalid_display_name", "Display name is required and may not exceed 160 characters."));
    if (!["Info", "Yellow", "Red"].includes(event.severity)) errors.push(issue(`${path}.severity`, "invalid_severity", "Severity must be Info, Yellow, or Red."));
    if (typeof event.enabled !== "boolean") errors.push(issue(`${path}.enabled`, "invalid_enabled", "Enabled must be true or false."));
    if (!["transient", "latched", "monitor"].includes(event.eventClass)) errors.push(issue(`${path}.eventClass`, "invalid_event_class", "Event class must be transient, latched, or monitor."));
    const triggerType = validateOpening(event.opening, `${path}.opening`, fields, errors);
    const closePolicy = validateClosing(event.closing, `${path}.closing`, fields, errors);
    const onOpen = validatePhaseWithFields(event.onOpen, `${path}.onOpen`, fields, writable, errors, "onOpen");
    const onClose = validatePhaseWithFields(event.onClose, `${path}.onClose`, fields, writable, errors, "onClose");
    if (event.eventClass === "transient" && closePolicy !== "condition" && closePolicy !== "immediate") errors.push(issue(`${path}.closing.policy`, "transient_close_policy", "Transient events close by condition or immediate policy."));
    if (event.eventClass === "latched" && closePolicy !== "clearEvents") errors.push(issue(`${path}.closing.policy`, "latched_close_policy", "Latched events close only through Clear Events."));
    if (event.eventClass === "monitor" && closePolicy === "immediate") errors.push(issue(`${path}.closing.policy`, "monitor_close_policy", "Monitor events close by condition or Clear Events."));
    if (closePolicy === "immediate" && triggerType === "condition") errors.push(issue(`${path}.closing.policy`, "immediate_condition_event", "Immediate closing is reserved for manual or internal occurrences."));
    if (closePolicy === "immediate" && onOpen.some(assignment => assignment.ownership === "whileOpen")) errors.push(issue(`${path}.onOpen`, "immediate_cannot_hold_assignment", "An immediate event cannot create whileOpen ownership."));
    if (event.eventClass === "monitor" && onOpen.some(assignment => assignment.ownership === "whileOpen")) errors.push(issue(`${path}.onOpen`, "monitor_cannot_hold_assignment", "Monitor ownership is the implicit Monitor resource, not a writable-field hold."));
    onOpen.filter(assignment => assignment.ownership === "whileOpen" && assignment.field).forEach(assignment => {
      const existing = held.get(assignment.target);
      if (existing && !equalValue(existing.value, assignment.value)) errors.push(issue(assignment.path, "ownership_value_conflict", `${assignment.target} has incompatible whileOpen ownership values.`));
      else held.set(assignment.target, assignment);
    });
    openTransitions.push(...onOpen.filter(assignment => assignment.ownership === "transition"));
    closeAssignments.push(...onClose);
  });
  openTransitions.forEach(assignment => {
    const heldAssignment = held.get(assignment.target);
    if (heldAssignment && !equalValue(heldAssignment.value, assignment.value)) errors.push(issue(assignment.path, "transition_assignment_conflicts_with_ownership", `${assignment.target} has incompatible transition and whileOpen values.`));
  });
  closeAssignments.forEach(assignment => {
    if (held.has(assignment.target)) errors.push(issue(assignment.path, "close_assignment_conflicts_with_ownership", `${assignment.target} is released through ownership and cannot also be explicitly assigned on close.`));
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function validateAndCompileV3(draft) {
  if (!isObject(draft) || draft.schemaVersion !== V3_SCHEMA_VERSION || draft.kind !== V3_KIND) throw new RulesEngineV3ContractError("invalid_v3_package", [issue("schemaVersion", "invalid_schema", "V3 requires schemaVersion 3 and the V3 package kind.")]);
  const errors = [];
  if (!hasOnly(draft, new Set(["schemaVersion", "kind", "releaseId", "packageVersion", "adoption", "devices", "calculatedFields", "events"]))) errors.push(issue("", "unsupported_root_property", "V3 package contains an unsupported root property."));
  if (!RELEASE_ID_PATTERN.test(draft.releaseId || "")) errors.push(issue("releaseId", "invalid_release_id", "V3 adoption requires a bounded immutable V3 release ID."));
  if (!Number.isInteger(draft.packageVersion) || draft.packageVersion < 1 || draft.packageVersion > 2147483647) errors.push(issue("packageVersion", "invalid_package_version", "V3 adoption requires a positive bounded package version."));
  if (!isObject(draft.adoption) || draft.adoption.runtimeSchemaVersion !== 3 || draft.adoption.legacyPackagePolicy !== "reject" || !hasOnly(draft.adoption, new Set(["runtimeSchemaVersion", "legacyPackagePolicy"]))) errors.push(issue("adoption", "invalid_adoption_policy", "V3 adoption requires runtimeSchemaVersion 3 and legacyPackagePolicy reject."));
  if (Array.isArray(draft.devices) && draft.devices.length > MAX_DEVICES) errors.push(issue("devices", "devices_too_large", `A package may contain at most ${MAX_DEVICES} devices.`));
  if (Array.isArray(draft.devices)) draft.devices.forEach((device, index) => { if (Array.isArray(device?.fields) && device.fields.length > MAX_FIELDS_PER_DEVICE) errors.push(issue(`devices[${index}].fields`, "device_fields_too_large", `A device may expose at most ${MAX_FIELDS_PER_DEVICE} fields.`)); });
  if (Array.isArray(draft.calculatedFields) && draft.calculatedFields.length > MAX_CALCULATIONS) errors.push(issue("calculatedFields", "calculations_too_large", `A package may contain at most ${MAX_CALCULATIONS} calculations.`));
  validateBaseShapes(draft, errors);
  // Never pass malformed V3 nested values to the V2 helper: it predates V3's
  // closed shapes and assumes object entries while iterating them.
  if (errors.length) return { valid: false, errors, runtimePackage: null, canonicalJson: null };

  // This call reuses the existing V2 field, calculation, driver-binding, and
  // writable-field checks without letting any V2 event semantics leak into V3.
  const base = validateAndCompileV2({ schemaVersion: 2, devices: draft.devices, calculatedFields: draft.calculatedFields, events: [] });
  errors.push(...base.errors.map(error => ({ ...error, code: `base_${error.code}` })));
  if (errors.length) return { valid: false, errors, runtimePackage: null, canonicalJson: null };

  const fields = new Map();
  const writable = new Map();
  base.runtimePackage.devices.forEach(device => device.fields.forEach(field => {
    const model = { type: field.type, unit: field.unit, enumValues: field.enumValues || null, operators: TYPE_OPERATORS[field.type] || [] };
    fields.set(field.systemName, model);
    if (field.access === "readWrite") writable.set(field.systemName, { ...model, normalValue: field.write.normalValue });
  }));
  base.runtimePackage.calculations.forEach(calculation => (calculation.output ? [calculation.output] : calculation.outputs).forEach(field => fields.set(field.systemName, { type: field.type, unit: field.unit, enumValues: field.enumValues || null, operators: TYPE_OPERATORS[field.type] || [] })));
  validateEvents(draft.events, fields, writable, errors);
  if (errors.length) return { valid: false, errors, runtimePackage: null, canonicalJson: null };

  const runtimePackage = canonicalize({
    schemaVersion: 3,
    kind: V3_KIND,
    releaseId: draft.releaseId,
    packageVersion: draft.packageVersion,
    adoption: { runtimeSchemaVersion: 3, legacyPackagePolicy: "reject" },
    // Retain the established V2 authoring shapes so a V3 adopter can validate
    // the exact bytes it receives. Expression programs are additive compiled
    // data; V2 never sees this V3 package kind.
    devices: draft.devices,
    calculatedFields: base.runtimePackage.calculations.map(compiled => {
      const source = draft.calculatedFields.find(calculation => calculation.id === compiled.id);
      return compiled.kind === "expression" ? { ...source, program: compiled.program } : source;
    }),
    events: draft.events
  });
  const canonicalJson = JSON.stringify(runtimePackage);
  if (Buffer.byteLength(canonicalJson, "utf8") > MAX_PACKAGE_BYTES) return { valid: false, errors: [issue("", "package_too_large", `A canonical V3 package may not exceed ${MAX_PACKAGE_BYTES} bytes.`)], runtimePackage: null, canonicalJson: null };
  return { valid: true, errors: [], runtimePackage, canonicalJson };
}

function validateV3PackageForAdoption(candidate) {
  if (!isObject(candidate) || candidate.schemaVersion !== 3 || candidate.kind !== V3_KIND) throw new RulesEngineV3ContractError("unsupported_package_version", [issue("schemaVersion", "v2_requires_v2_adopter", "V2 and other package bytes must not be interpreted as V3.")]);
  return validateAndCompileV3(candidate);
}

module.exports = { RulesEngineV3ContractError, V3_KIND, V3_SCHEMA_VERSION, validateAndCompileV3, validateV3PackageForAdoption };
