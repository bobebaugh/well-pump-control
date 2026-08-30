"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _createHandler } = require("../cloud/netlify/functions/control-request");

const TYPES = ["clear-events", "monitor", "normal", "restart-tab5", "restart-shelly1"];

function fixture(initial = {}, options = {}) {
  let state = initial;
  let databaseCalls = 0;
  let path = null;
  const db = { ref(value) {
    path = value;
    return { async transaction(update) {
      if (options.transactionFailure) throw new Error("database unavailable");
      state = update(state);
      return { committed: true };
    } };
  } };
  const handler = _createHandler({
    getPilotDatabase: () => {
      databaseCalls += 1;
      if (options.configurationFailure) throw new (require("../cloud/netlify/lib/firebase").ConfigurationError)("bad config");
      return { db, projectId: options.projectId || "well-pump-control", databaseUrl: options.databaseUrl };
    },
    now: () => new Date("2026-08-30T00:00:07.000Z"),
    env: { PILOT_CONTROL_TOKEN: "control-key" }
  });
  return { handler, state: () => state, databaseCalls: () => databaseCalls, path: () => path };
}

function request(body, token = "control-key", extra = {}) {
  return { httpMethod: "POST", headers: { "X-Pilot-Key": token }, body: JSON.stringify(body), ...extra };
}

test("control-request maps only the five V3 commands into exact sequenced records", async () => {
  const value = fixture();
  const commands = [];
  for (const commandType of TYPES) {
    const result = await value.handler(request({ commandType }));
    assert.equal(result.statusCode, 201);
    commands.push(JSON.parse(result.body).command);
  }
  assert.deepEqual(commands.map(command => command.commandType), TYPES);
  assert.deepEqual(commands.map(command => command.commandSequence), [1, 2, 3, 4, 5]);
  for (const command of commands) {
    assert.deepEqual(Object.keys(command), [
      "schemaVersion", "runtimeSchemaVersion", "commandId", "commandSequence", "siteId",
      "targetDeviceId", "commandType", "requestedAt", "requestedBy", "status", "payload"]);
    assert.equal(command.runtimeSchemaVersion, 3);
    assert.deepEqual(command.payload, {});
    assert.deepEqual(command.requestedBy, { type: "user", id: "pilot-web" });
  }
  assert.equal(value.state()._nextCommandSequence, 5);
  assert.equal(value.path(), "v1/sites/well-main/devices/tab5-well-main/commands");
});

test("control-request migrates a pre-counter subtree above legacy command sequences", async () => {
  const prior = { legacyCommand: { commandSequence: 14, preserved: true } };
  const value = fixture({ ...prior });
  const body = JSON.parse((await value.handler(request({ commandType: "monitor" }))).body);
  assert.equal(body.command.commandSequence, 15);
  assert.deepEqual(value.state().legacyCommand, prior.legacyCommand);
  assert.equal(value.state()._nextCommandSequence, 15);
});

test("control-request uses the high-water command sequence despite stale counters and malformed children", async () => {
  const prior = {
    _nextCommandSequence: 9,
    legacy: { preserved: true },
    legacyCommand: { commandSequence: 14, preserved: true },
    malformed: { commandSequence: "not-an-integer", preserved: true }
  };
  const value = fixture({ ...prior });
  const body = JSON.parse((await value.handler(request({ commandType: "monitor" }))).body);
  assert.equal(body.command.commandSequence, 15);
  assert.deepEqual(value.state().legacy, prior.legacy);
  assert.deepEqual(value.state().legacyCommand, prior.legacyCommand);
  assert.deepEqual(value.state().malformed, prior.malformed);
  assert.equal(value.state()._nextCommandSequence, 15);
});

test("control-request ignores malformed children but never overwrites an existing command key", async () => {
  const existingId = "20260830000007-command-web_control-0000000001";
  const prior = {
    malformedScalar: "unrelated",
    malformedObject: { commandSequence: -1 },
    [existingId]: { preserved: true }
  };
  const value = fixture(prior);
  const body = JSON.parse((await value.handler(request({ commandType: "monitor" }))).body);
  assert.equal(body.command.commandSequence, 2);
  assert.deepEqual(value.state()[existingId], prior[existingId]);
  assert.equal(value.state()._nextCommandSequence, 2);
});

test("control-request authenticates before database use and rejects malformed input", async () => {
  const value = fixture();
  assert.equal((await value.handler(request({ commandType: "monitor" }, "ingest-key"))).statusCode, 401);
  assert.equal(value.databaseCalls(), 0);
  for (const body of [
    {}, { commandType: "close-event" }, { commandType: "monitor", payload: {} },
    { commandType: "monitor", runtimeSchemaVersion: 3 }
  ]) assert.equal((await value.handler(request(body))).statusCode, 400);
  assert.equal(value.databaseCalls(), 0);
  const encoded = Buffer.from(JSON.stringify({ commandType: "normal" }), "utf8").toString("base64");
  assert.equal((await value.handler({ httpMethod: "POST", headers: { "x-pilot-key": "control-key" }, isBase64Encoded: true, body: encoded })).statusCode, 201);
  assert.equal((await value.handler({ httpMethod: "GET", headers: {}, body: "" })).statusCode, 405);
  assert.equal((await value.handler({ httpMethod: "POST", headers: { "x-pilot-key": "control-key" }, body: "x".repeat(4097) })).statusCode, 400);
});

test("control-request guards overflow, configuration, host, and database failures", async () => {
  let value = fixture({ _nextCommandSequence: 9999999999 });
  assert.equal((await value.handler(request({ commandType: "normal" }))).statusCode, 400);
  assert.equal(value.state()._nextCommandSequence, 9999999999);
  value = fixture({ legacyCommand: { commandSequence: 9999999999 } });
  assert.equal((await value.handler(request({ commandType: "normal" }))).statusCode, 400);
  assert.deepEqual(value.state().legacyCommand, { commandSequence: 9999999999 });
  value = fixture({}, { transactionFailure: true });
  assert.equal((await value.handler(request({ commandType: "normal" }))).statusCode, 503);
  value = fixture({}, { configurationFailure: true });
  assert.equal((await value.handler(request({ commandType: "normal" }))).statusCode, 503);
  value = fixture({}, { databaseUrl: "https://evil.example" });
  assert.equal((await value.handler(request({ commandType: "normal" }))).statusCode, 503);
});
