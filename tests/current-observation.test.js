"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../cloud/netlify/functions/current-observation");

const NOW = Date.parse("2026-09-15T18:00:10Z");

function handlerFor(record, { ok = true, env = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes("identitytoolkit")) {
      return { ok: true, async json() { return { idToken: "token-abc" }; } };
    }
    return { ok, async json() { return record; } };
  };
  const handler = createHandler({
    env: { FIREBASE_WEB_API_KEY: "key", FIREBASE_RTDB_URL:
             "https://well-pump-control-default-rtdb.firebaseio.com", ...env },
    firebase: { getPilotAuth: () => ({
      projectId: "well-pump-control",
      auth: { async createCustomToken() { return "custom"; } } }) },
    fetch: fetchImpl,
    now: () => NOW
  });
  return { handler, calls };
}

function observation(over = {}) {
  return {
    schemaVersion: 1, siteId: "well-main", deviceId: "tab5-well-main",
    sessionId: "boot_abc", sequence: 42,
    observedAt: "2026-09-15T18:00:08Z",
    receivedAtMs: Date.parse("2026-09-15T18:00:08Z"),
    values: { pressure_psi: 50.0018, adc_raw: 14307, power: 2800.0, voltage: 240.0,
              pf: 0.98, battery_percent: 78, shelly1_sw0: true, shelly1_rly0: false,
              shelly1_lock: 0, shelly1_lockout_count: 0, shelly1_tab5lock: false },
    status: { shelly1_available: true, shelly_available: true,
              pressure_sensor_commissioned: true, pressure_valid: true },
    ...over
  };
}

async function body(record, options) {
  const { handler } = handlerFor(record, options);
  const reply = await handler({ httpMethod: "GET" });
  return { statusCode: reply.statusCode, ...JSON.parse(reply.body) };
}

test("the live record carries pressure, which is why this endpoint exists", async () => {
  const reply = await body(observation());
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.values.pressurePsi, 50.0018);
  assert.equal(reply.values.adcRaw, 14307);
  assert.equal(reply.pressureCommissioned, true);
});

test("every live reading comes from the one record, so they share an instant", async () => {
  const reply = await body(observation());
  assert.deepEqual(reply.values, {
    pressurePsi: 50.0018, adcRaw: 14307, powerW: 2800, voltageV: 240,
    powerFactor: 0.98, batteryPercent: 78
  });
  assert.deepEqual(reply.shelly1, {
    available: true, sw0: true, rly0: false,
    isLocked: 0, lockoutCount: 0, tab5IsLocked: false
  });
});

test("age is measured from the server stamp, not the device clock", async () => {
  // The device clock steps at SNTP; the server stamp is what tells the page the
  // device has gone quiet.
  assert.equal((await body(observation())).ageSeconds, 2);
  assert.equal((await body(observation({ receivedAtMs: null }))).ageSeconds, null);
  // A stamp ahead of us must not read as a negative age.
  assert.equal((await body(observation({ receivedAtMs: NOW + 5000 }))).ageSeconds, 0);
});

test("a missing or unusable value is null rather than a guess", async () => {
  const reply = await body(observation({
    values: { pressure_psi: "50", power: null, voltage: Infinity, pf: NaN,
              shelly1_sw0: "true" },
    status: {}
  }));
  assert.equal(reply.values.pressurePsi, null);
  assert.equal(reply.values.powerW, null);
  assert.equal(reply.values.voltageV, null);
  assert.equal(reply.values.powerFactor, null);
  assert.equal(reply.shelly1.sw0, null);
  assert.equal(reply.pressureCommissioned, null);
});

test("an absent record is reported as empty, not as an error", async () => {
  assert.equal((await body(null)).code, "telemetry_missing");
  assert.equal((await body(null)).statusCode, 404);
});

test("configuration and transport failures are distinguished", async () => {
  const missing = await body(observation(), { env: { FIREBASE_WEB_API_KEY: "" } });
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.code, "configuration_missing");

  const failed = await body(observation(), { ok: false });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.code, "rtdb_read_failed");
});

test("it authenticates as the identity the RTDB rules actually permit", async () => {
  // currentObservation grants read to netlify-operator-control with
  // purpose operator-control and nothing else. A reader identity of this
  // endpoint's own invention is denied until the rules are hand-deployed, so
  // this pins the pairing rather than trusting it.
  const { OPERATOR_UID } = require("../cloud/netlify/lib/operator-control-store");
  let minted = null;
  const handler = createHandler({
    env: { FIREBASE_WEB_API_KEY: "key", FIREBASE_RTDB_URL:
             "https://well-pump-control-default-rtdb.firebaseio.com" },
    firebase: { getPilotAuth: () => ({
      projectId: "well-pump-control",
      auth: { async createCustomToken(uid, claims) { minted = { uid, claims }; return "custom"; } } }) },
    fetch: async url => String(url).includes("identitytoolkit")
      ? { ok: true, async json() { return { idToken: "t" }; } }
      : { ok: true, async json() { return observation(); } },
    now: () => NOW
  });
  await handler({ httpMethod: "GET" });
  assert.equal(minted.uid, OPERATOR_UID);
  assert.equal(minted.claims.purpose, "operator-control");
  assert.equal(minted.claims.siteId, "well-main");
  assert.equal(minted.claims.deviceId, "tab5-well-main");
});

test("it reads the path Tab5 writes, and only answers GET", async () => {
  const { handler, calls } = handlerFor(observation());
  await handler({ httpMethod: "GET" });
  const read = calls.find(call => String(call.url).includes("currentObservation"));
  assert.ok(read, "must read currentObservation");
  assert.match(read.url,
    /sites\/well-main\/devices\/tab5-well-main\/currentObservation\.json/);

  const rejected = await handler({ httpMethod: "POST" });
  assert.equal(rejected.statusCode, 405);
});
