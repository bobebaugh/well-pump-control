"use strict";

const { DEVICE_DRIVERS, EVENT_FUNCTIONS, FUNCTION_CATALOG, TYPE_OPERATORS } = require("./rules-engine-defaults");

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const TYPES = new Set(["number", "integer", "boolean", "enum", "signal"]);
const LOG_MODES = new Set(["none", "delta", "change", "always"]);
const ACCESS = new Set(["read", "readWrite"]);

class RulesEngineContractError extends Error {
  constructor(code, errors = []) {
    super(code);
    this.name = "RulesEngineContractError";
    this.code = code;
    this.errors = errors;
  }
}

function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function issue(path, code, message) { return { path, code, message }; }

function validateLogging(logging, field, path, errors) {
  if (!isObject(logging) || !LOG_MODES.has(logging.mode)) {
    errors.push(issue(`${path}.logging`, "invalid_logging", "Choose none, delta, change, or always."));
    return;
  }
  if (logging.mode === "delta") {
    if (!(field.type === "number" || field.type === "integer")) {
      errors.push(issue(`${path}.logging.mode`, "invalid_delta_type", "Delta logging requires a numeric field."));
    }
    if (typeof logging.threshold !== "number" || !Number.isFinite(logging.threshold) || logging.threshold <= 0) {
      errors.push(issue(`${path}.logging.threshold`, "invalid_delta_threshold", "Delta threshold must be greater than zero."));
    }
  }
  if (logging.mode === "change" && field.type === "signal") {
    errors.push(issue(`${path}.logging.mode`, "invalid_signal_logging", "Signals use always or none logging."));
  }
}

function validateField(field, path, errors, names, writable) {
  if (!isObject(field)) { errors.push(issue(path, "invalid_field", "Field must be an object.")); return; }
  if (!NAME_PATTERN.test(field.systemName || "")) errors.push(issue(`${path}.systemName`, "invalid_system_name", "Use a unique letter-led system name."));
  if (names.has(field.systemName)) errors.push(issue(`${path}.systemName`, "duplicate_system_name", `${field.systemName} is already defined.`));
  else if (field.systemName) names.set(field.systemName, { type: field.type, unit: field.unit ?? null, enumValues: field.enumValues || null, path });
  if (typeof field.label !== "string" || !field.label.trim()) errors.push(issue(`${path}.label`, "missing_label", "Display label is required."));
  if (!TYPES.has(field.type)) errors.push(issue(`${path}.type`, "invalid_type", "Unsupported field type."));
  if (field.type === "enum" && (!Array.isArray(field.enumValues) || field.enumValues.length < 2)) errors.push(issue(`${path}.enumValues`, "invalid_enum", "Enum fields require at least two values."));
  validateLogging(field.logging, field, path, errors);
  if (field.access !== undefined) {
    if (!ACCESS.has(field.access)) errors.push(issue(`${path}.access`, "invalid_access", "Access must be read or readWrite."));
    if (field.access === "readWrite") {
      if (!isObject(field.write) || typeof field.write.method !== "string" || !field.write.method) errors.push(issue(`${path}.write`, "missing_write_mapping", "Writable fields require a device write mapping."));
      else {
        if (!isObject(field.write.parameters) || typeof field.write.parameters.valueParameter !== "string" || !field.write.parameters.valueParameter) errors.push(issue(`${path}.write.parameters`, "invalid_write_parameters", "Write parameters must identify the device API value parameter."));
        if (!valueMatchesField(field.write.normalValue, field, "eq")) errors.push(issue(`${path}.write.normalValue`, "invalid_normal_value", "A writable field requires a type-compatible normal value."));
        writable.set(field.systemName, { type: field.type, path });
      }
    }
  }
}

