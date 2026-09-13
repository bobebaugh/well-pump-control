"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { FieldPath, getFirestore } = require("firebase-admin/firestore");
const { _decodeCursor, _encodeCursor, catalogFromSavedDraft, eventDefaultColumns, exportRows, fieldState, joinOccurrences, observationView } = require("../cloud/netlify/lib/record-browser");
const { _createHandler, _initialSessionFollowingQuery } = require("../cloud/netlify/functions/record-browser");

const draft = {
  devices: [{ enabled: true, fields: [{ systemName: "PumpWatts", label: "Pump watts", unit: "W", logging: { mode: "delta" } }, { systemName: "Hidden", logging: { mode: "none" } }] }],
  calculatedFields: [{ output: { systemName: "PressurePSI", label: "Pressure", unit: "psi", logging: { mode: "change" } } }],
  systemFields: [{ systemName: "ClockValid", label: "Clock", logging: { mode: "change" } }]
};

test("browser catalog is read-only shaped from logging-enabled saved rules", () => {
  const catalog = catalogFromSavedDraft(draft);
  assert.deepEqual(catalog.map(item => item.name), ["ClockValid", "PressurePSI", "PumpWatts"]);
  assert.equal(catalogFromSavedDraft({ devices: [] }), null);
  const selected = eventDefaultColumns([{ id: "E1", opening: { trigger: { condition: { clauses: [{ field: "PumpWatts" }] } } }, closing: { condition: { clauses: [{ field: "ClockValid" }] } }, onOpen: { assignments: [{ target: "PressurePSI" }] } }], "E1", catalog);
  assert.deepEqual(selected, ["ClockValid", "PressurePSI", "PumpWatts"]);
});

test("browser distinguishes available false/zero from unavailable and older missing fields", () => {
  const v2 = { schemaVersion: 2, recordId: "obs_s_0000000001", sessionId: "session000", cycleSequence: 4, time: { uptimeMs: 1, observedAt: "2026-03-08T06:59:59.000Z" }, fields: { Zero: { state: "available", value: 0 }, False: { state: "available", value: false }, Gone: { state: "unavailable", reason: "adc_invalid" } } };
  assert.deepEqual(fieldState(v2, "Zero"), { state: "available", value: 0 });
  assert.deepEqual(fieldState(v2, "False"), { state: "available", value: false });
  assert.deepEqual(fieldState(v2, "Gone"), { state: "unavailable", reason: "adc_invalid" });
  assert.equal(fieldState(v2, "NewField").state, "missing");
  const unsynchronised = observationView({ ...v2, time: { uptimeMs: 1 } }, ["Zero"]);
  assert.equal(unsynchronised.observationTimeStatus, "unavailable-unsynchronized");
  assert.equal(unsynchronised.fields.Zero.value, 0);
  assert.equal(fieldState({ schemaVersion: 1, values: { Zero: 0 }, status: { False: false } }, "Later").reason, "field_absent_from_legacy_record");
});

test("history joins same-name occurrences by session and occurrence identity", () => {
  const openA = { schemaVersion: 2, recordType: "event-open", sessionId: "sessionAAA", occurrenceId: "E1:1", displayName: "Same name" };
  const closeA = { ...openA, recordType: "event-close", closeReason: "inferred-board-disappearance" };
  const openB = { ...openA, occurrenceId: "E1:2" };
  const closeB = { ...openB, recordType: "event-close", closeReason: "ended-by-restart" };
  const joined = joinOccurrences([openA, closeA, openB, closeB]);
  assert.equal(joined.length, 2);
  assert.equal(joined.find(item => item.open.occurrenceId === "E1:1").close.closeReason, "inferred-board-disappearance");
  assert.equal(joined.find(item => item.open.occurrenceId === "E1:2").close.closeReason, "ended-by-restart");
});

