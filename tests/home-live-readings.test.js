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
  const names = ["protShelly", "protShellyDetail", "protTab5", "protMode", "protModeDetail"];
  const els = Object.fromEntries(names.map(name => [name, element()]));
  const render = new Function(...names,
    `${lift("setProtection")}\n${lift("renderProtection")}\nreturn renderProtection;`)(...Object.values(els));
  return { els, render };
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
