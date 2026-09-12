"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateEventBoard, EventBoardError } = require("../cloud/netlify/lib/event-board-contract");
const { reduceEventBoard } = require("../cloud/netlify/lib/event-board-reducer");
const { createEventBoardMirror } = require("../cloud/netlify/lib/event-board-mirror");
const { _createHandler } = require("../cloud/netlify/functions/event-board");
const { fakeFirestore } = require("./fixtures/memory-firestore");

const sessionA = "boot_AAAAAAAAAAAA";
const sessionB = "boot_BBBBBBBBBBBB";
const release = { releaseId: "20260912001035-event-v3-v15", packageVersion: 15, contentHash: "a".repeat(64) };
function slot(occurrenceId, name = "Utility voltage high") {
  return { occurrenceId, displayName: name, severity: "Red", eventClass: "transient",
    opening: { kind: "condition-qualified", cycleSequence: 20, uptimeMs: 20000, observedAt: "2026-09-12T16:00:20.000Z" } };
}
function board(sequence, openEvents = {}, sessionId = sessionA) {
  return { schemaVersion: 1, kind: "current-event-board", siteId: "well-main", deviceId: "tab5-well-main",
    sessionId, boardSequence: sequence, complete: true, producedUptimeMs: sequence * 1000,
    producedAt: `2026-09-12T16:00:${String(sequence).padStart(2, "0")}.000Z`, rulesRelease: release, openEvents };
}

test("strict board contract rejects malformed, incomplete, oversize-slot, and duplicate occurrence input", () => {
  assert.equal(validateEventBoard(board(1)).boardSequence, 1);
  assert.throws(() => validateEventBoard({ ...board(1), complete: false }), error => error instanceof EventBoardError && error.code === "incomplete_board");
  assert.throws(() => validateEventBoard({ ...board(1), extra: true }), EventBoardError);
  assert.throws(() => validateEventBoard({ ...board(1), producedAt: "2026-02-30T16:00:01Z" }), EventBoardError);
  assert.throws(() => validateEventBoard(board(1, { E007: slot("same"), E008: slot("same") })), EventBoardError);
  const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`E${index + 100}`, slot(`r:${index}`)]));
  assert.throws(() => validateEventBoard(board(1, tooMany)), error => error.code === "too_many_events");
});

test("newer complete boards immediately reconcile opens, omissions, replacements, stale reports, and restart", () => {
  let result = reduceEventBoard(null, board(1), "2026-09-12T16:00:01.100Z");
  assert.equal(result.decision, "accepted-new-session");
  assert.deepEqual(result.projection.openEvents, {});
  result = reduceEventBoard(result.projection, board(2, { E007: slot("r15:E007:1") }), "2026-09-12T16:00:02.100Z");
  assert.deepEqual(result.records.map(record => record.recordType), ["event-open"]);
  assert.equal(result.records[0].openingEvidenceStatus, "exact-device");
  const openProjection = result.projection;
  const duplicate = reduceEventBoard(openProjection, board(2, { E007: slot("r15:E007:1") }), "2026-09-12T16:01:00Z");
  assert.equal(duplicate.decision, "duplicate");
  assert.equal(duplicate.projection.lastReportAt, openProjection.lastReportAt);
  const stale = reduceEventBoard(openProjection, board(1), "2026-09-12T16:01:01Z");
  assert.equal(stale.decision, "stale-ignored");
  assert.ok(stale.projection.openEvents.E007);
  const replacement = reduceEventBoard(openProjection, board(3, { E007: slot("r15:E007:2") }), "2026-09-12T16:00:03.100Z");
  assert.deepEqual(replacement.records.map(record => record.recordType), ["event-close", "event-open"]);
  assert.equal(replacement.records[0].closeTimeStatus, "unknown");
  assert.equal(replacement.records[0].closeReason, "inferred-board-disappearance");
  assert.equal(replacement.records[0].detectedAt, "2026-09-12T16:00:03.100Z");
  assert.equal(replacement.records[0].observedAt, undefined);
  const omitted = reduceEventBoard(replacement.projection, board(4), "2026-09-12T16:00:04.100Z");
  assert.deepEqual(omitted.records.map(record => record.recordType), ["event-close"]);
  assert.deepEqual(omitted.projection.openEvents, {});
  const reopened = reduceEventBoard(omitted.projection, board(5, { E007: slot("r15:E007:3") }), "2026-09-12T16:00:05.100Z");
  const restarted = reduceEventBoard(reopened.projection, board(1, {}, sessionB), "2026-09-12T17:00:00Z");
  assert.equal(restarted.records[0].closeReason, "ended-by-restart");
  assert.equal(restarted.records[0].restartDetectedAt, "2026-09-12T17:00:00Z");
  assert.equal(restarted.records[0].observedAt, undefined);
  assert.equal(reduceEventBoard(restarted.projection, board(99, {}, sessionA), "2026-09-12T18:00:00Z").decision, "stale-ignored");
});

test("same-session release change and equal-sequence changed content cannot alter projection", () => {
  const initial = reduceEventBoard(null, board(1, { E007: slot("r15:E007:1") }), "2026-09-12T16:00:01Z").projection;
  const conflict = reduceEventBoard(initial, board(1, {}), "2026-09-12T16:00:02Z");
  assert.equal(conflict.decision, "sequence-conflict");
  assert.ok(conflict.projection.openEvents.E007);
  const changedRelease = board(2, {});
  changedRelease.rulesRelease = { ...release, packageVersion: 16 };
  assert.equal(reduceEventBoard(initial, changedRelease, "2026-09-12T16:00:02Z").decision, "release-conflict");
});

