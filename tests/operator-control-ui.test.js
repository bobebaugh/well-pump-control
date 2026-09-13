"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = readFileSync(path.join(root, "web/index.html"), "utf8");
const app = readFileSync(path.join(root, "web/app.js"), "utf8");

test("home exposes only the three approved operator controls", () => {
  for (const id of ["enter-user-monitor", "restart-tab5", "restart-shelly1"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /Clear Events|Monitor OFF/i);
  assert.match(html, /Shelly-local and mechanical protection remain authoritative/);
  assert.match(html, /not relay or lockout-clear confirmation/);
});

test("browser uses unique one-shot requests and does not retry an ambiguous restart", () => {
  assert.match(app, /clientRequestId: commandIdentity\(\)/);
  assert.match(app, /Unknown: the request may have executed/);
  assert.match(app, /will not be retried automatically/);
  assert.equal((app.match(/issueOperatorAction\(action\)/g) || []).length, 1);
  assert.match(app, /button\.disabled = value/);
  assert.match(app, /User Monitor ACTIVE until Tab5 restart/);
});
