"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const analysis = require(path.join(root, "web", "rules-engine-analysis.js"));
const { analyzeAuthoringPackage, analysisUnsatisfiable, analysisFieldIndex } = analysis;

const backup = JSON.parse(fs.readFileSync(
  path.join(root, "tests", "fixtures", "rules-authoring-backup-2026-09-14.json"), "utf8"));

function codes(result) { return result.findings.map(item => item.code); }
function find(result, code) { return result.findings.find(item => item.code === code); }

test("the shipped package holds the pump off behind evidence that can vanish", () => {
  const result = analyzeAuthoringPackage(backup);
  const finding = find(result, "analysis_inhibit_evidence_loss");
  assert.ok(finding, "E007 can only close by reading SupplyVoltage from the EM");
  assert.equal(finding.level, "error");
  assert.match(finding.message, /E007/);
  assert.match(finding.message, /SupplyVoltage/);
});

test("an availability guard in a closing condition is reported as inert", () => {
  const result = analyzeAuthoringPackage(backup);
  const finding = find(result, "analysis_inert_availability_clause");
  assert.ok(finding, "ShellyEMAvailable cannot rescue a close that also reads SupplyVoltage");
  assert.match(finding.message, /has no effect/);
  // Removing the guard must not make the finding go away: it is the measured
  // field that freezes the condition, not the guard.
  const stripped = JSON.parse(JSON.stringify(backup));
  const event = stripped.authoringPackage.events.find(item => item.id === "E007");
  event.closing.condition.clauses = event.closing.condition.clauses
    .filter(clause => clause.field !== "ShellyEMAvailable");
  const after = analyzeAuthoringPackage(stripped);
  assert.equal(find(after, "analysis_inert_availability_clause"), undefined);
  assert.equal(find(after, "analysis_inhibit_evidence_loss").level, "error");
});

test("a condition reading a disabled device can never be decided", () => {
  const pkg = JSON.parse(JSON.stringify(backup));
  pkg.authoringPackage.devices.find(item => item.id === "shelly-em-main").enabled = false;
  const result = analyzeAuthoringPackage(pkg);
  const present = codes(result);
  assert.ok(present.includes("analysis_opening_disabled_device"));
  assert.ok(present.includes("analysis_closing_disabled_device"));
});

test("a disabled inhibit is reported one level down rather than not at all", () => {
  const result = analyzeAuthoringPackage(backup);
  const finding = result.findings.find(item =>
    item.code === "analysis_inhibit_until_restart" && /E002/.test(item.message));
  assert.ok(finding, "E002 closes on clearEvents and holds PumpEnable off");
  assert.equal(finding.level, "warning");
  assert.match(finding.message, /latent until it is enabled/);
});

test("every hardware hold is listed with the way it lets go", () => {
  const { holds } = analyzeAuthoringPackage(backup);
  const byEvent = Object.fromEntries(holds.map(hold => [hold.eventId, hold]));
  assert.equal(byEvent.E007.target, "PumpEnable");
  assert.equal(byEvent.E007.escape.kind, "condition");
  assert.equal(byEvent.E002.escape.kind, "restart");
  assert.equal(byEvent.M001.escape.kind, "restart");
  assert.equal(byEvent.E002.enabled, false);
});

test("a Monitor event opened without a person is flagged", () => {
  const result = analyzeAuthoringPackage(backup);
  const finding = find(result, "analysis_monitor_not_manual");
  assert.ok(finding);
  assert.match(finding.message, /H001/);
  assert.equal(find(result, "analysis_monitor_terminal").message.includes("M001"), true);
});

test("contradictory numeric clauses are caught and consistent ones are not", () => {
  const fields = new Map([["V", { type: "number" }], ["B", { type: "boolean" }]]);
  const all = clauses => ({ mode: "all", clauses });
  assert.ok(analysisUnsatisfiable(all([
    { field: "V", operator: "gt", value: 266 },
    { field: "V", operator: "lt", value: 200 }]), fields));
  assert.ok(analysisUnsatisfiable(all([
    { field: "V", operator: "gt", value: 266 },
    { field: "V", operator: "lte", value: 266 }]), fields));
  assert.ok(analysisUnsatisfiable(all([
    { field: "B", operator: "eq", value: true },
    { field: "B", operator: "eq", value: false }]), fields));
  assert.ok(analysisUnsatisfiable(all([
    { field: "B", operator: "eq", value: true },
    { field: "B", operator: "neq", value: true }]), fields));
  assert.equal(analysisUnsatisfiable(all([
    { field: "V", operator: "gte", value: 40 },
    { field: "V", operator: "lte", value: 60 }]), fields), null);
  // The real E007 pair is complementary across open and close, not contradictory.
  assert.equal(analysisUnsatisfiable(all([
    { field: "V", operator: "lte", value: 266 },
    { field: "B", operator: "eq", value: true }]), fields), null);
});

