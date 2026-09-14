"use strict";

// Pilot-side regressions for the Tab5IsLocked unit: what may be authored, what
// the runtime-support gate refuses, and what the static analysis now reports.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const { defaults } = require(path.join(root, "cloud/netlify/lib/rules-engine-v3-defaults"));
const { validateAndCompileV3 } = require(path.join(root, "cloud/netlify/lib/rules-engine-v3-contract"));
const { defaults: v2Defaults, DRIVER_BINDINGS } = require(path.join(root, "cloud/netlify/lib/rules-engine-defaults"));
const analysis = require(path.join(root, "web", "rules-engine-analysis.js"));

const INHIBITION_OBJECT = "UDF(Tab5IsLocked)";

function codes(result) { return (result.errors || []).map(error => error.code); }
function inhibitionField(draft) {
  return draft.devices
    .flatMap(device => device.fields)
    .find(field => field.object === INHIBITION_OBJECT);
}

test("the shipped defaults author exactly one device write, on the inhibition flag", () => {
  const draft = defaults();
  const writable = draft.devices.flatMap(d => d.fields).filter(f => f.access === "readWrite");
  assert.equal(writable.length, 1);
  assert.equal(writable[0].object, INHIBITION_OBJECT);
  assert.deepEqual(writable[0].write, {
    method: "Boolean.Set",
    parameters: { valueParameter: "value" },
    normalValue: false
  });
  assert.equal(validateAndCompileV3(draft).valid, true);
});

test("RLY(0) is observed and cannot be made writable again", () => {
  assert.equal(DRIVER_BINDINGS["shelly-gen4-switch"]["RLY(0)"].access, "read");
  assert.equal(DRIVER_BINDINGS["shelly-gen4-switch"]["RLY(0)"].write, undefined);
  const draft = defaults();
  const relay = draft.devices.flatMap(d => d.fields).find(f => f.object === "RLY(0)");
  relay.access = "readWrite";
  relay.write = { method: "Switch.Set", parameters: { id: 0, valueParameter: "on" }, normalValue: true };
  const result = validateAndCompileV3(draft);
  assert.equal(result.valid, false);
  assert.ok(codes(result).some(code => code.endsWith("driver_field_contract_mismatch") || code === "tab5_unsupported"),
    `unexpected codes: ${codes(result).join(", ")}`);
});

test("the inhibition write shape is exact", () => {
  for (const write of [
    { method: "Switch.Set", parameters: { id: 0, valueParameter: "on" }, normalValue: false },
    { method: "Boolean.Set", parameters: { id: 0, valueParameter: "value" }, normalValue: false },
    { method: "Boolean.Set", parameters: { valueParameter: "on" }, normalValue: false },
    { method: "Boolean.Set", parameters: { valueParameter: "value" }, normalValue: true }
  ]) {
    const draft = defaults();
    inhibitionField(draft).write = write;
    assert.equal(validateAndCompileV3(draft).valid, false, JSON.stringify(write));
  }
});

test("only a held opening request may set the inhibition flag", () => {
  const legal = { target: "Tab5IsLocked", value: true, ownership: "whileOpen" };
  const base = defaults();
  assert.equal(validateAndCompileV3(base).valid, true);

  const illegal = [
    ["onOpen", { target: "Tab5IsLocked", value: true, ownership: "transition" }],
    ["onOpen", { target: "Tab5IsLocked", value: false, ownership: "whileOpen" }],
    ["onOpen", { target: "Tab5IsLocked", value: false, ownership: "transition" }],
    ["onClose", { target: "Tab5IsLocked", value: true, ownership: "transition" }],
    ["onClose", { target: "Tab5IsLocked", value: false, ownership: "transition" }]
  ];
  for (const [phase, assignment] of illegal) {
    for (const guarded of [false, true]) {
      const draft = defaults();
      const event = draft.events.find(e => e.id === "E007");
      event.onOpen = { assignments: [], guardedGroups: [] };
      event.onClose = { assignments: [], guardedGroups: [] };
      if (guarded) {
        event[phase].guardedGroups = [{
          guard: { mode: "all", clauses: [{ field: "ShellyEMAvailable", operator: "eq", value: true }] },
          assignments: [assignment]
        }];
      } else {
        event[phase].assignments = [assignment];
      }
      const result = validateAndCompileV3(draft);
      assert.equal(result.valid, false, `${phase} ${JSON.stringify(assignment)} guarded=${guarded}`);
    }
  }

  // The legal form still passes inside a guarded group.
  const guardedLegal = defaults();
  const event = guardedLegal.events.find(e => e.id === "E007");
  event.onOpen = {
    assignments: [],
    guardedGroups: [{
      guard: { mode: "all", clauses: [{ field: "ShellyEMAvailable", operator: "eq", value: true }] },
      assignments: [legal]
    }]
  };
  assert.equal(validateAndCompileV3(guardedLegal).valid, true);
});

