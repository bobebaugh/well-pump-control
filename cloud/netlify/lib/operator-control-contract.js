"use strict";

const COMMAND_LIFETIME_MS = 45_000;
const PRESENCE_FRESH_MS = 45_000;
const COMPLETION_GRACE_MS = 60_000;
const ACTIONS = new Set(["enter-user-monitor", "restart-tab5", "restart-shelly1"]);
const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

class OperatorControlError extends Error {
  constructor(code, field) {
    super(code);
    this.name = "OperatorControlError";
    this.code = code;
    this.field = field;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateOperatorRequest(value) {
  if (!isObject(value)) throw new OperatorControlError("invalid_request", "body");
  const allowed = new Set(["action", "clientRequestId"]);
  if (!Object.keys(value).every(key => allowed.has(key))) {
    throw new OperatorControlError("invalid_request", "body");
  }
  if (!ACTIONS.has(value.action)) throw new OperatorControlError("invalid_request", "action");
  if (typeof value.clientRequestId !== "string" || !CLIENT_ID.test(value.clientRequestId)) {
    throw new OperatorControlError("invalid_request", "clientRequestId");
  }
  return value;
}

function buildOperatorCommand(request, identity) {
  const requestedAtMs = identity.requestedAtMs;
  return {
    schemaVersion: 1,
    kind: "operator-command",
    commandId: identity.commandId,
    commandSequence: identity.commandSequence,
    clientRequestId: request.clientRequestId,
    siteId: "well-main",
    targetDeviceId: "tab5-well-main",
    targetSessionId: identity.targetSessionId,
    commandType: request.action,
    requestedAtMs,
    expiresAtMs: requestedAtMs + COMMAND_LIFETIME_MS,
    requestedBy: { type: "user", id: "authenticated-owner" },
    payload: {}
  };
}

function freshPresence(presence, nowMs) {
  return isObject(presence) && typeof presence.sessionId === "string" && SESSION_ID.test(presence.sessionId) &&
    Number.isInteger(presence.lastSeenAtMs) && presence.lastSeenAtMs <= nowMs &&
    nowMs - presence.lastSeenAtMs <= PRESENCE_FRESH_MS;
}

function matchingResult(command, result) {
  return isObject(result) && result.commandId === command.commandId &&
    result.commandSequence === command.commandSequence &&
    result.targetSessionId === command.targetSessionId &&
    result.commandType === command.commandType;
}

function stagedRestartConsequence(rulesV3State) {
  if (!isObject(rulesV3State) || !isObject(rulesV3State.staged)) return null;
  const staged = rulesV3State.staged;
  const running = isObject(rulesV3State.running) ? rulesV3State.running : null;
  if (running && staged.contentHash === running.contentHash) return null;
  return {
    releaseId: staged.releaseId,
    packageVersion: staged.packageVersion,
    contentHashPrefix: typeof staged.contentHash === "string" ? staged.contentHash.slice(0, 12) : null
  };
}

function freshDeviceRecord(record, presence, nowMs, timestampField) {
  return freshPresence(presence, nowMs) && isObject(record) &&
    record.sessionId === presence.sessionId && Number.isInteger(record[timestampField]) &&
    record[timestampField] <= nowMs && nowMs - record[timestampField] <= PRESENCE_FRESH_MS;
}

function deriveOperatorStatus(snapshot, nowMs) {
  const command = isObject(snapshot?.command) ? snapshot.command : null;
  const result = isObject(snapshot?.result) ? snapshot.result : null;
  const presence = isObject(snapshot?.presence) ? snapshot.presence : null;
  const observation = isObject(snapshot?.currentObservation) ? snapshot.currentObservation : null;
  const observationFresh = freshDeviceRecord(
    observation, presence, nowMs, "receivedAtMs");
  const observationStatus = observationFresh && isObject(observation?.status)
    ? observation.status : {};
  const rulesState = freshDeviceRecord(
    snapshot?.rulesV3State, presence, nowMs, "reportedAtMs")
    ? snapshot.rulesV3State : null;
  const base = {
    outcome: "idle",
    detailCode: "no-current-command",
    command: null,
    userMonitor: observationFresh ? observationStatus.user_monitor_active === true : null,
    relayRestoration: observationFresh ? (observationStatus.tab5_relay_restoration || "unknown") : "unknown",
    shellyLock: observationFresh ? (observation?.values?.shelly1_lock ?? null) : null,
    shellyLockoutCount: observationFresh ? (observation?.values?.shelly1_lockout_count ?? null) : null,
    deviceSessionId: freshPresence(presence, nowMs) ? presence.sessionId : null,
    stagedRestartAdoption: stagedRestartConsequence(rulesState)
  };
  if (!command) return base;
  base.command = {
    commandId: command.commandId,
    commandSequence: command.commandSequence,
    commandType: command.commandType,
    targetSessionId: command.targetSessionId,
    requestedAtMs: command.requestedAtMs,
    expiresAtMs: command.expiresAtMs
  };

  if (command.commandType === "restart-tab5" && freshPresence(presence, nowMs) &&
      presence.sessionId !== command.targetSessionId &&
      presence.lastSeenAtMs > command.requestedAtMs) {
    base.outcome = "confirmed-completed";
    base.detailCode = "fresh-tab5-session";
    return base;
  }
  if (matchingResult(command, result)) {
    base.outcome = result.outcome;
    base.detailCode = result.detailCode;
    base.relayRestoration = result.relayRestoration;
    if (result.outcome !== "accepted" || nowMs <= command.expiresAtMs + COMPLETION_GRACE_MS) return base;
  }
  if (nowMs > command.expiresAtMs) {
    base.outcome = "unknown";
    base.detailCode = "expired-after-possible-execution";
  } else {
    base.outcome = "not-delivered";
    base.detailCode = "awaiting-device-acceptance";
  }
  return base;
}

module.exports = {
  ACTIONS,
  COMMAND_LIFETIME_MS,
  COMPLETION_GRACE_MS,
  OperatorControlError,
  PRESENCE_FRESH_MS,
  buildOperatorCommand,
  deriveOperatorStatus,
  freshPresence,
  validateOperatorRequest
};