test("an event that can never close is reported as holding until restart", () => {
  const pkg = JSON.parse(JSON.stringify(backup));
  const event = pkg.authoringPackage.events.find(item => item.id === "E007");
  event.closing.condition.clauses.push({ field: "SupplyVoltage", operator: "gt", value: 300 });
  const result = analyzeAuthoringPackage(pkg);
  const finding = find(result, "analysis_closing_unsatisfiable");
  assert.ok(finding);
  assert.equal(finding.level, "error");
  assert.match(finding.message, /can never close/);
});

test("counter fields are understood even though the editor cannot author them yet", () => {
  const pkg = JSON.parse(JSON.stringify(backup));
  pkg.authoringPackage.systemFields.push({
    id: "system-lock-hold", systemName: "Tab5LockHold", label: "Tab5 lock hold",
    source: "session", runtimeRole: "counter", type: "integer", unit: "cycles",
    initialValue: 0, maxValue: 60, logging: { mode: "change" }, assignmentTarget: true
  });
  const event = pkg.authoringPackage.events.find(item => item.id === "E007");
  event.onOpen.assignments.push({ target: "Tab5LockHold", value: 30, ownership: "whileOpen" });
  const index = analysisFieldIndex(pkg.authoringPackage);
  assert.equal(index.get("Tab5LockHold").role, "counter");
  const result = analyzeAuthoringPackage(pkg);
  assert.ok(!codes(result).includes("analysis_counter_overflow"));
  const held = find(result, "analysis_counter_while_open");
  assert.ok(held, "a whileOpen counter preset should explain its self-releasing behaviour");
  assert.match(held.message, /run down/);
  // A counter is not a hardware hold, so it must not appear in the holds table.
  assert.equal(result.holds.some(hold => hold.target === "Tab5LockHold"), false);
});

test("counter presets are checked against the declared ceiling and shape", () => {
  const pkg = JSON.parse(JSON.stringify(backup));
  pkg.authoringPackage.systemFields.push({
    id: "system-bad-counter", systemName: "BadHold", label: "Bad hold",
    source: "session", runtimeRole: "counter", type: "number", unit: "cycles",
    initialValue: 5, maxValue: 10, logging: { mode: "none" }, assignmentTarget: true
  });
  const event = pkg.authoringPackage.events.find(item => item.id === "E007");
  event.onOpen.assignments.push({ target: "BadHold", value: 99, ownership: "transition" });
  const result = analyzeAuthoringPackage(pkg);
  const present = codes(result);
  for (const code of ["analysis_counter_initial", "analysis_counter_type", "analysis_counter_overflow"]) {
    assert.ok(present.includes(code), `expected ${code}`);
  }
});

test("a package with no enabled inhibit says so plainly", () => {
  const pkg = JSON.parse(JSON.stringify(backup));
  for (const event of pkg.authoringPackage.events) event.enabled = false;
  const result = analyzeAuthoringPackage(pkg);
  assert.ok(codes(result).includes("analysis_no_pump_inhibit"));
});

test("unknown fields and non-writable targets are refused", () => {
  const pkg = JSON.parse(JSON.stringify(backup));
  const event = pkg.authoringPackage.events.find(item => item.id === "E007");
  event.opening.trigger.condition.clauses.push({ field: "NoSuchField", operator: "eq", value: 1 });
  event.onOpen.assignments.push({ target: "SupplyVoltage", value: 1, ownership: "transition" });
  const result = analyzeAuthoringPackage(pkg);
  const present = codes(result);
  assert.ok(present.includes("analysis_unknown_field"));
  assert.ok(present.includes("analysis_target_not_writable"));
});

test("the browser wiring exposes the tile and never blocks on the server", () => {
  const html = fs.readFileSync(path.join(root, "web", "rules-engine.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "web", "rules-engine.js"), "utf8");
  assert.match(html, /id="engine-analyze"/);
  assert.match(html, /id="analysis-panel"/);
  assert.match(html, /rules-engine-analysis\.js/);
  assert.match(source, /function runAnalysis/);
  assert.match(source, /analyzeAuthoringPackage\(authoringDraft\(\)\)/);
  // Analysis must not call the API: it has to work on a draft validation rejects.
  const body = source.slice(source.indexOf("function runAnalysis"), source.indexOf("function syncButtons"));
  assert.doesNotMatch(body, /\bapi\(/);
});

test("analysis states its own limits rather than implying proof", () => {
  const { limits } = analyzeAuthoringPackage(backup);
  assert.ok(limits.length >= 4);
  assert.ok(limits.some(text => /not proof/i.test(text)));
});