test("cursor is deterministic and whole-day CSV keeps historical field union and timestamp roles", () => {
  const cursor = _decodeCursor(_encodeCursor({ time: "2026-11-01T05:00:00.000Z", id: "obs_s_0000000002" }));
  assert.deepEqual(cursor, { time: "2026-11-01T05:00:00.000Z", id: "obs_s_0000000002" });
  const csv = exportRows([
    { schemaVersion: 1, recordId: "old", sessionId: "oldsession", sequence: 1, observedAt: "2026-11-01T04:30:00.000Z", receivedAt: "2026-11-01T04:31:00.000Z", publishReason: "manual", values: { Legacy: 0 }, status: { ok: false } },
    { schemaVersion: 2, recordId: "new", sessionId: "newsession", cycleSequence: 2, time: { uptimeMs: 5 }, receivedAt: "2026-11-01T06:00:00.000Z", triggerReasons: [{ kind: "session-start" }], fields: { Current: { state: "unavailable", reason: "clock_unsynchronized" } } }
  ]);
  assert.match(csv, /Legacy,Legacy\.availability,Legacy\.reason/);
  assert.match(csv, /status\.ok,status\.ok\.availability,status\.ok\.reason/);
  assert.match(csv, /unavailable-unsynchronized/);
  assert.match(csv, /clock_unsynchronized/);
});

test("read endpoint is GET-only and reports an unavailable approved configuration without exposing details", async () => {
  const handler = _createHandler({ getPilotFirestore: () => ({ db: null, projectId: "wrong-project", databaseId: "(default)" }) });
  const wrongMethod = await handler({ httpMethod: "POST" });
  assert.equal(wrongMethod.statusCode, 405);
  const missing = await handler({ httpMethod: "GET", queryStringParameters: {} });
  assert.equal(missing.statusCode, 503);
  assert.deepEqual(JSON.parse(missing.body), { status: "error", code: "configuration_missing" });
});

function timestamp(value) { return { toDate: () => new Date(value) }; }
function browserFirestore(seed) {
  const values = new Map(Object.entries(seed));
  const name = field => typeof field === "string" ? field : "__name__";
  const valueAt = (data, field, id) => field === "__name__" ? id : field.split(".").reduce((current, part) => current?.[part], data);
  const firestoreType = value => value?.toDate ? "timestamp" : typeof value;
  const comparable = value => value?.toDate ? value.toDate().getTime() : value;
  const compare = (left, right) => typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
  class Ref { constructor(path) { this.path = path; this.id = path.split("/").at(-1); this.firestore = db; } collection(part) { return new Collection(`${this.path}/${part}`); } async get() { return snap(this.path); } }
  class Query {
    constructor(path, filters = [], orders = [], boundary = null, max = Infinity) { Object.assign(this, { path, filters, orders, boundary, max }); }
    where(field, operator, expected) { return new Query(this.path, [...this.filters, [name(field), operator, expected]], this.orders, this.boundary, this.max); }
    orderBy(field, direction = "asc") { return new Query(this.path, this.filters, [...this.orders, [name(field), direction]], this.boundary, this.max); }
    startAfter(...values) { return new Query(this.path, this.filters, this.orders, ["after", values], this.max); }
    startAt(...values) { return new Query(this.path, this.filters, this.orders, ["at", values], this.max); }
    endBefore(...values) { return new Query(this.path, this.filters, this.orders, ["before", values], this.max); }
    limit(max) { return new Query(this.path, this.filters, this.orders, this.boundary, max); }
    async get() {
      let rows = [...values.entries()].filter(([path]) => path.startsWith(`${this.path}/`) && !path.slice(this.path.length + 1).includes("/")).map(([path, data]) => ({ id: path.split("/").at(-1), data }));
      rows = rows.filter(row => this.filters.every(([field, op, expected]) => { const left = comparable(valueAt(row.data, field, row.id)); const right = comparable(expected); return op === "==" ? left === right : op === ">=" ? left >= right : op === "<" ? left < right : false; }));
      rows = rows.filter(row => this.orders.every(([field]) => valueAt(row.data, field, row.id) !== undefined));
      rows.sort((left, right) => {
        for (const [field, direction] of this.orders) {
          const leftValue = comparable(valueAt(left.data, field, left.id));
          const rightValue = comparable(valueAt(right.data, field, right.id));
          const order = compare(leftValue, rightValue);
          if (order) return direction === "desc" ? -order : order;
        }
        return 0;
      });
      if (this.boundary) {
        const [type, points] = this.boundary;
        const position = row => {
          for (let index = 0; index < points.length; index += 1) {
            const [field, direction] = this.orders[index];
            const rowValue = valueAt(row.data, field, row.id); const point = points[index];
            if (firestoreType(rowValue) !== firestoreType(point)) throw new Error(`cursor_type_mismatch:${field}`);
            const comparison = compare(comparable(rowValue), comparable(point));
            if (comparison) return direction === "desc" ? -comparison : comparison;
          }
          return 0;
        };
        rows = rows.filter(row => type === "after" ? position(row) > 0 : type === "at" ? position(row) >= 0 : position(row) < 0);
      }
      return { docs: rows.slice(0, this.max).map(row => ({ id: row.id, exists: true, data: () => row.data })) };
    }
  }
  class Collection extends Query { constructor(path) { super(path); } doc(id) { return new Ref(`${this.path}/${id}`); } }
  function snap(path) { const data = values.get(path); return { id: path.split("/").at(-1), exists: data !== undefined, data: () => data }; }
  const db = { collection: part => new Collection(part), getAll: async (...refs) => refs.map(ref => snap(ref.path)) };
  return db;
}

