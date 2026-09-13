"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { ConfigurationError } = require("../lib/firebase");
const {
  OperatorControlError,
  deriveOperatorStatus,
  validateOperatorRequest
} = require("../lib/operator-control-contract");
const { createOperatorControlStore } = require("../lib/operator-control-store");

const MAX_BODY_BYTES = 2048;
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const response = (statusCode, body, extra = {}) => ({ statusCode, headers: { ...headers, ...extra }, body: JSON.stringify(body) });

function getHeader(source, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(source || {}).find(([key]) => key.toLowerCase() === target);
  return entry ? entry[1] : "";
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  return timingSafeEqual(
    createHash("sha256").update(provided, "utf8").digest(),
    createHash("sha256").update(expected, "utf8").digest()
  );
}

function parseBody(event) {
  const text = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new OperatorControlError("payload_too_large", "body");
  try { return JSON.parse(text); } catch { throw new OperatorControlError("invalid_json", "body"); }
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const store = dependencies.store || createOperatorControlStore(dependencies);
  const now = dependencies.now || (() => Date.now());
  return async function operatorControl(event) {
    if (!["GET", "POST"].includes(event.httpMethod)) {
      return response(405, { status: "error", code: "method_not_allowed" }, { Allow: "GET, POST" });
    }
    if (!env.PILOT_INGEST_TOKEN) return response(503, { status: "error", code: "configuration_missing" });
    if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), env.PILOT_INGEST_TOKEN)) {
      return response(401, { status: "error", code: "unauthorized" });
    }
    try {
      if (event.httpMethod === "GET") return response(200, { status: "ok", control: await store.status() });
      const request = validateOperatorRequest(parseBody(event));
      const issued = await store.issue(request);
      if (!issued.issued) {
        return response(409, {
          status: "not-delivered",
          code: issued.code,
          control: deriveOperatorStatus(issued.snapshot || {}, now())
        });
      }
      return response(202, {
        status: "accepted-for-delivery",
        idempotent: issued.idempotent === true,
        control: deriveOperatorStatus(issued.snapshot, now())
      });
    } catch (error) {
      if (error instanceof OperatorControlError) {
        return response(400, { status: "error", code: error.code, field: error.field });
      }
      const configuration = error instanceof ConfigurationError;
      console.error("Operator control failed", { category: configuration ? "configuration" : "upstream" });
      return response(503, { status: "error", code: configuration ? "configuration_missing" : "control_unavailable" });
    }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
exports._tokenMatches = tokenMatches;
