"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function settle() { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }

function page() {
  let now = Date.parse("2026-10-20T18:00:00Z"), nextTimer = 0;
  const timers = new Map(), listeners = new Map(), elements = new Map(), requests = [];
  function element() {
    const children = new Map();
    return { textContent: "", innerHTML: "", hidden: true, style: {}, nextElementSibling: { hidden: false },
      classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
      querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); } };
  }
  const document = { hidden: false, querySelectorAll: () => [],
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    addEventListener(type, callback) { listeners.set(type, callback); } };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  function schedule(callback, ms, repeat = false) { timers.set(++nextTimer, { callback, due: now + ms, ms, repeat }); return nextTimer; }
  let releaseHistory = null;
  const context = vm.createContext({ document, console, Intl, URLSearchParams,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    sessionStorage: storage, localStorage: storage,
    setTimeout: (callback, ms) => schedule(callback, ms), clearTimeout: id => timers.delete(id),
    setInterval: (callback, ms) => schedule(callback, ms, true),
    HistoryChart: { VIEWS: { gallons: { title: "Tank water" } }, ZOOM_MIN_MS: {}, mount() {}, mountRail() {}, caption: () => "history" },
    fetch: async url => {
      requests.push(url);
      if (url.includes("observation-series") && releaseHistory) await new Promise(resolve => { releaseHistory.resolve = resolve; });
      const body = url.includes("current-observation") ? { ageSeconds: 2, values: {} }
        : url.includes("operator-control") ? { signedIn: false, control: {} }
        : url.includes("observation-series") ? { startMs: now - 86400000, endMs: now, totals: {}, runs: [] }
        : { status: "ok", board: null, recentClosed: [] };
      return { ok: true, json: async () => body };
    } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "web/app.js"), "utf8"), context);
  return { context, document, requests, listeners,
    evaluate: source => vm.runInContext(source, context),
    holdHistory() { releaseHistory = {}; },
    releaseHistory() { const pending = releaseHistory; releaseHistory = null; pending.resolve(); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (!timers.has(id) || timer.due > now) continue;
        if (timer.repeat) timer.due = now + timer.ms; else timers.delete(id);
        timer.callback();
      }
      await settle();
    } };
}

test("all timed fetches stop at idle expiry and each refreshes once on interaction or visibility resume", async () => {
  for (const type of ["pointerdown", "visibilitychange"]) {
    const view = page(); await settle();
    assert.equal(view.requests.length, 6);
    view.requests.length = 0;
    await view.advance(15 * 60000);
    assert.equal(view.evaluate("livePaused"), true);
    await view.advance(30 * 60000);
    assert.deepEqual(view.requests, []);
    view.listeners.get(type)(); await settle();
    assert.equal(view.evaluate("livePaused"), false);
    assert.equal(view.requests.length, 6);
    assert.equal(new Set(view.requests).size, 6, "no poll refreshes twice on resume");
  }
});

test("a history response landing during pause cannot start another range fetch or restart its timer", async () => {
  const view = page(); await settle();
  view.holdHistory();
  view.evaluate('historyWindow = "7d"; checkHistory();'); await settle();
  view.evaluate("pauseLive()");
  view.requests.length = 0;
  view.releaseHistory(); await settle();
  await view.advance(5 * 60000);
  assert.deepEqual(view.requests, []);
  assert.equal(view.evaluate("livePaused"), true);
});

test("a failed live read clears electrical digits and meter health", async () => {
  const view = page(); await settle();
  await view.evaluate(`(async () => {
    renderObservation({ ageSeconds: 2, values: { powerW: 2800, voltageV: 240, powerFactor: 0.98, isValid: true } });
    fetch = async () => { throw new Error("offline"); };
    await checkObservation();
  })()`);
  assert.equal(view.evaluate('powerValue.textContent + voltageValue.textContent + pfValue.textContent'), "———");
  assert.doesNotMatch(view.evaluate('shellyRow.querySelector("small").textContent'), /Meter valid/);
});
