"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _createHandler } = require("../cloud/netlify/functions/control-request");

function makeHandler() {
  let state = {};
  const root = { transaction: async update => { state = update(state); } };
  return {
    handler: _createHandler({
      getPilotDatabase: () => ({ projectId: "well-pump-control", db: { ref: () => root } }),
      now: () => new Date("2026-08-28T21:15:30.000Z"),
      env: { PILOT_INGEST_TOKEN: "pilot-key" }
    }),
    state: () => state
  };
}

function request(commandType, token = "pilot-key") {
  return { httpMethod: "POST", headers: { "X-Pilot-Key": token }, body: JSON.stringify({ commandType }) };
}

test("control-request writes a sequenced, device-scoped System Override command", async () => {
  const fixture = makeHandler();
  const result = await fixture.handler(request("system-override"));
  assert.equal(result.statusCode, 201);
  const body = JSON.parse(result.body);
  assert.equal(body.command.commandType, "system-override");
  assert.equal(body.command.commandSequence, 1);
  assert.match(body.command.commandId, /^20260828211530-command-web-client-0000000001$/);
  assert.deepEqual(fixture.state().devices["tab5-well-main"].commands[body.command.commandId], body.command);
});

test("control-request rejects unauthenticated and unsupported commands before database access", async () => {
  const fixture = makeHandler();
  assert.equal((await fixture.handler(request("system-override", "wrong"))).statusCode, 401);
  assert.equal((await fixture.handler(request("not-a-command"))).statusCode, 400);
  assert.deepEqual(fixture.state(), {});
});
