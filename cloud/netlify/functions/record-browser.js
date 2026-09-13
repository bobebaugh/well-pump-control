"use strict";

const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");
const { MAX_EXPORT_ROWS, MAX_PAGE_SIZE, _decodeCursor, _encodeCursor, catalogFromSavedDraft, eventDefaultColumns, exportRows, iso, joinOccurrences, observationView } = require("../lib/record-browser");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const idField = FieldPath.documentId();
function json(statusCode, body) { return { statusCode, headers, body: JSON.stringify(body) }; }
function limit(value, fallback = MAX_PAGE_SIZE) { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number, MAX_PAGE_SIZE) : fallback; }
function date(value) { const result = new Date(value); return Number.isFinite(result.getTime()) ? result : null; }
function serialise(snapshot) { return { ...snapshot.data(), recordId: snapshot.data().recordId || snapshot.id, receivedAt: iso(snapshot.data().receivedAt), observedAt: iso(snapshot.data().observedAt), time: { ...snapshot.data().time, observedAt: iso(snapshot.data().time?.observedAt) } }; }
function draftFromSnapshots(snapshots) { return Object.fromEntries(snapshots.map(snapshot => [snapshot.id, snapshot.exists ? snapshot.data().items : null])); }
function requireApprovedDb(provider) { const result = provider(); if (result.projectId !== "well-pump-control" || result.databaseId !== "(default)") throw new ConfigurationError("Firestore target is not the approved pilot database"); return result.db; }

