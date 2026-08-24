"use strict";

class DeviceSyncError extends Error {
  constructor(code, field) {
    super(code);
    this.name = "DeviceSyncError";
    this.code = code;
    this.field = field;
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const EXCHANGE_PATTERN = /^[0-9]{14}-sync-[A-Za-z0-9_-]{8,64}-[0-9]{10}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMAND_PATTERN = /^[0-9]{14}-command-[A-Za-z0-9_-]{8,64}-[0-9]{10}$/;
const COMMAND_TYPES = new Set(["close-event", "set-event-override", "set-global-enable", "reset-shelly-lockout"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireCondition(condition, code, field) {
  if (!condition) throw new DeviceSyncError(code, field);
}

function validateRulesReference(value, field) {
  requireCondition(isPlainObject(value), "invalid_request", field);
  requireCondition(Number.isInteger(value.version) && value.version >= 1, "invalid_request", `${field}.version`);
  requireCondition(typeof value.contentHash === "string" && HASH_PATTERN.test(value.contentHash), "invalid_request", `${field}.contentHash`);
  requireCondition(Object.keys(value).every(key => key === "version" || key === "contentHash"), "invalid_request", field);
}

function validateDeviceSyncRequest(value) {
  requireCondition(isPlainObject(value), "invalid_request", "body");
  const allowed = new Set([
    "schemaVersion", "kind", "exchangeId", "siteId", "deviceId", "sessionId",
    "requestedAt", "lastAppliedCommandSequence", "appliedRules", "openEventIds",
    "globalEnable"
  ]);
  requireCondition(Object.keys(value).every(key => allowed.has(key)), "invalid_request", "body");
  requireCondition(value.schemaVersion === 1, "unsupported_schema_version", "schemaVersion");
  requireCondition(value.kind === "device-sync-request", "invalid_request", "kind");
  requireCondition(typeof value.exchangeId === "string" && EXCHANGE_PATTERN.test(value.exchangeId), "invalid_request", "exchangeId");
  requireCondition(typeof value.siteId === "string" && ID_PATTERN.test(value.siteId), "invalid_request", "siteId");
  requireCondition(typeof value.deviceId === "string" && ID_PATTERN.test(value.deviceId), "invalid_request", "deviceId");
  requireCondition(typeof value.sessionId === "string" && SESSION_PATTERN.test(value.sessionId), "invalid_request", "sessionId");
  requireCondition(typeof value.requestedAt === "string" && Number.isFinite(Date.parse(value.requestedAt)), "invalid_request", "requestedAt");
  requireCondition(Number.isInteger(value.lastAppliedCommandSequence) && value.lastAppliedCommandSequence >= 0, "invalid_request", "lastAppliedCommandSequence");
  validateRulesReference(value.appliedRules, "appliedRules");
  requireCondition(Array.isArray(value.openEventIds), "invalid_request", "openEventIds");
  requireCondition(new Set(value.openEventIds).size === value.openEventIds.length, "invalid_request", "openEventIds");
  requireCondition(value.openEventIds.every(id => typeof id === "string" && id.length >= 1 && id.length <= 160), "invalid_request", "openEventIds");
  requireCondition(typeof value.globalEnable === "boolean", "invalid_request", "globalEnable");
  return value;
}

function pendingCommands(raw, request) {
  const commands = isPlainObject(raw) ? Object.values(raw) : [];
  const allowed = new Set([
    "schemaVersion", "commandId", "commandSequence", "siteId",
    "targetDeviceId", "commandType", "requestedAt", "requestedBy",
    "status", "payload", "completedAt", "resultRecordId",
    "rejectionReason"
  ]);
  return commands.filter(command => (
    isPlainObject(command) &&
    Object.keys(command).every(key => allowed.has(key)) &&
    command.schemaVersion === 1 &&
    typeof command.commandId === "string" && COMMAND_PATTERN.test(command.commandId) &&
    command.siteId === request.siteId &&
    command.targetDeviceId === request.deviceId &&
    COMMAND_TYPES.has(command.commandType) &&
    typeof command.requestedAt === "string" && Number.isFinite(Date.parse(command.requestedAt)) &&
    isPlainObject(command.requestedBy) &&
    Object.keys(command.requestedBy).length === 2 &&
    Object.keys(command.requestedBy).every(key => key === "type" || key === "id") &&
    ["user", "device", "system"].includes(command.requestedBy.type) &&
    typeof command.requestedBy.id === "string" && command.requestedBy.id.length >= 1 && command.requestedBy.id.length <= 128 &&
    command.status === "pending" &&
    isPlainObject(command.payload) &&
    Number.isInteger(command.commandSequence) &&
    command.commandSequence >= 1 &&
    command.commandSequence > request.lastAppliedCommandSequence
  )).sort((left, right) => left.commandSequence - right.commandSequence);
}

function rulesReference(raw, fallback) {
  if (isPlainObject(raw) && Number.isInteger(raw.rulesVersion) && raw.rulesVersion >= 1 &&
      typeof raw.contentHash === "string" && HASH_PATTERN.test(raw.contentHash)) {
    return { version: raw.rulesVersion, contentHash: raw.contentHash };
  }
  return fallback;
}

function globalEnableValue(raw, fallback) {
  if (typeof raw === "boolean") return raw;
  if (isPlainObject(raw) && typeof raw.desired === "boolean") return raw.desired;
  return fallback;
}

module.exports = {
  DeviceSyncError,
  globalEnableValue,
  pendingCommands,
  rulesReference,
  validateDeviceSyncRequest
};
