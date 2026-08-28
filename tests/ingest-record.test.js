"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { _createHandler } = require("../cloud/netlify/functions/ingest-record");
const { IngestRecordError, validateIngestRecord } = require("../cloud/netlify/lib/ingest-record-contract");

const root = path.resolve(__dirname, "..");
const readJson = relative => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const observation = readJson("contracts/examples/v1/durable-observation.json");
const eventOpen = readJson("contracts/examples/v1/event-open.json");
const eventClose = readJson("contracts/examples/v1/event-close.json");
const ruleAdoption = {
  schemaVersion: 1,
  recordType: "rule-adoption",
  recordId: "20260825000042-rule-adoption-boot_A7f93k2Q-0000000042",
  siteId: "well-main",
  deviceId: "tab5-well-main",
  sessionId: "boot_A7f93k2Q",
  sequence: 42,
  observedAt: "2026-08-25T00:00:42Z",
  rulesRelease: {
    version: 1,
    contentHash: "ee0220eebdd0fa9b3b9751435180c17a16d3c93cb5f7325f1ab74d8d132e410a"
  },
  releaseId: "20260825000000-rules-v1",
  activeRules: {
    version: 1,
    contentHash: "ee0220eebdd0fa9b3b9751435180c17a16d3c93cb5f7325f1ab74d8d132e410a"
  },
  actor: { type: "device", id: "tab5-well-main" }
};

class FakeTimestamp {
  constructor(date) { this.date = date; }
  toDate() { return this.date; }
}

function fakeFirestore() {
  const records = new Map();
  const document = parts => ({
    path: parts.join("/"),
    collection(name) { return collection([...parts, name]); }
  });
  const collection = parts => ({
    doc(id) { return document([...parts, id]); }
  });
  const db = {
    collection(name) { return collection([name]); },
    async runTransaction(callback) {
      const transaction = {
        async get(ref) {
          return { exists: records.has(ref.path), data: () => records.get(ref.path) };
        },
        create(ref, value) {
          if (records.has(ref.path)) throw new Error("already exists");
          records.set(ref.path, value);
        },
        set(ref, value, options) {
          const previous = records.get(ref.path) || {};
          records.set(ref.path, options?.merge ? { ...previous, ...value } : value);
        }
      };
      return callback(transaction);
    }
  };
  return { db, records };
}

function makeHandler() {
  const { db, records } = fakeFirestore();
  const handler = _createHandler({
    getPilotFirestore: () => ({ db, projectId: "well-pump-control", databaseId: "(default)" }),
    toTimestamp: date => new FakeTimestamp(date),
    serverTimestamp: () => new FakeTimestamp(new Date("2026-08-24T18:00:00.000Z")),
    env: { PILOT_INGEST_TOKEN: "test-ingest-token" }
  });
  return { handler, records };
}

function request(body, token = "test-ingest-token") {
  return { httpMethod: "POST", headers: { "X-Pilot-Key": token }, body: JSON.stringify(body) };
}

test("stores a complete durable observation at its contract path", async () => {
  const { handler, records } = makeHandler();
  const result = await handler(request(observation));
  assert.equal(result.statusCode, 201);
  const body = JSON.parse(result.body);
  assert.equal(body.duplicate, false);
  const stored = records.get(body.document);
  assert.deepEqual(stored.values.futureCalculatedValue, { value: 3.2, unit: "gpm" });
  assert.deepEqual(stored.futureEnvelopeField, ["preserved"]);
  assert.equal(stored.observedAt.toDate().toISOString(), observation.observedAt);
  assert.equal(stored.receivedAt.toDate().toISOString(), "2026-08-24T18:00:00.000Z");
});

test("accepts Netlify base64-encoded request bodies", async () => {
  const { handler } = makeHandler();
  const result = await handler({
    httpMethod: "POST",
    headers: { "X-Pilot-Key": "test-ingest-token" },
    isBase64Encoded: true,
    body: Buffer.from(JSON.stringify(observation), "utf8").toString("base64")
  });
  assert.equal(result.statusCode, 201);
});

test("stores event openings and closings as separate records sharing eventId", async () => {
  const { handler, records } = makeHandler();
  const opened = JSON.parse((await handler(request(eventOpen))).body);
  const closed = JSON.parse((await handler(request(eventClose))).body);
  assert.equal(records.get(opened.document).eventId, eventOpen.eventId);
  assert.equal(records.get(closed.document).eventId, eventOpen.eventId);
  assert.notEqual(opened.recordId, closed.recordId);
  const instance = records.get(`sites/well-main/eventInstances/${eventOpen.eventId}`);
  assert.equal(instance.status, "closed");
  assert.equal(instance.closeReason, eventClose.closeReason);
});

test("stores rules adoption and rejection audit records without creating event lifecycle state", async () => {
  const { handler, records } = makeHandler();
  const adopted = await handler(request(ruleAdoption));
  assert.equal(adopted.statusCode, 201);
  const rejectedRecord = {
    ...ruleAdoption,
    recordType: "rule-rejection",
    recordId: "20260825000043-rule-rejection-boot_A7f93k2Q-0000000043",
    sequence: 43,
    observedAt: "2026-08-25T00:00:43Z",
    rejectionReason: "release-hash-mismatch"
  };
  delete rejectedRecord.activeRules;
  const rejected = await handler(request(rejectedRecord));
  assert.equal(rejected.statusCode, 201);
  assert.equal(records.size, 2);
});

test("accepts a close before its independently retried opening and preserves a closed instance", async () => {
  const { handler, records } = makeHandler();
  const result = await handler(request(eventClose));
  assert.equal(result.statusCode, 201);
  assert.equal(records.size, 2);
  assert.equal(records.get(`sites/well-main/eventInstances/${eventClose.eventId}`).status, "closed");
});

