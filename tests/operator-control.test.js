"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const {
  COMMAND_LIFETIME_MS,
  buildOperatorCommand,
  deriveOperatorStatus,
  validateOperatorRequest
} = require("../cloud/netlify/lib/operator-control-contract");
const { _createHandler } = require("../cloud/netlify/functions/operator-control");
const { OPERATOR_UID, createOperatorControlStore } = require("../cloud/netlify/lib/operator-control-store");
const { _databaseForUrl } = require("../cloud/netlify/lib/firebase");

const now = 1_800_000_000_000;
const presence = { sessionId: "boot_AAAAAAAA", lastSeenAtMs: now - 1000 };
const request = { action: "enter-user-monitor", clientRequestId: "browser_12345678" };
const command = buildOperatorCommand(request, {
  commandId: "op_1234567890abcdef",
  commandSequence: 7,
  targetSessionId: presence.sessionId,
  requestedAtMs: now
});

test("operator command is closed, session-targeted, and lives exactly 45 seconds", () => {
  assert.equal(validateOperatorRequest(request), request);
  assert.equal(command.expiresAtMs - command.requestedAtMs, COMMAND_LIFETIME_MS);
  assert.equal(command.targetSessionId, presence.sessionId);
  assert.equal(command.schemaVersion, 2);
  assert.deepEqual(command.payload, { kind: "none" });
  assert.throws(() => validateOperatorRequest({ ...request, action: "clear-events" }), /invalid_request/);
});

test("status distinguishes not delivered, accepted, failed, and unknown", () => {
  const base = { command, presence };
  assert.equal(deriveOperatorStatus(base, now + 1000).outcome, "not-delivered");
  assert.equal(deriveOperatorStatus({ ...base, result: {
    commandId: command.commandId, commandSequence: 7,
    targetSessionId: command.targetSessionId, commandType: command.commandType,
    outcome: "accepted", detailCode: "monitor-request-accepted",
    relayRestoration: "unconfirmed", reportingSessionId: presence.sessionId,
    reportedAtMs: now + 500
  } }, now + 1000).outcome, "accepted");
  assert.equal(deriveOperatorStatus(base, command.expiresAtMs + 1).outcome, "unknown");
  assert.equal(deriveOperatorStatus({ ...base, result: {
    commandId: command.commandId, commandSequence: 7,
    targetSessionId: command.targetSessionId, commandType: command.commandType,
    outcome: "failed", detailCode: "monitor-event-unavailable",
    relayRestoration: "not-applicable", reportingSessionId: presence.sessionId,
    reportedAtMs: now + 500
  } }, now + 1000).outcome, "failed");
});

test("Tab5 restart completion requires request-linked new-session evidence", () => {
  const restart = { ...command, commandType: "restart-tab5" };
  const newPresence = { sessionId: "boot_BBBBBBBB", lastSeenAtMs: now + 5000 };
  const completed = {
    commandId: restart.commandId, commandSequence: restart.commandSequence,
    targetSessionId: restart.targetSessionId, commandType: restart.commandType,
    reportingSessionId: newPresence.sessionId, outcome: "confirmed-completed",
    detailCode: "tab5-restart-new-session", reportedAtMs: now + 4000,
    relayRestoration: "not-applicable"
  };
  assert.equal(deriveOperatorStatus({
    command: restart, result: completed, presence: newPresence
  }, now + 6000).outcome, "confirmed-completed");
  assert.equal(deriveOperatorStatus({
    command: restart, result: completed,
    presence: { sessionId: "boot_CCCCCCCC", lastSeenAtMs: now + 9000 }
  }, now + 10_000).outcome, "confirmed-completed");

  const lostAllAcknowledgments = deriveOperatorStatus({
    command: restart, presence: newPresence
  }, now + 6000);
  assert.equal(lostAllAcknowledgments.outcome, "unknown");
  assert.equal(lostAllAcknowledgments.detailCode,
    "new-session-without-request-evidence");

  const expiredManualRestart = deriveOperatorStatus({
    command: restart,
    presence: { sessionId: "boot_MANUAL00", lastSeenAtMs: restart.expiresAtMs + 5000 }
  }, restart.expiresAtMs + 6000);
  assert.equal(expiredManualRestart.outcome, "unknown");
  assert.equal(expiredManualRestart.detailCode, "new-session-without-request-evidence");

  const rejected = { ...completed, reportingSessionId: restart.targetSessionId,
    outcome: "not-delivered", detailCode: "command-expired", reportedAtMs: now + 1000 };
  const rejectedThenRestarted = deriveOperatorStatus({
    command: restart, result: rejected, presence: newPresence
  }, now + 6000);
  assert.equal(rejectedThenRestarted.outcome, "not-delivered");
  assert.equal(rejectedThenRestarted.detailCode, "command-expired");

  const acceptedLostCompletion = { ...completed,
    reportingSessionId: restart.targetSessionId, outcome: "accepted",
    detailCode: "tab5-restart-scheduled", reportedAtMs: now + 1000 };
  const lostAcknowledgment = deriveOperatorStatus({
    command: restart, result: acceptedLostCompletion, presence: newPresence
  }, now + 6000);
  assert.equal(lostAcknowledgment.outcome, "unknown");
  assert.equal(lostAcknowledgment.detailCode, "new-session-without-request-evidence");

  const wrongCompletion = deriveOperatorStatus({
    command: restart,
    result: { ...completed, detailCode: "fresh-tab5-session" },
    presence: newPresence
  }, now + 6000);
  assert.equal(wrongCompletion.outcome, "unknown");
});

