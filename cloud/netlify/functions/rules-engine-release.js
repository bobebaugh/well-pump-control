"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { RELEASE_ID_PATTERN, RulesEngineReleaseError, verifiedRuntimeRelease } = require("../lib/rules-engine-release-contract");

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
function response(statusCode, body) { return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) }; }
function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(provided, "utf8").digest(), createHash("sha256").update(expected, "utf8").digest());
}
function getHeader(headers, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === target);
  return entry ? entry[1] : "";
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const storeFactory = dependencies.createStore || (() => require("../lib/rules-engine-store").createRulesEngineStore());
  return async function rulesEngineRelease(event) {
    if (event.httpMethod !== "GET") return { ...response(405, { status: "error", code: "method_not_allowed" }), headers: { ...jsonHeaders, Allow: "GET" } };
    if (!env.PILOT_INGEST_TOKEN) return response(503, { status: "error", code: "configuration_missing" });
    if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), env.PILOT_INGEST_TOKEN)) return response(401, { status: "error", code: "unauthorized" });
    const releaseId = event.queryStringParameters?.releaseId;
    if (typeof releaseId !== "string" || !RELEASE_ID_PATTERN.test(releaseId)) return response(404, { status: "error", code: "release_not_found" });
    try {
      const release = await storeFactory().getRelease(releaseId);
      return { statusCode: 200, headers: jsonHeaders, body: verifiedRuntimeRelease(release, releaseId).runtimeBody };
    } catch (error) {
      const code = error instanceof RulesEngineReleaseError ? error.code : "release_unavailable";
      return response(404, { status: "error", code });
    }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
exports._tokenMatches = tokenMatches;
