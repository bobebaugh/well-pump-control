"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ui = require("../web/event-v3-ui-model");

test("Event V3 UI model maps only the reviewed controls and classifies restarts", () => {
  assert.deepEqual(Object.keys(ui.CONTROL_ACTIONS), [
    "clear-events", "monitor", "normal", "restart-tab5", "restart-shelly1"
  ]);
  assert.deepEqual(ui.controlAction("restart-tab5"), { label: "Restart Tab5", restartTarget: "Tab5" });
  assert.deepEqual(ui.controlAction("restart-shelly1"), { label: "Restart Shelly 1", restartTarget: "Shelly 1" });
  assert.equal(ui.controlAction("close-event"), null);
});

test("Event V3 UI model bounds, formats, and labels event status safely", () => {
  const view = ui.statusView({
    board: { sessionId: "boot-1", mode: "Monitor", boundaryObservedAt: "2026-08-30T00:00:07.000Z",
      openEvents: Array.from({ length: 65 }, (_, index) => ({
        eventId: `event-${index}`, eventInstanceId: `v3-instance-${index + 1}`, ruleId: "E007",
        eventClass: "transient", severity: "Red", consequence: "inhibit", openedAt: "2026-08-30T00:00:07Z"
      })) },
    history: [{ eventId: "<img src=x onerror=alert(1)>", eventInstanceId: "v3-instance-1", ruleId: "E007",
      eventClass: "transient", severity: "Red", consequence: "inhibit", effectiveStatus: "interrupted",
      openedAt: "2026-08-30T00:00:07Z", closeTransitionReason: "clear_events" }]
  });
  assert.equal(view.mode, "Monitor");
  assert.equal(view.openEvents.length, 64);
  assert.equal(view.history[0].status, "interrupted");
  assert.equal(view.history[0].eventId, "<img src=x onerror=alert(1)>");
  assert.equal(view.history[0].openedAt, "2026-08-30T00:00:07Z");
  assert.equal(view.history[0].reason, "clear_events");
  assert.equal(ui.eventTime("bad time"), "—");
  assert.equal(ui.eventStatus("unsafe"), "unknown");
});

test("Event V3 browser wiring uses text-only rendering and has no automatic control request", () => {
  const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
  const index = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
  assert.doesNotMatch(app, /innerHTML/);
  assert.match(app, /\.textContent\s*=/);
  assert.match(app, /\.netlify\/functions\/events-status/);
  assert.match(app, /\.netlify\/functions\/control-request/);
  assert.match(app, /sessionStorage\.getItem\("pilotControlKey"\)/);
  assert.match(app, /JSON\.stringify\(\{ commandType \}\)/);
  assert.match(app, /window\.confirm\(`Queue \$\{action\.label\} for \$\{action\.restartTarget\}\?`\)/);
  assert.match(index, /EVENT V3 CONTROLS — NOT YET COMMISSIONED/);
  assert.match(index, /aria-live="polite"/);
  const startup = app.slice(app.lastIndexOf("checkServices();"));
  assert.doesNotMatch(startup, /control-request/);
});