async function savedCatalog(site) {
  const drafts = site.collection("rulesEngineV3Draft");
  const snapshots = await Promise.all(["devices", "calculatedFields", "systemFields", "events"].map(name => drafts.doc(name).get()));
  const draft = draftFromSnapshots(snapshots);
  const catalog = catalogFromSavedDraft(draft);
  return catalog ? { catalog, events: draft.events || [] } : { catalog: null, events: [] };
}
function timeQuery(observations, schemaVersion, field, before, count) {
  let query = observations.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", schemaVersion).orderBy(field, "desc").orderBy(idField, "desc");
  if (before) query = query.startAfter(Timestamp.fromDate(before.time), before.id);
  return query.limit(count).get();
}
async function observationPage(site, query) {
  const observations = site.collection("observations"); const cursor = _decodeCursor(query.cursor) || (() => { const anchor = date(query.anchor); return anchor ? { time: anchor.toISOString(), id: "\uffff" } : null; })(); const count = limit(query.limit);
  const [one, two] = await Promise.all([timeQuery(observations, 1, "observedAt", cursor, count), timeQuery(observations, 2, "time.observedAt", cursor, count)]);
  const catalogState = await savedCatalog(site);
  if (!catalogState.catalog) return { status: "configuration", code: "saved_rules_missing", records: [], catalog: [] };
  const records = [...one.docs, ...two.docs].map(serialise).sort((a, b) => {
    const left = a.schemaVersion === 2 ? a.time.observedAt : a.observedAt; const right = b.schemaVersion === 2 ? b.time.observedAt : b.observedAt;
    return right.localeCompare(left) || b.recordId.localeCompare(a.recordId);
  }).slice(0, count);
  const columns = String(query.columns || "").split(",").filter(name => catalogState.catalog.some(item => item.name === name));
  const next = records.at(-1); const nextTime = next && (next.schemaVersion === 2 ? next.time.observedAt : next.observedAt);
  return { status: records.length ? "ok" : "empty", catalog: catalogState.catalog, defaultColumns: eventDefaultColumns(catalogState.events, query.event, catalogState.catalog), records: records.map(item => observationView(item, columns)), nextCursor: next ? _encodeCursor({ time: nextTime, id: next.recordId }) : null };
}
async function receiptPage(site, query) {
  const observations = site.collection("observations"); const cursor = _decodeCursor(query.cursor); const count = limit(query.limit);
  const read = schema => { let request = observations.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", schema).orderBy("receivedAt", "desc").orderBy(idField, "desc"); if (cursor) request = request.startAfter(Timestamp.fromDate(cursor.time), cursor.id); return request.limit(count).get(); };
  const [one, two, catalogState] = await Promise.all([read(1), read(2), savedCatalog(site)]);
  if (!catalogState.catalog) return { status: "configuration", code: "saved_rules_missing", records: [], catalog: [] };
  const columns = String(query.columns || "").split(",").filter(name => catalogState.catalog.some(item => item.name === name));
  const records = [...one.docs, ...two.docs].map(serialise).sort((left, right) => right.receivedAt.localeCompare(left.receivedAt) || right.recordId.localeCompare(left.recordId)).slice(0, count);
  const last = records.at(-1);
  return { status: records.length ? "ok" : "empty", source: "receipt-time-fallback", catalog: catalogState.catalog, defaultColumns: eventDefaultColumns(catalogState.events, query.event, catalogState.catalog), records: records.map(item => observationView(item, columns)), nextCursor: last ? _encodeCursor({ time: last.receivedAt, id: last.recordId }) : null };
}
async function sessionPage(site, query) {
  const sessionId = typeof query.session === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(query.session) ? query.session : null;
  const cycle = Number(query.cycle);
  if (!sessionId || !Number.isInteger(cycle) || cycle < 0) return { status: "error", code: "invalid_session_navigation", records: [], catalog: [] };
  const observations = site.collection("observations"); const count = limit(query.limit);
  const around = async (schema, field) => {
    const base = observations.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", schema).where("sessionId", "==", sessionId);
    return (await base.orderBy(field, "asc").startAt(cycle).limit(count).get()).docs;
  };
  const [one, two, catalogState] = await Promise.all([around(1, "sequence"), around(2, "cycleSequence"), savedCatalog(site)]);
  if (!catalogState.catalog) return { status: "configuration", code: "saved_rules_missing", records: [], catalog: [] };
  const columns = String(query.columns || "").split(",").filter(name => catalogState.catalog.some(item => item.name === name));
  const records = [...one, ...two].map(serialise).sort((left, right) => (left.schemaVersion === 2 ? left.cycleSequence : left.sequence) - (right.schemaVersion === 2 ? right.cycleSequence : right.sequence)).slice(0, count);
  return { status: records.length ? "ok" : "empty", catalog: catalogState.catalog, defaultColumns: eventDefaultColumns(catalogState.events, query.event, catalogState.catalog), records: records.map(item => observationView(item, columns)), nextCursor: null, navigation: { sessionId, cycle } };
}
async function eventHistory(site, count) {
  const history = site.collection("eventRecords");
  const openings = await history.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", 2).where("recordType", "==", "event-open").orderBy("firstReportedAt", "desc").orderBy(idField, "desc").limit(count).get();
  const openRecords = openings.docs.map(serialise);
  const closeIds = openRecords.map(item => item.recordId.replace("event-open--", "event-close--"));
  const closeSnapshots = closeIds.length ? await site.firestore.getAll(...closeIds.map(id => history.doc(id))) : [];
  return joinOccurrences([...openRecords, ...closeSnapshots.filter(item => item.exists).map(serialise)]);
}
async function home(site) {
  const [boardSnapshot, history] = await Promise.all([site.collection("eventBoardState").doc(DEVICE_ID).get(), eventHistory(site, 10)]);
  const board = boardSnapshot.exists ? boardSnapshot.data() : null;
  return { status: board ? "ok" : "empty", board: board ? { ...board, lastReportAt: iso(board.lastReportAt), lastBoardProducedAt: iso(board.lastBoardProducedAt) } : null, recentClosed: history.filter(item => item.close) };
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
      if (query.view === "history") return json(200, { status: "ok", occurrences: await eventHistory(site, limit(query.limit, 50)) });
      if (query.view === "session") return json(200, await sessionPage(site, query));
      if (query.view === "receipt") return json(200, await receiptPage(site, query));
      return json(200, await observationPage(site, query));
    } catch (error) {
      const configuration = error instanceof ConfigurationError;
      const denied = !configuration && /permission|denied/i.test(String(error?.code || ""));
      console.error("Record browser read failed", { category: configuration ? "configuration" : denied ? "denied" : "firestore", code: error?.code || "unknown" });
      return json(denied ? 403 : 503, { status: "error", code: configuration ? "configuration_missing" : denied ? "read_denied" : "read_unavailable" });
    }
  };
}
exports.handler = createHandler();
exports._createHandler = createHandler;
