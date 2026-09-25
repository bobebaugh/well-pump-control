"use strict";

const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");
const { reasonFilter, reasonMatches, MAX_EXPORT_DAYS, MAX_EXPORT_ROWS, MAX_PAGE_SIZE, _decodeCursor, _encodeCursor, eventTriggerField, exportRows, iso, joinOccurrences, observationView, pageFields, requestedColumns } = require("../lib/record-browser");

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
// Only an event link needs the rules, to find that event's trigger field; the
// column list itself comes from the records. One document, and only then.
async function eventDefinitions(site, query) {
  if (!query.event) return [];
  const snapshot = await site.collection("rulesEngineV3Draft").doc("events").get();
  return snapshot.exists && Array.isArray(snapshot.data().items) ? snapshot.data().items : [];
}
// The trigger field's values come with the page so the link needs one read.
function columnView(records, query, events) {
  const trigger = eventTriggerField(events, query.event);
  const columns = [...new Set([...requestedColumns(query.columns), ...(trigger ? [trigger] : [])])];
  return { catalog: pageFields(records), eventTriggerField: trigger, records: records.map(item => observationView(item, columns)) };
}
function timeQuery(observations, schemaVersion, field, before, count, since = null) {
  let query = observations.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", schemaVersion);
  if (since) query = query.where(field, ">=", Timestamp.fromDate(since));
  query = query.orderBy(field, "desc").orderBy(idField, "desc");
  if (before) query = query.startAfter(Timestamp.fromDate(before.time), before.id);
  return query.limit(count).get();
}
function initialSessionFollowingQuery(base, field, cycle, count) {
  return base.orderBy(field, "asc").orderBy(idField, "asc").startAt(cycle).limit(count);
}
// A filtered page keeps reading back, a batch at a time, until it has a full
// page, reaches the range's start, or has read MAX_SCAN records. The cursor is
// the last record read, matched or not, so Older continues where it stopped.
const SCAN_BATCH = 200;
const MAX_SCAN = 2000;
function observedTime(record) { return record.schemaVersion === 2 ? record.time.observedAt : record.observedAt; }
function reasonsOf(record) { return record.triggerReasons || (record.publishReason ? [{ kind: record.publishReason }] : []); }
async function observationPage(site, query) {
  const observations = site.collection("observations"); let pageCursor = cursor(query, "timestamp");
  if (!pageCursor && query.anchor !== undefined) { const anchor = date(query.anchor); if (!anchor) throw new BrowserInputError("invalid_anchor"); pageCursor = { time: anchor, id: "\uffff" }; }
  let since = null; if (query.start !== undefined) { since = date(query.start); if (!since) throw new BrowserInputError("invalid_range"); }
  const count = limit(query.limit); const filter = reasonFilter(query.filter); const batch = filter === "all" ? count : SCAN_BATCH;
  const events = await eventDefinitions(site, query);
  const records = []; let position = pageCursor; let scanned = 0; let exhausted = false; let stopped = null;
  while (records.length < count) {
    const [one, two] = await Promise.all([timeQuery(observations, 1, "observedAt", position, batch, since), timeQuery(observations, 2, "time.observedAt", position, batch, since)]);
    const read = [...one.docs, ...two.docs].map(serialise).sort((a, b) => observedTime(b).localeCompare(observedTime(a)) || b.recordId.localeCompare(a.recordId)).slice(0, batch);
    for (const record of read) {
      scanned += 1; stopped = record;
      if (reasonMatches(reasonsOf(record), filter)) records.push(record);
      if (records.length >= count) break;
    }
    if (read.length < batch && records.length < count) { exhausted = true; break; }
    position = stopped && { time: new Date(observedTime(stopped)), id: stopped.recordId };
    if (scanned >= MAX_SCAN) break;
  }
  const capped = !exhausted && records.length < count;
  return { status: records.length ? "ok" : "empty", ...columnView(records, query, events), scan: { filter, scanned, capped, searchedTo: capped && stopped ? observedTime(stopped) : null }, nextCursor: !exhausted && stopped ? _encodeCursor({ time: observedTime(stopped), id: stopped.recordId }) : null, previousCursor: pageCursor ? _encodeCursor({ time: pageCursor.time.toISOString(), id: pageCursor.id }) : null };
}
// Event occurrences first reported in a range, newest first, for the Event list.
async function eventsInRange(site, query) {
  const start = date(query.start); const end = date(query.end);
  if (!start || !end || end <= start || end.getTime() - start.getTime() > MAX_EXPORT_DAYS * 86400000) return { error: "invalid_range" };
  const snapshot = await site.collection("eventRecords").where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", 2).where("recordType", "==", "event-open").where("firstReportedAt", ">=", start.toISOString()).where("firstReportedAt", "<", end.toISOString()).orderBy("firstReportedAt", "desc").limit(100).get();
  return { status: "ok", events: snapshot.docs.map(serialise).map(item => ({ eventDefinitionId: item.eventDefinitionId, displayName: item.displayName, severity: item.severity, sessionId: item.sessionId, cycleSequence: item.opening?.cycleSequence ?? null, observedAt: iso(item.opening?.observedAt) || null, firstReportedAt: item.firstReportedAt })) };
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
async function exportRange(site, query) {
  const start = date(query.start); const end = date(query.end);
  if (!start || !end || end <= start || end.getTime() - start.getTime() > MAX_EXPORT_DAYS * 86400000) return { error: "invalid_range" };
  const observations = site.collection("observations");
  const read = (schema, field) => observations.where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", schema).where(field, ">=", Timestamp.fromDate(start)).where(field, "<", Timestamp.fromDate(end)).orderBy(field, "asc").orderBy(idField, "asc").limit(MAX_EXPORT_ROWS + 1).get();
  const [one, two] = await Promise.all([read(1, "observedAt"), read(2, "time.observedAt")]);
  // The size check counts every record in the range, so a filter can never
  // hide that the read stopped short.
  const all = [...one.docs, ...two.docs];
  if (all.length > MAX_EXPORT_ROWS) return { error: "export_too_large", count: all.length };
  const filter = reasonFilter(query.filter);
  const rows = all.map(serialise).filter(record => reasonMatches(reasonsOf(record), filter)).sort((a, b) => observedTime(a).localeCompare(observedTime(b)));
  return { csv: exportRows(rows, { timeZone: query.tz, columns: requestedColumns(query.columns) }), count: rows.length };
}
function createHandler(dependencies = {}) {
  const firestoreProvider = dependencies.getPilotFirestore || getPilotFirestore;
  return async function recordBrowser(event) {
    if (event.httpMethod !== "GET") return { ...json(405, { status: "error", code: "method_not_allowed" }), headers: { ...headers, Allow: "GET" } };
    try {
      const db = requireApprovedDb(firestoreProvider); const site = db.collection("sites").doc(SITE_ID); const query = event.queryStringParameters || {};
      if (query.view === "home") return json(200, await home(site));
      if (query.view === "export") {
        const result = await exportRange(site, query);
        if (result.error) return json(result.error === "export_too_large" ? 413 : 400, { status: "error", code: result.error, count: result.count });
        return { statusCode: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": "attachment; filename=durable-observations.csv", "X-Export-Record-Count": String(result.count) }, body: result.csv };
      }
      if (query.view === "events") { const result = await eventsInRange(site, query); return result.error ? json(400, { status: "error", code: result.error }) : json(200, result); }
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
