"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { RulesEngineV3ContractError, V3_KIND, validateAndCompileV3, validateV3PackageForAdoption } = require("../cloud/netlify/lib/rules-engine-v3-contract");

function fixture() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "../contracts/examples/v3/rules-runtime-package.json"), "utf8"));
}
function codes(result) { return result.errors.map(error => error.code); }
function assertRejectedByCompilerAndAdopter(draft, code) {
  assert.ok(codes(validateAndCompileV3(draft)).includes(code));
  assert.ok(codes(validateV3PackageForAdoption(draft)).includes(code));
}

function guardedNormalAssignmentDraft() {
  const draft = fixture();
  const event = structuredClone(draft.events[2]);
  event.id = "TEST-NORMAL";
  event.systemName = "TestNormalAssignment";
  event.displayName = "Host-only normal assignment";
  event.eventClass = "transient";
  event.onOpen = {
    assignments: [],
    guardedGroups: [{
      guard: { mode: "all", clauses: [{ field: "Shelly1Available", operator: "eq", value: true }] },
      assignments: [{ target: "PumpEnable", value: true, ownership: "transition" }]
    }]
  };
  draft.events = [event];
  return draft;
}

test("V3 fixture compiles deterministically with explicit lifecycle and adoption semantics", () => {
  const first = validateAndCompileV3(fixture());
  const second = validateAndCompileV3(fixture());
  assert.equal(first.valid, true);
  assert.equal(first.runtimePackage.schemaVersion, 3);
  assert.equal(first.runtimePackage.kind, V3_KIND);
  assert.equal(first.runtimePackage.releaseId, "20260830000000-event-v3-v1");
  assert.equal(first.runtimePackage.packageVersion, 1);
  assert.deepEqual(first.runtimePackage.adoption, { legacyPackagePolicy: "reject", runtimeSchemaVersion: 3 });
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.canonicalJson, JSON.stringify(first.runtimePackage));
  assert.equal(validateV3PackageForAdoption(first.runtimePackage).valid, true);
  assert.deepEqual(first.runtimePackage.events.map(event => event.eventClass), ["transient", "latched", "monitor", "monitor", "transient"]);
  assert.equal(first.runtimePackage.events[0].onOpen.assignments[0].ownership, "whileOpen");
  assert.equal(first.runtimePackage.events[1].onOpen.assignments[0].target, "PumpEnable");
  assert.equal(first.runtimePackage.events[3].opening.trigger.type, "manual");
  assert.equal(first.runtimePackage.events[4].closing.policy, "immediate");
});

test("V3 preserves condition structure and rejects invalid field references and typed values", () => {
  const draft = fixture();
  draft.events[0].opening.trigger.condition.clauses[0].field = "NoSuchField";
  draft.events[0].onOpen.assignments[0].value = "false";
  draft.events[0].onClose.assignments.push({ target: "NoWritableField", value: false, ownership: "transition" });
  const result = validateAndCompileV3(draft);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("unknown_condition_field"));
  assert.ok(codes(result).includes("action_value_type"));
  assert.ok(codes(result).includes("action_target_not_writable"));
});

test("V3 guards are bounded frozen-snapshot predicates and use typed field comparisons", () => {
  const draft = guardedNormalAssignmentDraft();
  draft.events[0].onOpen.guardedGroups[0].guard.clauses[0].operator = "gt";
  const result = validateAndCompileV3(draft);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("invalid_operator"));
  const qualifiedGuard = guardedNormalAssignmentDraft();
  qualifiedGuard.events[0].onOpen.guardedGroups[0].guard.observationCount = 1;
  assert.ok(codes(validateAndCompileV3(qualifiedGuard)).includes("invalid_condition_shape"));
});

test("V3 represents guarded type-correct normal values when no held target conflicts", () => {
  const result = validateAndCompileV3(guardedNormalAssignmentDraft());
  assert.equal(result.valid, true);
  assert.equal(result.runtimePackage.events[0].onOpen.guardedGroups[0].assignments[0].value, true);
});

test("V3 rejects unsupported class and close-policy combinations", () => {
  const draft = fixture();
  draft.events[0].closing = { policy: "clearEvents" };
  draft.events[1].closing = { policy: "condition", condition: structuredClone(draft.events[0].opening.trigger.condition) };
  draft.events[4].opening.trigger.type = "condition";
  draft.events[4].opening.trigger.condition = structuredClone(draft.events[0].opening.trigger.condition);
  delete draft.events[4].opening.trigger.occurrence;
  delete draft.events[4].opening.trigger.qualification;
  const result = validateAndCompileV3(draft);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("transient_close_policy"));
  assert.ok(codes(result).includes("latched_close_policy"));
  assert.ok(codes(result).includes("immediate_condition_event"));
});

test("V3 ownership is target-specific and rejects incompatible held values or explicit release writes", () => {
  const draft = fixture();
  draft.events[1].onOpen.assignments[0].value = true;
  draft.events[0].onClose.assignments.push({ target: "PumpEnable", value: false, ownership: "transition" });
  const result = validateAndCompileV3(draft);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("ownership_value_conflict"));
  assert.ok(codes(result).includes("close_assignment_conflicts_with_ownership"));
});