test("status exposes explicit Monitor, relay, staged adoption, and Shelly evidence", () => {
  const status = deriveOperatorStatus({
    presence,
    currentObservation: {
      sessionId: "boot_AAAAAAAA", receivedAtMs: now - 500,
      values: { shelly1_lock: -1, shelly1_lockout_count: 3 },
      status: { user_monitor_active: true, tab5_relay_restoration: "unconfirmed" }
    },
    rulesV3State: {
      sessionId: "boot_AAAAAAAA", reportedAtMs: now - 500,
      running: { contentHash: "a".repeat(64) },
      staged: { releaseId: "20260913010101-event-v3-v16", packageVersion: 16, contentHash: "b".repeat(64) }
    }
  }, now);
  assert.equal(status.userMonitor, true);
  assert.equal(status.relayRestoration, "unconfirmed");
  assert.equal(status.shellyLock, -1);
  assert.equal(status.shellyLockoutCount, 3);
  assert.equal(status.stagedRestartAdoption.packageVersion, 16);
});

test("cached connection and stale observation never fabricate current control state", () => {
  const status = deriveOperatorStatus({
    presence,
    currentObservation: {
      sessionId: "boot_OLDER000", receivedAtMs: now - 500,
      values: { shelly1_lock: 0 },
      status: { user_monitor_active: false, tab5_relay_restoration: "confirmed" }
    },
    rulesV3State: {
      sessionId: "boot_OLDER000", reportedAtMs: now - 500,
      running: { contentHash: "a".repeat(64) },
      staged: { contentHash: "b".repeat(64) }
    }
  }, now);
  assert.equal(status.userMonitor, null);
  assert.equal(status.relayRestoration, "unknown");
  assert.equal(status.shellyLock, null);
  assert.equal(status.stagedRestartAdoption, null);
});

test("operator function authenticates and never turns stale presence into a queued command", async () => {
  const store = {
    status: async () => deriveOperatorStatus({ presence }, now),
    issue: async () => ({ issued: false, code: "device-presence-not-fresh", snapshot: {} })
  };
  const handler = _createHandler({ store, now: () => now, env: { PILOT_INGEST_TOKEN: "owner-key" } });
  const unauthorized = await handler({ httpMethod: "GET", headers: {} });
  assert.equal(unauthorized.statusCode, 401);
  const result = await handler({
    httpMethod: "POST", headers: { "X-Pilot-Key": "owner-key" }, body: JSON.stringify(request)
  });
  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).status, "not-delivered");
});