function validateDevices(devices, errors, names, writable) {
  if (!Array.isArray(devices) || !devices.length) { errors.push(issue("devices", "missing_devices", "At least one device is required.")); return; }
  const ids = new Set();
  devices.forEach((device, index) => {
    const path = `devices[${index}]`;
    if (!isObject(device) || !ID_PATTERN.test(device.id || "")) errors.push(issue(`${path}.id`, "invalid_device_id", "Device ID is required."));
    else if (ids.has(device.id)) errors.push(issue(`${path}.id`, "duplicate_device_id", "Device IDs must be unique."));
    else ids.add(device.id);
    if (!Object.hasOwn(DEVICE_DRIVERS, device.driver)) errors.push(issue(`${path}.driver`, "unknown_driver", "Device driver is not implemented by the Tab5 runtime catalog."));
    if (typeof device.address !== "string" || !device.address.trim()) errors.push(issue(`${path}.address`, "missing_address", "Device address is required."));
    if (typeof device.enabled !== "boolean") errors.push(issue(`${path}.enabled`, "invalid_enabled", "Enabled must be true or false."));
    if (!Array.isArray(device.fields) || !device.fields.length) errors.push(issue(`${path}.fields`, "missing_fields", "Device must expose at least one field."));
    else device.fields.forEach((field, fieldIndex) => validateField(field, `${path}.fields[${fieldIndex}]`, errors, names, writable));
  });
}

function parameterTypeOk(expected, value) {
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "scalar") return ["string", "number", "boolean"].includes(typeof value) && value !== null;
  return false;
}

function validateCalculations(calculations, errors, names) {
  if (!Array.isArray(calculations)) { errors.push(issue("calculatedFields", "invalid_calculations", "Calculated fields must be an array.")); return []; }
  const ids = new Set();
  const pending = calculations.map((calculation, index) => ({ calculation, index }));
  const ordered = [];

  calculations.forEach((calculation, index) => {
    const path = `calculatedFields[${index}]`;
    if (!isObject(calculation) || !ID_PATTERN.test(calculation.id || "")) errors.push(issue(`${path}.id`, "invalid_calculation_id", "Calculation ID is required."));
    else if (ids.has(calculation.id)) errors.push(issue(`${path}.id`, "duplicate_calculation_id", "Calculation IDs must be unique."));
    else ids.add(calculation.id);
    const spec = FUNCTION_CATALOG[calculation.functionId];
    if (!spec) errors.push(issue(`${path}.functionId`, "unknown_function", "Function is not implemented by the Tab5 runtime catalog."));
    if (!Array.isArray(calculation.outputs) || !calculation.outputs.length) errors.push(issue(`${path}.outputs`, "missing_outputs", "Calculation must define at least one output."));
    else calculation.outputs.forEach((output, outputIndex) => validateField(output, `${path}.outputs[${outputIndex}]`, errors, names, new Map()));
    if (spec && calculation.outputs?.length !== spec.outputs.length) errors.push(issue(`${path}.outputs`, "wrong_output_count", `${spec.label} requires ${spec.outputs.length} output(s).`));
    if (spec && calculation.outputs?.length === spec.outputs.length) calculation.outputs.forEach((output, outputIndex) => {
      const expected = spec.outputs[outputIndex];
      if (output.type !== expected.type || (output.unit ?? null) !== (expected.unit ?? null)) errors.push(issue(`${path}.outputs[${outputIndex}]`, "output_contract_mismatch", `Output must be ${expected.type}${expected.unit ? ` in ${expected.unit}` : ""}.`));
    });
    if (spec) {
      for (const [name, type] of Object.entries(spec.parameters)) {
        if (!parameterTypeOk(type, calculation.parameters?.[name])) errors.push(issue(`${path}.parameters.${name}`, "invalid_parameter", `${name} is required and must be ${type}.`));
      }
    }
  });

  const resolved = new Map([...names.entries()].filter(([, value]) => value.path.startsWith("devices")));
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const { calculation, index: originalIndex } = pending[index];
      const spec = FUNCTION_CATALOG[calculation.functionId];
      if (!spec) { pending.splice(index, 1); continue; }
      const refs = Object.values(calculation.inputs || {});
      if (!refs.every(reference => resolved.has(reference))) continue;
      for (const [inputName, acceptedTypes] of Object.entries(spec.inputs)) {
        const reference = calculation.inputs?.[inputName];
        const source = resolved.get(reference);
        if (!source) errors.push(issue(`calculatedFields[${originalIndex}].inputs.${inputName}`, "missing_input", `${inputName} must reference an available field.`));
        else if (!acceptedTypes.includes(source.type)) errors.push(issue(`calculatedFields[${originalIndex}].inputs.${inputName}`, "input_type_mismatch", `${reference} has incompatible type ${source.type}.`));
        else if (spec.inputUnits?.[inputName] && source.unit !== spec.inputUnits[inputName]) errors.push(issue(`calculatedFields[${originalIndex}].inputs.${inputName}`, "input_unit_mismatch", `${reference} must use ${spec.inputUnits[inputName]}, not ${source.unit || "an unspecified unit"}.`));
      }
      calculation.outputs?.forEach(output => resolved.set(output.systemName, { type: output.type, unit: output.unit ?? null, enumValues: output.enumValues || null, path: `calculatedFields[${originalIndex}]` }));
      ordered.push(calculation);
      pending.splice(index, 1);
      progress = true;
    }
  }
  pending.forEach(({ calculation, index }) => errors.push(issue(`calculatedFields[${index}].inputs`, "unresolved_calculation", `${calculation.label || calculation.id} has a missing input or calculation cycle.`)));
  return { ordered, resolved };
}

