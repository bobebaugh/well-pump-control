"use strict";

// Executes the page's real JavaScript against a fake Shelly, driving real button
// clicks and asserting on real fetch calls. The device is not contacted; this
// proves the page's decisions, not the device's RPC behaviour.
//
// Run: node --test shelly1/tools/shelly-cors-proxy/index.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const SCRIPT = /<script>([\s\S]*)<\/script>/.exec(HTML)[1];
const IDS = [...HTML.matchAll(/id="([^"]+)"/g)].map(match => match[1]);

// Enough DOM for this page: every element it queries by id, with click and input.
function makePage(respond) {
  const nodes = {};
  for (const id of IDS) {
    nodes[id] = {
      id, textContent: "", className: "", value: "", disabled: false,
      _handlers: {},
      addEventListener(type, fn) { (this._handlers[type] ||= []).push(fn); },
      click() { return Promise.all((this._handlers.click || []).map(fn => fn())); },
    };
  }
  nodes["min-runtime"].value = "60";
  const calls = [];
  const sandbox = {
    document: { querySelector: sel => nodes[sel.replace("#", "")] || null },
    localStorage: { getItem: () => "192.168.50.201", setItem: () => {} },
    location: { href: "http://localhost:8899/" },
    URL, URLSearchParams, Promise, Object, Number, Math, Date, JSON, Error, console,
    setInterval: () => 0, clearInterval: () => {},
    fetch: async url => {
      const request = url.pathname + url.search;
      calls.push(request);
      const method = /\/rpc\/([^?]+)/.exec(request)[1];
      const body = respond(method, Object.fromEntries(url.searchParams));
      return { ok: true, status: 200, json: async () => body };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: "index.html" });
  return { nodes, calls };
}

// A Shelly whose physical input position and invert config we control. It answers
// a bare JSON null to every setter, which is what the real device does.
function device(state) {
  return (method, params) => {
    if (method === "Shelly.GetComponents") {
      // The device answers a keys filter with exactly the matching components, in
      // no guaranteed order, and silently omits a key it does not have.
      if (params.keys) {
        const wanted = JSON.parse(params.keys);
        const available = {
          // The envelope shape captured from the device: state on the input,
          // output on the switch, both under status.
          "input:0": state.inputEntry || {
            key: "input:0", config: { id: 0, type: "switch", invert: state.invert },
            status: { id: 0, state: state.physical !== state.invert } },
          "switch:0": { key: "switch:0", config: { id: 0, initial_state: "off" },
                        status: { id: 0, output: state.relay, source: "loopback" } },
        };
        if (state.noInput) delete available["input:0"];
        const matched = wanted.map(k => available[k]).filter(Boolean).reverse();
        return { components: matched, offset: 0, total: matched.length };
      }
      const components = [
        { key: "number:201", config: { id: 201, name: "IsLocked" }, status: { value: state.locked ?? 0 } },
        { key: "number:202", config: { id: 202, name: "loCntr" }, status: { value: 0 } },
        { key: "boolean:246", config: { id: 246, name: "Tab5IsLocked" }, status: { value: state.flag } },
      ];
      return { components: state.noFlag ? components.filter(c => c.config.name !== "Tab5IsLocked") : components };
    }
    if (method === "Shelly.GetStatus") {
      // Only the Diagnose panel may ask for this: its reply was never captured
      // from this device, so no display path is allowed to depend on it.
      if (!state.allowGetStatus) {
        throw new Error("the page must not call Shelly.GetStatus outside Diagnose");
      }
      return { sys: {}, "switch:0": { id: 0, output: state.relay } };
    }
    if (method === "Input.GetStatus") return { id: 0, state: state.physical !== state.invert };
    if (method === "Input.GetConfig") return { id: 0, invert: state.invert };
    if (method === "Input.SetConfig") { state.invert = JSON.parse(params.config).invert; return null; }
    if (method === "Boolean.Set") { state.flag = params.value === "true"; return null; }
    if (method === "Number.Set") { if (params.id === "201") state.locked = Number(params.value); return null; }
    return {};
  };
}

function freshState(over = {}) {
  return Object.assign({ physical: false, invert: false, flag: false, relay: false }, over);
}

