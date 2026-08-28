"use strict";

const { DEVICE_DRIVERS, DRIVER_BINDINGS, FUNCTION_CATALOG, SUMMARY_OPERATIONS, TYPE_OPERATORS } = require("./rules-engine-defaults");

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const TYPES = new Set(["number", "integer", "boolean", "enum", "signal"]);
const NUMERIC_TYPES = new Set(["number", "integer"]);
const LOG_MODES = new Set(["none", "delta", "change", "always"]);
const ACCESS = new Set(["read", "readWrite"]);
const EXPRESSION_LIMIT = 512;
const EXPRESSION_TOKEN_LIMIT = 128;

class RulesEngineContractError extends Error {
  constructor(code, errors = []) { super(code); this.name = "RulesEngineContractError"; this.code = code; this.errors = errors; }
}

function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function issue(path, code, message) { return { path, code, message }; }

function valueMatchesField(value, field, operator) {
  if (operator === "occurs") return value === null || value === undefined;
  if (operator === "between" || operator === "outside") return Array.isArray(value) && value.length === 2 && value.every(item => typeof item === "number" && Number.isFinite(item));
  if (field.type === "number" || field.type === "integer") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "enum") return typeof value === "string" && (!field.enumValues || field.enumValues.includes(value));
  return false;
}

function validateLogging(logging, field, path, errors) {
  if (!isObject(logging) || !LOG_MODES.has(logging.mode)) {
    errors.push(issue(`${path}.logging`, "invalid_logging", "Choose none, delta, change, or always."));
    return;
  }
  if (logging.mode === "delta") {
    if (!NUMERIC_TYPES.has(field.type)) errors.push(issue(`${path}.logging.mode`, "invalid_delta_type", "Delta logging requires a numeric field."));
    if (typeof logging.threshold !== "number" || !Number.isFinite(logging.threshold) || logging.threshold <= 0) errors.push(issue(`${path}.logging.threshold`, "invalid_delta_threshold", "Delta threshold must be greater than zero."));
  }
  if (logging.mode === "change" && field.type === "signal") errors.push(issue(`${path}.logging.mode`, "invalid_signal_logging", "Signals use always or none logging."));
}

function validateField(field, path, errors, names, writable = new Map()) {
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

function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function validateDriverBinding(driver, field, path, errors) {
  if (!Object.hasOwn(DRIVER_BINDINGS, driver) || !isObject(field)) return;
  if (typeof field.object !== "string" || !field.object) {
    errors.push(issue(`${path}.object`, "missing_device_object", "A device object is required."));
    return;
  }
  const binding = DRIVER_BINDINGS[driver][field.object];
  if (!binding) {
    errors.push(issue(`${path}.object`, "unsupported_device_object", `${field.object} is not implemented for ${driver}.`));
    return;
  }
  if (field.type !== binding.type || (field.unit ?? null) !== binding.unit || field.access !== binding.access) {
    errors.push(issue(path, "driver_field_contract_mismatch", `This ${driver} object requires ${binding.type}${binding.unit ? ` (${binding.unit})` : ""} ${binding.access} access.`));
  }
  if (binding.write && (!isObject(field.write) || field.write.method !== binding.write.method || !sameJson(field.write.parameters, binding.write.parameters) || field.write.normalValue !== binding.write.normalValue)) {
    errors.push(issue(`${path}.write`, "driver_write_mapping_mismatch", `${field.object} must use its implemented ${binding.write.method} mapping.`));
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
    else device.fields.forEach((field, fieldIndex) => {
      const fieldPath = `${path}.fields[${fieldIndex}]`;
      validateField(field, fieldPath, errors, names, writable);
      validateDriverBinding(device.driver, field, fieldPath, errors);
    });
  });
}

