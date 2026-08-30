"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_OPEN_EVENTS, boardProjection, instanceUpdate
} = require("../cloud/netlify/lib/event-v3-projection");
const { _createHandler } = require("../cloud/netlify/functions/events-status");

function record({ eventId = "20260830000007-E007-boot_A7f93k2Q-0000000007", instance = "v3-instance-7",
  session = "boot_A7f93k2Q", type = "event-open", observedAt = "2026-08-30T00:00:07Z",
  mode = "Normal", reason = type === "event-open" ? "opening_qualified" : "closing_qualified" } = {}) {
  return {
    schemaVersion: 1, runtimeSchemaVersion: 3, recordType: type,
    recordId: `${observedAt.slice(0, 19).replace(/[-T:]/g, "")}-${type}-${session}-0000000007`,
    eventId, eventInstanceId: instance, siteId: "well-main", deviceId: "tab5-well-main",
    sessionId: session, sequence: 7, observedAt, ruleId: "E007", severity: "Red",
    latched: false, eventClass: "transient", consequence: "inhibit", transitionReason: reason,
    mode, rulesRelease: { version: 1, contentHash: "a".repeat(64) },
    condition: { SupplyVoltage: 270 }, actor: { type: "device", id: "tab5-well-main" }
  };
}

test("V3 board projection supports recurrence, overlap, close idempotency, and session replacement", () => {
  const first = record();
  const firstInstance = instanceUpdate(null, first);
  let board = boardProjection(null, first, firstInstance).board;
  assert.deepEqual(board.openEventIds, [first.eventId]);
  board = boardProjection(board, first, firstInstance).board;
  assert.deepEqual(board.openEventIds, [first.eventId]);

  const overlap = record({ eventId: "20260830000008-E006-boot_A7f93k2Q-0000000008", instance: "v3-instance-8",
    observedAt: "2026-08-30T00:00:08Z", mode: "Monitor" });
  overlap.ruleId = "E006";
  board = boardProjection(board, overlap, instanceUpdate(null, overlap)).board;
  assert.deepEqual(board.openEventIds, [first.eventId, overlap.eventId]);
  assert.equal(board.mode, "Monitor");

  const close = record({ type: "event-close", observedAt: "2026-08-30T00:00:09Z", mode: "Normal" });
  const closedInstance = instanceUpdate(firstInstance, close);
  board = boardProjection(board, close, closedInstance).board;
  board = boardProjection(board, close, closedInstance).board;
  assert.deepEqual(board.openEventIds, [overlap.eventId]);
  const recurrence = record({ eventId: "20260830000010-E007-boot_A7f93k2Q-0000000010", instance: "v3-instance-9",
    observedAt: "2026-08-30T00:00:10Z" });
  board = boardProjection(board, recurrence, instanceUpdate(null, recurrence)).board;
  assert.equal(board.openEvents[recurrence.eventId].eventInstanceId, "v3-instance-9");
  assert.notEqual(recurrence.eventId, first.eventId);

  const newSession = record({ eventId: "20260830000011-E007-boot_B7f93k2Q-0000000000", instance: "v3-instance-1",
    session: "boot_B7f93k2Q", observedAt: "2026-08-30T00:00:11Z" });
  board = boardProjection(board, newSession, instanceUpdate(null, newSession)).board;
  assert.deepEqual(board.openEventIds, [newSession.eventId]);
  const late = boardProjection(board, overlap, instanceUpdate(null, overlap));
  assert.equal(late.changed, false);
  assert.equal(late.lateSession, true);
  assert.equal(late.board.sessionId, "boot_B7f93k2Q");
});

test("V3 instance projection retains transition identities, actors, and optional command context", () => {
  const open = record();
  open.commandId = "20260830000000-command-boot_A7f93k2Q-0000000009";
  const close = record({ type: "event-close", observedAt: "2026-08-30T00:00:37Z", reason: "clear_events" });
  close.actor = { type: "user", id: "operator-7" };
  const instance = instanceUpdate(instanceUpdate(null, open), close);
  assert.equal(instance.status, "closed");
  assert.equal(instance.openTransitionReason, "opening_qualified");
  assert.equal(instance.closeTransitionReason, "clear_events");
  assert.equal(instance.openCommandId, open.commandId);
  assert.deepEqual(instance.closeActor, close.actor);
  assert.deepEqual(instance.rulesRelease, close.rulesRelease);
});

