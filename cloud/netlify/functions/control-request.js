"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { ConfigurationError, getPilotDatabase } = require("../lib/firebase");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";
const COMMAND_TYPES = new Set(["clear-events", "system-override"]);

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(expected).digest());
}

function header(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry ? entry[1] : "";
}

function parse(event) {
  try {
    const body = JSON.parse(event.body || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "commandType") || !COMMAND_TYPES.has(body.commandType)) throw new Error("invalid");
    return body;
  } catch { throw new Error("invalid_request"); }
}

function timestampPrefix(date) { return date.toISOString().slice(0, 19).replace(/[-T:]/g, ""); }

function createHandler(dependencies = {}) {
  const databaseProvider = dependencies.getPilotDatabase || getPilotDatabase;
  const now = dependencies.now || (() => new Date());
  const env = dependencies.env || process.env;
  return async function controlRequest(event) {
    if (event.httpMethod !== "POST") return response(405, { status: "error", code: "method_not_allowed" });
    if (!tokenMatches(header(event.headers, "x-pilot-key"), env.PILOT_INGEST_TOKEN)) return response(401, { status: "error", code: "unauthorized" });
    let request;
    try { request = parse(event); } catch { return response(400, { status: "error", code: "invalid_request" }); }
    try {
      const { db, projectId } = databaseProvider();
      if (projectId !== "well-pump-control") throw new ConfigurationError("Firebase project is not approved");
      const root = db.ref(`v1/sites/${SITE_ID}`);
      const createdAt = now();
      let command;
      await root.transaction(current => {
        const state = current && typeof current === "object" ? current : {};
        const control = state.control && typeof state.control === "object" ? state.control : {};
        const sequence = Number.isInteger(control.nextCommandSequence) ? control.nextCommandSequence + 1 : 1;
        const commandId = `${timestampPrefix(createdAt)}-command-web-client-${String(sequence).padStart(10, "0")}`;
        command = { schemaVersion: 1, commandId, commandSequence: sequence, siteId: SITE_ID, targetDeviceId: DEVICE_ID,
          commandType: request.commandType, requestedAt: createdAt.toISOString(), requestedBy: { type: "user", id: "pilot-web" }, status: "pending", payload: {} };
        const devices = state.devices && typeof state.devices === "object" ? state.devices : {};
        const device = devices[DEVICE_ID] && typeof devices[DEVICE_ID] === "object" ? devices[DEVICE_ID] : {};
        const commands = device.commands && typeof device.commands === "object" ? device.commands : {};
        return {
          ...state,
          control: { ...control, nextCommandSequence: sequence },
          devices: { ...devices, [DEVICE_ID]: { ...device, commands: { ...commands, [commandId]: command } } }
        };
      });
      return response(201, { status: "ok", command });
    } catch (error) {
      console.error("Control request failed", { category: error instanceof ConfigurationError ? "configuration" : "database" });
      return response(503, { status: "error", code: error instanceof ConfigurationError ? "configuration_missing" : "command_unavailable" });
    }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
