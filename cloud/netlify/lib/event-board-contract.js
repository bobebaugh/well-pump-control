"use strict";

const { stableJson } = require("./ingest-record-contract");

class EventBoardError extends Error {
  constructor(code, field) { super(code); this.name = "EventBoardError"; this.code = code; this.field = field; }
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const OCCURRENCE = /^[A-Za-z0-9_.:-]{1,192}$/;
const RELEASE = /^[0-9]{14}-event-v3-v[1-9][0-9]*$/;
const HASH = /^[a-f0-9]{64}$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function fail(field, code = "invalid_board") { throw new EventBoardError(code, field); }
function requireValue(condition, field, code) { if (!condition) fail(field, code); }
function safeTree(value, field = "body", depth = 0) {
  requireValue(depth <= 12, field);
  if (typeof value === "number") requireValue(Number.isFinite(value), field);
  if (Array.isArray(value)) value.forEach((item, index) => safeTree(item, `${field}[${index}]`, depth + 1));
  else if (plain(value)) for (const [key, child] of Object.entries(value)) {
    requireValue(!FORBIDDEN.has(key), `${field}.${key}`);
    safeTree(child, `${field}.${key}`, depth + 1);
  }
}
function dateTime(value, field) {
  requireValue(typeof value === "string", field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  requireValue(match !== null && Number.isFinite(Date.parse(value)), field);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  requireValue(year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59, field);
  if (zone !== "Z") requireValue(Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59, field);
}
function exactKeys(value, keys, field) {
  requireValue(Object.keys(value).every(key => keys.includes(key)), field);
}
function validateRulesRelease(value, field = "rulesRelease") {
  requireValue(plain(value), field);
  exactKeys(value, ["releaseId", "packageVersion", "contentHash"], field);
  requireValue(typeof value.releaseId === "string" && RELEASE.test(value.releaseId), `${field}.releaseId`);
  requireValue(Number.isInteger(value.packageVersion) && value.packageVersion >= 1, `${field}.packageVersion`);
  requireValue(typeof value.contentHash === "string" && HASH.test(value.contentHash), `${field}.contentHash`);
}
function validateOpening(value, field) {
  requireValue(plain(value), field);
  exactKeys(value, ["kind", "cycleSequence", "uptimeMs", "observedAt"], field);
  requireValue(["condition-qualified", "occurrence-qualified", "unknown"].includes(value.kind), `${field}.kind`);
  requireValue(Number.isInteger(value.cycleSequence) && value.cycleSequence >= 0, `${field}.cycleSequence`);
  requireValue(Number.isInteger(value.uptimeMs) && value.uptimeMs >= 0, `${field}.uptimeMs`);
  if (value.observedAt !== undefined) dateTime(value.observedAt, `${field}.observedAt`);
}
function validateSlot(value, field) {
  requireValue(plain(value), field);
  exactKeys(value, ["occurrenceId", "displayName", "severity", "eventClass", "opening"], field);
  requireValue(typeof value.occurrenceId === "string" && OCCURRENCE.test(value.occurrenceId) && !value.occurrenceId.includes("/"), `${field}.occurrenceId`);
  requireValue(typeof value.displayName === "string" && value.displayName.length >= 1 && value.displayName.length <= 160, `${field}.displayName`);
  requireValue(["Info", "Yellow", "Red"].includes(value.severity), `${field}.severity`);
  requireValue(["transient", "latched", "monitor"].includes(value.eventClass), `${field}.eventClass`);
  validateOpening(value.opening, `${field}.opening`);
}
function validateEventBoard(value) {
  requireValue(plain(value), "body");
  safeTree(value);
  exactKeys(value, ["schemaVersion", "kind", "siteId", "deviceId", "sessionId", "boardSequence", "complete", "producedUptimeMs", "producedAt", "rulesRelease", "openEvents"], "body");
  requireValue(value.schemaVersion === 1, "schemaVersion", "unsupported_schema_version");
  requireValue(value.kind === "current-event-board", "kind");
  requireValue(typeof value.siteId === "string" && ID.test(value.siteId), "siteId");
  requireValue(typeof value.deviceId === "string" && ID.test(value.deviceId), "deviceId");
  requireValue(typeof value.sessionId === "string" && SESSION.test(value.sessionId), "sessionId");
  requireValue(Number.isInteger(value.boardSequence) && value.boardSequence >= 1 && value.boardSequence <= 9999999999, "boardSequence");
  requireValue(value.complete === true, "complete", "incomplete_board");
  requireValue(Number.isInteger(value.producedUptimeMs) && value.producedUptimeMs >= 0, "producedUptimeMs");
  if (value.producedAt !== undefined) dateTime(value.producedAt, "producedAt");
  validateRulesRelease(value.rulesRelease);
  requireValue(plain(value.openEvents), "openEvents");
  const entries = Object.entries(value.openEvents);
  requireValue(entries.length <= 100, "openEvents", "too_many_events");
  const occurrences = new Set();
  for (const [key, slot] of entries) {
    requireValue(EVENT_KEY.test(key), `openEvents.${key}`);
    validateSlot(slot, `openEvents.${key}`);
    requireValue(!occurrences.has(slot.occurrenceId), `openEvents.${key}.occurrenceId`);
    occurrences.add(slot.occurrenceId);
  }
  return value;
}

function canonicalBoard(value) { return JSON.parse(JSON.stringify(validateEventBoard(value))); }
function semanticBoard(value) { return stableJson(canonicalBoard(value)); }

module.exports = { EventBoardError, canonicalBoard, semanticBoard, validateEventBoard, validateRulesRelease };
