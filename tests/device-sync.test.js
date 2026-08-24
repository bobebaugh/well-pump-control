"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const {
  _approvedRtdbUrl,
  _createHandler,
  _rtdbPath,
  _tokenMatches
} = require("../cloud/netlify/functions/device-sync");
const { validateDeviceSyncRequest } = require("../cloud/netlify/lib/device-sync-contract");

const root = path.resolve(__dirname, "..");
const request = JSON.parse(readFileSync(path.join(root, "contracts/examples/v1/device-sync-request.json"), "utf8"));
const command = JSON.parse(readFileSync(path.join(root, "contracts/examples/v1/device-command.json"), "utf8"));

function jsonResult(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeHandler(overrides = {}) {
  const calls = [];
  const signedClaims = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("accounts:signInWithCustomToken")) {
      return jsonResult({ idToken: "EXAMPLE_ONLY_ID_TOKEN", refreshToken: "EXAMPLE_ONLY_REFRESH_TOKEN", expiresIn: "3600" });
    }
    if (url.includes("/commands.json")) {
      return jsonResult({
        stale: { ...command, commandSequence: request.lastAppliedCommandSequence },
        next: command,
        otherDevice: { ...command, commandId: command.commandId.replace("0012", "0013"), commandSequence: 13, targetDeviceId: "other-device" }
      });
    }
    if (url.includes("/control/globalEnable.json")) return jsonResult({ desired: true });
    if (url.includes("/rules/current.json")) return jsonResult({ rulesVersion: 4, contentHash: "f".repeat(64) });
    throw new Error(`unexpected URL ${url}`);
  };
  const handler = _createHandler({
    fetch,
    getPilotAuth: () => ({
      projectId: "well-pump-control",
      auth: { createCustomToken: async (uid, claims) => {
        assert.equal(uid, "tab5-well-main");
        signedClaims.push(claims);
        return claims.purpose === "device-sync-probe"
          ? "EXAMPLE_ONLY_PROBE_TOKEN"
          : "EXAMPLE_ONLY_CUSTOM_TOKEN";
      } }
    }),
    now: () => new Date("2026-08-24T20:00:00.000Z"),
    env: {
      PILOT_INGEST_TOKEN: "test-ingest-token",
      FIREBASE_WEB_API_KEY: "EXAMPLE_ONLY_API_KEY",
      FIREBASE_RTDB_URL: "https://well-pump-control-default-rtdb.firebaseio.com"
    },
    ...overrides
  });
  return { handler, calls, signedClaims };
}

function event(body = request, token = "test-ingest-token") {
  return { httpMethod: "POST", headers: { "X-Pilot-Key": token }, body: JSON.stringify(body) };
}

test("device-sync exchanges a custom token and returns ordered RTDB coordination", async () => {
  const { handler, calls, signedClaims } = makeHandler();
  const result = await handler(event());
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.exchangeId, request.exchangeId);
  assert.equal(body.authenticationBootstrap.firebaseCustomToken, "EXAMPLE_ONLY_CUSTOM_TOKEN");
  assert.equal(body.highWaterCommandSequence, 12);
  assert.deepEqual(body.pendingCommands.map(item => item.commandSequence), [12]);
  assert.equal(body.globalEnable, true);
  assert.deepEqual(body.currentRules, { version: 4, contentHash: "f".repeat(64) });
  assert.deepEqual(body.canonicalOpenEvents, request.openEventIds);
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /accounts:signInWithCustomToken\?key=/);
  assert.match(calls[0].options.body, /EXAMPLE_ONLY_PROBE_TOKEN/);
  assert.ok(calls.slice(1).every(call => call.url.includes("auth=EXAMPLE_ONLY_ID_TOKEN")));
  assert.deepEqual(signedClaims.map(claims => claims.purpose), ["device-sync-probe", "device-transport"]);
});

test("device-sync request validation rejects unsupported schema versions", async () => {
  const { handler } = makeHandler();
  const result = await handler(event({ ...request, schemaVersion: 2 }));
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).code, "unsupported_schema_version");
});

test("device-sync authenticates before signing any Firebase token", async () => {
  let authCalls = 0;
  const { handler } = makeHandler({ getPilotAuth: () => { authCalls += 1; throw new Error("should not run"); } });
  const result = await handler(event(request, "wrong-token"));
  assert.equal(result.statusCode, 401);
  assert.equal(authCalls, 0);
});

test("device-sync validates fixed device identity", async () => {
  const { handler } = makeHandler();
  const result = await handler(event({ ...request, deviceId: "other-device" }));
  assert.equal(result.statusCode, 403);
});

test("RTDB URL builder scopes JSON paths and token", () => {
  const url = _rtdbPath(
    { rtdbUrl: "https://example.invalid" },
    "v1/sites/well-main/devices/tab5-well-main/currentObservation",
    "token with spaces"
  );
  assert.equal(url, "https://example.invalid/v1/sites/well-main/devices/tab5-well-main/currentObservation.json?auth=token%20with%20spaces");
});