function tokenizeExpression(expression) {
  if (typeof expression !== "string" || !expression.trim()) throw new Error("Expression is required.");
  if (expression.length > EXPRESSION_LIMIT) throw new Error(`Expression exceeds ${EXPRESSION_LIMIT} characters.`);
  const tokens = [];
  const pattern = /\s*(?:((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)|([A-Za-z][A-Za-z0-9_]*)|([()+\-*/]))/y;
  let position = 0;
  while (position < expression.length) {
    if (/^\s*$/.test(expression.slice(position))) break;
    pattern.lastIndex = position;
    const match = pattern.exec(expression);
    if (!match) throw new Error(`Unsupported expression text at character ${position + 1}.`);
    tokens.push(match[1] ? { kind: "number", value: Number(match[1]) } : match[2] ? { kind: "field", value: match[2] } : { kind: match[3] === "(" || match[3] === ")" ? "paren" : "operator", value: match[3] });
    position = pattern.lastIndex;
    if (tokens.length > EXPRESSION_TOKEN_LIMIT) throw new Error(`Expression exceeds ${EXPRESSION_TOKEN_LIMIT} tokens.`);
  }
  return tokens;
}

function compileExpression(expression) {
  const tokens = tokenizeExpression(expression);
  const output = [];
  const operators = [];
  const dependencies = new Set();
  const precedence = { "+": 1, "-": 1, "*": 2, "/": 2, neg: 3 };
  let expectingOperand = true;
  for (const token of tokens) {
    if (token.kind === "number" || token.kind === "field") {
      if (!expectingOperand) throw new Error("An operator is required between values.");
      output.push([token.kind, token.value]);
      if (token.kind === "field") dependencies.add(token.value);
      expectingOperand = false;
      continue;
    }
    if (token.kind === "paren" && token.value === "(") {
      if (!expectingOperand) throw new Error("An operator is required before '('.");
      operators.push("(");
      expectingOperand = true;
      continue;
    }
    if (token.kind === "paren" && token.value === ")") {
      if (expectingOperand) throw new Error("A value is required before ')'.");
      while (operators.length && operators.at(-1) !== "(") output.push(["operator", operators.pop()]);
      if (operators.pop() !== "(") throw new Error("Parentheses are not balanced.");
      if (operators.at(-1) === "neg") output.push(["operator", operators.pop()]);
      expectingOperand = false;
      continue;
    }
    let operator = token.value;
    if (expectingOperand) {
      if (operator === "+") continue;
      if (operator !== "-") throw new Error(`Operator ${operator} requires a left value.`);
      operator = "neg";
    } else {
      expectingOperand = true;
    }
    while (operators.length && operators.at(-1) !== "(" && (precedence[operators.at(-1)] > precedence[operator] || (operator !== "neg" && precedence[operators.at(-1)] === precedence[operator]))) output.push(["operator", operators.pop()]);
    operators.push(operator);
  }
  if (expectingOperand) throw new Error("Expression ends before a value.");
  while (operators.length) {
    const operator = operators.pop();
    if (operator === "(") throw new Error("Parentheses are not balanced.");
    output.push(["operator", operator]);
  }
  return { dependencies: [...dependencies], program: output };
}

function parameterTypeOk(expected, value) {
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "scalar") return ["string", "number", "boolean"].includes(typeof value) && value !== null;
  return false;
}
function calculationOutputs(calculation) { return calculation.kind === "expression" ? [calculation.output] : calculation.outputs; }