test("activate and deactivate work from every starting input position", async () => {
  for (const physical of [false, true]) {
    for (const invert of [false, true]) {
      const state = freshState({ physical, invert });
      const { nodes } = makePage(device(state));
      await nodes.connect.click();
      await nodes["pump-on"].click();
      assert.equal(nodes["input-value"].textContent, "ON",
        `activate with physical=${physical} invert=${invert}`);
      await nodes["pump-off"].click();
      assert.equal(nodes["input-value"].textContent, "OFF",
        `deactivate with physical=${physical} invert=${invert}`);
    }
  }
});

test("the run timer measures the gap and calls the short cycle", async () => {
  const state = freshState();
  const { nodes } = makePage(device(state));
  await nodes.connect.click();
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    await nodes["pump-on"].click();
    clock += 42_000;
    await nodes["pump-off"].click();
    assert.match(nodes.message.textContent, /42s/);
    assert.match(nodes.message.textContent, /under MinRuntime/);

    await nodes["pump-on"].click();
    clock += 75_000;
    await nodes["pump-off"].click();
    assert.match(nodes.message.textContent, /75s/);
    assert.match(nodes.message.textContent, /no strike is expected/);
  } finally {
    Date.now = realNow;
  }
});

test("a bare null reply is not reported as a failure", async () => {
  // The device answers null to Number.Set and Boolean.Set. Dereferencing that
  // threw, so every successful write used to report a phantom error.
  const state = freshState();
  const { nodes } = makePage(device(state));
  await nodes.connect.click();

  nodes["is-locked-input"].value = "90";
  await nodes["set-is-locked"].click();
  assert.notEqual(nodes.message.className, "error", nodes.message.textContent);
  assert.equal(state.locked, 90, "the write reached the device");

  await nodes["tab5-set"].click();
  assert.notEqual(nodes.message.className, "error", nodes.message.textContent);
  assert.equal(state.flag, true);
  assert.equal(nodes["tab5-value"].textContent, "TRUE");

  await nodes["tab5-clear"].click();
  assert.equal(state.flag, false);
  assert.equal(nodes["tab5-value"].textContent, "false");
});

test("a device without the boolean says so instead of failing obscurely", async () => {
  const state = freshState({ noFlag: true });
  const { nodes } = makePage(device(state));
  await nodes.connect.click();
  assert.equal(nodes["tab5-value"].textContent, "absent");
  await nodes["tab5-set"].click();
  assert.match(nodes.message.textContent, /not declared on the device/);
});

test("components are found by name and the id comes from config", async () => {
  // Ids are not stable across a rebuild, so a hard-coded one must not appear.
  const state = freshState();
  const { nodes, calls } = makePage(device(state));
  await nodes.connect.click();
  await nodes["tab5-set"].click();
  assert.ok(calls.some(c => c.includes("Boolean.Set") && c.includes("id=246")),
    "used the discovered id");
  assert.ok(calls.some(c => c.includes("dynamic_only=true")), "discovered by name first");
});

test("the relay is never written", async () => {
  const state = freshState();
  const { nodes, calls } = makePage(device(state));
  await nodes.connect.click();
  await nodes["pump-on"].click();
  await nodes["tab5-set"].click();
  nodes["is-locked-input"].value = "5";
  await nodes["set-is-locked"].click();
  await nodes["pump-off"].click();
  assert.ok(!calls.some(c => c.includes("Switch.Set")), "no relay write from any control");
});

test("clear invert puts the input config back", async () => {
  const state = freshState({ physical: false });
  const { nodes } = makePage(device(state));
  await nodes.connect.click();
  await nodes["pump-on"].click();
  assert.equal(state.invert, true, "activate flipped invert to report ON");
  await nodes["invert-clear"].click();
  assert.equal(state.invert, false);
  assert.equal(nodes["input-value"].textContent, "OFF");
});