test("RTDB rules are closed by default and scope the fixed device", () => {
  const rules = JSON.parse(readFileSync(path.join(root, "firebase/rtdb.rules.json"), "utf8")).rules;
  assert.equal(rules[".read"], false);
  assert.equal(rules[".write"], false);
  const site = rules.v1.sites["well-main"];
  const device = site.devices["tab5-well-main"];
  assert.match(device.currentObservation[".write"], /auth\.uid == 'tab5-well-main'/);
  assert.equal(Object.hasOwn(device.currentObservation, ".read"), false);
  assert.equal(Object.hasOwn(device.presence, ".read"), false);
  assert.equal(Object.hasOwn(device.syncState, ".read"), false);
  assert.match(device.commands[".read"], /auth\.uid == 'tab5-well-main'/);
  assert.equal(device.commands[".write"], false);
  assert.equal(site.control.globalEnable[".write"], false);
  assert.equal(site.rules.current[".write"], false);
});

test("published request example is accepted by runtime validation", () => {
  assert.equal(validateDeviceSyncRequest(request), request);
});

test("duplicate exchange is operationally retry-safe without response replay or RTDB writes", async () => {
  let tokenNumber = 0;
  let clockNumber = 0;
  const { handler, calls } = makeHandler({
    getPilotAuth: () => ({
      projectId: "well-pump-control",
      auth: {
        createCustomToken: async () => `EXAMPLE_ONLY_TOKEN_${++tokenNumber}`
      }
    }),
    now: () => new Date(1787601600000 + (clockNumber++ * 1000))
  });
  const caughtUp = { ...request, lastAppliedCommandSequence: 12 };
  const first = JSON.parse((await handler(event(caughtUp))).body);
  const second = JSON.parse((await handler(event(caughtUp))).body);

  assert.equal(first.exchangeId, caughtUp.exchangeId);
  assert.equal(second.exchangeId, caughtUp.exchangeId);
  assert.deepEqual(first.pendingCommands, []);
  assert.deepEqual(second.pendingCommands, []);
  assert.notEqual(first.authenticationBootstrap.firebaseCustomToken,
    second.authenticationBootstrap.firebaseCustomToken);
  assert.notEqual(first.issuedAt, second.issuedAt);
  const rtdbCalls = calls.filter(call => call.url.includes("firebaseio.com"));
  assert.equal(rtdbCalls.length, 6);
  assert.ok(rtdbCalls.every(call => (call.options.method || "GET") === "GET"));
});

test("malformed command envelopes with extra fields are not delivered", async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes("accounts:signInWithCustomToken")) return jsonResult({ idToken: "EXAMPLE_ONLY_ID_TOKEN" });
    if (url.includes("/commands.json")) return jsonResult({ malformed: { ...command, extraEnvelopeField: true } });
    if (url.includes("/control/globalEnable.json")) return jsonResult(false);
    if (url.includes("/rules/current.json")) return jsonResult(null);
    throw new Error(`unexpected URL ${url}`);
  };
  const { handler } = makeHandler({ fetch });
  const body = JSON.parse((await handler(event())).body);
  assert.deepEqual(body.pendingCommands, []);
});

test("malformed nested command actors and schema fields are not delivered", async () => {
  const variants = [
    { ...command, requestedBy: { ...command.requestedBy, role: "admin" } },
    { ...command, requestedBy: { type: "user", id: "x".repeat(129) } },
    { ...command, requestedAt: "not-a-date" },
    { ...command, commandId: "command-12" },
    { ...command, commandSequence: 0 }
  ];
  for (const malformed of variants) {
    const fetch = async (url) => {
      if (url.includes("accounts:signInWithCustomToken")) return jsonResult({ idToken: "EXAMPLE_ONLY_ID_TOKEN" });
      if (url.includes("/commands.json")) return jsonResult({ malformed });
      if (url.includes("/control/globalEnable.json")) return jsonResult(false);
      if (url.includes("/rules/current.json")) return jsonResult(null);
      throw new Error(`unexpected URL ${url}`);
    };
    const { handler } = makeHandler({ fetch });
    const body = JSON.parse((await handler(event())).body);
    assert.deepEqual(body.pendingCommands, []);
  }
});

test("configuration accepts only the approved project RTDB host", () => {
  assert.equal(
    _approvedRtdbUrl("https://well-pump-control-default-rtdb.firebaseio.com/", "well-pump-control"),
    "https://well-pump-control-default-rtdb.firebaseio.com"
  );
  assert.throws(
    () => _approvedRtdbUrl("https://evil.example/well-pump-control", "well-pump-control"),
    /approved project database host/
  );
});

test("ingest token comparison uses equal-length digests", () => {
  assert.equal(_tokenMatches("same-token", "same-token"), true);
  assert.equal(_tokenMatches("short", "a-much-longer-token"), false);
});
