"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SILENCE_AFTER_MS, checkDeviceSilence, decideSilence } = require("../cloud/netlify/lib/device-silence");
const { _createHandler } = require("../cloud/netlify/functions/device-silence");

const NOW = Date.parse("2026-09-28T15:00:00Z");
const ENV = { RESEND_API_KEY: "k", NOTIFY_FROM: "f@x", NOTIFY_EMAIL_TO: "e@x", NOTIFY_SMS_TO: "s@x" };

test("silence is a record-free half hour, judged by receipt time", () => {
  assert.equal(SILENCE_AFTER_MS, 1800000);
  assert.equal(decideSilence({ lastReceivedMs: NOW - SILENCE_AFTER_MS, nowMs: NOW, state: null }).next.status, "ok");
  const silent = decideSilence({ lastReceivedMs: NOW - SILENCE_AFTER_MS - 1, nowMs: NOW, state: { status: "ok" } });
  assert.equal(silent.next.status, "silent");
  assert.equal(silent.message.kind, "silent");
  assert.match(silent.message.text, /No record from the Tab5 since .*\(30 min\)/);
  assert.equal(decideSilence({ lastReceivedMs: null, nowMs: NOW, state: null }).message.kind, "silent");
});

test("one message when silence starts, none while it lasts, one when records resume", () => {
  const since = new Date(NOW - 3 * 3600000).toISOString();
  assert.equal(decideSilence({ lastReceivedMs: NOW - 3 * 3600000, nowMs: NOW, state: { status: "silent", lastReceivedAt: since } }).message, null);
  const resumed = decideSilence({ lastReceivedMs: NOW - 60000, nowMs: NOW, state: { status: "silent", lastReceivedAt: since } });
  assert.equal(resumed.message.kind, "resumed");
  assert.match(resumed.message.text, /after 179 min without one/);
  assert.equal(decideSilence({ lastReceivedMs: NOW - 60000, nowMs: NOW, state: { status: "ok" } }).message, null);
});

test("messages are plain ASCII so a text stays in GSM-7 segments", () => {
  for (const kind of [
    decideSilence({ lastReceivedMs: NOW - 7200000, nowMs: NOW, state: null }).message,
    decideSilence({ lastReceivedMs: NOW, nowMs: NOW, state: { status: "silent", lastReceivedAt: new Date(NOW - 7200000).toISOString() } }).message
  ]) {
    assert.match(kind.subject + kind.text, /^[\x20-\x7e]+$/);
    assert.ok(kind.subject.startsWith("MF-Well "));
  }
});

function harness({ lastReceivedMs, state, env = ENV, status = 200 }) {
  const calls = [], writes = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: status < 300, status }; };
  return {
    calls, writes,
    run: () => checkDeviceSilence({
      readNewestReceivedMs: async () => lastReceivedMs, readState: async () => state,
      writeState: async value => { writes.push(value); }, nowMs: NOW, env, fetchImpl, log: { error() {} }
    })
  };
}

test("a transition sends email and text in one idempotent batch, then records the state", async () => {
  const h = harness({ lastReceivedMs: NOW - 3600000, state: { status: "ok" } });
  const result = await h.run();
  assert.deepEqual(result.sent, { kind: "silent", status: "sent" });
  assert.equal(h.calls.length, 1);
  const body = JSON.parse(h.calls[0].options.body);
  assert.deepEqual(body.map(message => message.to[0]), ["e@x", "s@x"]);
  assert.match(h.calls[0].options.headers["Idempotency-Key"], /^[0-9a-f]{64}$/);
  assert.equal(h.writes.at(-1).status, "silent");
  assert.equal(h.writes.at(-1).notified.kind, "silent");
});

test("a failed send leaves the state alone so the next run retries it", async () => {
  const h = harness({ lastReceivedMs: NOW - 3600000, state: { status: "ok" }, status: 500 });
  assert.deepEqual((await h.run()).sent, { kind: "silent", status: "failed", code: "resend_500" });
  assert.equal(h.writes.length, 0);
});

test("dry run and missing settings never call Resend", async () => {
  const dry = harness({ lastReceivedMs: NOW - 3600000, state: null, env: { ...ENV, NOTIFY_DRY_RUN: "1" } });
  assert.equal((await dry.run()).sent.status, "dry-run");
  assert.equal(dry.calls.length, 0);
  assert.equal(dry.writes.at(-1).status, "silent");
  const missing = harness({ lastReceivedMs: NOW - 3600000, state: null, env: {} });
  assert.equal((await missing.run()).sent.status, "not-configured");
  assert.equal(missing.calls.length, 0);
});

test("steady running writes the state once and sends nothing", async () => {
  const first = harness({ lastReceivedMs: NOW - 60000, state: null });
  await first.run();
  assert.equal(first.writes.length, 1);
  const later = harness({ lastReceivedMs: NOW - 60000, state: { status: "ok" } });
  await later.run();
  assert.equal(later.writes.length + later.calls.length, 0);
});

test("the scheduled handler reads the newest record by receipt and stores its own state", async () => {
  const queries = [], stored = {};
  const newest = { receivedAt: { toMillis: () => NOW - 3600000 } };
  const query = {
    where(field, op, value) { queries.push(["where", field, op, value]); return query; },
    orderBy(field, direction) { queries.push(["orderBy", String(field), direction]); return query; },
    limit(count) { queries.push(["limit", count]); return query; },
    async get() { return { docs: [{ data: () => newest }] }; }
  };
  const site = {
    collection(name) {
      if (name === "observations") return query;
      return { doc: id => ({
        async get() { return { exists: Boolean(stored[`${name}/${id}`]), data: () => stored[`${name}/${id}`] }; },
        async set(value) { stored[`${name}/${id}`] = value; }
      }) };
    }
  };
  const db = { collection: () => ({ doc: () => site }) };
  const handler = _createHandler({ getPilotFirestore: () => ({ db }), env: { ...ENV, NOTIFY_DRY_RUN: "1" }, now: () => NOW });
  const response = await handler({});
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).device, "silent");
  assert.deepEqual(queries.slice(0, 3), [["where", "deviceId", "==", "tab5-well-main"], ["where", "schemaVersion", "==", 2], ["orderBy", "receivedAt", "desc"]]);
  assert.equal(stored["alerts/device-silence"].status, "silent");
  const again = await handler({});
  assert.equal(JSON.parse(again.body).sent, null, "a second run in the same silence sends nothing");
});