test("an alias cannot create a second writer for one physical component", () => {
  const draft = defaults();
  const device = draft.devices.find(d => d.driver === "shelly-gen4-switch");
  const alias = JSON.parse(JSON.stringify(inhibitionField(draft)));
  alias.systemName = "Tab5Inhibit";
  alias.label = "Tab5 inhibition (alias)";
  device.fields.push(alias);
  assert.equal(validateAndCompileV3(draft).valid, false);
});

test("the target is recognised by binding even when the owner renames it", () => {
  const draft = defaults();
  const field = inhibitionField(draft);
  field.systemName = "WellInhibit";
  for (const event of draft.events) {
    for (const assignment of event.onOpen.assignments) {
      if (assignment.target === "Tab5IsLocked") assignment.target = "WellInhibit";
    }
  }
  assert.equal(validateAndCompileV3(draft).valid, true);
  assert.equal(analysis.analysisInhibitionTarget(draft), "WellInhibit");
});

test("H001 opens on a condition the device can evaluate", () => {
  const h001 = defaults().events.find(event => event.id === "H001");
  assert.equal(h001.opening.trigger.type, "condition");
  assert.deepEqual(h001.opening.trigger.condition.clauses,
    [{ field: "ShellyEMAvailable", operator: "eq", value: false }]);
  assert.deepEqual(h001.onOpen.assignments,
    [{ target: "OperatingMode", value: "Monitor", ownership: "whileOpen" }]);
});

test("the revised closing condition removes the evidence-loss finding", () => {
  // The legacy package could only close E007 by reading SupplyVoltage, so losing
  // the EM stranded the inhibit. The analysis reported that as an error.
  const legacy = JSON.parse(fs.readFileSync(
    path.join(root, "tests", "fixtures", "rules-authoring-backup-2026-09-14.json"), "utf8"));
  const before = analysis.analyzeAuthoringPackage(legacy);
  const stranded = before.findings.find(f => f.code === "analysis_inhibit_evidence_loss");
  assert.ok(stranded, "the legacy package strands its inhibit");
  assert.equal(stranded.level, "error");

  // The revised package adds a definite clause that decides without the EM.
  const revised = { ...legacy, authoringPackage: defaults() };
  const after = analysis.analyzeAuthoringPackage(revised);
  assert.equal(after.findings.find(f => f.code === "analysis_inhibit_evidence_loss"), undefined,
    "the any-condition closes on the availability clause alone");
});

test("the analysis still reports a package that holds the flag with no escape", () => {
  const draft = defaults();
  // Force E007 back to a closing condition that needs the vanished evidence.
  draft.events.find(e => e.id === "E007").closing = {
    policy: "condition",
    condition: {
      mode: "all",
      clauses: [{ field: "SupplyVoltage", operator: "lte", value: 266 }],
      observationCount: 10,
      minimumSeconds: 0
    }
  };
  const result = analysis.analyzeAuthoringPackage({ authoringPackage: draft });
  const finding = result.findings.find(f => f.code === "analysis_inhibit_evidence_loss");
  assert.ok(finding, "the analyzer still recognises the shape it is meant to catch");
  assert.match(finding.message, /Tab5IsLocked/);
});

test("a package with no enabled inhibit is still reported", () => {
  const draft = defaults();
  for (const event of draft.events) event.enabled = false;
  const result = analysis.analyzeAuthoringPackage({ authoringPackage: draft });
  const finding = result.findings.find(f => f.code === "analysis_no_pump_inhibit");
  assert.ok(finding);
  assert.match(finding.message, /Tab5IsLocked/);
});

test("V2 authoring keeps a coherent writable target", () => {
  // The V2 line is superseded and not executed, but its defaults must still
  // compile against the same device catalog.
  const v2 = v2Defaults();
  const writable = v2.devices.flatMap(d => d.fields).filter(f => f.access === "readWrite");
  assert.equal(writable.length, 1);
  assert.equal(writable[0].object, INHIBITION_OBJECT);
  for (const rule of v2.rules || []) {
    for (const action of rule.actions || []) {
      assert.equal(action.target, writable[0].systemName);
    }
  }
});