test("input and switch are read from the keys-filtered components call", async () => {
  // Shelly.GetStatus was never captured from this device and did not carry a
  // usable input:0 in practice. The components envelope is the captured shape and
  // the one Tab5 itself reads.
  const state = freshState({ physical: true, relay: true });
  const { nodes, calls } = makePage(device(state));
  await nodes.connect.click();
  assert.equal(nodes["input-value"].textContent, "ON");
  assert.equal(nodes["relay-value"].textContent, "CLOSED");
  assert.ok(!calls.some(c => c.includes("Shelly.GetStatus")), "no GetStatus call");
  assert.ok(calls.some(c => c.includes("keys=") && c.includes("switch%3A0")),
    "asked for the static components by key");
});

test("a missing input:0 is reported plainly instead of as a type error", async () => {
  const state = freshState({ noInput: true });
  const { nodes } = makePage(device(state));
  await nodes.connect.click();
  assert.equal(nodes["input-value"].textContent, "—");
  await nodes["pump-on"].click();
  assert.match(nodes.message.textContent, /not returned by the keys-filtered/);
});

test("a stateless input:0 is named, not silently dashed", async () => {
  // A button-type input reports state null and emits events instead. The invert
  // trick cannot drive it, so the page has to say that rather than retry.
  const state = freshState({
    inputEntry: { key: "input:0", config: { id: 0, type: "button", enable: true },
                  status: { id: 0, state: null } },
  });
  const { nodes } = makePage(device(state));
  await nodes.connect.click();
  assert.equal(nodes["input-value"].textContent, "\u2014");
  assert.match(nodes["invert-note"].textContent, /type "button" reports no steady state/);

  await nodes["pump-on"].click();
  assert.equal(nodes.message.className, "error");
  assert.match(nodes.message.textContent, /type "button", not "switch"/);
  assert.match(nodes["diagnose-output"].textContent, /"state": null/,
    "the entry itself is dumped, so the device's own words are available");
});

test("a disabled input:0 is reported as disabled", async () => {
  const state = freshState({
    inputEntry: { key: "input:0", config: { id: 0, enable: false }, status: { id: 0 } },
  });
  const { nodes } = makePage(device(state));
  await nodes.connect.click();
  await nodes["pump-on"].click();
  assert.match(nodes.message.textContent, /disabled in its config/);
});

test("an absent input:0 is distinguished from a stateless one", async () => {
  const state = freshState({ noInput: true });
  const { nodes } = makePage(device(state));
  await nodes.connect.click();
  assert.match(nodes["invert-note"].textContent, /not returned by the device/);
});

test("Diagnose dumps each reply against the exact URL that fetched it", async () => {
  const state = freshState({ allowGetStatus: true });
  const { nodes, calls } = makePage(device(state));
  await nodes.connect.click();
  await nodes.diagnose.click();
  const dump = nodes["diagnose-output"].textContent;

  // The point of the panel is that the URL shown is the page's own encoding,
  // not a hand-typed one, so it has to be the string actually fetched.
  const filtered = calls.filter(c => c.includes("keys=")).pop();
  assert.ok(dump.includes(`GET ${filtered}`), `missing the filtered URL:\n${dump}`);
  assert.ok(dump.includes("input%3A0"), "the URL is shown percent-encoded as sent");
  assert.ok(dump.includes("Shelly.GetStatus"), "GetStatus is included only for comparison");
  assert.match(dump, /"key": "input:0"/, "the components reply is verbatim");
  assert.ok(!dump.includes("undefined"), dump);
});

test("Diagnose keeps going when one call fails, and the relay is still never written", async () => {
  const state = freshState();   // Shelly.GetStatus throws in this fake
  const { nodes, calls } = makePage(device(state));
  await nodes.connect.click();
  await nodes.diagnose.click();
  const dump = nodes["diagnose-output"].textContent;
  assert.match(dump, /Shelly\.GetStatus[\s\S]*FAILED/, dump);
  assert.match(dump, /"key": "input:0"/, "the calls before the failure are still reported");
  assert.ok(!calls.some(c => c.includes("Set")), "Diagnose only reads");
});

test("Copy falls back to a message when there is no clipboard", async () => {
  const state = freshState();
  const { nodes } = makePage(device(state));   // the sandbox has no navigator
  await nodes.connect.click();
  await nodes["diagnose-copy"].click();
  assert.match(nodes.message.textContent, /copy it manually/);
});
