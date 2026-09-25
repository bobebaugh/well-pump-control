"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

class Element {
  constructor(id) { this.id = id; this.listeners = new Map(); this.disabled = false; this.textContent = ""; this.innerHTML = ""; this.value = ""; this.checked = true; this.dataset = {}; this.style = { values: {}, setProperty(name, value) { this.values[name] = value; } }; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  async fire(name) { this.listeners.get(name)?.({ target: this }); await settle(); }
  querySelectorAll(selector) {
    const inputs = this.inputs || [];
    if (selector === "input") return inputs;
    if (selector === 'input[data-kind="metadata"]:checked') return inputs.filter(item => item.dataset.kind === "metadata" && item.checked);
    if (selector === 'input[data-kind="data"]:checked') return inputs.filter(item => item.dataset.kind === "data" && item.checked);
    return [];
  }
}
async function settle() { for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve)); }
function response(query, recordId, extra = {}) {
  return { status: "ok", catalog: [{ name: "ClockValid" }, { name: "PumpWatts" }], eventTriggerField: query.get("event") ? "ClockValid" : null, records: [{ recordId, schemaVersion: 2, sessionId: "session001", cycleSequence: 4, observationTime: "2026-03-08T01:00:00.000Z", receiptTime: "2026-03-08T01:01:00.000Z", rulesRelease: {}, triggerReasons: [{ kind: recordId }], fields: { PumpWatts: { state: "available", value: 0 }, ClockValid: { state: "available", value: false } } }], ...extra };
}
function page(search, stored = null, pageRecords = null) {
  const ids = ["records-status", "records-table", "column-picker", "range-from", "range-to", "range-today", "range-day", "range-week", "view-range", "export-shown", "export-range", "newer-records", "older-records", "latest-records", "receipt-records", "timezone-label", "history-older", "history-newer", "history-panel", "history-list"];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  const picker = elements["column-picker"];
  // The picker delegates: one listener sees the event from whichever control changed.
  const change = async (kind, value, checked = true) => { picker.listeners.get("change")({ target: { dataset: { kind }, value, checked } }); await settle(); };
  const remove = async name => { picker.listeners.get("click")({ target: { dataset: { remove: name } } }); await settle(); };
  const store = new Map(stored ? [["recordBrowserColumns.v2", JSON.stringify(stored)]] : []);
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
  const requests = [];
  const document = {
    querySelector(selector) { return elements[selector.slice(1)] || null; },
    querySelectorAll(selector) { return selector === "#column-picker input:checked" ? elements["column-picker"].inputs.filter(item => item.checked) : []; }
  };
  const fetch = async raw => {
    const url = new URL(raw, "http://browser.test"); const query = url.searchParams; requests.push(Object.fromEntries(query));
    let body;
    if (query.get("view") === "session") {
      if (query.get("session") === "empty000") body = { ...response(query, "unused"), status: "empty", records: [], nextCursor: null, previousCursor: null };
      else if (query.get("cursor") === "before-first") body = { ...response(query, "unused"), status: "empty", records: [], nextCursor: null, previousCursor: null };
      else if (query.get("cursor") === "after-last") body = { ...response(query, "unused"), status: "empty", records: [], nextCursor: null, previousCursor: null };
      else if (query.get("cursor") === "after-first") body = response(query, "session-last", { nextCursor: "after-last", previousCursor: "back-first" });
      else if (query.get("cursor") === "back-first") body = response(query, "session-first", { nextCursor: "after-first", previousCursor: "before-first" });
      else body = response(query, "session-first", { nextCursor: "after-first", previousCursor: "before-first" });
    } else if (query.get("view") === "receipt") body = response(query, "receipt-row", { source: "receipt-time-fallback", nextCursor: null, previousCursor: null });
    else if (query.get("view") === "export") return { ok: true, text: async () => "csv", headers: { get: () => "3" } };
    else body = response(query, query.has("anchor") ? "observation-anchored" : "observation-row", { nextCursor: null, previousCursor: null, ...(pageRecords ? { records: pageRecords } : {}) });
    return { ok: true, json: async () => body };
  };
  const downloads = [];
  document.createElement = () => ({ click() { downloads.push(this.download); } });
  class BrowserURL extends URL { static createObjectURL() { return "blob:test"; } static revokeObjectURL() {} }
  const context = { URL: BrowserURL, URLSearchParams, Intl, Date, Promise, setImmediate, document, location: { search }, fetch, console, Blob: class {}, localStorage };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "web", "record-reasons.js"), "utf8"), context, { filename: "web/record-reasons.js" });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "web", "records.js"), "utf8"), context, { filename: "web/records.js" });
  const saved = () => JSON.parse(store.get("recordBrowserColumns.v2") || "null");
  return { elements, change, remove, saved, requests, downloads, store, ready: settle };
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
  await view.change("data", "PumpWatts", false);
  assert.match(view.elements["records-table"].innerHTML, /session-last/);
  assert.doesNotMatch(view.elements["records-table"].innerHTML, /<strong>PumpWatts<\/strong>/);
  await view.elements["older-records"].fire("click");
  assert.match(view.elements["records-table"].innerHTML, /session-first/);
  await view.elements["latest-records"].fire("click");
  assert.match(view.elements["records-table"].innerHTML, /observation-row/);
  view.elements["range-from"].value = "2026-03-07T01:00"; view.elements["range-to"].value = "2026-03-08T01:00"; await view.elements["range-to"].fire("change"); await view.elements["view-range"].fire("click");
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

