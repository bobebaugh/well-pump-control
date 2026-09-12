"use strict";

class IngestRecordError extends Error {
  constructor(code, field) {
    super(code);
    this.name = "IngestRecordError";
    this.code = code;
    this.field = field;
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const EVENT_ID_PATTERN = /^[0-9]{14}-[a-z0-9][a-z0-9-]{0,63}-[A-Za-z0-9_-]{8,64}-[0-9]{10}$/;
const COMMAND_ID_PATTERN = /^[0-9]{14}-command-[A-Za-z0-9_-]{8,64}-[0-9]{10}$/;
const RULE_RELEASE_ID_PATTERN = /^[0-9]{14}-rules-v[0-9]+$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const PUBLISH_REASONS = new Set(["material-change", "maximum-interval", "event-boundary", "manual"]);
const CLOSE_REASONS = new Set([
  "condition-cleared", "user-request", "rules-updated", "rule-disabled",
  "rule-removed", "restart-reconciliation"
]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(field, code = "invalid_record") {
  throw new IngestRecordError(code, field);
}

function requireCondition(condition, field, code) {
  if (!condition) fail(field, code);
}

function validateSafeTree(value, field = "body", depth = 0) {
  requireCondition(depth <= 16, field);
  if (typeof value === "number") {
    requireCondition(Number.isFinite(value), field);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSafeTree(item, `${field}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    requireCondition(!FORBIDDEN_KEYS.has(key), `${field}.${key}`);
    validateSafeTree(child, `${field}.${key}`, depth + 1);
  }
}

function validateDateTime(value, field) {
  requireCondition(typeof value === "string", field);
  const match = RFC3339_PATTERN.exec(value);
  requireCondition(match !== null, field);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  requireCondition(
    year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    calendarCheck.getUTCFullYear() === year &&
    calendarCheck.getUTCMonth() === month - 1 &&
    calendarCheck.getUTCDate() === day,
    field
  );
  requireCondition(hour <= 23 && minute <= 59 && second <= 59, field);
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    requireCondition(zoneHour <= 23 && zoneMinute <= 59, field);
  }
  requireCondition(Number.isFinite(Date.parse(value)), field);
}

function validateRulesReference(value, field) {
  requireCondition(isPlainObject(value), field);
  requireCondition(Object.keys(value).every(key => key === "version" || key === "contentHash"), field);
  requireCondition(Number.isInteger(value.version) && value.version >= 1, `${field}.version`);
  requireCondition(typeof value.contentHash === "string" && HASH_PATTERN.test(value.contentHash), `${field}.contentHash`);
}

function validateRulesReferenceV2(value, field) {
  requireCondition(isPlainObject(value), field);
  requireCondition(Object.keys(value).every(key => ["releaseId", "packageVersion", "contentHash"].includes(key)), field);
  requireCondition(typeof value.releaseId === "string" && /^[0-9]{14}-event-v3-v[1-9][0-9]*$/.test(value.releaseId), `${field}.releaseId`);
  requireCondition(Number.isInteger(value.packageVersion) && value.packageVersion >= 1, `${field}.packageVersion`);
  requireCondition(typeof value.contentHash === "string" && HASH_PATTERN.test(value.contentHash), `${field}.contentHash`);
}

function utcPrefix(value) {
  const date = new Date(value);
  return date.toISOString().slice(0, 19).replace(/[-T:]/g, "");
}

function sequenceText(sequence) {
  return String(sequence).padStart(10, "0");
}

function validateCommon(value) {
  requireCondition(isPlainObject(value), "body");
  validateSafeTree(value);
  requireCondition(value.schemaVersion === 1, "schemaVersion", "unsupported_schema_version");
  requireCondition(["observation", "event-open", "event-close", "rule-adoption", "rule-rejection"].includes(value.recordType), "recordType");
  requireCondition(typeof value.recordId === "string", "recordId");
  requireCondition(typeof value.siteId === "string" && ID_PATTERN.test(value.siteId), "siteId");
  requireCondition(typeof value.deviceId === "string" && ID_PATTERN.test(value.deviceId), "deviceId");
  requireCondition(typeof value.sessionId === "string" && SESSION_PATTERN.test(value.sessionId), "sessionId");
  requireCondition(Number.isInteger(value.sequence) && value.sequence >= 0 && value.sequence <= 9999999999, "sequence");
  validateDateTime(value.observedAt, "observedAt");
  if (value.receivedAt !== undefined) validateDateTime(value.receivedAt, "receivedAt");
  validateRulesReference(value.rulesRelease, "rulesRelease");
}

function validateObservation(value) {
  const required = ["source", "publishReason", "values", "status"];
  required.forEach(field => requireCondition(Object.hasOwn(value, field), field));
  requireCondition(value.source === "tab5", "source");
  requireCondition(PUBLISH_REASONS.has(value.publishReason), "publishReason");
  requireCondition(isPlainObject(value.values), "values");
  requireCondition(isPlainObject(value.status), "status");
  const expected = `${utcPrefix(value.observedAt)}-observation-${value.sessionId}-${sequenceText(value.sequence)}`;
  requireCondition(value.recordId === expected, "recordId");
}

function validateObservationV2(value) {
  requireCondition(isPlainObject(value), "body");
  validateSafeTree(value);
  requireCondition(Object.keys(value).every(key => [
    "schemaVersion", "recordType", "recordId", "siteId", "deviceId",
    "sessionId", "cycleSequence", "time", "receivedAt", "source",
    "rulesRelease", "snapshotPhase", "triggerReasons", "fields"
  ].includes(key)), "body");
  ["recordType", "recordId", "siteId", "deviceId", "sessionId", "cycleSequence", "time", "source", "rulesRelease", "snapshotPhase", "triggerReasons", "fields"].forEach(
    field => requireCondition(Object.hasOwn(value, field), field));
  requireCondition(value.schemaVersion === 2, "schemaVersion", "unsupported_schema_version");
  requireCondition(value.recordType === "observation", "recordType");
  requireCondition(typeof value.siteId === "string" && ID_PATTERN.test(value.siteId), "siteId");
  requireCondition(typeof value.deviceId === "string" && ID_PATTERN.test(value.deviceId), "deviceId");
  requireCondition(typeof value.sessionId === "string" && SESSION_PATTERN.test(value.sessionId), "sessionId");
  requireCondition(Number.isInteger(value.cycleSequence) && value.cycleSequence >= 0 && value.cycleSequence <= 9999999999, "cycleSequence");
  requireCondition(value.recordId === `obs_${value.sessionId}_${sequenceText(value.cycleSequence)}`, "recordId");
  requireCondition(value.source === "tab5", "source");
  requireCondition(value.snapshotPhase === "observed-pre-dispatch", "snapshotPhase");
  requireCondition(isPlainObject(value.time), "time");
  requireCondition(Object.keys(value.time).every(key => ["uptimeMs", "observedAt"].includes(key)), "time");
  requireCondition(Number.isInteger(value.time.uptimeMs) && value.time.uptimeMs >= 0, "time.uptimeMs");
  if (value.time.observedAt !== undefined) validateDateTime(value.time.observedAt, "time.observedAt");
  if (value.receivedAt !== undefined) validateDateTime(value.receivedAt, "receivedAt");
  validateRulesReferenceV2(value.rulesRelease, "rulesRelease");
  requireCondition(Array.isArray(value.triggerReasons) && value.triggerReasons.length >= 1, "triggerReasons");
  value.triggerReasons.forEach((reason, index) => requireCondition(isPlainObject(reason) && typeof reason.kind === "string", `triggerReasons[${index}]`));
  requireCondition(isPlainObject(value.fields), "fields");
  for (const [name, field] of Object.entries(value.fields)) {
    requireCondition(/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(name), `fields.${name}`);
    requireCondition(isPlainObject(field), `fields.${name}`);
    requireCondition(["available", "unavailable"].includes(field.state), `fields.${name}.state`);
    if (field.state === "available") {
      requireCondition(Object.hasOwn(field, "value") &&
        (["string", "boolean"].includes(typeof field.value) ||
         (typeof field.value === "number" && Number.isFinite(field.value))), `fields.${name}.value`);
      requireCondition(Object.keys(field).every(key => key === "state" || key === "value"), `fields.${name}`);
    } else {
      requireCondition(typeof field.reason === "string" && field.reason.length >= 1 && field.reason.length <= 128, `fields.${name}.reason`);
      requireCondition(Object.keys(field).every(key => key === "state" || key === "reason"), `fields.${name}`);
    }
  }
}

function validateActor(value) {
  requireCondition(isPlainObject(value), "actor");
  requireCondition(Object.keys(value).every(key => key === "type" || key === "id"), "actor");
  requireCondition(["device", "user", "system"].includes(value.type), "actor.type");
  requireCondition(typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 128, "actor.id");
}

function validateEvent(value) {
  ["eventId", "ruleId", "condition", "actor"].forEach(field => requireCondition(Object.hasOwn(value, field), field));
  requireCondition(typeof value.eventId === "string" && EVENT_ID_PATTERN.test(value.eventId), "eventId");
  requireCondition(typeof value.ruleId === "string" && ID_PATTERN.test(value.ruleId), "ruleId");
  requireCondition(value.eventId.slice(15).startsWith(`${value.ruleId}-`), "eventId");
  requireCondition(isPlainObject(value.condition), "condition");
  validateActor(value.actor);
  if (value.severity !== undefined) requireCondition(["yellow", "red"].includes(value.severity), "severity");
  if (value.latched !== undefined) requireCondition(typeof value.latched === "boolean", "latched");
  if (value.consequence !== undefined) requireCondition(["log-only", "inhibit"].includes(value.consequence), "consequence");
  if (value.closeReason !== undefined) requireCondition(CLOSE_REASONS.has(value.closeReason), "closeReason");
  if (value.commandId !== undefined) {
    requireCondition(typeof value.commandId === "string" && COMMAND_ID_PATTERN.test(value.commandId), "commandId");
  }
  const transition = value.recordType === "event-open" ? "open" : "close";
  const expected = `${utcPrefix(value.observedAt)}-event-${transition}-${value.sessionId}-${sequenceText(value.sequence)}`;
  requireCondition(value.recordId === expected, "recordId");

  if (value.recordType === "event-open") {
    requireCondition(["yellow", "red"].includes(value.severity), "severity");
    requireCondition(typeof value.latched === "boolean", "latched");
    requireCondition(["log-only", "inhibit"].includes(value.consequence), "consequence");
    const expectedEventId = `${utcPrefix(value.observedAt)}-${value.ruleId}-${value.sessionId}-${sequenceText(value.sequence)}`;
    requireCondition(value.eventId === expectedEventId, "eventId");
  } else {
    requireCondition(CLOSE_REASONS.has(value.closeReason), "closeReason");
  }
}

function validateRuleAudit(value) {
  ["releaseId", "actor"].forEach(field => requireCondition(Object.hasOwn(value, field), field));
  requireCondition(typeof value.releaseId === "string" && RULE_RELEASE_ID_PATTERN.test(value.releaseId), "releaseId");
  validateActor(value.actor);
  requireCondition(value.actor.type === "device", "actor.type");
  const expected = `${utcPrefix(value.observedAt)}-${value.recordType}-${value.sessionId}-${sequenceText(value.sequence)}`;
  requireCondition(value.recordId === expected, "recordId");
  if (value.recordType === "rule-adoption") {
    requireCondition(isPlainObject(value.activeRules), "activeRules");
    validateRulesReference(value.activeRules, "activeRules");
    requireCondition(value.activeRules.version === value.rulesRelease.version, "activeRules.version");
    requireCondition(value.activeRules.contentHash === value.rulesRelease.contentHash, "activeRules.contentHash");
  } else {
    requireCondition(typeof value.rejectionReason === "string" && value.rejectionReason.length >= 1 && value.rejectionReason.length <= 128, "rejectionReason");
  }
}

function validateIngestRecord(value) {
  if (isPlainObject(value) && value.schemaVersion === 2) {
    validateObservationV2(value);
    return value;
  }
  validateCommon(value);
  if (value.recordType === "observation") validateObservation(value);
  else if (value.recordType === "event-open" || value.recordType === "event-close") validateEvent(value);
  else validateRuleAudit(value);
  return value;
}

function canonicalRecord(value) {
  const copy = JSON.parse(JSON.stringify(value));
  delete copy.receivedAt;
  if (copy.schemaVersion === 2) {
    if (copy.time.observedAt !== undefined) copy.time.observedAt = new Date(copy.time.observedAt).toISOString();
  } else {
    copy.observedAt = new Date(copy.observedAt).toISOString();
  }
  return copy;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  IngestRecordError,
  canonicalRecord,
  stableJson,
  validateIngestRecord
};
