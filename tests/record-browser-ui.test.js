"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

class Element {
  constructor(id) { this.id = id; this.listeners = new Map(); this.disabled = false; this.textContent = ""; this.innerHTML = ""; this.value = ""; this.checked = true; this.style = { setProperty() {} }; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  async fire(name) { this.listeners.get(name)?.({ target: this }); await settle(); }
  querySelectorAll(selector) { return selector === "input" ? this.inputs || [] : []; }
}
async function settle() { for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve)); }
function response(recordId, extra = {}) {
  return { status: "ok", catalog: [{ name: "PumpWatts", label: "Pump watts", unit: "W" }, { name: "ClockValid", label: "Clock", unit: null }], defaultColumns: ["PumpWatts", "ClockValid"], records: [{ recordId, schemaVersion: 2, sessionId: "session001", cycleSequence: 4, observationTime: "2026-03-08T01:00:00.000Z", receiptTime: "2026-03-08T01:01:00.000Z", rulesRelease: {}, triggerReasons: [{ kind: recordId }], fields: { PumpWatts: { state: "available", value: 0 }, ClockValid: { state: "available", value: false } } }], ...extra };
}
function page(search) {
  const ids = ["records-status", "records-table", "column-picker", "record-day", "record-at", "newer-records", "older-records", "latest-records", "receipt-records", "export-day", "timezone-label", "history-older", "history-newer", "history-panel", "history-list"];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  const input = new Element("PumpWatts"); const clock = new Element("ClockValid"); elements["column-picker"].inputs = [input, clock];
  const requests = [];
  const document = {
    querySelector(selector) { return elements[selector.slice(1)] || null; },
    querySelectorAll(selector) { return selector === "#column-picker input:checked" ? elements["column-picker"].inputs.filter(item => item.checked) : []; }
  };
  const fetch = async raw => {
    const url = new URL(raw, "http://browser.test"); const query = url.searchParams; requests.push(Object.fromEntries(query));
    let body;
    if (query.get("view") === "session") {
      if (query.get("session") === "empty000") body = { ...response("unused"), status: "empty", records: [], nextCursor: null, previousCursor: null };
      else if (query.get("cursor") === "before-first") body = { ...response("unused"), status: "empty", records: [], nextCursor: null, previousCursor: null };
      else if (query.get("cursor") === "after-last") body = { ...response("unused"), status: "empty", records: [], nextCursor: null, previousCursor: null };
      else if (query.get("cursor") === "after-first") body = response("session-last", { nextCursor: "after-last", previousCursor: "back-first" });
      else if (query.get("cursor") === "back-first") body = response("session-first", { nextCursor: "after-first", previousCursor: "before-first" });
      else body = response("session-first", { nextCursor: "after-first", previousCursor: "before-first" });
    } else if (query.get("view") === "receipt") body = response("receipt-row", { source: "receipt-time-fallback", nextCursor: null, previousCursor: null });
    else body = response(query.has("anchor") ? "observation-anchored" : "observation-row", { nextCursor: null, previousCursor: null });
    return { ok: true, json: async () => body };
  };
  const context = { URL, URLSearchParams, Intl, Date, Promise, setImmediate, document, location: { search }, fetch, console, Blob: class {}, URLSearchParams };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "web", "records.js"), "utf8"), context, { filename: "web/records.js" });
  return { elements, input, requests, ready: settle };
}

test("browser JavaScript preserves a populated session page at both boundaries", async () => {
  const view = page("?session=session001&cycle=4&event=E1"); await view.ready();
  assert.match(view.elements["records-table"].innerHTML, /session-first/);
  await view.elements["older-records"].fire("click");
  assert.match(view.elements["records-status"].textContent, /No earlier session records/);
  assert.match(view.elements["records-table"].innerHTML, /session-first/);
  assert.equal(view.elements["older-records"].disabled, true);
  assert.equal(view.elements["newer-records"].disabled, false);
  await view.elements["newer-records"].fire("click");
  assert.match(view.elements["records-table"].innerHTML, /session-last/);
  await view.elements["newer-records"].fire("click");
  assert.match(view.elements["records-status"].textContent, /No later session records/);
  assert.match(view.elements["records-table"].innerHTML, /session-last/);
  assert.equal(view.elements["newer-records"].disabled, true);
  assert.equal(view.elements["older-records"].disabled, false);
  view.input.checked = false; await view.input.fire("change");
  assert.match(view.elements["records-table"].innerHTML, /session-last/);
  assert.doesNotMatch(view.elements["records-table"].innerHTML, /PUMPWATTS/);
  await view.elements["older-records"].fire("click");
  assert.match(view.elements["records-table"].innerHTML, /session-first/);
  await view.elements["latest-records"].fire("click");
  assert.match(view.elements["records-table"].innerHTML, /observation-row/);
  view.elements["record-at"].value = "2026-03-08T01:00"; await view.elements["record-at"].fire("change");
  assert.match(view.elements["records-table"].innerHTML, /observation-anchored/);
  await view.elements["receipt-records"].fire("click");
  assert.match(view.elements["records-table"].innerHTML, /receipt-row/);
  assert.equal(view.requests.some(query => query.view === "session" && query.event === "E1"), true);
});

test("browser JavaScript reports an empty session without manufacturing navigation", async () => {
  const view = page("?session=empty000&cycle=0"); await view.ready();
  assert.equal(view.elements["records-status"].textContent, "No records at this position.");
  assert.equal(view.elements["older-records"].disabled, true);
  assert.equal(view.elements["newer-records"].disabled, true);
});