test("optional metadata columns default hidden and remain selected across navigation modes", async () => {
  const view = page("?session=session001&cycle=4&event=E1"); await view.ready();
  const table = view.elements["records-table"];
  assert.match(table.innerHTML, /Observation time/);
  assert.doesNotMatch(table.innerHTML, /Session \/ cycle|Receipt time|<strong>Release<\/strong>/);
  await view.change("metadata", "session-cycle"); await view.change("metadata", "release"); await view.change("metadata", "receipt-time");
  assert.match(table.innerHTML, /Session \/ cycle/);
  assert.match(table.innerHTML, /Receipt time/);
  assert.match(table.innerHTML, /<strong>Release<\/strong>/);
  await view.elements["newer-records"].fire("click");
  assert.match(table.innerHTML, /Session \/ cycle/);
  await view.change("data", "PumpWatts", false);
  assert.match(table.innerHTML, /Receipt time/);
  await view.elements["latest-records"].fire("click");
  assert.match(table.innerHTML, /<strong>Release<\/strong>/);
  await view.elements["receipt-records"].fire("click");
  assert.match(table.innerHTML, /Session \/ cycle/);
  assert.match(table.style.values["--record-grid-template"], /170px 180px 190px/);
});

function headers(view) { return [...view.elements["records-table"].innerHTML.split("</div>")[0].matchAll(/<strong>([^<]+)<\/strong>/g)].map(match => match[1]); }

