"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { RulesContractError, validatePackage, validateRules } = require("../lib/rules-contract");

const SITE_ID = "well-main";
const MAX_BODY_BYTES = 131072;
const RELEASE_DIRECTORY = path.join(__dirname, "..", "rules-releases");
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function response(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}

function getHeader(headers, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === target);
  return entry ? entry[1] : "";
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

function parseBody(event) {
  const text = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new RulesContractError("payload_too_large", "body");
  try {
    return JSON.parse(text);
  } catch {
    throw new RulesContractError("invalid_json", "body");
  }
}

function releaseIdAt(date, version) {
  const timestamp = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${timestamp}-rules-v${version}`;
}

function bundledRelease(releaseId, readFile) {
  try {
    return readFile(path.join(RELEASE_DIRECTORY, `${releaseId}.json`), "utf8");
  } catch {
    return null;
  }
}

async function releaseFor(store, releaseId, readFile) {
  return bundledRelease(releaseId, readFile) || store.getReleaseBody(releaseId);
}

function validPointer(pointer) {
  return pointer && pointer.schemaVersion === 1 && pointer.siteId === SITE_ID &&
    /^[0-9]{14}-rules-v[0-9]+$/.test(pointer.releaseId) &&
    Number.isInteger(pointer.rulesVersion) && pointer.rulesVersion >= 1 &&
    pointer.rulesSchemaVersion === 1 && /^[a-f0-9]{64}$/.test(pointer.contentHash);
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const readFile = dependencies.readFile || readFileSync;
  const now = dependencies.now || (() => new Date());
  const storeFactory = dependencies.createRulesStore || (() => require("../lib/rules-store").createRulesStore(env));

  return async function rulesAdmin(event) {
    if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
      return { ...response(405, { status: "error", code: "method_not_allowed" }), headers: { ...jsonHeaders, Allow: "GET, POST" } };
    }
    if (!env.PILOT_INGEST_TOKEN) return response(503, { status: "error", code: "configuration_missing" });
    if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), env.PILOT_INGEST_TOKEN)) {
      return response(401, { status: "error", code: "unauthorized" });
    }

    try {
      const store = storeFactory();
      const current = await store.getCurrentPointer();
      if (!validPointer(current)) return response(503, { status: "error", code: "current_rules_unavailable" });
      const currentBody = await releaseFor(store, current.releaseId, readFile);
      if (!currentBody) return response(503, { status: "error", code: "current_rules_unavailable" });
      const actualHash = createHash("sha256").update(currentBody, "utf8").digest("hex");
      if (actualHash !== current.contentHash) return response(503, { status: "error", code: "current_rules_hash_mismatch" });
      const currentPackage = validatePackage(JSON.parse(currentBody));

      if (event.httpMethod === "GET") {
        return response(200, { status: "ok", pointer: current, rulesPackage: currentPackage });
      }

      const request = parseBody(event);
      if (!request || typeof request !== "object" || Array.isArray(request) ||
          Object.keys(request).length !== 2 || !Object.hasOwn(request, "baseContentHash") || !Object.hasOwn(request, "rules")) {
        return response(400, { status: "error", code: "invalid_publish_request", field: "body" });
      }
      if (!request || request.baseContentHash !== current.contentHash) {
        return response(409, { status: "error", code: "stale_draft", currentPointer: current });
      }
      validateRules(request.rules);
      if (JSON.stringify(request.rules) === JSON.stringify(currentPackage.rules)) {
        return response(400, { status: "error", code: "no_changes", field: "rules" });
      }
      const rulesVersion = current.rulesVersion + 1;
      const releaseId = releaseIdAt(now(), rulesVersion);
      const rulesPackage = {
        schemaVersion: 1,
        kind: "well-pump-rules-release",
        releaseId,
        rulesVersion,
        rulesSchemaVersion: 1,
        sourceWorkbook: "well_pump_operational_rules_1.xlsx",
        rules: request.rules
      };
      validatePackage(rulesPackage);
      const releaseBody = `${JSON.stringify(rulesPackage, null, 2)}\n`;
      const contentHash = createHash("sha256").update(releaseBody, "utf8").digest("hex");
      const metadata = {
        schemaVersion: 1,
        siteId: SITE_ID,
        releaseId,
        rulesVersion,
        rulesSchemaVersion: 1,
        contentHash,
        hashAlgorithm: "sha256",
        publishedAtMs: now().getTime(),
        downloadPath: `/.netlify/functions/rules-release/${releaseId}.json`
      };
      await store.publish(releaseId, releaseBody, metadata);
      return response(201, { status: "published", pointer: metadata });
    } catch (error) {
      if (error instanceof RulesContractError || error instanceof SyntaxError) {
        return response(400, { status: "error", code: error.code || "invalid_release_json", field: error.field || "body" });
      }
      if (error && error.name === "RulesStoreConflictError") {
        return response(409, { status: "error", code: "stale_draft" });
      }
      const configurationError = error && error.name === "ConfigurationError";
      console.error("Rules administration failed", { category: configurationError ? "configuration" : "storage" });
      return response(503, { status: "error", code: configurationError ? "configuration_missing" : "rules_store_unavailable" });
    }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
exports._releaseIdAt = releaseIdAt;
