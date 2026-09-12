"use strict";

const { stableJson } = require("./ingest-record-contract");

function boardEvidence(board) {
  const evidence = { boardSequence: board.boardSequence, producedUptimeMs: board.producedUptimeMs };
  if (board.producedAt !== undefined) evidence.producedAt = board.producedAt;
  return evidence;
}
function recordId(type, board, occurrenceId) {
  return `event-${type}--${board.deviceId}--${board.sessionId}--${occurrenceId}`;
}
function openRecord(board, eventKey, slot, receivedAt) {
  const openingExact = typeof slot.opening.observedAt === "string" &&
    Number.isInteger(slot.opening.cycleSequence) && Number.isInteger(slot.opening.uptimeMs);
  return {
    schemaVersion: 2, recordType: "event-open",
    recordId: recordId("open", board, slot.occurrenceId),
    siteId: board.siteId, deviceId: board.deviceId, sessionId: board.sessionId,
    eventDefinitionId: eventKey, occurrenceId: slot.occurrenceId,
    displayName: slot.displayName, severity: slot.severity, eventClass: slot.eventClass,
    rulesRelease: board.rulesRelease,
    openingEvidenceStatus: openingExact ? "exact-device" : "reported-open",
    opening: slot.opening, firstReportedBoard: boardEvidence(board), firstReportedAt: receivedAt,
  };
}
function closeRecord(prior, closingBoard, reason, receivedAt) {
  const board = { deviceId: prior.deviceId, sessionId: prior.sessionId };
  const record = {
    schemaVersion: 2, recordType: "event-close",
    recordId: recordId("close", board, prior.occurrenceId),
    siteId: prior.siteId, deviceId: prior.deviceId, sessionId: prior.sessionId,
    eventDefinitionId: prior.eventDefinitionId, occurrenceId: prior.occurrenceId,
    displayName: prior.slot.displayName, severity: prior.slot.severity,
    eventClass: prior.slot.eventClass, rulesRelease: prior.rulesRelease,
    closeReason: reason, closeTimeStatus: "unknown",
    lastPresentBoard: prior.lastPresentBoard,
  };
  if (reason === "ended-by-restart") {
    record.restartDetectedAt = receivedAt;
    record.restartBoard = boardEvidence(closingBoard);
  } else {
    record.detectedAt = receivedAt;
    record.firstAbsentBoard = boardEvidence(closingBoard);
  }
  return record;
}
function projectionEntry(board, eventKey, slot, firstSeen) {
  return {
    siteId: board.siteId, deviceId: board.deviceId, sessionId: board.sessionId,
    eventDefinitionId: eventKey, occurrenceId: slot.occurrenceId,
    rulesRelease: board.rulesRelease, slot,
    firstSeenBoardSequence: firstSeen,
    lastPresentBoard: boardEvidence(board),
  };
}
function releaseEqual(left, right) { return stableJson(left) === stableJson(right); }

function reduceEventBoard(stored, board, receivedAt) {
  const current = stored && typeof stored === "object" ? JSON.parse(JSON.stringify(stored)) : null;
  if (current?.retiredSessionIds?.includes(board.sessionId)) {
    return { decision: "stale-ignored", projection: current, records: [], changed: false };
  }
  const newSession = !current || current.sessionId !== board.sessionId;
  if (!newSession) {
    if (!releaseEqual(current.rulesRelease, board.rulesRelease)) {
      return { decision: "release-conflict", projection: current, records: [], changed: false, conflict: true };
    }
    if (board.boardSequence < current.lastBoardSequence) {
      return { decision: "stale-ignored", projection: current, records: [], changed: false };
    }
    if (board.boardSequence === current.lastBoardSequence) {
      if (stableJson(current.lastBoard) === stableJson(board)) {
        return { decision: "duplicate", projection: current, records: [], changed: false };
      }
      return { decision: "sequence-conflict", projection: current, records: [], changed: false, conflict: true };
    }
  }

  const records = [];
  const previousOpen = current?.openEvents || {};
  const retired = [...(current?.retiredSessionIds || [])];
  if (newSession && current) {
    for (const prior of Object.values(previousOpen)) records.push(closeRecord(prior, board, "ended-by-restart", receivedAt));
    retired.push(current.sessionId);
  }
  const compareOpen = newSession ? {} : previousOpen;
  const nextOpen = {};
  for (const [eventKey, slot] of Object.entries(board.openEvents)) {
    const prior = compareOpen[eventKey];
    if (!prior || prior.occurrenceId !== slot.occurrenceId) {
      if (prior) records.push(closeRecord(prior, board, "inferred-board-disappearance", receivedAt));
      records.push(openRecord(board, eventKey, slot, receivedAt));
      nextOpen[eventKey] = projectionEntry(board, eventKey, slot, board.boardSequence);
    } else {
      nextOpen[eventKey] = projectionEntry(board, eventKey, slot, prior.firstSeenBoardSequence);
    }
  }
  for (const [eventKey, prior] of Object.entries(compareOpen)) {
    if (!Object.hasOwn(board.openEvents, eventKey)) {
      records.push(closeRecord(prior, board, "inferred-board-disappearance", receivedAt));
    }
  }
  const projection = {
    schemaVersion: 1, kind: "event-board-projection",
    siteId: board.siteId, deviceId: board.deviceId, sessionId: board.sessionId,
    rulesRelease: board.rulesRelease, lastBoardSequence: board.boardSequence,
    lastBoardProducedUptimeMs: board.producedUptimeMs,
    lastBoardProducedAt: board.producedAt || null,
    lastReportAt: receivedAt, lastBoard: board, openEvents: nextOpen,
    retiredSessionIds: retired,
    acceptedBoardRevision: (current?.acceptedBoardRevision || 0) + 1,
  };
  return { decision: newSession ? "accepted-new-session" : "accepted", projection, records, changed: true };
}

module.exports = { boardEvidence, reduceEventBoard };
