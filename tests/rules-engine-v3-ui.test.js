"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "rules-engine.html"), "utf8");
const source = fs.readFileSync(path.join(root, "web", "rules-engine.js"), "utf8");

test("Rules Engine browser is explicitly routed to the isolated V3 endpoint", () => {
  assert.match(source, /rules-engine\$\{query\}\$\{separator\}version=3/);
  assert.match(source, /authoring\?\.schemaVersion === 3/);
  assert.match(source, /action: "restore"/);
  assert.match(source, /action: "publish"/);
  assert.match(html, /Event V3 Checkpoint 1 — nondeploying package work/);
});

test("Rules Engine presents all schema-3 authoring sections and lifecycle controls", () => {
  for (const needle of ['data-section="devices"', 'data-section="calculatedFields"', 'data-section="systemFields"', 'data-section="events"']) {
    assert.ok(html.includes(needle), `missing V3 authoring section ${needle}`);
  }
  for (const needle of [
    'id="sf-source"', 'id="sf-type"', 'id="sf-initial"', 'id="sf-enum"', 'id="sf-assignment"', 'id="sf-log"', 'id="v3-class"', 'id="v3-trigger"', 'id="v3-close-policy"',
    'data-v3-add-clause', 'data-v3-add-assignment', 'data-v3-add-group', 'data-v3-remove-group',
    'id="add-summary-row"', 'id="notify-open"', 'id="notify-close"'
  ]) assert.ok(source.includes(needle), `missing V3 editor control ${needle}`);
  assert.match(source, /normalizeSystemFieldSource/);
  assert.match(source, /normalizeWorkingFieldType/);
  assert.match(source, /runtimeRole: "working"/);
  assert.match(source, /Working fields are session\/RAM state, not device telemetry/);
  assert.match(source, /runtimeRole: "occurrence", type: "signal"/);
});

test("Rules Engine browser has no delivery control or delivery request path", () => {
  assert.doesNotMatch(html, /engine-deliver|>Deliver(?: package)?</i);
  assert.doesNotMatch(source, /engine-deliver|deliverPackage|action:\s*["']deliver["']/);
  assert.match(source, /no delivery path in Checkpoint 1/);
});

test("working-field editor transitions preserve the old form shape and normalize the new model", () => {
  const extract = (name, next) => {
    const start = source.indexOf(`function ${name}`);
    const end = source.indexOf(`function ${next}`, start);
    assert.ok(start >= 0 && end > start, `could not isolate ${name}`);
    return source.slice(start, end);
  };
  const model = vm.runInNewContext(`${extract("workingFieldWithType", "normalizeWorkingFieldType")}${extract("systemFieldWithLogging", "normalizeSystemFieldLogging")}; ({ workingFieldWithType, systemFieldWithLogging })`);
  const boolean = { id: "working", systemName: "Working", label: "Working", source: "session", runtimeRole: "working", type: "boolean", unit: null, initialValue: false, logging: { mode: "none" }, assignmentTarget: true };
  assert.deepEqual(JSON.parse(JSON.stringify(model.workingFieldWithType(boolean, "enum"))), { ...boolean, type: "enum", enumValues: ["ChoiceA", "ChoiceB"], initialValue: "ChoiceA" });
  assert.deepEqual(JSON.parse(JSON.stringify(model.systemFieldWithLogging(boolean, "delta").logging)), { mode: "delta", threshold: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(model.systemFieldWithLogging({ ...boolean, logging: { mode: "delta", threshold: 2.5 } }, "delta").logging)), { mode: "delta", threshold: 2.5 });
  assert.match(source, /event\.target\.value = state\.draft\.systemFields\[state\.selected\.systemFields\]\.type;/);
  assert.match(source, /normalizeSystemFieldLogging/);
});
