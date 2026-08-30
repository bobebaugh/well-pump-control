"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

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
    'id="sf-source"', 'id="v3-class"', 'id="v3-trigger"', 'id="v3-close-policy"',
    'data-v3-add-clause', 'data-v3-add-assignment', 'data-v3-add-group', 'data-v3-remove-group',
    'id="add-summary-row"', 'id="notify-open"', 'id="notify-close"'
  ]) assert.ok(source.includes(needle), `missing V3 editor control ${needle}`);
  assert.match(source, /normalizeSystemFieldSource/);
  assert.match(source, /state\.draft\.systemFields\[index\] = source === "session"/);
  assert.match(source, /runtimeRole: "occurrence", type: "signal"/);
});

test("Rules Engine browser has no delivery control or delivery request path", () => {
  assert.doesNotMatch(html, /engine-deliver|>Deliver(?: package)?</i);
  assert.doesNotMatch(source, /engine-deliver|deliverPackage|action:\s*["']deliver["']/);
  assert.match(source, /no delivery path in Checkpoint 1/);
});
