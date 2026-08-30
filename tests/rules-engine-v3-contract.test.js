"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { defaults: v2Defaults } = require("../cloud/netlify/lib/rules-engine-defaults");
const { defaults } = require("../cloud/netlify/lib/rules-engine-v3-defaults");
const { compileV3Release, validateAndCompileV3 } = require("../cloud/netlify/lib/rules-engine-v3-contract");

function codes(result) { return result.errors.map(error => error.code); }

test("V3 defaults preserve installed V2 definitions and define the four reviewed event classes", () => {
  const draft = defaults();
  const v2 = v2Defaults();
  const result = validateAndCompileV3(draft);
  assert.equal(result.valid, true);
  assert.deepEqual(draft.devices, v2.devices);
  assert.deepEqual(draft.calculatedFields, v2.calculatedFields);
  assert.deepEqual(draft.events.map(event => event.id), ["E007", "M001", "H001", "E002"]);
  const highVoltage = draft.events.find(event => event.id === "E007");
  assert.equal(highVoltage.enabled, true);
  assert.deepEqual(highVoltage.opening.trigger.condition, { mode: "all", clauses: [{ field: "SupplyVoltage", operator: "gt", value: 265 }, { field: "ShellyEMAvailable", operator: "eq", value: true }], observationCount: 2, minimumSeconds: 0 });
  assert.deepEqual(highVoltage.closing.condition, { mode: "all", clauses: [{ field: "SupplyVoltage", operator: "lt", value: 265 }, { field: "ShellyEMAvailable", operator: "eq", value: true }], observationCount: 30, minimumSeconds: 0 });
  assert.equal(draft.events.find(event => event.id === "E002").enabled, false);
  assert.deepEqual(draft.events.find(event => event.id === "E002").opening.trigger.condition.clauses, [
    { field: "ContactorFlag", operator: "eq", value: true },
    { field: "PumpEnable", operator: "eq", value: true },
    { field: "PumpWatts", operator: "lt", value: 500 },
    { field: "ShellyEMAvailable", operator: "eq", value: true },
    { field: "Shelly1Available", operator: "eq", value: true }
  ]);
  assert.deepEqual(draft.systemFields.map(field => field.systemName), ["OperatingMode", "OperatorMonitorRequest", "ShellyEMUnavailable"]);
  assert.equal(draft.events.find(event => event.id === "H001").opening.trigger.occurrenceField, "ShellyEMUnavailable");
  assert.equal(draft.events.find(event => event.id === "H001").closing.condition.clauses[0].field, "ShellyEMAvailable");
});

test("V3 release compilation is deterministic and server identity is not part of the editable draft", () => {
  const draft = defaults();
  const first = compileV3Release(draft, "20260830000000-event-v3-v1", 1);
  const second = compileV3Release(draft, "20260830000000-event-v3-v1", 1);
  assert.equal(first.valid, true);
  assert.equal(first.runtimeBody, second.runtimeBody);
  assert.equal(first.runtimePackage.kind, "well-pump-event-runtime-v3");
  assert.equal(first.runtimePackage.releaseId, "20260830000000-event-v3-v1");
  assert.equal(Object.hasOwn(first.runtimePackage, "calculatedFields"), false);
  assert.equal(first.runtimePackage.calculations.length, 3);
  assert.equal(first.runtimePackage.events.some(event => Object.hasOwn(event, "web")), false);
  assert.equal(Object.hasOwn(draft, "releaseId"), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(__dirname, "../contracts/examples/v3/rules-runtime-package.json"), "utf8")), first.runtimePackage);
  assert.ok(Buffer.byteLength(first.runtimeBody, "utf8") < 65536);
});

test("V3 contract rejects invalid system sources, typed assignments, lifecycle policy, ownership, and bounds", () => {
  const badSource = defaults();
  badSource.events.find(event => event.id === "M001").opening.trigger.occurrenceField = "SupplyVoltage";
  assert.ok(codes(validateAndCompileV3(badSource)).includes("invalid_trigger_source"));

  const badType = defaults();
  badType.events.find(event => event.id === "E007").onOpen.assignments[0].value = "false";
  assert.ok(codes(validateAndCompileV3(badType)).includes("assignment_value_type"));

  const badPolicy = defaults();
  badPolicy.events.find(event => event.id === "E002").closing = { policy: "condition", condition: { mode: "all", clauses: [{ field: "PumpWatts", operator: "gte", value: 0 }], observationCount: 1, minimumSeconds: 0 } };
  assert.ok(codes(validateAndCompileV3(badPolicy)).includes("latched_close_policy"));

  const ownership = defaults();
  ownership.events.find(event => event.id === "E002").onOpen.assignments[0].value = true;
  assert.ok(codes(validateAndCompileV3(ownership)).includes("ownership_value_conflict"));

  const monitor = defaults();
  monitor.events.find(event => event.id === "M001").onOpen.assignments = [];
  assert.ok(codes(validateAndCompileV3(monitor)).includes("monitor_ownership_required"));

  const bounds = defaults();
  bounds.events = Array.from({ length: 65 }, (_, index) => ({ ...structuredClone(bounds.events[0]), id: `E${index}`, systemName: `Event${index}` }));
  assert.ok(codes(validateAndCompileV3(bounds)).includes("events_too_large"));

  const summaryBounds = defaults();
  summaryBounds.events[0].summary.aggregates = Array.from({ length: 33 }, (_, index) => ({ source: "SupplyVoltage", operation: "maximum", scale: 1, output: { systemName: `HighVoltageMaximum${index}`, label: `Maximum voltage ${index}`, type: "number", unit: "V", logging: { mode: "none" } } }));
  assert.ok(codes(validateAndCompileV3(summaryBounds)).includes("summary_aggregates_too_large"));
});

test("V3 contract rejects malformed closed shapes and unavailable condition fields", () => {
  const malformed = defaults();
  malformed.systemFields[0].unexpected = true;
  malformed.events[0].opening.trigger.condition.clauses[0].field = "NotAField";
  const result = validateAndCompileV3(malformed);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("invalid_system_field_shape"));
  assert.ok(codes(result).includes("unknown_condition_field"));
  assert.deepEqual(result.warnings, []);
});

test("V3 preserves validated event summaries in runtime bytes and rejects malformed summary rows", () => {
  const draft = defaults();
  const event = draft.events.find(item => item.id === "E007");
  event.summary = {
    durationOutput: { systemName: "HighVoltageDurationSeconds", label: "High voltage duration", type: "number", unit: "s", logging: { mode: "none" } },
    aggregates: [{ source: "SupplyVoltage", operation: "maximum", scale: 1, output: { systemName: "HighVoltageMaximum", label: "Maximum voltage", type: "number", unit: "V", logging: { mode: "none" } } }]
  };
  const valid = compileV3Release(draft, "20260830000000-event-v3-v1", 1);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.runtimePackage.events.find(item => item.id === "E007").summary, event.summary);
  assert.deepEqual(valid.warnings, []);

  const malformed = defaults();
  malformed.events[0].summary.aggregates = [{ source: "ShellyEMAvailable", operation: "average", scale: 1, output: { systemName: "BadSummary", label: "Bad", type: "number", unit: "V", logging: { mode: "none" } } }];
  const result = validateAndCompileV3(malformed);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("summary_source_type"));
  assert.deepEqual(result.warnings, []);
});
