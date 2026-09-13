"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _decodeCursor, _encodeCursor, catalogFromSavedDraft, eventDefaultColumns, exportRows, fieldState, joinOccurrences, observationView } = require("../cloud/netlify/lib/record-browser");
const { _createHandler } = require("../cloud/netlify/functions/record-browser");

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
