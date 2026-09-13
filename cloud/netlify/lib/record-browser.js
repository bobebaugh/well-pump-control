"use strict";

const MAX_PAGE_SIZE = 50;
const MAX_EXPORT_ROWS = 5000;

function iso(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function loggingField(field, kind) {
  if (!field || field.logging?.mode === "none" || !field.systemName) return null;
  return { name: field.systemName, label: field.label || field.systemName, unit: field.unit || null, kind };
}

function catalogFromSavedDraft(draft) {
  if (!draft || !Array.isArray(draft.devices) || !Array.isArray(draft.calculatedFields) || !Array.isArray(draft.systemFields)) return null;
  const catalog = [];
  for (const device of draft.devices) {
    if (device?.enabled === false) continue;
    for (const field of device?.fields || []) {
      const item = loggingField(field, "device"); if (item) catalog.push(item);
    }
  }
  for (const calculated of draft.calculatedFields) {
    for (const output of calculated?.outputs || (calculated?.output ? [calculated.output] : [])) {
      const item = loggingField(output, "calculated"); if (item) catalog.push(item);
    }
  }
  for (const field of draft.systemFields) {
    const item = loggingField(field, "system"); if (item) catalog.push(item);
  }
  return catalog.sort((left, right) => left.name.localeCompare(right.name));
}

function conditionFields(condition) { return (condition?.clauses || []).map(item => item?.field).filter(Boolean); }
function guardedFields(phase) {
  return (phase?.guardedGroups || []).flatMap(group => [
    ...conditionFields(group?.guard),
    ...(group?.assignments || []).map(item => item?.target)
  ]).filter(Boolean);
}
function eventDefaultColumns(events, eventDefinitionId, catalog) {
  const event = (events || []).find(item => item?.id === eventDefinitionId);
  const requested = new Set([
    ...conditionFields(event?.opening?.trigger?.condition),
    ...conditionFields(event?.closing?.condition),
    ...(event?.onOpen?.assignments || []).map(item => item?.target),
    ...(event?.onClose?.assignments || []).map(item => item?.target),
    ...guardedFields(event?.onOpen),
    ...guardedFields(event?.onClose)
  ]);
  return (catalog || []).filter(item => requested.has(item.name)).map(item => item.name);
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
      return Number.isFinite(time.getTime()) ? { time: time.toISOString(), id: parsed.id } : null;
    }
    if (Number.isInteger(parsed?.sequence) && parsed.sequence >= 0 && parsed.sequence <= Number.MAX_SAFE_INTEGER) return { sequence: parsed.sequence, id: parsed.id };
    return null;
  } catch { return null; }
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : (typeof value === "string" ? value : JSON.stringify(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportRows(records) {
  const names = new Set();
  for (const record of records) {
    Object.keys(record.fields || {}).forEach(name => names.add(name));
    Object.keys(record.values || {}).forEach(name => names.add(name));
    Object.keys(record.status || {}).forEach(name => names.add(`status.${name}`));
  }
  const columns = [...names].sort();
  const header = ["recordId", "schemaVersion", "sessionId", "cycleSequence", "observationTime", "receiptTime", "observationTimeStatus", "triggerReasons", ...columns.flatMap(name => [name, `${name}.availability`, `${name}.reason`])];
  const lines = [header.map(csvCell).join(",")];
  for (const record of records) {
    const view = observationView(record, []);
    const values = [view.recordId, view.schemaVersion, view.sessionId, view.cycleSequence, view.observationTime, view.receiptTime, view.observationTimeStatus, view.triggerReasons];
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

module.exports = { MAX_EXPORT_ROWS, MAX_PAGE_SIZE, _decodeCursor: decodeCursor, _encodeCursor: encodeCursor, catalogFromSavedDraft, eventDefaultColumns, exportRows, fieldState, iso, joinOccurrences, observationView };
