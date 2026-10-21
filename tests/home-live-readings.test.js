"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const app = readFileSync(path.join(__dirname, "..", "web/app.js"), "utf8");

function lift(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  let depth = 0;
  for (let index = app.indexOf(") {", start) + 2; index < app.length; index += 1) {
    if (app[index] === "{") depth += 1;
    if (app[index] === "}" && --depth === 0) return app.slice(start, index + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function element() {
  const children = {};
  return { textContent: "", className: "", style: {}, classList: { add() {}, remove() {} },
    querySelector: selector => children[selector] ||= { textContent: "", className: "" } };
}

function page() {
  const names = ["protShelly", "protShellyDetail", "protTab5", "protMode", "protModeDetail",
    "pressureValue", "tankPressure", "tankGallons", "tankFlow", "tankWater", "pressureTag", "pressureRow",
    "powerValue", "voltageValue", "pfValue", "sw0Value", "rly0Value", "shellyRow", "shelly1Row", "tab5Row", "pumpState"];
  const els = Object.fromEntries(names.map(name => [name, element()]));
  const funcs = ["setProtection", "renderProtection", "setHealth", "setBinaryValue", "shelly1RelayView", "binaryText",
    "renderShelly1Health", "renderMeterHealth", "renderObservation", "clearObservation"];
  const renderers = new Function(...names, `
    let liveReading;
    function renderEventStatus() {} function renderPumpBadge() {} function pumpBadgeState() {}
    function tankWaterGallons() { return null; } function tankFillPercent() { return null; }
    function tankFlowText() { return "—"; }
    ${funcs.map(lift).join("\n")}
    return { render: renderProtection, observation: renderObservation, clear: clearObservation };
  `)(...Object.values(els));
  return { els, ...renderers };
}

test("System Monitor is amber and distinct from Normal and User Monitor", () => {
  const { els, render } = page();
  render({ userMonitor: false, systemMonitor: true }, true);
  assert.equal(els.protMode.textContent, "System Monitor");
  assert.equal(els.protMode.className, "caution");
  assert.match(els.protModeDetail.textContent, /System event/);
  render({ userMonitor: true, systemMonitor: true }, true);
  assert.equal(els.protMode.textContent, "Tab5 hold released");
  assert.match(els.protModeDetail.textContent, /User Monitor/);
  render({ userMonitor: false, systemMonitor: false }, true);
  assert.equal(els.protMode.textContent, "Normal");
  assert.equal(els.protMode.className, "ok");
  for (const [data, fresh] of [[{ userMonitor: false }, true], [{ userMonitor: false, systemMonitor: true }, false]]) {
    render(data, fresh);
    assert.equal(els.protMode.textContent, "Unknown");
  }
  render({ userMonitor: false, systemMonitor: true, relayRestoration: "unconfirmed" }, true);
  assert.match(els.protModeDetail.textContent, /Relay restoration unconfirmed/);
});

test("electrical values clear on stale, missing or failed observations and recover on fresh data", () => {
  const { els, observation, clear } = page();
  const good = { ageSeconds: 2, values: { pressurePsi: 50, powerW: 2800, voltageV: 240, powerFactor: 0.98, isValid: true } };
  const digits = () => [els.powerValue, els.voltageValue, els.pfValue].map(el => el.textContent);
  for (const bad of [
    { ...good, ageSeconds: 31 }, { ...good, ageSeconds: null }, { ...good, ageSeconds: undefined },
    { ...good, values: { powerW: null, voltageV: null, powerFactor: null } }, { ageSeconds: 2 }
  ]) {
    observation(good);
    assert.deepEqual(digits(), ["2800", "240.0", "0.98"]);
    observation(bad);
    assert.deepEqual(digits(), ["—", "—", "—"]);
    assert.doesNotMatch(els.shellyRow.querySelector("small").textContent, /Meter valid/);
    observation(good);
    assert.equal(els.shellyRow.querySelector("small").textContent, "Meter valid");
  }
  clear();
  assert.deepEqual(digits(), ["—", "—", "—"]);
  assert.doesNotMatch(els.shellyRow.querySelector("small").textContent, /Meter valid/);
});