function valueMatchesField(value, field, operator) {
  if (operator === "occurs") return value === null || value === undefined;
  if (operator === "between" || operator === "outside") return Array.isArray(value) && value.length === 2 && value.every(item => typeof item === "number" && Number.isFinite(item));
  if (field.type === "number" || field.type === "integer") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "enum") return typeof value === "string" && (!field.enumValues || field.enumValues.includes(value));
  return false;
}

function validateCondition(condition, path, fields, errors) {
  if (!isObject(condition) || !["all", "any"].includes(condition.mode)) errors.push(issue(`${path}.mode`, "invalid_condition_mode", "Condition mode must be all or any."));
  if (!Array.isArray(condition?.clauses) || !condition.clauses.length) errors.push(issue(`${path}.clauses`, "missing_clauses", "At least one condition clause is required."));
  else condition.clauses.forEach((clause, index) => {
    const clausePath = `${path}.clauses[${index}]`;
    const field = fields.get(clause.field);
    if (!field) { errors.push(issue(`${clausePath}.field`, "unknown_condition_field", `${clause.field || "Field"} is not defined.`)); return; }
    const operators = TYPE_OPERATORS[field.type] || [];
    if (!operators.includes(clause.operator)) errors.push(issue(`${clausePath}.operator`, "invalid_operator", `${clause.operator} is not valid for ${field.type}.`));
    else if (!valueMatchesField(clause.value, field, clause.operator)) errors.push(issue(`${clausePath}.value`, "invalid_condition_value", "Comparison value does not match the selected field."));
  });
  if (!Number.isInteger(condition?.observationCount) || condition.observationCount < 1) errors.push(issue(`${path}.observationCount`, "invalid_observation_count", "Observation count must be a positive integer."));
  if (typeof condition?.minimumSeconds !== "number" || !Number.isFinite(condition.minimumSeconds) || condition.minimumSeconds < 0) errors.push(issue(`${path}.minimumSeconds`, "invalid_minimum_seconds", "Minimum seconds must be zero or greater."));
}

function validateEvents(events, errors, fields, writable) {
  if (!Array.isArray(events)) { errors.push(issue("events", "invalid_events", "Events must be an array.")); return; }
  const ids = new Set();
  const eventNames = new Set();
  events.forEach((event, index) => {
    const path = `events[${index}]`;
    if (!isObject(event) || !ID_PATTERN.test(event.id || "")) errors.push(issue(`${path}.id`, "invalid_event_id", "Event ID is required."));
    else if (ids.has(event.id)) errors.push(issue(`${path}.id`, "duplicate_event_id", "Event IDs must be unique."));
    else ids.add(event.id);
    if (!NAME_PATTERN.test(event.systemName || "")) errors.push(issue(`${path}.systemName`, "invalid_event_name", "Event system name is required."));
    else if (eventNames.has(event.systemName)) errors.push(issue(`${path}.systemName`, "duplicate_event_name", "Event system names must be unique."));
    else eventNames.add(event.systemName);
    if (typeof event.displayName !== "string" || !event.displayName.trim()) errors.push(issue(`${path}.displayName`, "missing_event_name", "Display name is required."));
    if (!["Info", "Yellow", "Red"].includes(event.severity)) errors.push(issue(`${path}.severity`, "invalid_severity", "Severity must be Info, Yellow, or Red."));
    if (typeof event.enabled !== "boolean" || typeof event.latched !== "boolean") errors.push(issue(path, "invalid_event_flags", "Enabled and latched must be true or false."));
    validateCondition(event.open, `${path}.open`, fields, errors);
    validateCondition(event.close, `${path}.close`, fields, errors);
    if (!Array.isArray(event.actions)) errors.push(issue(`${path}.actions`, "invalid_actions", "Actions must be an array."));
    else event.actions.forEach((action, actionIndex) => {
      const actionPath = `${path}.actions[${actionIndex}]`;
      const target = writable.get(action.target);
      if (!target) errors.push(issue(`${actionPath}.target`, "action_target_not_writable", `${action.target || "Target"} is not a writable device field.`));
      else if (!valueMatchesField(action.value, target, "eq")) errors.push(issue(`${actionPath}.value`, "action_value_type", "Action value does not match its target."));
    });
    for (const [name, functions] of [["openFunctions", event.openFunctions], ["closeFunctions", event.closeFunctions]]) {
      if (!Array.isArray(functions) || functions.some(functionName => !EVENT_FUNCTIONS.has(functionName))) errors.push(issue(`${path}.${name}`, "unknown_event_function", "Event functions must be selected from the implemented lifecycle catalog."));
    }
    if (!isObject(event.web) || typeof event.web.notifyOnOpen !== "boolean" || typeof event.web.notifyOnClose !== "boolean") errors.push(issue(`${path}.web`, "invalid_notification_policy", "Open and close notification choices are required."));
    else {
      if (event.web.notifyOnOpen && !event.web.openMessage?.trim()) errors.push(issue(`${path}.web.openMessage`, "missing_open_message", "Open notification message is required."));
      if (event.web.notifyOnClose && !event.web.closeMessage?.trim()) errors.push(issue(`${path}.web.closeMessage`, "missing_close_message", "Close notification message is required."));
    }
  });
}