function validateCalculations(calculations, errors, names) {
  if (!Array.isArray(calculations)) { errors.push(issue("calculatedFields", "invalid_calculations", "Calculated fields must be an array.")); return { ordered: [], resolved: new Map(names) }; }
  const ids = new Set();
  const prepared = [];
  calculations.forEach((calculation, index) => {
    const path = `calculatedFields[${index}]`;
    if (!isObject(calculation) || !ID_PATTERN.test(calculation.id || "")) errors.push(issue(`${path}.id`, "invalid_calculation_id", "Calculation ID is required."));
    else if (ids.has(calculation.id)) errors.push(issue(`${path}.id`, "duplicate_calculation_id", "Calculation IDs must be unique."));
    else ids.add(calculation.id);
    if (!["expression", "function"].includes(calculation.kind)) errors.push(issue(`${path}.kind`, "invalid_calculation_kind", "Choose expression or programmed function."));
    const outputs = calculationOutputs(calculation);
    if (!Array.isArray(outputs) || !outputs.length) errors.push(issue(`${path}.outputs`, "missing_outputs", "Calculation must define at least one output."));
    else outputs.forEach((output, outputIndex) => validateField(output, calculation.kind === "expression" ? `${path}.output` : `${path}.outputs[${outputIndex}]`, errors, names));
    let compiled = null;
    if (calculation.kind === "expression") {
      if (calculation.output && !NUMERIC_TYPES.has(calculation.output.type)) errors.push(issue(`${path}.output.type`, "expression_output_type", "Arithmetic expressions require a numeric output."));
      try { compiled = compileExpression(calculation.expression); }
      catch (error) { errors.push(issue(`${path}.expression`, "invalid_expression", error.message)); }
    } else if (calculation.kind === "function") {
      const spec = FUNCTION_CATALOG[calculation.functionId];
      if (!spec) errors.push(issue(`${path}.functionId`, "unknown_function", "Function is not implemented by the Tab5 runtime catalog."));
      else {
        if (outputs?.length !== spec.outputs.length) errors.push(issue(`${path}.outputs`, "wrong_output_count", `${spec.label} requires ${spec.outputs.length} output(s).`));
        outputs?.forEach((output, outputIndex) => {
          const expected = spec.outputs[outputIndex];
          if (expected && (output.type !== expected.type || (output.unit ?? null) !== (expected.unit ?? null))) errors.push(issue(`${path}.outputs[${outputIndex}]`, "output_contract_mismatch", `Output must be ${expected.type}${expected.unit ? ` in ${expected.unit}` : ""}.`));
        });
        for (const [name, type] of Object.entries(spec.parameters)) if (!parameterTypeOk(type, calculation.parameters?.[name])) errors.push(issue(`${path}.parameters.${name}`, "invalid_parameter", `${name} is required and must be ${type}.`));
      }
    }
    prepared.push({ calculation, index, compiled });
  });

  const resolved = new Map([...names.entries()].filter(([, value]) => value.path.startsWith("devices")));
  const pending = [...prepared];
  const ordered = [];
  let progress = true;
  while (pending.length && progress) {
    progress = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index];
      const { calculation, compiled } = item;
      const spec = FUNCTION_CATALOG[calculation.functionId];
      const references = calculation.kind === "expression" ? (compiled?.dependencies || []) : Object.values(calculation.inputs || {});
      if (!references.every(reference => resolved.has(reference))) continue;
      if (calculation.kind === "expression") {
        for (const reference of references) if (!NUMERIC_TYPES.has(resolved.get(reference).type)) errors.push(issue(`calculatedFields[${item.index}].expression`, "expression_input_type", `${reference} is not numeric.`));
      } else if (spec) {
        for (const [inputName, acceptedTypes] of Object.entries(spec.inputs)) {
          const reference = calculation.inputs?.[inputName];
          const source = resolved.get(reference);
          if (!source) errors.push(issue(`calculatedFields[${item.index}].inputs.${inputName}`, "missing_input", `${inputName} must reference an available field.`));
          else if (!acceptedTypes.includes(source.type)) errors.push(issue(`calculatedFields[${item.index}].inputs.${inputName}`, "input_type_mismatch", `${reference} has incompatible type ${source.type}.`));
          else if (spec.inputUnits?.[inputName] && source.unit !== spec.inputUnits[inputName]) errors.push(issue(`calculatedFields[${item.index}].inputs.${inputName}`, "input_unit_mismatch", `${reference} must use ${spec.inputUnits[inputName]}, not ${source.unit || "an unspecified unit"}.`));
        }
      }
      calculationOutputs(calculation)?.forEach(output => resolved.set(output.systemName, { type: output.type, unit: output.unit ?? null, enumValues: output.enumValues || null, path: `calculatedFields[${item.index}]` }));
      ordered.push(item);
      pending.splice(index, 1);
      progress = true;
    }
  }
  pending.forEach(({ calculation, index }) => errors.push(issue(`calculatedFields[${index}]`, "unresolved_calculation", `${calculation.label || calculation.id} has a missing field reference or calculation cycle.`)));
  return { ordered, resolved };
}

