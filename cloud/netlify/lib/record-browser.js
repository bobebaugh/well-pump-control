"use strict";

const MAX_PAGE_SIZE = 50;
const MAX_EXPORT_ROWS = 5000;
const MAX_EXPORT_DAYS = 32;
const { summary: reasonSummary } = require("../../../web/record-reasons.js");

function iso(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

// The columns on offer are the fields the records themselves carry. A v2
// record holds every field that was logging-enabled in the package that wrote
// it, so this follows the running package -- not the draft being edited -- and
// fields that come and go with logging settings come and go here too. Legacy v1
// records carry raw device keys rather than rules fields and offer none.
function pageFields(records) {
  const names = new Set();
  for (const record of records || []) {
    if (record?.schemaVersion === 2) Object.keys(record.fields || {}).forEach(name => names.add(name));
  }
  return [...names].sort((left, right) => left.localeCompare(right)).map(name => ({ name }));
}

// A requested column need not be on this page: a saved selection keeps names
// that are absent for now, and each reads back as missing. Names are bounded to
// the durable-record field pattern.
const MAX_COLUMNS = 64;
function requestedColumns(raw) {
  const names = String(raw || "").split(",").filter(name => /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(name));
  return [...new Set(names)].slice(0, MAX_COLUMNS);
}

// An event link adds the field that opens the event: the first clause of its
// opening trigger. The rest of the view is the viewer's own selection.
function eventTriggerField(events, eventDefinitionId) {
  if (!eventDefinitionId) return null;
  const event = (events || []).find(item => item?.id === eventDefinitionId);
  const field = event?.opening?.trigger?.condition?.clauses?.[0]?.field;
  return typeof field === "string" && /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(field) ? field : null;
}

function fieldState(record, name) {
  if (record?.schemaVersion === 2) {
    const state = record.fields?.[name];
    if (state?.state === "available") return { state: "available", value: state.value };
    if (state?.state === "unavailable") return { state: "unavailable", reason: state.reason };
    return { state: "missing", reason: "field_absent_from_record" };
  }
  if (Object.hasOwn(record?.values || {}, name)) return { state: "available", value: record.values[name] };
  if (Object.hasOwn(record?.status || {}, name)) return { state: "available", value: record.status[name] };
  return { state: "missing", reason: "field_absent_from_legacy_record" };
}

function observationView(record, columns = []) {
  const observationTime = record.schemaVersion === 2 ? iso(record.time?.observedAt) : iso(record.observedAt);
  const receiptTime = iso(record.receivedAt);
  return {
    recordId: record.recordId,
    schemaVersion: record.schemaVersion,
    sessionId: record.sessionId,
    cycleSequence: record.schemaVersion === 2 ? record.cycleSequence : record.sequence,
    uptimeMs: record.schemaVersion === 2 ? record.time?.uptimeMs : null,
    observationTime,
    receiptTime,
    observationTimeStatus: observationTime ? "reported-device-time" : "unavailable-unsynchronized",
    rulesRelease: record.rulesRelease || null,
    triggerReasons: record.triggerReasons || (record.publishReason ? [{ kind: record.publishReason }] : []),
    fields: Object.fromEntries(columns.map(name => [name, fieldState(record, name)])),
    raw: { values: record.schemaVersion === 1 ? record.values || {} : undefined, status: record.schemaVersion === 1 ? record.status || {} : undefined }
  };
}

function occurrenceKey(record) { return `${record.sessionId}\u0000${record.occurrenceId}`; }
function joinOccurrences(records) {
  const opens = new Map(); const closes = new Map();
  for (const record of records || []) {
    if (record?.schemaVersion !== 2 || !record.occurrenceId || !record.sessionId) continue;
    (record.recordType === "event-open" ? opens : record.recordType === "event-close" ? closes : new Map()).set(occurrenceKey(record), record);
  }
  return [...opens.values()].map(open => ({ open, close: closes.get(occurrenceKey(open)) || null }));
}

function encodeCursor(value) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decodeCursor(value) {
  if (!value || typeof value !== "string" || value.length > 1000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed?.id !== "string" || !parsed.id || parsed.id.length > 256) return null;
    if (typeof parsed?.time === "string") {
      const time = new Date(parsed.time);
      // Validate the RFC3339 instant without changing its serialized form. Event
      // history uses its stored ISO string as an ordered Firestore cursor value.
      return Number.isFinite(time.getTime()) ? { time: parsed.time, id: parsed.id } : null;
    }
    if (Number.isInteger(parsed?.sequence) && parsed.sequence >= 0 && parsed.sequence <= Number.MAX_SAFE_INTEGER) return { sequence: parsed.sequence, id: parsed.id };
    return null;
  } catch { return null; }
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : (typeof value === "string" ? value : JSON.stringify(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// The viewer's time zone, when it is one this runtime knows; otherwise none.
function timeZone(value) {
  if (typeof value !== "string" || !value || value.length > 64) return null;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone; } catch { return null; }
}
// The same instant written as local wall-clock time with its offset, for
// example 2026-09-25T00:02:25.000-04:00. The UTC column stays beside it.
function localIso(value, zone) {
  if (!value || !zone) return null;
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, timeZoneName: "longOffset" }).formatToParts(instant).map(part => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
}

// options.timeZone adds local-time columns; options.columns, when given, keeps
// only those fields (each still with its availability and reason).
function exportRows(records, options = {}) {
  const zone = timeZone(options.timeZone);
  const only = Array.isArray(options.columns) && options.columns.length ? new Set(options.columns) : null;
  const names = new Set();
  for (const record of records) {
    Object.keys(record.fields || {}).forEach(name => names.add(name));
    Object.keys(record.values || {}).forEach(name => names.add(name));
    Object.keys(record.status || {}).forEach(name => names.add(`status.${name}`));
  }
  const columns = [...names].filter(name => !only || only.has(name)).sort();
  const local = zone ? ["observationTimeLocal", "receiptTimeLocal"] : [];
  const header = ["recordId", "schemaVersion", "sessionId", "cycleSequence", ...local, "observationTime", "receiptTime", "observationTimeStatus", "reasonSummary", "triggerReasons", ...columns.flatMap(name => [name, `${name}.availability`, `${name}.reason`])];
  const lines = [header.map(csvCell).join(",")];
  for (const record of records) {
    const view = observationView(record, []);
    const values = [view.recordId, view.schemaVersion, view.sessionId, view.cycleSequence, ...(zone ? [localIso(view.observationTime, zone), localIso(view.receiptTime, zone)] : []), view.observationTime, view.receiptTime, view.observationTimeStatus, reasonSummary(view.triggerReasons), view.triggerReasons];
    for (const name of columns) {
      const state = name.startsWith("status.")
        ? (Object.hasOwn(record.status || {}, name.slice(7)) ? { state: "available", value: record.status[name.slice(7)] } : { state: "missing", reason: "field_absent_from_legacy_record" })
        : fieldState(record, name);
      values.push(state.value, state.state, state.reason || null);
    }
    lines.push(values.map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

module.exports = { MAX_EXPORT_DAYS, MAX_EXPORT_ROWS, MAX_PAGE_SIZE, _decodeCursor: decodeCursor, _encodeCursor: encodeCursor, eventTriggerField, exportRows, fieldState, iso, localIso, joinOccurrences, observationView, pageFields, requestedColumns };
