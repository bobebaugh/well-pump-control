"use strict";

const { getPilotFirestore } = require("../lib/firebase");
const { instanceHistoryView } = require("../lib/event-v3-projection");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";
const HISTORY_LIMIT = 50;
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function response(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function timestampToIso(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() :
    (typeof value === "string" ? value : null);
}

function boardView(board) {
  const openEvents = Object.entries(board.openEvents && typeof board.openEvents === "object" ? board.openEvents : {})
    .filter(([eventId, item]) => typeof eventId === "string" && item && typeof item === "object" &&
      item.eventId === eventId && typeof item.eventInstanceId === "string" &&
      typeof item.ruleId === "string" && typeof item.eventClass === "string")
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 64)
    .map(([eventId, item]) => {
      const view = {
        eventId, eventInstanceId: item.eventInstanceId, ruleId: item.ruleId,
        eventClass: item.eventClass, openedAt: timestampToIso(item.openedAt)
      };
      if (item.severity !== undefined) view.severity = item.severity;
      if (item.consequence !== undefined) view.consequence = item.consequence;
      return view;
    });
  return {
    deviceId: board.deviceId,
    sessionId: board.sessionId,
    mode: board.mode,
    openEventIds: openEvents.map(item => item.eventId),
    openEvents,
    boundaryObservedAt: timestampToIso(board.boundaryObservedAt),
    lastObservedAt: timestampToIso(board.lastObservedAt)
  };
}

function createHandler(dependencies = {}) {
  const firestoreProvider = dependencies.getPilotFirestore || getPilotFirestore;
  return async function eventsStatus(event) {
    if (event.httpMethod !== "GET") {
      return { ...response(405, { status: "error", code: "method_not_allowed" }),
        headers: { ...headers, Allow: "GET" } };
    }
    try {
      const { db } = firestoreProvider();
      const site = db.collection("sites").doc(SITE_ID);
      const boardSnapshot = await site.collection("eventBoards").doc(DEVICE_ID).get();
      if (!boardSnapshot.exists) return response(404, { status: "empty", code: "event_board_missing" });
      const board = boardSnapshot.data();
      const instances = await site.collection("eventInstances")
        .orderBy("updatedAt", "desc").limit(HISTORY_LIMIT).get();
      const history = instances.docs.map(snapshot => instanceHistoryView(
        snapshot.data(), board.sessionId));
      return response(200, { status: "ok", siteId: SITE_ID, board: boardView(board), history });
    } catch (error) {
      console.error("Event status read failed", { category: "firestore" });
      return response(503, { status: "error", code: "firestore_unavailable" });
    }
  };
}

exports.handler = createHandler();
exports._boardView = boardView;
exports._createHandler = createHandler;
