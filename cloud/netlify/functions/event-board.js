"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");
const { EventBoardError, validateEventBoard } = require("../lib/event-board-contract");
const { EventBoardStoreError, createEventBoardStore } = require("../lib/event-board-store");
const { createEventBoardMirror } = require("../lib/event-board-mirror");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";
const MAX_BODY_BYTES = 65536;
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
function response(statusCode, body) { return { statusCode, headers, body: JSON.stringify(body) }; }
function getHeader(values, name) { const entry = Object.entries(values || {}).find(([key]) => key.toLowerCase() === name.toLowerCase()); return entry ? entry[1] : ""; }
function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(expected).digest());
}
function parseBody(event) {
  const text = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new EventBoardError("payload_too_large", "body");
  try { return JSON.parse(text); } catch { throw new EventBoardError("invalid_json", "body"); }
}
function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const firestoreProvider = dependencies.getPilotFirestore || getPilotFirestore;
  const clock = dependencies.clock || (() => new Date());
  const mirrorProvider = dependencies.createMirror || (() => createEventBoardMirror({ env }));
  return async function eventBoard(event) {
    if (event.httpMethod !== "POST") return { ...response(405, { status: "error", code: "method_not_allowed" }), headers: { ...headers, Allow: "POST" } };
    if (!env.PILOT_INGEST_TOKEN) return response(503, { status: "error", code: "configuration_missing" });
    if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), env.PILOT_INGEST_TOKEN)) return response(401, { status: "error", code: "unauthorized" });
    try {
      const board = validateEventBoard(parseBody(event));
      if (board.siteId !== SITE_ID || board.deviceId !== DEVICE_ID) return response(403, { status: "error", code: "device_not_allowed" });
      const { db, projectId, databaseId } = firestoreProvider();
      if (projectId !== "well-pump-control" || databaseId !== "(default)") throw new ConfigurationError("unapproved database");
      const received = clock();
      const store = createEventBoardStore(db, SITE_ID, DEVICE_ID);
      const outcome = await store.reconcile(board, received.toISOString());
      if (outcome.decision !== "stale-ignored") {
        const acceptedBoard = outcome.projection.lastBoard;
        await mirrorProvider().mirror(
          acceptedBoard, outcome.projection.acceptedBoardRevision,
          Date.parse(outcome.projection.lastReportAt));
      }
      return response(outcome.changed ? 201 : 200, {
        status: "ok", accepted: true, decision: outcome.decision,
        boardSequence: board.boardSequence,
        acceptedBoardRevision: outcome.projection.acceptedBoardRevision
      });
    } catch (error) {
      if (error instanceof EventBoardError) return response(error.code === "payload_too_large" ? 413 : 400, { status: "error", code: error.code, field: error.field });
      if (error instanceof EventBoardStoreError) return response(error.code.includes("conflict") ? 409 : 400, { status: "error", code: error.code });
      const configuration = error instanceof ConfigurationError || error?.code === "configuration_missing";
      console.error("Event board ingestion failed", { category: configuration ? "configuration" : "storage" });
      return response(503, { status: "error", code: configuration ? "configuration_missing" : "event_board_unavailable" });
    }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
