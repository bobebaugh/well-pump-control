"use strict";

const MAX_OPEN_EVENTS = 64;

class EventProjectionError extends Error {
  constructor(code) {
    super(code);
    this.name = "EventProjectionError";
    this.code = code;
  }
}

function isV3EventRecord(record) {
  return record?.runtimeSchemaVersion === 3 &&
    (record.recordType === "event-open" || record.recordType === "event-close");
}

function timestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function copyOpenEvents(value) {
  const entries = Object.entries(value && typeof value === "object" ? value : {})
    .filter(([eventId, item]) => typeof eventId === "string" && item && typeof item === "object")
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([eventId, item]) => [eventId, { ...item }]));
}

function eventMetadata(record) {
  const metadata = {
    eventId: record.eventId,
    eventInstanceId: record.eventInstanceId,
    ruleId: record.ruleId,
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    rulesRelease: { ...record.rulesRelease },
    eventClass: record.eventClass
  };
  for (const name of ["severity", "latched", "consequence"]) {
    if (record[name] !== undefined) metadata[name] = record[name];
  }
  return metadata;
}

function instanceUpdate(prior, record) {
  const existing = prior && typeof prior === "object" ? prior : {};
  for (const name of ["eventInstanceId", "ruleId", "sessionId", "deviceId"]) {
    if (existing[name] !== undefined && existing[name] !== record[name]) {
      throw new EventProjectionError("event_instance_identity_conflict");
    }
  }
  const update = eventMetadata(record);
  if (record.recordType === "event-open") {
    update.openRecordId = record.recordId;
    update.openedAt = record.observedAt;
    update.openTransitionReason = record.transitionReason;
    update.openActor = { ...record.actor };
    if (record.commandId !== undefined) update.openCommandId = record.commandId;
    if (existing.status !== "closed") {
      update.status = "open";
      update.mode = record.mode;
    }
  } else {
    update.status = "closed";
    update.mode = record.mode;
    update.closeRecordId = record.recordId;
    update.closedAt = record.observedAt;
    update.closeTransitionReason = record.transitionReason;
    update.closeActor = { ...record.actor };
    if (record.commandId !== undefined) update.closeCommandId = record.commandId;
  }
  return { ...existing, ...update };
}

function newBoard(record) {
  return {
    deviceId: record.deviceId,
    sessionId: record.sessionId,
    mode: "Normal",
    openEventIds: [],
    openEvents: {},
    boundaryObservedAt: record.observedAt,
    lastObservedAt: record.observedAt
  };
}

function boardProjection(prior, record, instance) {
  if (!isV3EventRecord(record)) throw new EventProjectionError("invalid_v3_event_record");
  const existing = prior && typeof prior === "object" ? prior : null;
  let board = existing ? {
    ...existing,
    openEvents: copyOpenEvents(existing.openEvents),
    openEventIds: Array.isArray(existing.openEventIds) ? [...existing.openEventIds] : []
  } : null;
  const recordMs = timestampMs(record.observedAt);
  if (!board) {
    board = newBoard(record);
  } else if (board.sessionId !== record.sessionId) {
    const lastMs = timestampMs(board.lastObservedAt || board.boundaryObservedAt);
    if (recordMs <= lastMs) return { board: existing, changed: false, lateSession: true };
    board = newBoard(record);
  }

  const laterOrEqual = recordMs >= timestampMs(board.lastObservedAt);
  const isOpen = record.recordType === "event-open" && instance.status === "open";
  if (isOpen && !Object.hasOwn(board.openEvents, record.eventId)) {
    if (Object.keys(board.openEvents).length >= MAX_OPEN_EVENTS) {
      throw new EventProjectionError("event_board_capacity");
    }
    board.openEvents[record.eventId] = {
      eventId: record.eventId,
      eventInstanceId: record.eventInstanceId,
      ruleId: record.ruleId,
      eventClass: record.eventClass,
      severity: record.severity,
      consequence: record.consequence,
      openedAt: record.observedAt
    };
  }
  if (record.recordType === "event-close") delete board.openEvents[record.eventId];
  board.openEvents = copyOpenEvents(board.openEvents);
  board.openEventIds = Object.keys(board.openEvents);
  if (laterOrEqual) {
    board.mode = record.mode;
    board.lastObservedAt = record.observedAt;
  }
  return { board, changed: true, lateSession: false };
}

function effectiveStatus(instance, boardSessionId) {
  if (!instance || typeof instance !== "object") return "unknown";
  if (instance.status === "open" && instance.sessionId !== boardSessionId) return "interrupted";
  return instance.status === "closed" ? "closed" : "open";
}

function instanceHistoryView(instance, boardSessionId) {
  const view = {
    eventId: instance.eventId,
    eventInstanceId: instance.eventInstanceId,
    ruleId: instance.ruleId,
    sessionId: instance.sessionId,
    deviceId: instance.deviceId,
    eventClass: instance.eventClass,
    severity: instance.severity,
    mode: instance.mode,
    effectiveStatus: effectiveStatus(instance, boardSessionId),
    openedAt: instance.openedAt || null,
    closedAt: instance.closedAt || null,
    openTransitionReason: instance.openTransitionReason || null,
    closeTransitionReason: instance.closeTransitionReason || null
  };
  for (const name of ["severity", "consequence"]) {
    if (instance[name] !== undefined) view[name] = instance[name];
  }
  return view;
}

module.exports = {
  EventProjectionError,
  MAX_OPEN_EVENTS,
  boardProjection,
  effectiveStatus,
  instanceHistoryView,
  instanceUpdate,
  isV3EventRecord
};
