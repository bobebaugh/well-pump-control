"use strict";

// The tank cutaway, tested on the real source.
//
// app.js resolves its DOM references at module scope, so it cannot simply be
// required here. These lift the two pure functions out of the file and run them,
// which is what catches a change to the maths; the wiring assertions catch the
// case the maths cannot see, where the functions are correct but nothing ever
// supplies them a tank model.

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const app = readFileSync(path.join(__dirname, "..", "web/app.js"), "utf8");
const html = readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");

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

// Same shape the saved rules carry, and the switch the Sep 15 records observed.
const MODEL = { effectiveTankGallons: 79.3, prechargeGaugePsi: 38, atmosphericPressurePsi: 13.07 };
const SWITCH = { cycles: 3, cutInPsi: 39.1, fullPsi: 60.0 };

function evaluate({ model = null, pressureSwitch = null }) {
  const make = new Function("tankModel", "pressureSwitch",
    `${lift("tankWaterGallons")}\n${lift("tankFillPercent")}\n` +
    "return { tankWaterGallons, tankFillPercent };");
  return make(model, pressureSwitch);
}

test("with no tank model the cutaway declines to draw rather than drawing empty", () => {
  const { tankFillPercent, tankWaterGallons } = evaluate({});
  // Returning 0 here would render an empty tank beside a healthy pressure on
  // every load until the history endpoint answered.
  assert.equal(tankFillPercent(51.9), null);
  assert.equal(tankWaterGallons(51.9), null);
});

test("the caller leaves the bar untouched when the fill is unknown", () => {
  assert.match(app, /if \(fill === null\) \{\s*tankWater\.style\.height = "";\s*tankWater\.classList\.remove\("live"\)/);
});

test("water comes from the Boyle model, not a pressure ratio", () => {
  const { tankWaterGallons } = evaluate({ model: MODEL });
  assert.equal(tankWaterGallons(49.8).toFixed(2), "14.88");
  assert.equal(tankWaterGallons(38), 0);
  // Below precharge the bladder is against the wall and the model does not apply.
  assert.equal(tankWaterGallons(20), null);
});

test("the cutaway spans the observed usable drawdown, empty at cut-in and full at cut-out", () => {
  const { tankFillPercent } = evaluate({ model: MODEL, pressureSwitch: SWITCH });
  assert.equal(tankFillPercent(39.1).toFixed(1), "0.0");
  assert.equal(tankFillPercent(60.0).toFixed(1), "100.0");
  assert.equal(tankFillPercent(49.8).toFixed(1), "59.5");
  // The old linear scale put 49.8 psi at 71% of a hardcoded 70 psi full mark.
  assert.ok(Math.abs(tankFillPercent(49.8) - 71) > 10);
});

test("with a model but no observed cycle it falls back to water in the tank", () => {
  const { tankFillPercent } = evaluate({ model: MODEL });
  // Honest, just always low-looking: even at cut-out a bladder tank is about a
  // third water. Never a nominal full mark.
  assert.equal(tankFillPercent(49.8).toFixed(1), "18.8");
});

test("nothing in the page assumes a nominal switch band or tank rating", () => {
  assert.doesNotMatch(app, /TANK_FULL_PSI/);
  // The tank is rated to 150 psi and a band may be 30-50, 40-60 or higher, so no
  // constant pressure may divide or bound the cutaway. Staleness thresholds in
  // seconds are not pressures, hence matching the psi arithmetic specifically.
  assert.doesNotMatch(app, /psi\s*\/\s*\d/);
  assert.doesNotMatch(app, /\/\s*(70|150)\s*\)\s*\*\s*100/);
});

test("the tank model is actually fetched, or the maths above never runs", () => {
  assert.match(app, /observation-series\?window=\$\{encodeURIComponent\(windowKey\)\}/);
  // The tank cutaway needs the day window specifically, and that is the default.
  assert.match(app, /let historyWindow = "1d"/);
  assert.match(app, /if \(data\.tankModel\) tankModel = data\.tankModel/);
  assert.match(app, /pressureSwitch\?\.cycles > 0\) pressureSwitch = data\.pressureSwitch/);
  // Fetched at load and again when the tab comes back, not only on a timer.
  assert.ok((app.match(/checkHistory\(\);/g) || []).length >= 2);
});

test("the tank shows gallons beside the pressure", () => {
  assert.match(html, /id="tank-gallons"/);
  assert.match(app, /tankGallons\.textContent = water === null \? "—" : `\$\{water\.toFixed\(1\)\} gal`/);
});

test("the motor-power placeholder is gone, replaced by the history panel", () => {
  // "Not worth graphing" -- the panel that never had a data source.
  assert.doesNotMatch(html, /Motor power/);
  assert.doesNotMatch(html, /No telemetry received/);
  assert.doesNotMatch(html, /Pressure overlay reserved/);
  assert.match(html, /id="history-chart"/);
  assert.match(html, /id="history-caption"/);
});

test("the chart offers all three views and both intervals", () => {
  for (const view of ["gallons", "used", "starts"]) {
    assert.match(html, new RegExp(`data-view="${view}"`));
  }
  for (const range of ["1d", "7d"]) {
    assert.match(html, new RegExp(`data-window="${range}"`));
  }
});

test("the chart module loads before the script that uses it", () => {
  assert.ok(html.indexOf("/history-chart.js") < html.indexOf("/app.js"),
    "history-chart.js must be parsed before app.js references HistoryChart");
});

test("the three dead tiles carry real figures, and energy is not among them", () => {
  // Energy is not computable at all: ShellyEnergyWh is logging mode "none" in
  // the live package, so no durable record has ever carried it.
  assert.doesNotMatch(html, /Energy today/);
  assert.doesNotMatch(html, /Last cycle/);
  for (const id of ["stat-used", "stat-starts", "stat-run"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // They are always the last 24 hours, whatever window the chart is showing.
  assert.match(app, /historyData\["1d"\]\?\.totals/);
  assert.match(app, /await loadHistory\("1d"\)/);
});

test("switching view does not refetch, and switching window caches per window", () => {
  assert.match(app, /if \(historyData\[historyWindow\]\) \{ renderHistory\(\); return; \}/);
  assert.match(app, /historyData\[windowKey\] = data/);
});