test("initial session navigation uses an actual Firestore SDK-valid cycle boundary", async () => {
  const app = initializeApp({ projectId: "well-pump-control" }, `record-browser-${process.pid}`);
  try {
    const base = getFirestore(app).collection("sites/well-main/observations")
      .where("deviceId", "==", "tab5-well-main")
      .where("schemaVersion", "==", 2)
      .where("sessionId", "==", "boot_4b08faf436e2");
    assert.throws(
      () => base.orderBy("cycleSequence", "asc").orderBy(FieldPath.documentId(), "asc").startAt(600, ""),
      /Only a direct child can be used as a query boundary/
    );
    const repaired = _initialSessionFollowingQuery(base, "cycleSequence", 600, 25);
    assert.equal(repaired._queryOptions.startAt.values.length, 1);
  } finally {
    await deleteApp(app);
  }
});

test("event session navigation keeps three prior records, pages both ways, and includes unsynchronized startup", async () => {
  const root = "sites/well-main";
  const saved = { items: [] };
  const session = "boot_4b08faf436e2";
  const record = (cycle, sessionId = session, observed = true) => ({
    schemaVersion: 2,
    recordId: `obs_${sessionId}_${String(cycle).padStart(10, "0")}`,
    deviceId: "tab5-well-main",
    sessionId,
    cycleSequence: cycle,
    time: { uptimeMs: cycle * 1000, ...(observed ? { observedAt: timestamp(`2026-09-13T00:${String(cycle % 60).padStart(2, "0")}:00.000Z`) } : {}) },
    receivedAt: timestamp("2026-09-13T01:00:00.000Z"),
    fields: { PumpWatts: { state: "available", value: cycle } }
  });
  const seed = {
    [`${root}/rulesEngineV3Draft/devices`]: { items: [{ enabled: true, fields: [{ systemName: "PumpWatts", logging: { mode: "change" } }] }] },
    [`${root}/rulesEngineV3Draft/calculatedFields`]: saved,
    [`${root}/rulesEngineV3Draft/systemFields`]: saved,
    [`${root}/rulesEngineV3Draft/events`]: { items: [] }
  };
  for (const cycle of [590, 596, 597, 598, 599, 600, 748]) {
    const item = record(cycle);
    seed[`${root}/observations/${item.recordId}`] = item;
  }
  for (const cycle of [0, 1]) {
    const item = record(cycle, "boot_UNSYNC000", false);
    seed[`${root}/observations/${item.recordId}`] = item;
  }
  const handler = _createHandler({ getPilotFirestore: () => ({ db: browserFirestore(seed), projectId: "well-pump-control", databaseId: "(default)" }) });
  const call = async queryStringParameters => JSON.parse((await handler({ httpMethod: "GET", queryStringParameters })).body);
  const initial = await call({ view: "session", session, cycle: "600", event: "S010", limit: "1", columns: "PumpWatts" });
  assert.deepEqual(initial.records.map(item => item.cycleSequence), [597, 598, 599, 600]);
  const earlier = await call({ view: "session", session, cycle: "600", cursor: initial.previousCursor, direction: "before", limit: "2", columns: "PumpWatts" });
  assert.deepEqual(earlier.records.map(item => item.cycleSequence), [590, 596]);
  const later = await call({ view: "session", session, cycle: "600", cursor: initial.nextCursor, direction: "after", limit: "1", columns: "PumpWatts" });
  assert.deepEqual(later.records.map(item => item.cycleSequence), [748]);
  const startup = await call({ view: "session", session: "boot_UNSYNC000", cycle: "0", limit: "10", columns: "PumpWatts" });
  assert.deepEqual(startup.records.map(item => item.cycleSequence), [0, 1]);
  assert.equal(startup.records[0].observationTimeStatus, "unavailable-unsynchronized");
});

