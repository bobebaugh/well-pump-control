"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _createHandler, _shelly1State } = require("../cloud/netlify/functions/current-power");

function timestamp(iso) {
  return { toDate() { return new Date(iso); } };
}

function handlerFor(data) {
  const snapshot = { exists: Boolean(data), data() { return data; } };
  const db = {
    collection() { return { doc() { return { collection() { return { doc() { return { async get() { return snapshot; } }; } }; } }; } }; }
  };
  return _createHandler({
    getPilotFirestore: () => ({ db }),
    now: () => Date.parse("2026-08-25T14:00:10Z")
  });
}

test("returns installed Shelly 1 SW0 and RLY0 from the complete observation", async () => {
  const handler = handlerFor({
    deviceId: "shelly-em-well", pumpRunning: true,
    observedAt: timestamp("2026-08-25T14:00:09Z"),
    receivedAt: timestamp("2026-08-25T14:00:09Z"),
    values: { powerW: 2500 },
    observation: {
      values: { shelly1_sw0: true, shelly1_rly0: false },
      status: { shelly1_available: true }
    }
  });
  const result = await handler({ httpMethod: "GET" });
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.deepEqual(body.shelly1, { available: true, sw0: true, rly0: false });
  assert.equal(body.ageSeconds, 1);
});

test("keeps older telemetry compatible and reports unknown Shelly 1 state", async () => {
  assert.deepEqual(_shelly1State(undefined), { available: null, sw0: null, rly0: null });
  const result = await handlerFor(null)({ httpMethod: "GET" });
  assert.equal(result.statusCode, 404);
});
