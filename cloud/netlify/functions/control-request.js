"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { ConfigurationError, approvedDatabaseUrl, getPilotDatabase } = require("../lib/firebase");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";
const COMMAND_TYPES = new Set(["clear-events", "monitor", "normal", "restart-tab5", "restart-shelly1"]);
const MAX_BODY_BYTES = 4096;
const COUNTER_FIELD = "_nextCommandSequence";
const MAX_COMMAND_SEQUENCE = 9999999999;
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

class ControlRequestError extends Error {
  constructor(code) { super(code); this.name = "ControlRequestError"; this.code = code; }
}

function response(statusCode, body) { return { statusCode, headers, body: JSON.stringify(body) }; }

function getHeader(headersValue, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(headersValue || {}).find(([key]) => key.toLowerCase() === target);
  return entry ? entry[1] : "";
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

function parseRequest(event) {
  const text = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new ControlRequestError("payload_too_large");
  let body;
  try { body = JSON.parse(text); } catch { throw new ControlRequestError("invalid_request"); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, "commandType") ||
      !COMMAND_TYPES.has(body.commandType)) throw new ControlRequestError("invalid_request");
  return body;
}

function compactTimestamp(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new ControlRequestError("clock_unavailable");
  return date.toISOString().slice(0, 19).replace(/[-T:]/g, "");
}

function commandHighWater(commands) {
  let highWater = Number.isInteger(commands[COUNTER_FIELD]) && commands[COUNTER_FIELD] >= 0
    ? commands[COUNTER_FIELD] : 0;
  for (const child of Object.values(commands)) {
    if (child && typeof child === "object" && !Array.isArray(child) &&
        Number.isInteger(child.commandSequence) && child.commandSequence >= 0) {
      highWater = Math.max(highWater, child.commandSequence);
    }
  }
  return highWater;
}

function createHandler(dependencies = {}) {
  const databaseProvider = dependencies.getPilotDatabase || getPilotDatabase;
  const now = dependencies.now || (() => new Date());
  const env = dependencies.env || process.env;
  return async function controlRequest(event) {
    if (event.httpMethod !== "POST") {
      return { ...response(405, { status: "error", code: "method_not_allowed" }), headers: { ...headers, Allow: "POST" } };
    }
    if (!env.PILOT_CONTROL_TOKEN) return response(503, { status: "error", code: "configuration_missing" });
    if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), env.PILOT_CONTROL_TOKEN)) {
      return response(401, { status: "error", code: "unauthorized" });
    }
    try {
      const request = parseRequest(event);
      const createdAt = now();
      const prefix = compactTimestamp(createdAt);
      const { db, projectId, databaseUrl } = databaseProvider();
      if (projectId !== "well-pump-control") throw new ConfigurationError("Firebase project is not approved");
      if (databaseUrl !== undefined) approvedDatabaseUrl(databaseUrl, projectId);
      const commandsRef = db.ref(`v1/sites/${SITE_ID}/devices/${DEVICE_ID}/commands`);
      let command;
      await commandsRef.transaction(current => {
        const commands = current && typeof current === "object" && !Array.isArray(current) ? current : {};
        let sequence = commandHighWater(commands) + 1;
        while (sequence <= MAX_COMMAND_SEQUENCE &&
               Object.hasOwn(commands, `${prefix}-command-web_control-${String(sequence).padStart(10, "0")}`)) {
          sequence += 1;
        }
        if (sequence > MAX_COMMAND_SEQUENCE) throw new ControlRequestError("sequence_exhausted");
        const commandId = `${prefix}-command-web_control-${String(sequence).padStart(10, "0")}`;
        command = {
          schemaVersion: 1, runtimeSchemaVersion: 3, commandId, commandSequence: sequence,
          siteId: SITE_ID, targetDeviceId: DEVICE_ID, commandType: request.commandType,
          requestedAt: createdAt.toISOString(), requestedBy: { type: "user", id: "pilot-web" },
          status: "pending", payload: {}
        };
        return { ...commands, [COUNTER_FIELD]: sequence, [commandId]: command };
      });
      return response(201, { status: "ok", command });
    } catch (error) {
      if (error instanceof ControlRequestError) return response(400, { status: "error", code: error.code });
      const configurationError = error instanceof ConfigurationError;
      console.error("Control request failed", { category: configurationError ? "configuration" : "database" });
      return response(503, { status: "error", code: configurationError ? "configuration_missing" : "command_unavailable" });
    }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
exports._parseRequest = parseRequest;
exports._tokenMatches = tokenMatches;
exports._commandHighWater = commandHighWater;