function validateQualifier(condition, path, errors) {
  if (!Number.isInteger(condition?.observationCount) || condition.observationCount < 1) errors.push(issue(`${path}.observationCount`, "invalid_observation_count", "Observation count must be a positive integer."));
  if (typeof condition?.minimumSeconds !== "number" || !Number.isFinite(condition.minimumSeconds) || condition.minimumSeconds < 0) errors.push(issue(`${path}.minimumSeconds`, "invalid_minimum_seconds", "Warm-up or cool-off seconds must be zero or greater."));
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
  validateQualifier(condition, path, errors);
}

function validateSummary(summary, path, fields, summaryNames, errors) {
  if (!isObject(summary) || !Array.isArray(summary.aggregates)) { errors.push(issue(path, "invalid_summary", "Event summary must contain an aggregate list.")); return; }
  if (summary.durationOutput !== null) {
    validateField(summary.durationOutput, `${path}.durationOutput`, errors, summaryNames);
    if (summary.durationOutput?.type !== "number" || summary.durationOutput?.unit !== "s") errors.push(issue(`${path}.durationOutput`, "invalid_duration_output", "Duration output must be a number in seconds."));
  }
  summary.aggregates.forEach((aggregate, index) => {
    const aggregatePath = `${path}.aggregates[${index}]`;
    const source = fields.get(aggregate.source);
    if (!source) errors.push(issue(`${aggregatePath}.source`, "unknown_summary_source", `${aggregate.source || "Source"} is not defined.`));
    else if (!NUMERIC_TYPES.has(source.type)) errors.push(issue(`${aggregatePath}.source`, "summary_source_type", "Standard event summaries require numeric source fields."));
    if (!Object.hasOwn(SUMMARY_OPERATIONS, aggregate.operation)) errors.push(issue(`${aggregatePath}.operation`, "invalid_summary_operation", "Unsupported standard event summary operation."));
    if (typeof aggregate.scale !== "number" || !Number.isFinite(aggregate.scale)) errors.push(issue(`${aggregatePath}.scale`, "invalid_summary_scale", "Summary scale must be a finite number."));
    validateField(aggregate.output, `${aggregatePath}.output`, errors, summaryNames);
    if (!NUMERIC_TYPES.has(aggregate.output?.type)) errors.push(issue(`${aggregatePath}.output.type`, "summary_output_type", "Summary output must be numeric."));
  });
}

function validateEvents(events, errors, fields, writable) {
  if (!Array.isArray(events)) { errors.push(issue("events", "invalid_events", "Events must be an array.")); return; }
  const ids = new Set();
  const eventNames = new Set();
  const summaryNames = new Map(fields);
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
    if (!isObject(event.close) || !["openingFalse", "custom"].includes(event.close.basis)) errors.push(issue(`${path}.close.basis`, "invalid_close_basis", "Close must use opening no longer true or a custom condition."));
    else if (event.close.basis === "custom") validateCondition(event.close, `${path}.close`, fields, errors);
    else validateQualifier(event.close, `${path}.close`, errors);
    validateSummary(event.summary, `${path}.summary`, fields, summaryNames, errors);
    if (!Array.isArray(event.actions)) errors.push(issue(`${path}.actions`, "invalid_actions", "Actions must be an array."));
    else event.actions.forEach((action, actionIndex) => {
      const actionPath = `${path}.actions[${actionIndex}]`;
      const target = writable.get(action.target);
      if (!target) errors.push(issue(`${actionPath}.target`, "action_target_not_writable", `${action.target || "Target"} is not a writable device field.`));
      else if (!valueMatchesField(action.value, target, "eq")) errors.push(issue(`${actionPath}.value`, "action_value_type", "Action value does not match its target."));
    });
    if (!isObject(event.web) || typeof event.web.notifyOnOpen !== "boolean" || typeof event.web.notifyOnClose !== "boolean") errors.push(issue(`${path}.web`, "invalid_notification_policy", "Open and close notification choices are required."));
    else {
      if (event.web.notifyOnOpen && !event.web.openMessage?.trim()) errors.push(issue(`${path}.web.openMessage`, "missing_open_message", "Open notification message is required."));
      if (event.web.notifyOnClose && !event.web.closeMessage?.trim()) errors.push(issue(`${path}.web.closeMessage`, "missing_close_message", "Close notification message is required."));
    }
  });
}

