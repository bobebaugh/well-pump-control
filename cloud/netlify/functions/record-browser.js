"use strict";

const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");
const { MAX_EXPORT_ROWS, MAX_PAGE_SIZE, _decodeCursor, _encodeCursor, eventDefaultColumns, exportRows, iso, joinOccurrences, observationView, pageFields, requestedColumns } = require("../lib/record-browser");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const idField = FieldPath.documentId();
class BrowserInputError extends Error { constructor(code) { super(code); this.code = code; } }
function json(statusCode, body) { return { statusCode, headers, body: JSON.stringify(body) }; }
function limit(value, fallback = MAX_PAGE_SIZE) { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number, MAX_PAGE_SIZE) : fallback; }
function date(value) { const result = new Date(value); return typeof value === "string" && Number.isFinite(result.getTime()) ? result : null; }
function cursor(query, kind) {
  const raw = query.cursor;
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = _decodeCursor(raw);
  if (!parsed || ((kind === "timestamp" || kind === "string-time") && !parsed.time) || (kind === "sequence" && !Number.isInteger(parsed.sequence))) throw new BrowserInputError("invalid_cursor");
  // Observation and receipt fields are Firestore Timestamps. Event-board closure
  // fields are persisted RFC3339 strings and must use a string cursor boundary.
  return kind === "timestamp" ? { ...parsed, time: new Date(parsed.time) } : parsed;
}
function serialise(snapshot) { return { ...snapshot.data(), recordId: snapshot.data().recordId || snapshot.id, receivedAt: iso(snapshot.data().receivedAt), observedAt: iso(snapshot.data().observedAt), firstReportedAt: iso(snapshot.data().firstReportedAt), detectedAt: iso(snapshot.data().detectedAt), restartDetectedAt: iso(snapshot.data().restartDetectedAt), time: { ...snapshot.data().time, observedAt: iso(snapshot.data().time?.observedAt) } }; }
function requireApprovedDb(provider) { const result = provider(); if (result.projectId !== "well-pump-control" || result.databaseId !== "(default)") throw new ConfigurationError("Firestore target is not the approved pilot database"); return result.db; }
// Only an event link needs the rules, to choose that event's fields; the
// column list itself comes from the records. One document, and only then.
async function eventDefinitions(site, query) {
  if (!query.event) return [];
  const snapshot = await site.collection("rulesEngineV3Draft").doc("events").get();
  return snapshot.exists && Array.isArray(snapshot.data().items) ? snapshot.data().items : [];
}
function columnView(records, query, events) {
  const catalog = pageFields(records);
  const columns = requestedColumns(query.columns);
  return { catalog, defaultColumns: eventDefaultColumns(events, query.event, catalog), records: records.map(item => observationView(item, columns)) };
}
function timeQuery(observations, schemaVersion, field, before, count) {
  let query = observations.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", schemaVersion).orderBy(field, "desc").orderBy(idField, "desc");
  if (before) query = query.startAfter(Timestamp.fromDate(before.time), before.id);
  return query.limit(count).get();
}
function initialSessionFollowingQuery(base, field, cycle, count) {
  return base.orderBy(field, "asc").orderBy(idField, "asc").startAt(cycle).limit(count);
}
async function observationPage(site, query) {
  const observations = site.collection("observations"); let pageCursor = cursor(query, "timestamp");
  if (!pageCursor && query.anchor !== undefined) { const anchor = date(query.anchor); if (!anchor) throw new BrowserInputError("invalid_anchor"); pageCursor = { time: anchor, id: "\uffff" }; }
  const count = limit(query.limit);
  const [one, two, events] = await Promise.all([timeQuery(observations, 1, "observedAt", pageCursor, count), timeQuery(observations, 2, "time.observedAt", pageCursor, count), eventDefinitions(site, query)]);
  const records = [...one.docs, ...two.docs].map(serialise).sort((a, b) => {
    const left = a.schemaVersion === 2 ? a.time.observedAt : a.observedAt; const right = b.schemaVersion === 2 ? b.time.observedAt : b.observedAt;
    return right.localeCompare(left) || b.recordId.localeCompare(a.recordId);
  }).slice(0, count);
  const next = records.at(-1); const nextTime = next && (next.schemaVersion === 2 ? next.time.observedAt : next.observedAt);
  return { status: records.length ? "ok" : "empty", ...columnView(records, query, events), nextCursor: next ? _encodeCursor({ time: nextTime, id: next.recordId }) : null, previousCursor: pageCursor ? _encodeCursor({ time: pageCursor.time.toISOString(), id: pageCursor.id }) : null };
}
async function receiptPage(site, query) {
  const observations = site.collection("observations"); const pageCursor = cursor(query, "timestamp"); const count = limit(query.limit);
  const read = schema => { let request = observations.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", schema).orderBy("receivedAt", "desc").orderBy(idField, "desc"); if (pageCursor) request = request.startAfter(Timestamp.fromDate(pageCursor.time), pageCursor.id); return request.limit(count).get(); };
  const [one, two, events] = await Promise.all([read(1), read(2), eventDefinitions(site, query)]);
  const records = [...one.docs, ...two.docs].map(serialise).sort((left, right) => right.receivedAt.localeCompare(left.receivedAt) || right.recordId.localeCompare(left.recordId)).slice(0, count);
  const last = records.at(-1);
  return { status: records.length ? "ok" : "empty", source: "receipt-time-fallback", ...columnView(records, query, events), nextCursor: last ? _encodeCursor({ time: last.receivedAt, id: last.recordId }) : null, previousCursor: pageCursor ? _encodeCursor({ time: pageCursor.time.toISOString(), id: pageCursor.id }) : null };
}
async function sessionPage(site, query) {
  const sessionId = typeof query.session === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(query.session) ? query.session : null;
  const cycle = Number(query.cycle);
  if (!sessionId || !Number.isInteger(cycle) || cycle < 0) return { status: "error", code: "invalid_session_navigation", records: [], catalog: [] };
  const observations = site.collection("observations"); const count = limit(query.limit); const pageCursor = cursor(query, "sequence"); const direction = query.direction === "before" ? "before" : "after";
  const around = async (schema, field) => {
    const base = observations.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", schema).where("sessionId", "==", sessionId);
    // Contract-generated observation IDs sort after "0". In descending order this
    // selects strictly earlier durable observations, not arithmetic cycle numbers.
    if (pageCursor && direction === "before") return (await base.orderBy(field, "desc").orderBy(idField, "desc").startAfter(pageCursor.sequence, "0").limit(count).get()).docs.reverse();
    if (pageCursor) return (await base.orderBy(field, "asc").orderBy(idField, "asc").startAfter(pageCursor.sequence, pageCursor.id).limit(count).get()).docs;
    const [previous, following] = await Promise.all([
      base.orderBy(field, "desc").orderBy(idField, "desc").startAfter(cycle, "0").limit(3).get(),
      initialSessionFollowingQuery(base, field, cycle, count).get()
    ]);
    return [...previous.docs.reverse(), ...following.docs];
  };
  const [one, two, events] = await Promise.all([around(1, "sequence"), around(2, "cycleSequence"), eventDefinitions(site, query)]);
  const records = [...one, ...two].map(serialise).sort((left, right) => {
    const leftSequence = left.schemaVersion === 2 ? left.cycleSequence : left.sequence;
    const rightSequence = right.schemaVersion === 2 ? right.cycleSequence : right.sequence;
    return leftSequence - rightSequence || left.recordId.localeCompare(right.recordId);
  });
  const sequence = record => record.schemaVersion === 2 ? record.cycleSequence : record.sequence;
  const selected = pageCursor ? records.slice(0, count) : [
    ...records.filter(record => sequence(record) < cycle).slice(-3),
    ...records.filter(record => sequence(record) >= cycle).slice(0, count)
  ];
  const first = selected.at(0); const last = selected.at(-1);
  return { status: selected.length ? "ok" : "empty", ...columnView(selected, query, events), nextCursor: last ? _encodeCursor({ sequence: sequence(last), id: last.recordId }) : null, previousCursor: first ? _encodeCursor({ sequence: sequence(first), id: first.recordId }) : null, navigation: { sessionId, cycle } };
}
function closureTime(record) { return iso(record.closeReason === "ended-by-restart" ? record.restartDetectedAt : record.detectedAt); }
function closureQuery(history, reason, field, pageCursor, count) {
  let request = history.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", 2).where("recordType", "==", "event-close").where("closeReason", "==", reason).orderBy(field, "desc").orderBy(idField, "desc");
  if (pageCursor) request = request.startAfter(pageCursor.time, pageCursor.id);
  return request.limit(count).get();
}
async function eventHistory(site, count, query = {}) {
  const history = site.collection("eventRecords");
  const pageCursor = cursor(query, "string-time");
  const [inferred, restart] = await Promise.all([
    closureQuery(history, "inferred-board-disappearance", "detectedAt", pageCursor, count),
    closureQuery(history, "ended-by-restart", "restartDetectedAt", pageCursor, count)
  ]);
  const closes = [...inferred.docs, ...restart.docs].map(serialise).sort((left, right) => {
    const order = closureTime(right).localeCompare(closureTime(left)); return order || right.recordId.localeCompare(left.recordId);
  }).slice(0, count);
  const openIds = closes.map(item => item.recordId.replace("event-close--", "event-open--"));
  const openingSnapshots = openIds.length ? await site.firestore.getAll(...openIds.map(id => history.doc(id))) : [];
  const occurrences = joinOccurrences([...closes, ...openingSnapshots.filter(item => item.exists).map(serialise)]).filter(item => item.close);
  const last = closes.at(-1);
  return { occurrences, nextCursor: last ? _encodeCursor({ time: closureTime(last), id: last.recordId }) : null, previousCursor: pageCursor ? _encodeCursor({ time: pageCursor.time, id: pageCursor.id }) : null };
}
async function home(site) {
  const [boardSnapshot, history] = await Promise.all([site.collection("eventBoardState").doc(DEVICE_ID).get(), eventHistory(site, 10)]);
  const board = boardSnapshot.exists ? boardSnapshot.data() : null;
  return { status: board ? "ok" : "empty", board: board ? { ...board, lastReportAt: iso(board.lastReportAt), lastBoardProducedAt: iso(board.lastBoardProducedAt) } : null, recentClosed: history.occurrences };
}
async function exportDay(site, query) {
  const start = date(query.start); const end = date(query.end);
  if (!start || !end || end <= start || end.getTime() - start.getTime() > 27 * 3600000) return { error: "invalid_day_range" };
  const observations = site.collection("observations");
  const read = (schema, field) => observations.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", schema).where(field, ">=", Timestamp.fromDate(start)).where(field, "<", Timestamp.fromDate(end)).orderBy(field, "asc").orderBy(idField, "asc").limit(MAX_EXPORT_ROWS + 1).get();
  const [one, two] = await Promise.all([read(1, "observedAt"), read(2, "time.observedAt")]);
  const rows = [...one.docs, ...two.docs].map(serialise).sort((a, b) => (a.schemaVersion === 2 ? a.time.observedAt : a.observedAt).localeCompare(b.schemaVersion === 2 ? b.time.observedAt : b.observedAt));
  if (rows.length > MAX_EXPORT_ROWS) return { error: "export_too_large", count: rows.length };
  return { csv: exportRows(rows), count: rows.length };
}
function createHandler(dependencies = {}) {
  const firestoreProvider = dependencies.getPilotFirestore || getPilotFirestore;
  return async function recordBrowser(event) {
    if (event.httpMethod !== "GET") return { ...json(405, { status: "error", code: "method_not_allowed" }), headers: { ...headers, Allow: "GET" } };
    try {
      const db = requireApprovedDb(firestoreProvider); const site = db.collection("sites").doc(SITE_ID); const query = event.queryStringParameters || {};
      if (query.view === "home") return json(200, await home(site));
      if (query.view === "export") {
        const result = await exportDay(site, query);
        if (result.error) return json(result.error === "export_too_large" ? 413 : 400, { status: "error", code: result.error, count: result.count });
        return { statusCode: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": "attachment; filename=durable-observations.csv", "X-Export-Record-Count": String(result.count) }, body: result.csv };
      }
      if (query.view === "history") return json(200, { status: "ok", ...(await eventHistory(site, limit(query.limit, 50), query)) });
      if (query.view === "session") return json(200, await sessionPage(site, query));
      if (query.view === "receipt") return json(200, await receiptPage(site, query));
      return json(200, await observationPage(site, query));
    } catch (error) {
      if (error instanceof BrowserInputError) return json(400, { status: "error", code: error.code });
      const configuration = error instanceof ConfigurationError;
      const denied = !configuration && /permission|denied/i.test(String(error?.code || ""));
      console.error("Record browser read failed", { category: configuration ? "configuration" : denied ? "denied" : "firestore", code: error?.code || "unknown" });
      return json(denied ? 403 : 503, { status: "error", code: configuration ? "configuration_missing" : denied ? "read_denied" : "read_unavailable" });
    }
  };
}
exports.handler = createHandler();
exports._createHandler = createHandler;
exports._initialSessionFollowingQuery = initialSessionFollowingQuery;
