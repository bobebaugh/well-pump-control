"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { defaults } = require("../cloud/netlify/lib/rules-engine-defaults");
const { validateAndCompile } = require("../cloud/netlify/lib/rules-engine-contract");

test("default authoring model compiles into a bounded Tab5-facing package", () => {
  const result = validateAndCompile(defaults());
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.runtimePackage.devices.length, 3);
  assert.equal(result.runtimePackage.events.length, 8);
  assert.equal(result.runtimePackage.events.every(event => event.web === undefined), true);
  assert.equal(result.runtimePackage.eventLifecycle.actionMode, "while_event_active");
  assert.equal(result.runtimePackage.eventLifecycle.qualification.observationCount, "consecutive");
  assert.equal(result.runtimePackage.eventLifecycle.systemOverride.continuesLogging, true);
  assert.equal(result.runtimePackage.observationLogging.recordShape, "all_named_fields");
  assert.equal(result.runtimePackage.devices[1].fields.find(field => field.systemName === "PumpEnable").write.normalValue, true);
  const order = result.runtimePackage.calculations.map(calculation => calculation.id);
  assert.ok(order.indexOf("calc-pressure") < order.indexOf("calc-tank"));
  assert.ok(order.indexOf("calc-pump-state") < order.indexOf("calc-pump-runtime"));
  assert.ok(Buffer.byteLength(JSON.stringify(result.runtimePackage), "utf8") < 65536);
});

test("validation rejects missing references and calculation cycles", () => {
  const draft = defaults();
  draft.calculatedFields[0].inputs.power = "MissingPower";
  draft.calculatedFields[1].inputs.state = "PumpRuntimeSeconds";
  const result = validateAndCompile(draft);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "unresolved_calculation"));
  assert.ok(result.errors.some(error => error.path.includes("calculatedFields")));
});

test("programmed functions reject unit-incompatible inputs", () => {
  const draft = defaults();
  draft.calculatedFields.find(calculation => calculation.functionId === "boyle_tank").inputs.pressure = "PumpWatts";
  const result = validateAndCompile(draft);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "input_unit_mismatch"));
});

test("validation rejects incompatible actions, operators, and observation counts", () => {
  const draft = defaults();
  draft.events[0].actions = [{ target: "SupplyVoltage", value: false }];
  draft.events[1].open.clauses[0] = { field: "ContactorFlag", operator: "gt", value: 1 };
  draft.events[2].close.observationCount = 0;
  const result = validateAndCompile(draft);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "action_target_not_writable"));
  assert.ok(result.errors.some(error => error.code === "invalid_operator"));
  assert.ok(result.errors.some(error => error.code === "invalid_observation_count"));
});

test("validation keeps notification policy web-side and requires selected messages", () => {
  const draft = defaults();
  draft.events[0].web.notifyOnOpen = true;
  draft.events[0].web.openMessage = "";
  const result = validateAndCompile(draft);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "missing_open_message"));
});

test("device system names are the external identity and cannot be reused", () => {
  const draft = defaults();
  draft.devices[1].fields[0].systemName = "PumpWatts";
  const result = validateAndCompile(draft);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "duplicate_system_name"));
});

test("writable fields require a complete device command and normal value", () => {
  const draft = defaults();
  const pumpEnable = draft.devices[1].fields[0];
  pumpEnable.write.parameters = "not json";
  pumpEnable.write.normalValue = "ON";
  const result = validateAndCompile(draft);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === "invalid_write_parameters"));
  assert.ok(result.errors.some(error => error.code === "invalid_normal_value"));
});
