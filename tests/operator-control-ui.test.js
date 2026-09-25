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
  assert.match(app, /Tab5 hold RELEASED \(User Monitor\) until Tab5 restart/);
});

test("status UI distinguishes rejected authentication, missing configuration, and unavailable status", () => {
  assert.match(app, /Owner key not accepted; controls remain locked/);
  assert.match(app, /Control service configuration is unavailable; controls cannot be used/);
  assert.match(app, /Current control status is unavailable/);
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

test("status reads without a password; the three actions stay disabled until a sign-in is accepted", () => {
  for (const id of ["enter-user-monitor", "restart-tab5", "restart-shelly1"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*disabled`), `${id} starts disabled`);
  }
  assert.match(html, /Release Tab5 hold \(until restart\)/);
  assert.match(html, /only a Tab5 restart ends it/);
  assert.match(app, /button\.disabled = value \|\| !operatorSignedIn/);
  assert.match(app, /setSignedIn\(body\.signedIn === true\)/);
  assert.match(app, /There is no off switch: restarting the Tab5 is the only way back to normal/);
});

test("the protection line shows lockout, inhibit and mode from the live record, and unknown when stale", () => {
  for (const id of ["prot-shelly", "prot-tab5", "prot-mode"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /renderProtection\(data, fresh\)/);
  assert.match(app, /lock === -1\) setProtection\(protShelly, "FULL LOCKOUT", "alert"\)/);
  assert.match(app, /shelly1\.tab5IsLocked === true\) setProtection\(protTab5, "SET", "alert"\)/);
  assert.match(app, /if \(!fresh\) \{\s*setProtection\(protShelly, "Unknown", "unknown"\)/);
});

test("the last pump run reads off the day's history, and says so when there was none or records are missing", () => {
  assert.match(html, /id="last-run"/);
  assert.match(app, /historyData\["1d"\]\?\.runs\?\.at\(-1\)/);
  assert.match(app, /None in the last 24 h/);
  assert.match(app, /records missing during the run; figures partial/);
});
