"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const RELEASE_ID_PATTERN = /^[0-9]{14}-rules-v[0-9]+\.json$/;
const RELEASE_DIRECTORY = path.join(__dirname, "..", "rules-releases");
const MAX_RELEASE_BYTES = 65536;
const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

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
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function requestedReleaseId(event) {
  const id = event.queryStringParameters && event.queryStringParameters.releaseId;
  return typeof id === "string" && RELEASE_ID_PATTERN.test(id) ? id : null;
}

function releaseBody(releaseId, readFile = readFileSync) {
  const body = readFile(path.join(RELEASE_DIRECTORY, releaseId), "utf8");
  if (Buffer.byteLength(body, "utf8") > MAX_RELEASE_BYTES) throw new Error("release_too_large");
  return body;
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const readFile = dependencies.readFile || readFileSync;

  return async function rulesRelease(event) {
    if (event.httpMethod !== "GET") {
      return { ...response(405, { status: "error", code: "method_not_allowed" }), headers: { ...jsonHeaders, Allow: "GET" } };
    }
    if (!env.PILOT_INGEST_TOKEN) return response(503, { status: "error", code: "configuration_missing" });
    if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), env.PILOT_INGEST_TOKEN)) {
      return response(401, { status: "error", code: "unauthorized" });
    }
    const releaseId = requestedReleaseId(event);
    if (!releaseId) return response(404, { status: "error", code: "release_not_found" });
    try {
      return { statusCode: 200, headers: jsonHeaders, body: releaseBody(releaseId, readFile) };
    } catch {
      return response(404, { status: "error", code: "release_not_found" });
    }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
exports._releaseBody = releaseBody;
exports._tokenMatches = tokenMatches;