test("an identical retry is accepted without a second document", async () => {
  const { handler, records } = makeHandler();
  assert.equal((await handler(request(observation))).statusCode, 201);
  const retry = await handler(request({ ...observation, receivedAt: "2026-08-24T19:00:00.000Z" }));
  assert.equal(retry.statusCode, 200);
  assert.equal(JSON.parse(retry.body).duplicate, true);
  assert.equal(records.size, 1);
});

test("JSON key order and omission of caller receipt time do not change idempotency", async () => {
  const { handler, records } = makeHandler();
  const withoutReceipt = { ...observation };
  delete withoutReceipt.receivedAt;
  assert.equal((await handler(request(withoutReceipt))).statusCode, 201);
  const reordered = Object.fromEntries(Object.entries(withoutReceipt).reverse());
  const retry = await handler(request(reordered));
  assert.equal(retry.statusCode, 200);
  assert.equal(JSON.parse(retry.body).duplicate, true);
  assert.equal(records.size, 1);
});

test("equivalent RFC3339 offsets normalize without a false retry conflict", async () => {
  const { handler } = makeHandler();
  const offsetObservation = { ...observation, observedAt: "2026-08-24T13:30:45.125-04:00" };
  assert.equal((await handler(request(offsetObservation))).statusCode, 201);
  assert.equal((await handler(request(offsetObservation))).statusCode, 200);
});

test("a changed payload under an existing recordId is rejected", async () => {
  const { handler } = makeHandler();
  await handler(request(observation));
  const conflict = await handler(request({ ...observation, values: { ...observation.values, powerW: 1 } }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.body).code, "idempotency_conflict");
});

test("validates fixed identity before any Firestore write", async () => {
  const { handler, records } = makeHandler();
  const result = await handler(request({ ...observation, deviceId: "other-device" }));
  assert.equal(result.statusCode, 403);
  assert.equal(records.size, 0);
});

test("rejects unauthorized, malformed, and unsupported records", async () => {
  const { handler } = makeHandler();
  assert.equal((await handler(request(observation, "wrong"))).statusCode, 401);
  assert.equal((await handler(request({ ...observation, schemaVersion: 2 }))).statusCode, 400);
  assert.equal((await handler(request({ ...observation, values: null }))).statusCode, 400);
  assert.equal((await handler({ httpMethod: "GET", headers: {}, body: "" })).statusCode, 405);
  assert.equal((await handler({ httpMethod: "POST", headers: { "X-Pilot-Key": "test-ingest-token" }, body: "{" })).statusCode, 400);
  const oversized = { httpMethod: "POST", headers: { "X-Pilot-Key": "test-ingest-token" }, body: JSON.stringify({ padding: "x".repeat(65536) }) };
  assert.equal(JSON.parse((await handler(oversized)).body).code, "payload_too_large");
});

test("reports missing configuration and Firestore failure without exposing details", async () => {
  const missing = _createHandler({ env: {} });
  assert.equal((await missing(request(observation))).statusCode, 503);
  const failing = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-ingest-token" },
    getPilotFirestore: () => ({
      projectId: "well-pump-control",
      databaseId: "(default)",
      db: { collection() { throw new Error("private provider detail"); } }
    })
  });
  const result = await failing(request(observation));
  assert.equal(result.statusCode, 503);
  assert.deepEqual(JSON.parse(result.body), { status: "error", code: "firestore_unavailable" });
  const wrongTarget = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-ingest-token" },
    getPilotFirestore: () => ({ db: {}, projectId: "other-project", databaseId: "(default)" })
  });
  assert.deepEqual(JSON.parse((await wrongTarget(request(observation))).body), {
    status: "error", code: "configuration_missing"
  });
});

test("identifier components must agree with observation time, session, type, and sequence", () => {
  for (const value of [
    { ...observation, sequence: 43 },
    { ...observation, observedAt: "2026-08-24T17:30:46.125Z" },
    { ...eventOpen, ruleId: "other-rule" },
    { ...eventClose, ruleId: "other-rule" },
    { ...eventClose, recordType: "event-open" }
  ]) {
    assert.throws(() => validateIngestRecord(value), error => error instanceof IngestRecordError);
  }
});

test("strict timestamps and all declared optional event fields match the versioned contract", () => {
  for (const value of [
    { ...observation, observedAt: "2026-08-24" },
    { ...observation, observedAt: "2026-02-30T17:30:45Z", recordId: "20260302173045-observation-boot_A7f93k2Q-0000000042" },
    { ...eventClose, commandId: "bad" },
    { ...eventClose, severity: "green" },
    { ...eventClose, latched: "yes" },
    { ...eventOpen, closeReason: "not-a-reason" }
  ]) {
    assert.throws(() => validateIngestRecord(value), error => error instanceof IngestRecordError);
  }
});

test("unknown future fields remain accepted while unsafe object keys and depth are rejected", () => {
  assert.equal(validateIngestRecord({ ...observation, futureField: { nested: true } }).futureField.nested, true);
  const unsafe = JSON.parse(JSON.stringify(observation));
  unsafe.values = JSON.parse('{"__proto__":"unsafe"}');
  assert.throws(() => validateIngestRecord(unsafe), error => error instanceof IngestRecordError);
  assert.throws(() => validateIngestRecord({ ...observation, futureField: Number.POSITIVE_INFINITY }), error => error instanceof IngestRecordError);
  let nested = {};
  const tooDeep = nested;
  for (let index = 0; index < 18; index += 1) nested = nested.next = {};
  assert.throws(() => validateIngestRecord({ ...observation, futureField: tooDeep }), error => error instanceof IngestRecordError);
});
