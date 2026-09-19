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

test("status UI distinguishes rejected authentication, missing configuration, and unavailable status", () => {
  assert.match(app, /Owner key not accepted; controls remain locked/);
  assert.match(app, /Control service configuration is unavailable; controls cannot be used/);
  assert.match(app, /Owner key accepted; current control status is unavailable/);
  assert.match(app, /Control status unavailable; no command was retried/);
});

test("the operator poll stops against a hidden tab, and resumes when it returns", () => {
  // The heaviest poll in the page: one call reads four RTDB children, the
  // current observation among them, and it was the only poller with no
  // visibility guard -- 17,280 calls and 69,120 RTDB reads a day against a
  // screen nobody was looking at.
  assert.match(app, /if \(document\.hidden && !promptForKey\) \{\s*operatorTimer = setTimeout\(checkOperatorStatus, 5000\);\s*return;/);
  // Unlocking is a deliberate click, so it must not be swallowed by the guard.
  assert.match(app, /document\.hidden && !promptForKey/);
  const visibility = app.slice(app.indexOf('addEventListener("visibilitychange"'));
  assert.match(visibility, /checkOperatorStatus\(\)/);
});

test("every repeating poll now has a visibility guard", () => {
  for (const poller of ["checkObservation", "checkHistory", "checkOperatorStatus"]) {
    const start = app.indexOf(`async function ${poller}(`);
    assert.notEqual(start, -1, `${poller} is missing`);
    const body = app.slice(start, start + 900);
    assert.match(body, /document\.hidden/, `${poller} polls a hidden tab`);
  }
});