test("V3 board has a hard bounded open set", () => {
  let board = null;
  for (let index = 0; index < MAX_OPEN_EVENTS; index += 1) {
    const item = record({ eventId: `20260830000007-E${String(index).padStart(3, "0")}-boot_A7f93k2Q-${String(index).padStart(10, "0")}`,
      instance: `v3-instance-${index + 1}`, observedAt: "2026-08-30T00:00:07Z" });
    item.ruleId = `E${String(index).padStart(3, "0")}`;
    board = boardProjection(board, item, instanceUpdate(null, item)).board;
  }
  const overflow = record({ eventId: "20260830000008-E999-boot_A7f93k2Q-0000000099", instance: "v3-instance-65",
    observedAt: "2026-08-30T00:00:08Z" });
  overflow.ruleId = "E999";
  assert.throws(() => boardProjection(board, overflow, instanceUpdate(null, overflow)), /event_board_capacity/);
});

function timestamp(iso) { return { toDate: () => new Date(iso) }; }

function statusHandler({ board, instances = [], fail = false }) {
  const query = { limit: null };
  const db = { collection: () => ({ doc: () => ({ collection: name => {
    if (name === "eventBoards") return { doc: () => ({ async get() {
      if (fail) throw new Error("unavailable");
      return { exists: Boolean(board), data: () => board };
    } }) };
    return { orderBy() { return this; }, limit(value) { query.limit = value; return this; }, async get() {
      if (fail) throw new Error("unavailable");
      return { docs: instances.map(value => ({ data: () => value })) };
    } };
  } }) }) };
  return { handler: _createHandler({ getPilotFirestore: () => ({ db }) }), query };
}

test("events-status shapes a narrow board and bounded derived interrupted history", async () => {
  const board = { deviceId: "tab5-well-main", sessionId: "boot_new99", mode: "Monitor",
    openEventIds: ["open-1"], openEvents: {
      "open-1": { eventId: "open-1", eventInstanceId: "v3-instance-3", ruleId: "M001",
        eventClass: "monitor", severity: "Info", consequence: "monitor",
        openedAt: timestamp("2026-08-30T00:00:10Z") }
    }, boundaryObservedAt: timestamp("2026-08-30T00:00:10Z"),
    lastObservedAt: timestamp("2026-08-30T00:00:11Z") };
  const { handler, query } = statusHandler({ board, instances: [
    { eventId: "old-open", eventInstanceId: "v3-instance-1", ruleId: "E007", sessionId: "boot_old99",
      deviceId: "tab5-well-main", eventClass: "transient", severity: "Red", consequence: "inhibit",
      status: "open", mode: "Normal", openedAt: "2026-08-30T00:00:01Z" },
    { eventId: "closed", eventInstanceId: "v3-instance-2", ruleId: "E006", sessionId: "boot_new99",
      deviceId: "tab5-well-main", eventClass: "latched", severity: "Red", consequence: "inhibit",
      status: "closed", mode: "Normal", closedAt: "2026-08-30T00:00:09Z" }
  ] });
  const result = await handler({ httpMethod: "GET" });
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(query.limit, 50);
  assert.deepEqual(body.board.openEventIds, ["open-1"]);
  assert.deepEqual(body.board.openEvents, [{
    eventId: "open-1", eventInstanceId: "v3-instance-3", ruleId: "M001",
    eventClass: "monitor", severity: "Info", consequence: "monitor",
    openedAt: "2026-08-30T00:00:10.000Z"
  }]);
  assert.equal(body.board.boundaryObservedAt, "2026-08-30T00:00:10.000Z");
  assert.equal(body.history[0].effectiveStatus, "interrupted");
  assert.equal(body.history[1].effectiveStatus, "closed");
  assert.equal(Object.hasOwn(body.history[0], "condition"), false);
});

test("events-status has narrow GET-only empty and failure outcomes", async () => {
  let setup = statusHandler({ board: null });
  assert.equal((await setup.handler({ httpMethod: "GET" })).statusCode, 404);
  assert.equal((await setup.handler({ httpMethod: "POST" })).statusCode, 405);
  setup = statusHandler({ board: {}, fail: true });
  assert.equal((await setup.handler({ httpMethod: "GET" })).statusCode, 503);
});
