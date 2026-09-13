"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  COMMAND_LIFETIME_MS,
  buildOperatorCommand,
  deriveOperatorStatus,
  validateOperatorRequest
} = require("../cloud/netlify/lib/operator-control-contract");
const { _createHandler } = require("../cloud/netlify/functions/operator-control");
const { createOperatorControlStore } = require("../cloud/netlify/lib/operator-control-store");

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

test("single-slot store is idempotent, blocks overlap, and preserves sequence across expiry", async () => {
  const values = new Map([
    ["v1/sites/well-main/devices/tab5-well-main/presence", presence]
  ]);
  const snapshot = value => ({ val: () => value });
  const database = {
    ref(path) {
      return {
        child(name) { return database.ref(`${path}/${name}`); },
        async once() { return snapshot(values.get(path) ?? null); },
        async transaction(callback) {
          const next = callback(values.get(path) ?? null);
          if (next === undefined) return { committed: false, snapshot: snapshot(values.get(path) ?? null) };
          values.set(path, next);
          return { committed: true, snapshot: snapshot(next) };
        }
      };
    }
  };
  let clock = now;
  let nonce = 0;
  const store = createOperatorControlStore({
    getPilotDatabase: () => ({ database, projectId: "well-pump-control" }),
    now: () => clock,
    nonce: () => `1234567890abcde${++nonce}`
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
  values.set("v1/sites/well-main/devices/tab5-well-main/presence", {
    sessionId: presence.sessionId, lastSeenAtMs: clock
  });
  const second = await store.issue({ action: "restart-tab5", clientRequestId: "browser_87654321" });
  assert.equal(second.issued, true);
  assert.equal(second.snapshot.command.commandSequence, 2);
});