function validateAndCompile(draft) {
  const errors = [];
  const warnings = [];
  if (!isObject(draft) || draft.schemaVersion !== 1) throw new RulesEngineContractError("invalid_draft", [issue("schemaVersion", "invalid_schema", "Draft schema version 1 is required.")]);
  const names = new Map();
  const writable = new Map();
  validateDevices(draft.devices, errors, names, writable);
  const calculationResult = validateCalculations(draft.calculatedFields, errors, names);
  validateEvents(draft.events, errors, calculationResult.resolved || names, writable);
  draft.events?.forEach((event, index) => {
    if (event.enabled && event.actions?.length) warnings.push(issue(`events[${index}]`, "control_not_delivered", "This pilot compiles the action but does not deliver it to Tab5."));
  });
  if (errors.length) return { valid: false, errors, warnings, runtimePackage: null };
  const runtimePackage = {
    schemaVersion: 1,
    kind: "well-pump-parameter-runtime",
    deliveryEnabled: false,
    eventLifecycle: {
      actionMode: "while_event_active",
      qualification: {
        observationCount: "consecutive",
        minimumSeconds: "continuous",
        countAndTimeBothRequired: true,
        missingValue: "does_not_qualify"
      },
      normalClear: "close_condition_qualified",
      latchedClear: "user_request_then_close_condition_qualified",
      systemOverride: {
        persistent: true,
        suppressesTab5Actions: true,
        continuesEventEvaluation: true,
        continuesLogging: true
      }
    },
    observationLogging: {
      trigger: "any_named_field_policy",
      recordShape: "all_named_fields",
      standardFields: ["observedAtMs", "packageVersion"],
      historicalExtract: "union_names_null_when_absent"
    },
    devices: draft.devices.map(device => ({
      id: device.id, driver: device.driver, address: device.address, enabled: device.enabled,
      fields: device.fields.map(field => ({ systemName: field.systemName, object: field.object, type: field.type, unit: field.unit ?? null, access: field.access, logging: field.logging, ...(field.write ? { write: field.write } : {}) }))
    })),
    calculations: calculationResult.ordered.map(calculation => ({ id: calculation.id, functionId: calculation.functionId, inputs: calculation.inputs, parameters: calculation.parameters, outputs: calculation.outputs.map(output => ({ systemName: output.systemName, type: output.type, unit: output.unit ?? null, ...(output.enumValues ? { enumValues: output.enumValues } : {}), logging: output.logging })) })),
    events: draft.events.map(event => ({
      id: event.id, systemName: event.systemName, displayName: event.displayName, severity: event.severity, enabled: event.enabled,
      open: event.open, close: event.close, latched: event.latched,
      openFunctions: event.openFunctions || [], closeFunctions: event.closeFunctions || [], actions: event.actions
    }))
  };
  return { valid: true, errors, warnings, runtimePackage };
}

module.exports = { RulesEngineContractError, _valueMatchesField: valueMatchesField, validateAndCompile };