test("V3 compiler and adopter reject closed nested base shapes", () => {
  const nullDevice = fixture();
  nullDevice.devices = [null];
  assertRejectedByCompilerAndAdopter(nullDevice, "invalid_device_shape");
  const malformedDevice = fixture();
  malformedDevice.devices = [{}];
  assertRejectedByCompilerAndAdopter(malformedDevice, "missing_device_property");
  const nullCalculation = fixture();
  nullCalculation.calculatedFields = [null];
  assertRejectedByCompilerAndAdopter(nullCalculation, "invalid_calculation_shape");
  const malformedCalculation = fixture();
  malformedCalculation.calculatedFields = [{}];
  assertRejectedByCompilerAndAdopter(malformedCalculation, "invalid_calculation_shape");
  const extraDevice = fixture();
  extraDevice.devices[0].unexpected = true;
  assertRejectedByCompilerAndAdopter(extraDevice, "invalid_device_shape");
  const extraField = fixture();
  extraField.devices[0].fields[0].unexpected = true;
  assertRejectedByCompilerAndAdopter(extraField, "invalid_direct_field_shape");
  const extraWriteMapping = fixture();
  extraWriteMapping.devices[1].fields[0].write.unexpected = true;
  assertRejectedByCompilerAndAdopter(extraWriteMapping, "invalid_write_shape");
  const extraWrite = fixture();
  extraWrite.devices[1].fields[0].write.parameters.unexpected = true;
  assertRejectedByCompilerAndAdopter(extraWrite, "invalid_write_parameters_shape");
  const extraCalculation = fixture();
  extraCalculation.calculatedFields = [{ id: "calc-test", label: "Test calculation", kind: "expression", expression: "PumpWatts", output: { systemName: "CalculatedWatts", label: "Calculated watts", type: "number", unit: "W", logging: { mode: "none" } }, unexpected: true }];
  assertRejectedByCompilerAndAdopter(extraCalculation, "invalid_calculation_shape");
  const badProgramToken = fixture();
  badProgramToken.calculatedFields = [{ id: "calc-test", label: "Test calculation", kind: "expression", expression: "PumpWatts", output: { systemName: "CalculatedWatts", label: "Calculated watts", type: "number", unit: "W", logging: { mode: "none" } }, program: [["number", "not-a-number"]] }];
  assertRejectedByCompilerAndAdopter(badProgramToken, "invalid_expression_program_token");
});

test("V3 rejects unbounded event, condition, group, and phase structures", () => {
  const draft = fixture();
  draft.events[0].opening.trigger.condition.clauses = Array.from({ length: 17 }, () => ({ field: "SupplyVoltage", operator: "gt", value: 265 }));
  draft.events[0].onOpen.guardedGroups = Array.from({ length: 17 }, () => ({ guard: { mode: "all", clauses: [{ field: "Shelly1Available", operator: "eq", value: true }] }, assignments: [{ target: "PumpEnable", value: false, ownership: "whileOpen" }] }));
  draft.events[0].onClose.assignments = Array.from({ length: 33 }, () => ({ target: "PumpEnable", value: false, ownership: "transition" }));
  draft.events = Array.from({ length: 65 }, (_, index) => ({ ...structuredClone(draft.events[0]), id: `E${String(index).padStart(3, "0")}`, systemName: `Event${index}` }));
  const result = validateAndCompileV3(draft);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("events_too_large"));
  assert.ok(codes(result).includes("condition_too_large"));
  assert.ok(codes(result).includes("phase_too_large"));
});

test("V3 bounds devices, calculations, and canonical package bytes", () => {
  const tooManyDevices = fixture();
  tooManyDevices.devices = Array.from({ length: 17 }, (_, index) => ({ ...structuredClone(tooManyDevices.devices[0]), id: `em-${index}` }));
  assert.ok(codes(validateAndCompileV3(tooManyDevices)).includes("devices_too_large"));
  const tooManyCalculations = fixture();
  tooManyCalculations.calculatedFields = Array.from({ length: 65 }, (_, index) => ({ id: `calc-${index}`, label: `Calc ${index}`, kind: "expression", expression: "PumpWatts", output: { systemName: `Calculated${index}`, label: `Calculated ${index}`, type: "number", unit: "W", logging: { mode: "none" } } }));
  assert.ok(codes(validateAndCompileV3(tooManyCalculations)).includes("calculations_too_large"));
  const tooLarge = fixture();
  const repeatedFields = Array.from({ length: 32 }, (_, fieldIndex) => ({ ...structuredClone(fixture().devices[0].fields[0]), systemName: `Watts${fieldIndex}`, label: `Pump watts ${fieldIndex}` }));
  tooLarge.devices = [fixture().devices[0], fixture().devices[1], ...Array.from({ length: 14 }, (_, deviceIndex) => ({ ...structuredClone(fixture().devices[0]), id: `em-${deviceIndex}`, fields: repeatedFields.map((field, fieldIndex) => ({ ...field, systemName: `Watts${deviceIndex}_${fieldIndex}` })) }))];
  assert.ok(codes(validateAndCompileV3(tooLarge)).includes("package_too_large"));
});

test("V3 adoption never reinterprets V2 bytes", () => {
  assert.throws(
    () => validateV3PackageForAdoption({ schemaVersion: 2, kind: "well-pump-parameter-runtime" }),
    error => error instanceof RulesEngineV3ContractError && error.code === "unsupported_package_version" && error.errors[0].code === "v2_requires_v2_adopter"
  );
  const missingIdentity = fixture();
  delete missingIdentity.releaseId;
  assert.ok(codes(validateV3PackageForAdoption(missingIdentity)).includes("invalid_release_id"));
  const valid = validateV3PackageForAdoption(fixture());
  assert.equal(valid.valid, true);
});