test("endpoint transaction is deterministic and a retry repairs only the current mirror", async () => {
  const { db, values } = fakeFirestore();
  const mirrored = [];
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-token" },
    getPilotFirestore: () => ({ db, projectId: "well-pump-control", databaseId: "(default)" }),
    clock: () => new Date("2026-09-12T16:00:01.100Z"),
    createMirror: () => ({ async mirror(value, revision) { mirrored.push([value.boardSequence, revision]); } })
  });
  const request = value => ({ httpMethod: "POST", headers: { "X-Pilot-Key": "test-token" }, body: JSON.stringify(value) });
  assert.equal((await handler(request(board(1)))).statusCode, 201);
  assert.equal((await handler(request(board(1)))).statusCode, 200);
  assert.deepEqual(mirrored, [[1, 1], [1, 1]]);
  assert.equal(values.get("sites/well-main/eventBoardState/tab5-well-main").acceptedBoardRevision, 1);
  const opened = await handler(request(board(2, { E007: slot("r15:E007:1") })));
  assert.equal(opened.statusCode, 201);
  assert.ok(values.has("sites/well-main/eventRecords/event-open--tab5-well-main--boot_AAAAAAAAAAAA--r15:E007:1"));
  assert.equal((await handler(request(board(1)))).statusCode, 200);
  assert.deepEqual(mirrored.at(-1), [2, 2]);
});

test("concurrent duplicate requests create one deterministic history record", async () => {
  const { db, values } = fakeFirestore();
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-token" },
    getPilotFirestore: () => ({ db, projectId: "well-pump-control", databaseId: "(default)" }),
    clock: () => new Date("2026-09-12T16:00:01.100Z"),
    createMirror: () => ({ async mirror() {} })
  });
  const payload = board(1, { E007: slot("r15:E007:1") });
  const request = () => ({ httpMethod: "POST", headers: { "X-Pilot-Key": "test-token" }, body: JSON.stringify(payload) });
  const results = await Promise.all([handler(request()), handler(request())]);
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 201]);
  assert.equal([...values.keys()].filter(path => path.includes("/eventRecords/")).length, 1);
});

test("a retried transaction callback remains deterministic and creates history once", async () => {
  const { db, values, getTransactionAttempts } = fakeFirestore({ retryFirstTransaction: true });
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-token" },
    getPilotFirestore: () => ({ db, projectId: "well-pump-control", databaseId: "(default)" }),
    clock: () => new Date("2026-09-12T16:00:01.100Z"),
    createMirror: () => ({ async mirror() {} })
  });
  const payload = board(1, { E007: slot("r15:E007:1") });
  const result = await handler({
    httpMethod: "POST", headers: { "X-Pilot-Key": "test-token" },
    body: JSON.stringify(payload)
  });
  assert.equal(result.statusCode, 201);
  assert.equal(getTransactionAttempts(), 2);
  assert.equal([...values.keys()].filter(path => path.includes("/eventRecords/")).length, 1);
});

test("endpoint rejects unauthorized and incomplete input without Firestore changes", async () => {
  const { db, values } = fakeFirestore();
  const handler = _createHandler({ env: { PILOT_INGEST_TOKEN: "test-token" }, getPilotFirestore: () => ({ db, projectId: "well-pump-control", databaseId: "(default)" }) });
  const unauthorized = await handler({ httpMethod: "POST", headers: { "X-Pilot-Key": "wrong" }, body: JSON.stringify(board(1)) });
  const incomplete = await handler({ httpMethod: "POST", headers: { "X-Pilot-Key": "test-token" }, body: JSON.stringify({ ...board(1), complete: false }) });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(incomplete.statusCode, 400);
  assert.equal(values.size, 0);
});

function jsonResponse(status, body, etag = null) {
  return { ok: status >= 200 && status < 300, status, headers: { get: name => name.toLowerCase() === "etag" ? etag : null }, async json() { return body; } };
}
test("RTDB mirror uses revision ordering and conditional retry so delayed older work cannot overwrite", async () => {
  let current = null;
  let etagNumber = 1;
  let force412 = true;
  const mirror = createEventBoardMirror({
    env: { FIREBASE_WEB_API_KEY: "key", FIREBASE_RTDB_URL: "https://well-pump-control-default-rtdb.firebaseio.com" },
    firebase: { getPilotAuth() { return { projectId: "well-pump-control", auth: { async createCustomToken() { return "custom"; } } }; } },
    fetch: async (url, options) => {
      if (url.startsWith("https://identitytoolkit.googleapis.com")) return jsonResponse(200, { idToken: "id" });
      if (options.method === "GET") return jsonResponse(200, current, `"${etagNumber}"`);
      if (force412) { force412 = false; etagNumber += 1; return jsonResponse(412, null); }
      current = JSON.parse(options.body); etagNumber += 1; return jsonResponse(200, null);
    }
  });
  assert.deepEqual(await mirror.mirror(board(2), 2, 2000), { written: true });
  assert.equal(current.openEventCount, 0);
  assert.deepEqual(await mirror.mirror(board(1), 1, 1000), { superseded: true });
  assert.equal(current.boardSequence, 2);
  delete current.openEvents;
  assert.deepEqual(await mirror.mirror(board(2), 2, 2000), { duplicate: true });
});
