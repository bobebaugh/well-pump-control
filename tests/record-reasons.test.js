"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const reasons = require("../web/record-reasons.js");

// Reasons as the Tab5 wrote them on 25 September 2026.
const cloudLost = { kind: "change", field: "CloudAvailable", from: true, to: false };
const cloudBack = { kind: "change", field: "CloudAvailable", from: false, to: true };
const tank = { kind: "delta", field: "TankWaterGallons", from: 6.881134, to: 5.8502272, threshold: 1 };
const watts = { kind: "delta", field: "PumpWatts", from: 12.19, to: 2972.33, threshold: 10 };
const pumpOpen = { kind: "event-boundary", eventKey: "P001", transition: "open", occurrenceId: "20260924205736-event-v3-v46:P001:1" };
const health = { kind: "maximum-interval", intervalMs: 600000 };

test("each reason reads in plain words from what the record stored", () => {
  assert.equal(reasons.label(cloudLost), "Cloud lost");
  assert.equal(reasons.label(cloudBack), "Cloud back");
  assert.equal(reasons.label({ kind: "change", field: "ContactorFlag", from: false, to: true }), "Contactor on");
  assert.equal(reasons.label({ kind: "change", field: "OperatingMode", from: "Normal", to: "Away" }), "OperatingMode → Away");
  assert.equal(reasons.label(tank), "Tank −1.03 gal");
  assert.equal(reasons.label(watts), "Pump +2960 W");
  assert.equal(reasons.label(pumpOpen), "P001 opened");
  assert.equal(reasons.label(health), "Health");
  assert.equal(reasons.label({ kind: "session-start" }), "Session start");
  assert.equal(reasons.label({ kind: "something-new" }), "something-new");
  assert.match(reasons.detail(tank), /TankWaterGallons 6\.881134 → 5\.8502272 \(Δ −1\.03, threshold 1\)/);
  assert.match(reasons.detail(cloudLost), /CloudAvailable changed true → false/);
  assert.match(reasons.detail(health), /maximum interval 600 s/);
});

test("the short label leads with an event, then a change, and counts the rest", () => {
  assert.equal(reasons.short([watts, tank, { kind: "change", field: "ContactorFlag", from: true, to: false }, { ...pumpOpen, transition: "close" }]), "P001 closed +3");
  assert.equal(reasons.short([health]), "Health");
  assert.equal(reasons.short([]), "Not recorded");
  assert.equal(reasons.summary([watts, pumpOpen]), "P001 opened; Pump +2960 W");
  assert.deepEqual([...reasons.fields([watts, pumpOpen, cloudLost])], ["PumpWatts", "CloudAvailable"]);
});

test("the Show filter keeps what each choice names", () => {
  assert.equal(reasons.matches([health], "hide-health"), false);
  assert.equal(reasons.matches([tank], "hide-health"), true);
  assert.equal(reasons.matches([tank], "changes"), false);
  assert.equal(reasons.matches([cloudLost], "changes"), true);
  assert.equal(reasons.matches([watts, pumpOpen], "events"), true);
  assert.equal(reasons.matches([cloudLost], "events"), false);
  assert.equal(reasons.matches([health], "all"), true);
});