function runtimeField(field) {
  return { systemName: field.systemName, type: field.type, unit: field.unit ?? null, ...(field.enumValues ? { enumValues: field.enumValues } : {}), logging: field.logging };
}

function validateAndCompile(draft) {
  const errors = [];
  const warnings = [];
  if (!isObject(draft) || draft.schemaVersion !== 2) throw new RulesEngineContractError("invalid_draft", [issue("schemaVersion", "invalid_schema", "Draft schema version 2 is required.")]);
  const names = new Map();
  const writable = new Map();
  validateDevices(draft.devices, errors, names, writable);
  const calculationResult = validateCalculations(draft.calculatedFields, errors, names);
  validateEvents(draft.events, errors, calculationResult.resolved || names, writable);
  draft.events?.forEach((event, index) => { if (event.enabled && event.actions?.length) warnings.push(issue(`events[${index}]`, "control_not_delivered", "This pilot compiles the consequence but does not deliver it to Tab5.")); });
  if (errors.length) return { valid: false, errors, warnings, runtimePackage: null };

  const runtimePackage = {
    schemaVersion: 2,
    kind: "well-pump-parameter-runtime",
    deliveryEnabled: false,
    eventLifecycle: {
      recordOnOpen: true, recordOnClose: true, actionMode: "while_event_active",
      qualification: { observationCount: "consecutive", minimumSeconds: "continuous", countAndTimeBothRequired: true, missingValue: "does_not_qualify" },
      normalClear: "close_condition_qualified", latchedClear: "user_request_then_close_condition_qualified",
      systemOverride: { persistent: true, suppressesTab5Actions: true, continuesEventEvaluation: true, continuesLogging: true }
    },
    observationLogging: {
      trigger: "any_direct_or_calculated_field_policy", recordShape: "all_named_fields", maxRecordsPerObservation: 1,
      comparisonBaseline: "last_queued_durable_snapshot", baselineAdvancesOnQueueAcceptance: true,
      standardFields: ["observedAtMs", "packageVersion"], historicalExtract: "union_names_null_when_absent"
    },
    devices: draft.devices.map(device => ({
      id: device.id, driver: device.driver, address: device.address, enabled: device.enabled,
      fields: device.fields.map(field => ({ ...runtimeField(field), object: field.object, access: field.access, ...(field.write ? { write: field.write } : {}) }))
    })),
    calculations: calculationResult.ordered.map(({ calculation, compiled }) => calculation.kind === "expression"
      ? { id: calculation.id, kind: "expression", expression: calculation.expression, program: compiled.program, output: runtimeField(calculation.output) }
      : { id: calculation.id, kind: "function", functionId: calculation.functionId, inputs: calculation.inputs, parameters: calculation.parameters, outputs: calculation.outputs.map(runtimeField) }),
    events: draft.events.map(event => ({
      id: event.id, systemName: event.systemName, displayName: event.displayName, severity: event.severity, enabled: event.enabled,
      open: event.open, close: event.close, latched: event.latched, summary: event.summary, actions: event.actions
    }))
  };
  return { valid: true, errors, warnings, runtimePackage };
}

module.exports = { RulesEngineContractError, _compileExpression: compileExpression, _valueMatchesField: valueMatchesField, validateAndCompile };