test("endpoint keeps Timestamp observation cursors and string closure cursors distinct", async () => {
  const root = "sites/well-main";
  const saved = { items: [] };
  const seed = {
    [`${root}/rulesEngineV3Draft/devices`]: { items: [{ enabled: true, fields: [{ systemName: "PumpWatts", logging: { mode: "change" } }] }] },
    [`${root}/rulesEngineV3Draft/calculatedFields`]: saved, [`${root}/rulesEngineV3Draft/systemFields`]: saved, [`${root}/rulesEngineV3Draft/events`]: { items: [] },
    [`${root}/observations/v1-a`]: { schemaVersion: 1, recordId: "v1-a", deviceId: "tab5-well-main", sessionId: "session001", sequence: 1, observedAt: timestamp("2026-03-08T01:00:00.000Z"), receivedAt: timestamp("2026-03-08T01:01:00.000Z"), values: { PumpWatts: 0 } },
    [`${root}/observations/v2-b`]: { schemaVersion: 2, recordId: "v2-b", deviceId: "tab5-well-main", sessionId: "session001", cycleSequence: 2, time: { uptimeMs: 2, observedAt: timestamp("2026-03-08T01:00:00.000Z") }, receivedAt: timestamp("2026-03-08T01:02:00.000Z"), fields: { PumpWatts: { state: "available", value: false } } },
    [`${root}/observations/v2-c`]: { schemaVersion: 2, recordId: "v2-c", deviceId: "tab5-well-main", sessionId: "session001", cycleSequence: 9, time: { uptimeMs: 9 }, receivedAt: timestamp("2026-03-08T01:03:00.000Z"), fields: { PumpWatts: { state: "unavailable", reason: "clock" } } },
    [`${root}/observations/v2-d`]: { schemaVersion: 2, recordId: "v2-d", deviceId: "tab5-well-main", sessionId: "session001", cycleSequence: 7, time: { uptimeMs: 7, observedAt: timestamp("2026-03-08T00:50:00.000Z") }, receivedAt: timestamp("2026-03-08T01:02:30.000Z"), fields: { PumpWatts: { state: "available", value: 7 } } },
    [`${root}/observations/v2-e`]: { schemaVersion: 2, recordId: "v2-e", deviceId: "tab5-well-main", sessionId: "session001", cycleSequence: 11, time: { uptimeMs: 11 }, receivedAt: timestamp("2026-03-08T01:02:45.000Z"), fields: { PumpWatts: { state: "available", value: 11 } } },
    [`${root}/eventRecords/event-open--tab5-well-main--session001--old`]: { schemaVersion: 2, recordType: "event-open", recordId: "event-open--tab5-well-main--session001--old", deviceId: "tab5-well-main", sessionId: "session001", occurrenceId: "old", displayName: "Long run", severity: "Yellow", opening: { cycleSequence: 1 }, firstReportedAt: "2026-01-01T00:00:00.000Z" },
    [`${root}/eventRecords/event-close--tab5-well-main--session001--old`]: { schemaVersion: 2, recordType: "event-close", recordId: "event-close--tab5-well-main--session001--old", deviceId: "tab5-well-main", sessionId: "session001", occurrenceId: "old", closeReason: "ended-by-restart", restartDetectedAt: "2026-03-08T02:00:00Z" }
  };
  const expectedClosures = ["event-close--tab5-well-main--session001--old"];
  for (let index = 0; index < 104; index += 1) {
    const occurrenceId = `recent-${index}`;
    const prefix = `${root}/eventRecords/event-`;
    const detectedAt = new Date(Date.UTC(2026, 2, 7, 0, Math.floor(index / 2))).toISOString();
    const closeReason = index % 2 ? "ended-by-restart" : "inferred-board-disappearance";
    const closeId = `event-close--tab5-well-main--session001--${occurrenceId}`;
    expectedClosures.push(closeId);
    seed[`${prefix}open--tab5-well-main--session001--${occurrenceId}`] = { schemaVersion: 2, recordType: "event-open", recordId: `event-open--tab5-well-main--session001--${occurrenceId}`, deviceId: "tab5-well-main", sessionId: "session001", occurrenceId, displayName: "Recent closure", severity: "Blue", opening: { cycleSequence: index }, firstReportedAt: "2026-03-01T00:00:00.000Z" };
    seed[`${prefix}close--tab5-well-main--session001--${occurrenceId}`] = { schemaVersion: 2, recordType: "event-close", recordId: closeId, deviceId: "tab5-well-main", sessionId: "session001", occurrenceId, closeReason, ...(closeReason === "ended-by-restart" ? { restartDetectedAt: detectedAt } : { detectedAt }) };
  }
  const handler = _createHandler({ getPilotFirestore: () => ({ db: browserFirestore(seed), projectId: "well-pump-control", databaseId: "(default)" }) });
  const first = JSON.parse((await handler({ httpMethod: "GET", queryStringParameters: { limit: "1", columns: "PumpWatts" } })).body);
  assert.equal(first.records[0].recordId, "v2-b");
  const next = JSON.parse((await handler({ httpMethod: "GET", queryStringParameters: { limit: "1", cursor: first.nextCursor, columns: "PumpWatts" } })).body);
  assert.equal(next.records[0].recordId, "v1-a");
  const malformed = await handler({ httpMethod: "GET", queryStringParameters: { cursor: "not-a-cursor" } });
  assert.equal(JSON.parse(malformed.body).code, "invalid_cursor");
  const receipt = JSON.parse((await handler({ httpMethod: "GET", queryStringParameters: { view: "receipt", limit: "1", columns: "PumpWatts" } })).body);
  assert.equal(receipt.records[0].recordId, "v2-c");
  const history = JSON.parse((await handler({ httpMethod: "GET", queryStringParameters: { view: "history", limit: "17" } })).body);
  assert.equal(history.occurrences[0].open.displayName, "Long run");
  assert.equal(history.occurrences[0].close.closeReason, "ended-by-restart");
  assert.equal(history.occurrences.length, 17);
  assert.ok(history.nextCursor);
  const pages = [history.occurrences.map(item => item.close.recordId)]; const cursors = [null]; let nextHistoryCursor = history.nextCursor;
  while (nextHistoryCursor) {
    const nextHistory = JSON.parse((await handler({ httpMethod: "GET", queryStringParameters: { view: "history", limit: "17", cursor: nextHistoryCursor } })).body);
    if (!nextHistory.occurrences.length) break;
    cursors.push(nextHistoryCursor); pages.push(nextHistory.occurrences.map(item => item.close.recordId)); nextHistoryCursor = nextHistory.nextCursor;
  }
  const actualClosures = pages.flat();
  const expected = expectedClosures.sort((left, right) => {
    const record = seed[`${root}/eventRecords/${left}`]; const rightRecord = seed[`${root}/eventRecords/${right}`];
    const leftTime = record.detectedAt || record.restartDetectedAt;
    const rightTime = rightRecord.detectedAt || rightRecord.restartDetectedAt;
    return rightTime.localeCompare(leftTime) || right.localeCompare(left);
  });
  assert.deepEqual(actualClosures, expected);
  assert.equal(new Set(actualClosures).size, actualClosures.length);
  for (let index = pages.length - 2; index >= 0; index -= 1) {
    const back = JSON.parse((await handler({ httpMethod: "GET", queryStringParameters: { view: "history", limit: "17", cursor: cursors[index] || undefined } })).body);
    assert.deepEqual(back.occurrences.map(item => item.close.recordId), pages[index]);
  }
  const nearby = JSON.parse((await handler({ httpMethod: "GET", queryStringParameters: { view: "session", session: "session001", cycle: "9", limit: "1", columns: "PumpWatts" } })).body);
  assert.deepEqual(nearby.records.map(record => record.recordId), ["v1-a", "v2-b", "v2-d", "v2-c"]);
  const following = JSON.parse((await handler({ httpMethod: "GET", queryStringParameters: { view: "session", session: "session001", cycle: "9", cursor: nearby.nextCursor, direction: "after", limit: "1", columns: "PumpWatts" } })).body);
  assert.deepEqual(following.records.map(record => record.recordId), ["v2-e"]);
  const missingPrevious = JSON.parse((await handler({ httpMethod: "GET", queryStringParameters: { view: "session", session: "session001", cycle: "9", cursor: nearby.previousCursor, direction: "before", limit: "1", columns: "PumpWatts" } })).body);
  assert.equal(missingPrevious.status, "empty");
});
