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
  assert.match(app, /observation-series\?window=1d/);
  assert.match(app, /if \(data\.tankModel\) tankModel = data\.tankModel/);
  assert.match(app, /pressureSwitch\?\.cycles > 0\) pressureSwitch = data\.pressureSwitch/);
  // Fetched at load and again when the tab comes back, not only on a timer.
  assert.ok((app.match(/checkHistory\(\);/g) || []).length >= 2);
});

test("the tank shows gallons beside the pressure", () => {
  assert.match(html, /id="tank-gallons"/);
  assert.match(app, /tankGallons\.textContent = water === null \? "—" : `\$\{water\.toFixed\(1\)\} gal`/);
});