test("with nothing saved every screen opens on Standard, showing the fields the records carry", async () => {
  const view = page(""); await view.ready();
  assert.equal(view.requests.length, 1, "no second read to discover defaults");
  assert.equal(view.requests[0].columns, "ContactorFlag,PumpWatts,PressurePSI,TankWaterGallons,TankNetFlowGPM");
  // Only PumpWatts of Standard is on this page.
  assert.deepEqual(headers(view), ["Observation time", "Reasons", "PumpWatts"]);
  const picker = view.elements["column-picker"].innerHTML;
  assert.match(picker, /<option value="standard" selected>Standard/);
  // A preset field absent from these records stays visible as a dashed chip.
  assert.match(picker, /column-chip absent"[^>]*>ContactorFlag/);
  assert.equal(view.saved(), null, "opening the page saves nothing");
});

test("a custom selection is saved by name, restored in order, and may be empty", async () => {
  const view = page(""); await view.ready();
  await view.change("data", "ClockValid");
  assert.equal(view.requests.length, 2, "adding a field reads it");
  assert.deepEqual(headers(view), ["Observation time", "Reasons", "PumpWatts", "ClockValid"]);
  assert.equal(view.saved().preset, "custom");
  await view.remove("PumpWatts");
  assert.equal(view.requests.length, 2, "removing a field needs no read");
  assert.deepEqual(headers(view), ["Observation time", "Reasons", "ClockValid"]);
  const reopened = page("", view.saved()); await reopened.ready();
  assert.deepEqual(headers(reopened), ["Observation time", "Reasons", "ClockValid"]);
  // Preset fields absent from this page stay in the selection; order is kept.
  assert.deepEqual(reopened.saved().columns, ["ContactorFlag", "PressurePSI", "TankWaterGallons", "TankNetFlowGPM", "ClockValid"]);
  const cleared = page("", { preset: "custom", columns: [], metadata: [] }); await cleared.ready();
  assert.deepEqual(headers(cleared), ["Observation time", "Reasons"]);
  assert.match(cleared.elements["column-picker"].innerHTML, /No field columns selected/);
});

test("a field that has stopped being logged stays selected and returns when it does", async () => {
  const view = page("", { preset: "custom", columns: ["Retired", "PumpWatts"], metadata: [] }); await view.ready();
  assert.equal(view.requests[0].columns, "Retired,PumpWatts");
  assert.deepEqual(headers(view), ["Observation time", "Reasons", "PumpWatts"]);
  assert.match(view.elements["column-picker"].innerHTML, /column-chip absent"[^>]*>Retired/);
});

test("an event link adds its trigger field for the visit only, in one read", async () => {
  const stored = { preset: "custom", columns: ["PumpWatts"], metadata: [] };
  const view = page("?session=session001&cycle=4&event=E1", stored); await view.ready();
  assert.equal(view.requests.length, 1);
  assert.deepEqual(headers(view), ["Observation time", "Reasons", "PumpWatts", "ClockValid"]);
  assert.match(view.elements["column-picker"].innerHTML, /column-chip trigger"[^>]*>ClockValid/);
  // Metadata saved from an event page carries the selection, never the trigger.
  await view.change("metadata", "release");
  assert.deepEqual(view.saved(), { preset: "custom", columns: ["PumpWatts"], metadata: ["release"] });
  // Leaving the event's session drops the trigger field.
  await view.elements["latest-records"].fire("click");
  assert.deepEqual(headers(view), ["Observation time", "Release", "Reasons", "PumpWatts"]);
});

test("removing the trigger field saves nothing; an event already in the selection adds nothing", async () => {
  const stored = { preset: "custom", columns: ["PumpWatts"], metadata: [] };
  const view = page("?session=session001&cycle=4&event=E1", stored); await view.ready();
  await view.remove("ClockValid");
  assert.deepEqual(headers(view), ["Observation time", "Reasons", "PumpWatts"]);
  assert.deepEqual(view.saved(), stored);
  const covered = page("?session=session001&cycle=4&event=E1", { preset: "custom", columns: ["ClockValid"], metadata: [] }); await covered.ready();
  assert.deepEqual(headers(covered), ["Observation time", "Reasons", "ClockValid"]);
  assert.doesNotMatch(covered.elements["column-picker"].innerHTML, /column-chip trigger/);
});

// Two cloud blips and a health record, as on 25 September 2026 (newest first).
const day = [
  { recordId: "back", sessionId: "boot1", cycleSequence: 19835, observationTime: "2026-09-25T08:11:36.000Z", triggerReasons: [{ kind: "change", field: "CloudAvailable", from: false, to: true }], fields: { PumpWatts: { state: "available", value: 12.3456 } } },
  { recordId: "lost", sessionId: "boot1", cycleSequence: 19832, observationTime: "2026-09-25T08:11:30.000Z", triggerReasons: [{ kind: "change", field: "CloudAvailable", from: true, to: false }], fields: { PumpWatts: { state: "available", value: 11.97 } } },
  { recordId: "health", sessionId: "boot1", cycleSequence: 19700, observationTime: "2026-09-25T08:08:51.000Z", triggerReasons: [{ kind: "maximum-interval", intervalMs: 600000 }], fields: { PumpWatts: { state: "available", value: 12 } } },
  { recordId: "tank", sessionId: "boot1", cycleSequence: 19000, observationTime: "2026-09-24T23:58:25.000Z", triggerReasons: [{ kind: "delta", field: "PumpWatts", from: 12.19, to: 2972.33, threshold: 10 }], fields: { PumpWatts: { state: "available", value: 2972.33 } } }
].map(record => ({ schemaVersion: 2, receiptTime: record.observationTime, rulesRelease: {}, ...record }));

test("reasons read in plain words, a return shows how long the value was away, and values round only in the table", async () => {
  const view = page("", null, day); await view.ready();
  const html = view.elements["records-table"].innerHTML;
  assert.match(html, /Cloud back <small class="reason-held">after 6 s<\/small>/);
  assert.match(html, />Cloud lost<\/span>/);
  assert.match(html, />Health<\/span>/);
  assert.match(html, /title="12\.3456">12\.35</);
  assert.match(html, /<span class="trigger-cell"><span title="2972\.33">/, "the field that caused the record is highlighted");
  assert.equal((html.match(/class="records-date"/g) || []).length, 2, "one heading per local date");
});

test("a row opens to its full reasons and every digit, and the Show filter narrows the page", async () => {
  const view = page("", null, day); await view.ready();
  const table = view.elements["records-table"];
  table.listeners.get("click")({ target: { closest: () => ({ dataset: { record: "back" } }) } });
  assert.match(table.innerHTML, /records-detail/);
  assert.match(table.innerHTML, /CloudAvailable changed false → true · CloudAvailable was false for 6 s/);
  assert.match(table.innerHTML, /<strong>PumpWatts<\/strong> 12\.3456/);
  table.listeners.get("click")({ target: { closest: () => ({ dataset: { record: "back" } }) } });
  assert.doesNotMatch(table.innerHTML, /records-detail/);
  await view.change("filter", "changes");
  assert.match(table.innerHTML, /Showing 2 of 4 records on this page/);
  assert.doesNotMatch(table.innerHTML, />Health</);
  assert.equal(view.store.get("recordBrowserReasonFilter.v1"), "changes");
  assert.match(view.elements["column-picker"].innerHTML, /<option value="changes" selected>/);
});

test("export sends the local range, time zone and, when asked, only the shown columns", async () => {
  const view = page(""); await view.ready();
  view.elements["range-from"].value = "2026-09-24T00:00"; view.elements["range-to"].value = "2026-09-25T08:51";
  await view.elements["range-to"].fire("change");
  view.elements["export-shown"].checked = true;
  await view.elements["export-range"].fire("click");
  const request = view.requests.at(-1);
  assert.equal(request.view, "export");
  assert.equal(request.start, new Date("2026-09-24T00:00").toISOString());
  assert.equal(request.end, new Date("2026-09-25T08:51:59.999").toISOString());
  assert.equal(request.tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(request.columns, "ContactorFlag,PumpWatts,PressurePSI,TankWaterGallons,TankNetFlowGPM");
  assert.deepEqual(view.downloads, ["durable-observations-20260924_0000-to-20260925_0851.csv"]);
  assert.equal(view.elements["records-status"].textContent, "Export complete: 3 records.");
  view.elements["range-from"].value = "2026-07-01T00:00";
  const before = view.requests.length;
  await view.elements["export-range"].fire("click");
  assert.equal(view.requests.length, before, "an over-long range is refused before any read");
  assert.match(view.elements["records-status"].textContent, /32 days or less/);
});

test("To follows now until edited, and Today starts at local midnight", async () => {
  const view = page(""); await view.ready();
  const now = Date.now();
  await view.elements["range-today"].fire("click");
  const from = new Date(view.elements["range-from"].value);
  assert.equal(from.getHours() + from.getMinutes(), 0);
  view.elements["range-to"].value = "2000-01-01T00:00";
  await view.elements["export-range"].fire("click");
  assert.ok(Math.abs(new Date(view.elements["range-to"].value) - now) < 120000, "an untouched To is refreshed to now at export");
});
