"use strict";

// M6.46 web: the home page polls the live reading every 5 s (the Tab5 writes it at
// most every 10 s) and stops the live and operator polls after 15 minutes without a
// pointer, key or touch. Paused is its own state, never unknown, stale or unavailable.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = readFileSync(path.join(root, "web/app.js"), "utf8");
const html = readFileSync(path.join(root, "web/index.html"), "utf8");

function lift(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing from app.js`);
  let depth = 0;
  // Start at the body: a destructured parameter list also opens with a brace.
  for (let index = app.indexOf(") {", start) + 2; index < app.length; index += 1) {
    if (app[index] === "{") depth += 1;
    if (app[index] === "}" && (depth -= 1) === 0) return app.slice(start, index + 1);
  }
  throw new Error(`could not bound ${name}`);
}

function element() {
  const dot = { className: "" };
  const small = { textContent: "" };
  const strong = { textContent: "" };
  return {
    textContent: "", className: "", hidden: true, style: {}, nextElementSibling: { hidden: false },
    classList: { remove() {}, add() {} },
    querySelector: selector => selector === ".health-dot" ? dot : selector === "small" ? small : strong,
    dot, small, strong
  };
}

function pageHarness(nowMs) {
  const els = {};
  const names = ["pumpState", "pressureValue", "powerValue", "voltageValue", "pfValue", "sw0Value",
    "rly0Value", "tankPressure", "tankGallons", "tankFlow", "tankWater", "pressureTag", "tab5Row",
    "shellyRow", "pressureRow", "shelly1Row", "protShelly", "protTab5", "protMode", "protShellyDetail",
    "protModeDetail", "operatorSummary", "livePausedBanner", "eventStatus"];
  for (const name of names) els[name] = element();
  const calls = [];
  const body = `
    let livePaused = false; let lastInteractionAt = ${nowMs}; let liveReading = null;
    let observationTimer = 1; let operatorTimer = 2; let lastEventBoard = null;
    const LIVE_IDLE_PAUSE_MS = ${15 * 60 * 1000};
    const Date = { now: () => clock.now };
    function clearTimeout(handle) { calls.push(["clearTimeout", handle]); }
    function clearObservation() { calls.push(["clearObservation"]); }
    function checkObservation() { calls.push(["checkObservation"]); }
    function checkOperatorStatus() { calls.push(["checkOperatorStatus"]); }
    function renderEventStatus() { calls.push(["renderEventStatus", liveReading]); }
    ${lift("setHealth")}
    ${lift("setProtection")}
    ${lift("liveIdleExpired")}
    ${lift("renderPaused")}
    ${lift("pauseLive")}
    ${lift("resumeLive")}
    return { pauseLive, resumeLive, liveIdleExpired,
      state: () => ({ livePaused, lastInteractionAt, liveReading }) };`;
  const clock = { now: nowMs };
  const page = new Function("clock", "calls", ...names, body)(clock, calls, ...names.map(name => els[name]));
  return { page, els, calls, clock };
}

test("the live reading is polled every 5 s and the idle pause is 15 minutes", () => {
  assert.match(app, /const OBSERVATION_REFRESH_MS = 5000;/);
  assert.match(app, /const LIVE_IDLE_PAUSE_MS = 15 \* 60 \* 1000;/);
  const { page, clock } = pageHarness(1000000);
  clock.now = 1000000 + 15 * 60 * 1000 - 1;
  assert.equal(page.liveIdleExpired(clock.now), false);
  assert.equal(page.liveIdleExpired(clock.now + 1), true);
});

test("pausing stops both polls, shows the banner and marks every live tile paused", () => {
  const { page, els, calls } = pageHarness(1000000);
  page.pauseLive();
  assert.equal(page.state().livePaused, true);
  assert.equal(els.livePausedBanner.hidden, false);
  for (const name of ["pressureValue", "powerValue", "voltageValue"]) {
    assert.equal(els[name].nextElementSibling.hidden, true, `${name} unit is hidden while paused`);
  }
  assert.deepEqual(calls.filter(call => call[0] === "clearTimeout").map(call => call[1]), [1, 2]);
  for (const name of ["pressureValue", "powerValue", "voltageValue", "pfValue", "sw0Value", "rly0Value",
    "tankPressure", "tankGallons", "tankFlow", "protShelly", "protTab5", "protMode"]) {
    assert.equal(els[name].textContent, "Paused", `${name} says paused`);
  }
  assert.equal(els.pumpState.strong.textContent, "Live view paused");
  assert.equal(els.pressureTag.className, "tag paused");
  for (const row of ["tab5Row", "shellyRow", "pressureRow", "shelly1Row"]) {
    assert.equal(els[row].dot.className, "health-dot paused");
    assert.equal(els[row].small.textContent, "Live view paused");
  }
  const shown = Object.values(els).map(el => `${el.textContent} ${el.className} ${el.small.textContent} ${el.strong.textContent}`).join(" ");
  assert.doesNotMatch(shown, /unknown|stale|unavailable/i);
  assert.equal(page.state().liveReading.paused, true);
  // The events panel re-renders with the paused verdict.
  assert.ok(calls.some(call => call[0] === "renderEventStatus" && call[1]?.paused === true));
  // A second pause is harmless.
  page.pauseLive();
  assert.equal(calls.filter(call => call[0] === "renderEventStatus").length, 1);
});

test("an interaction resumes at once: banner hidden, both polls restarted", () => {
  const { page, els, calls, clock } = pageHarness(1000000);
  page.pauseLive();
  clock.now = 9000000;
  page.resumeLive();
  assert.equal(page.state().livePaused, false);
  assert.equal(els.livePausedBanner.hidden, true);
  for (const name of ["pressureValue", "powerValue", "voltageValue"]) {
    assert.equal(els[name].nextElementSibling.hidden, false, `${name} unit is restored on resume`);
  }
  assert.equal(page.state().lastInteractionAt, 9000000);
  assert.equal(page.state().liveReading, null);
  const after = calls.slice(calls.findIndex(call => call[0] === "clearObservation")).map(call => call[0]);
  assert.deepEqual(after, ["clearObservation", "checkObservation", "checkOperatorStatus"]);
  // Interaction while live only moves the idle clock.
  calls.length = 0;
  clock.now = 9100000;
  page.resumeLive();
  assert.equal(page.state().lastInteractionAt, 9100000);
  assert.deepEqual(calls, []);
});

test("the events panel says paused, not stale or unavailable", () => {
  const status = new Function("formatTime", "LIVE_STATUS_MAX_AGE_MS",
    `${lift("compactAge")}\n${lift("eventBoardStatus")}\nreturn eventBoardStatus;`)(() => "3:10 PM", 30000);
  const board = { lastReportAt: "2026-09-28T19:10:00Z", openEvents: {} };
  const text = status(board, { paused: true, fresh: false, ageSeconds: null, at: 0 }, 10000000);
  assert.equal(text, "Live view paused, so these open events are as of the last board, 3:10 PM. Resume to check them live.");
  assert.doesNotMatch(text, /stale|unavailable|unknown/i);
});

test("both polls check the pause before fetching and ignore a reply that lands after it", () => {
  const observation = lift("checkObservation");
  assert.ok(observation.indexOf("liveIdleExpired") < observation.indexOf("fetchStatus"));
  assert.ok(observation.indexOf("document.hidden") < observation.indexOf("liveIdleExpired"),
    "a hidden tab keeps today's behaviour");
  assert.match(observation, /const data = await fetchStatus[^;]+;\s*\/\/[^\n]*\n\s*if \(livePaused\) return;\s*renderObservation\(data\);/);
  assert.match(observation, /catch \(error\) \{\s*if \(livePaused\) return;/);
  const operator = lift("checkOperatorStatus");
  assert.ok(operator.indexOf("liveIdleExpired") < operator.indexOf("fetchStatus"));
  assert.match(operator, /if \(!promptForKey && \(livePaused \|\| liveIdleExpired\(Date\.now\(\)\)\)\) \{\s*pauseLive\(\);\s*return;/);
  assert.match(operator, /await fetchStatus\([^;]+;\s*if \(livePaused && !promptForKey\) return;/);
});

test("pointer, key and touch resume; the button and showing the tab do too", () => {
  assert.match(app, /for \(const type of \["pointerdown", "pointermove", "wheel", "keydown", "touchstart"\]\) \{\s*document\.addEventListener\(type, resumeLive, \{ passive: true \}\);/);
  assert.match(app, /liveResume\.addEventListener\("click", resumeLive\);/);
  const visibility = app.slice(app.indexOf('addEventListener("visibilitychange"'));
  assert.match(visibility, /if \(livePaused\) resumeLive\(\);/);
  assert.match(html, /<div class="live-paused" id="live-paused" role="status" hidden>/);
  assert.match(html, /<button type="button" id="live-resume"[^>]*>Resume<\/button>/);
});