test("operator status initializes the installed Admin SDK with the approved explicit RTDB URL", async () => {
  const app = initializeApp({ projectId: "well-pump-control" }, `operator-control-${process.pid}`);
  const url = "https://well-pump-control-default-rtdb.firebaseio.com";
  try {
    assert.throws(() => getDatabase(app, url), /Can't determine Firebase Database URL/);
    assert.equal(_databaseForUrl(app, url).ref().toString(), `${url}/`);
  } finally {
    await deleteApp(app);
  }
});

test("status failure reports a bounded stage, code, and denial category", async () => {
  const cases = [
    [() => { const e = new Error("boom"); e.name = "ConfigurationError"; throw e; },
      "configuration_missing", "configuration"],
    [() => { throw Object.assign(new Error("nope"), { code: "status_read_http_401", operatorControlStage: "status-read" }); },
      "control_denied", "denied"],
    [() => { throw Object.assign(new Error("slow"), { code: "status-read_timeout", operatorControlStage: "status-read" }); },
      "control_unavailable", "upstream"]
  ];
  for (const [status, expectedCode, expectedCategory] of cases) {
    const handler = _createHandler({
      store: { status, issue: async () => ({}) },
      env: { PILOT_INGEST_TOKEN: "owner-key" }
    });
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args);
    let result;
    try {
      result = await handler({ httpMethod: "GET", headers: { "X-Pilot-Key": "owner-key" } });
    } finally { console.error = original; }
    assert.equal(result.statusCode, 503);
    assert.equal(JSON.parse(result.body).code, expectedCode);
    assert.equal(logged[0][0], "Operator control failed");
    assert.equal(logged[0][1].category, expectedCategory);
    assert.doesNotMatch(result.body, /owner-key/);
  }
});

test("operator function accepts one issued record and returns its evidence", async () => {
  const snapshot = { command, presence };
  const handler = _createHandler({
    store: { status: async () => ({}), issue: async () => ({ issued: true, snapshot }) },
    now: () => now,
    env: { PILOT_INGEST_TOKEN: "owner-key" }
  });
  const result = await handler({
    httpMethod: "POST", headers: { "x-pilot-key": "owner-key" }, body: JSON.stringify(request)
  });
  assert.equal(result.statusCode, 202);
  assert.equal(JSON.parse(result.body).control.outcome, "not-delivered");
});

// Minimal RTDB REST double: ETag compare-and-set on the exact paths and verbs
// the store uses, so the test exercises the real transport rather than an
// Admin SDK shape the production path no longer has.
function rtdbRest(values) {
  const base = "https://well-pump-control-default-rtdb.firebaseio.com/v1/sites/well-main/devices/tab5-well-main/";
  let revision = 0;
  const etags = new Map();
  const tagFor = path => { if (!etags.has(path)) etags.set(path, `etag-${++revision}`); return etags.get(path); };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.startsWith("https://identitytoolkit.googleapis.com/")) {
      calls.push("token-exchange");
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ idToken: "id-token" }) };
    }
    assert.ok(url.startsWith(base), `unexpected url ${url}`);
    assert.match(url, /[?&]auth=id-token$/);
    const path = url.slice(base.length, url.indexOf(".json"));
    calls.push(`${options.method} ${path}`);
    if (options.method === "GET") {
      return {
        ok: true, status: 200,
        headers: { get: name => (name === "etag" ? tagFor(path) : null) },
        json: async () => values.get(path) ?? null
      };
    }
    if (options.method === "PUT") {
      if (options.headers["If-Match"] !== tagFor(path)) {
        return { ok: false, status: 412, headers: { get: () => null }, json: async () => ({}) };
      }
      values.set(path, JSON.parse(options.body));
      etags.set(path, `etag-${++revision}`);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(options.body) };
    }
    throw new Error(`unexpected method ${options.method}`);
  };
  return { fetchImpl, calls };
}

const storeEnv = {
  FIREBASE_WEB_API_KEY: "web-key",
  FIREBASE_RTDB_URL: "https://well-pump-control-default-rtdb.firebaseio.com"
};
const stubAuth = () => ({
  auth: { createCustomToken: async () => "custom-token" },
  projectId: "well-pump-control"
});

