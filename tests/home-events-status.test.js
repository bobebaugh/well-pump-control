"use strict";

// The home page's events panel judges the board by the live reading, not its age.
// The Tab5 re-sends an unchanged board only every 30 minutes (M6.45) but sends a
// change at once, so a fresh live reading means the board is current.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const app = readFileSync(path.join(__dirname, "..", "web/app.js"), "utf8");

function lift(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing from app.js`);
  let depth = 0;
  for (let index = app.indexOf("{", start); index < app.length; index += 1) {
    if (app[index] === "{") depth += 1;
    if (app[index] === "}" && (depth -= 1) === 0) return app.slice(start, index + 1);
  }
  throw new Error(`could not bound ${name}`);
}

const status = new Function("formatTime", "LIVE_STATUS_MAX_AGE_MS",
  `${lift("compactAge")}\n${lift("eventBoardStatus")}\nreturn eventBoardStatus;`)(
  () => "3:10 PM", 30000);
const NOW = 1000000;
const board = { lastReportAt: "2026-09-28T19:10:00Z", openEvents: {} };

test("a fresh live reading makes a 30-minute-old board current", () => {
  assert.equal(status(board, { fresh: true, ageSeconds: 2, at: NOW - 1000 }, NOW),
    "Current: the Tab5 is reporting live and sends any change in open events at once. Last board 3:10 PM.");
});

test("a stale or missing live reading says the events are as of the last board", () => {
  assert.match(status(board, { fresh: false, ageSeconds: 95, at: NOW }, NOW), /live reading is 95s old, so these open events are as of its last board, 3:10 PM/);
  assert.match(status(board, { fresh: false, ageSeconds: 900, at: NOW }, NOW), /15 min old/);
  assert.match(status(board, { fresh: false, ageSeconds: null, at: NOW }, NOW), /live reading is unavailable/);
  assert.match(status(board, null, NOW), /unavailable/);
  // A live verdict nobody refreshed (hidden page) proves nothing.
  assert.match(status(board, { fresh: true, ageSeconds: 2, at: NOW - 31000 }, NOW), /unavailable/);
  assert.equal(status(null, { fresh: true, ageSeconds: 2, at: NOW }, NOW), "No successful event board is stored yet.");
});

test("the board's own age no longer decides anything, and every live update re-renders it", () => {
  assert.doesNotMatch(app, /ageSeconds > 120/);
  const render = lift("renderObservation");
  assert.match(render, /liveReading = \{ fresh, ageSeconds: data\.ageSeconds, at: Date\.now\(\) \};\s*renderEventStatus\(\);/);
  assert.match(lift("checkObservation"), /liveReading = \{ fresh: false, ageSeconds: null, at: Date\.now\(\) \};/);
  assert.match(lift("checkEvents"), /eventBoardStatus\(lastEventBoard, liveReading, Date\.now\(\)\)/);
});