test("store reaches RTDB as the purpose-scoped operator identity over REST", async () => {
  const claims = [];
  const values = new Map([["presence", presence]]);
  const { fetchImpl } = rtdbRest(values);
  const store = createOperatorControlStore({
    env: storeEnv,
    getPilotAuth: () => ({
      auth: { createCustomToken: async (uid, extra) => { claims.push([uid, extra]); return "custom-token"; } },
      projectId: "well-pump-control"
    }),
    fetch: fetchImpl, now: () => now, nonce: () => "1234567890abcdef"
  });
  await store.issue(request);
  assert.deepEqual(claims[0], [OPERATOR_UID, {
    siteId: "well-main", deviceId: "tab5-well-main", purpose: "operator-control"
  }]);
  assert.equal(OPERATOR_UID, "netlify-operator-control");
});

test("single-slot store is idempotent, blocks overlap, and preserves sequence across expiry", async () => {
  const values = new Map([["presence", presence]]);
  const { fetchImpl } = rtdbRest(values);
  let clock = now;
  let nonce = 0;
  const store = createOperatorControlStore({
    env: storeEnv, getPilotAuth: stubAuth, fetch: fetchImpl,
    now: () => clock, nonce: () => `1234567890abcde${++nonce}`
  });
  const first = await store.issue(request);
  assert.equal(first.issued, true);
  assert.equal(first.snapshot.command.commandSequence, 1);
  const duplicate = await store.issue(request);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.snapshot.command.commandId, first.snapshot.command.commandId);
  const busy = await store.issue({ action: "restart-tab5", clientRequestId: "browser_87654321" });
  assert.equal(busy.issued, false);
  assert.equal(busy.code, "command-already-active");
  clock += COMMAND_LIFETIME_MS + 1;
  values.set("presence", { sessionId: presence.sessionId, lastSeenAtMs: clock });
  const second = await store.issue({ action: "restart-tab5", clientRequestId: "browser_87654321" });
  assert.equal(second.issued, true);
  assert.equal(second.snapshot.command.commandSequence, 2);
});

test("the command write never claims delivery it cannot evidence", async () => {
  const values = new Map([["presence", presence]]);
  const { fetchImpl } = rtdbRest(values);
  // An aborted PUT is indeterminate: the request may have reached RTDB.
  const abortingFetch = async (url, options = {}) => {
    if (options.method === "PUT") {
      const error = new Error("aborted"); error.name = "AbortError"; throw error;
    }
    return fetchImpl(url, options);
  };
  const store = createOperatorControlStore({
    env: storeEnv, getPilotAuth: stubAuth, fetch: abortingFetch,
    now: () => now, nonce: () => "1234567890abcdef"
  });
  await assert.rejects(store.issue(request), error => {
    assert.equal(error.operatorControlStage, "command-write");
    assert.equal(error.commandMayHaveBeenWritten, true);
    return true;
  });
  // A rejected write carries a status, so it definitively did not apply.
  const rejectingFetch = async (url, options = {}) => {
    if (options.method === "PUT") {
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
    return fetchImpl(url, options);
  };
  const denied = createOperatorControlStore({
    env: storeEnv, getPilotAuth: stubAuth, fetch: rejectingFetch,
    now: () => now, nonce: () => "1234567890abcdef"
  });
  await assert.rejects(denied.issue(request), error => {
    assert.equal(error.code, "command_write_http_401");
    assert.equal(error.commandMayHaveBeenWritten, false);
    return true;
  });
});

test("a hung backend is aborted well inside the Netlify 30s limit", async () => {
  const hangingFetch = (url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error);
    });
  });
  const store = createOperatorControlStore({
    env: storeEnv, getPilotAuth: stubAuth, fetch: hangingFetch, now: () => now,
    requestTimeoutMs: 40
  });
  const started = Date.now();
  await assert.rejects(store.status(), error => {
    assert.equal(error.operatorControlStage, "token-exchange");
    assert.match(error.code, /_timeout$/);
    return true;
  });
  assert.ok(Date.now() - started < 30000, "must resolve before the platform timeout");
});

function tokenCountingRest(values, tokenBody) {
  const inner = rtdbRest(values);
  let exchanges = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.startsWith("https://identitytoolkit.googleapis.com/")) {
      exchanges += 1;
      return { ok: true, status: 200, headers: new Map(), json: async () => tokenBody };
    }
    return inner.fetchImpl(url, options);
  };
  return { fetchImpl, exchanges: () => exchanges };
}

test("the operator token honors expiresIn and renews before it expires", async () => {
  const values = new Map([["presence", presence]]);
  const { fetchImpl, exchanges } = tokenCountingRest(values, { idToken: "id-token", expiresIn: "120" });
  let clock = 0;
  const store = createOperatorControlStore({
    env: storeEnv, getPilotAuth: stubAuth, fetch: fetchImpl,
    now: () => now, monotonic: () => clock
  });
  await store.status();
  assert.equal(exchanges(), 1);
  clock = 59_000;
  await store.status();
  assert.equal(exchanges(), 1, "a live token must be reused");
  clock = 61_000;
  await store.status();
  assert.equal(exchanges(), 2, "the token must renew ahead of its own expiry");
});

test("an authentication rejection clears the cached token so the next request recovers", async () => {
  const values = new Map([["presence", presence]]);
  const base = tokenCountingRest(values, { idToken: "id-token", expiresIn: "3600" });
  let deny = true;
  const fetchImpl = async (url, options = {}) => {
    if (!url.startsWith("https://identitytoolkit.googleapis.com/") && deny) {
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
    return base.fetchImpl(url, options);
  };
  const store = createOperatorControlStore({
    env: storeEnv, getPilotAuth: stubAuth, fetch: fetchImpl, now: () => now
  });
  await assert.rejects(store.status(), error => {
    assert.equal(error.code, "status_read_http_401");
    return true;
  });
  assert.equal(base.exchanges(), 1);
  deny = false;
  await store.status();
  assert.equal(base.exchanges(), 2, "a denied token must not be served from cache again");
});

// A body that never settles is the case the previous timer missed: headers had
// already arrived, so the timeout had been cleared.
function stallingBody(values, stallOn) {
  const inner = rtdbRest(values);
  return async (url, options = {}) => {
    const response = await inner.fetchImpl(url, options);
    if (!stallOn(url, options)) return response;
    return {
      ...response,
      json: () => new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          const error = new Error("aborted"); error.name = "AbortError"; reject(error);
        });
      })
    };
  };
}

test("a stalled response body is bounded and reported as a read failure", async () => {
  const values = new Map([["presence", presence]]);
  const store = createOperatorControlStore({
    env: storeEnv, getPilotAuth: stubAuth, now: () => now, requestTimeoutMs: 40,
    fetch: stallingBody(values, url => url.includes("/presence.json"))
  });
  const started = Date.now();
  await assert.rejects(store.status(), error => {
    assert.equal(error.operatorControlStage, "status-read");
    assert.match(error.code, /_timeout$/);
    return true;
  });
  assert.ok(Date.now() - started < 5000, "a stalled body must not hang the operation");
});

test("a stalled write body keeps the definitive status instead of becoming unknown", async () => {
  const values = new Map([["presence", presence]]);
  const store = createOperatorControlStore({
    env: storeEnv, getPilotAuth: stubAuth, now: () => now,
    nonce: () => "1234567890abcdef", requestTimeoutMs: 40,
    fetch: stallingBody(values, (_url, options) => options.method === "PUT")
  });
  // RTDB answered with headers, so the write applied. A slow body must not
  // downgrade that to an indeterminate outcome.
  const issued = await store.issue(request);
  assert.equal(issued.issued, true);
  assert.equal(issued.snapshot.command.commandSequence, 1);
});

test("the whole endpoint operation stays inside its budget", async () => {
  const never = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted"); error.name = "AbortError"; reject(error);
    });
  });
  const store = createOperatorControlStore({
    env: storeEnv, getPilotAuth: stubAuth, fetch: never, now: () => now,
    requestTimeoutMs: 5000, totalBudgetMs: 60
  });
  const started = Date.now();
  await assert.rejects(store.status(), error => {
    assert.match(error.code, /_timeout$/);
    return true;
  });
  assert.ok(Date.now() - started < 5000, "the shared budget must cap the operation");
});
