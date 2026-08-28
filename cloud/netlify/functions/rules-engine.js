"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { defaults, DEVICE_DRIVERS, FUNCTION_CATALOG, SUMMARY_OPERATIONS, TYPE_OPERATORS } = require("../lib/rules-engine-defaults");
const { validateAndCompile } = require("../lib/rules-engine-contract");
const { SECTIONS } = require("../lib/rules-engine-store");
const { RulesEngineReleaseError, RELEASE_ID_PATTERN, verifiedRuntimeRelease } = require("../lib/rules-engine-release-contract");

const MAX_BODY_BYTES = 524288;
const MAX_RUNTIME_BYTES = 65536;
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function response(statusCode, body) { return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) }; }
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
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw Object.assign(new Error("payload_too_large"), { code: "payload_too_large" });
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error("invalid_json"), { code: "invalid_json" }); }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((result, key) => { result[key] = canonical(value[key]); return result; }, {});
  return value;
}
function releaseIdAt(date, version) {
  return `${date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-parameters-v${version}`;
}
function requestedReleaseId(event) {
  const value = event.queryStringParameters?.releaseId;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : null;
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const now = dependencies.now || (() => new Date());
  const storeFactory = dependencies.createStore || (() => require("../lib/rules-engine-store").createRulesEngineStore());
  const deliveryFactory = dependencies.createDelivery || (() => require("../lib/rules-engine-delivery").createRulesEngineDelivery());

  return async function rulesEngine(event) {
    if (!["GET", "PUT", "POST"].includes(event.httpMethod)) return { ...response(405, { status: "error", code: "method_not_allowed" }), headers: { ...jsonHeaders, Allow: "GET, PUT, POST" } };
    if (!env.PILOT_INGEST_TOKEN) return response(503, { status: "error", code: "configuration_missing" });
    if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), env.PILOT_INGEST_TOKEN)) return response(401, { status: "error", code: "unauthorized" });

    try {
      const store = storeFactory();
      if (event.httpMethod === "GET") {
        if (event.queryStringParameters?.releaseId) {
          const releaseId = requestedReleaseId(event);
          if (!releaseId) return response(400, { status: "error", code: "invalid_release_id" });
          const release = await store.getRelease(releaseId);
          if (!release) return response(404, { status: "error", code: "release_not_found" });
          return response(200, { status: "ok", release });
        }
        const loaded = await store.loadOrSeed(defaults(), now().getTime());
        const releases = await store.listReleases();
        return response(200, {
          status: "ok", draft: loaded.draft, current: loaded.current, releases,
          capabilities: { functions: FUNCTION_CATALOG, operators: TYPE_OPERATORS, drivers: DEVICE_DRIVERS, summaryOperations: SUMMARY_OPERATIONS },
          delivery: {
            enabled: loaded.current?.deliveryEnabled === true,
            releaseId: loaded.current?.delivery?.releaseId || null,
            deliveredAtMs: loaded.current?.deliveredAtMs || null,
            description: "Delivery publishes the current immutable package identity to RTDB; Tab5 adoption remains separately verified."
          }
        });
      }

      const request = parseBody(event);
      if (event.httpMethod === "PUT") {
        if (!request || !SECTIONS.includes(request.section) || !Number.isInteger(request.baseRevision) || !Array.isArray(request.items)) {
          return response(400, { status: "error", code: "invalid_save_request" });
        }
        const revision = await store.saveSection(request.section, request.baseRevision, request.items, now().getTime());
        return response(200, { status: "saved", section: request.section, revision });
      }

      if (!request || !["validate", "publish", "restore", "deliver"].includes(request.action)) return response(400, { status: "error", code: "invalid_action" });
      if (request.action === "restore") {
        if (!requestedReleaseId({ queryStringParameters: { releaseId: request.releaseId } }) || !request.baseRevisions || SECTIONS.some(section => !Number.isInteger(request.baseRevisions[section]))) {
          return response(400, { status: "error", code: "invalid_restore_request" });
        }
        const draft = await store.restoreRelease(request.releaseId, request.baseRevisions, now().getTime());
        return response(200, { status: "restored", releaseId: request.releaseId, draft });
      }
      if (request.action === "deliver") {
        if (typeof request.releaseId !== "string" || !RELEASE_ID_PATTERN.test(request.releaseId)) {
          return response(400, { status: "error", code: "invalid_delivery_request" });
        }
        const loaded = await store.loadOrSeed(defaults(), now().getTime());
        if (!loaded.current || loaded.current.releaseId !== request.releaseId) {
          return response(409, { status: "error", code: "delivery_not_current", current: loaded.current });
        }
        const release = await store.getRelease(request.releaseId);
        const verified = verifiedRuntimeRelease(release, request.releaseId);
        if (verified.metadata.contentHash !== loaded.current.contentHash ||
            verified.metadata.packageVersion !== loaded.current.packageVersion) {
          return response(409, { status: "error", code: "delivery_release_mismatch", current: loaded.current });
        }
        await deliveryFactory().publishPointer(verified.metadata);
        const current = await store.markDelivered(
          request.releaseId, verified.metadata.contentHash, verified.metadata,
          now().getTime()
        );
        return response(200, { status: "delivered", current, metadata: verified.metadata });
      }
      const loaded = await store.loadOrSeed(defaults(), now().getTime());
      const result = validateAndCompile(loaded.draft);
      if (!result.valid) return response(400, { status: "invalid", errors: result.errors, warnings: result.warnings });
      const previewBody = `${JSON.stringify(result.runtimePackage, null, 2)}\n`;
      if (Buffer.byteLength(previewBody, "utf8") > MAX_RUNTIME_BYTES) return response(400, { status: "invalid", errors: [{ path: "runtimePackage", code: "runtime_package_too_large", message: `Runtime package exceeds the ${MAX_RUNTIME_BYTES} byte Tab5 pilot limit.` }], warnings: result.warnings });
      if (request.action === "validate") {
        return response(200, { status: "valid", errors: [], warnings: result.warnings, runtimePackage: result.runtimePackage, runtimeBytes: Buffer.byteLength(previewBody, "utf8") });
      }

      const currentVersion = loaded.current?.packageVersion || 0;
      if (!Number.isInteger(request.basePackageVersion) || request.basePackageVersion !== currentVersion) return response(409, { status: "error", code: "stale_package", current: loaded.current });
      const packageVersion = currentVersion + 1;
      const releaseId = releaseIdAt(now(), packageVersion);
      const runtimePackage = { ...result.runtimePackage, releaseId, packageVersion };
      const runtimeBody = `${JSON.stringify(canonical(runtimePackage), null, 2)}\n`;
      const contentHash = createHash("sha256").update(runtimeBody, "utf8").digest("hex");
      const stateValue = {
        schemaVersion: 2, packageVersion, releaseId, contentHash,
        publishedAtMs: now().getTime(), deliveryEnabled: false
      };
      const release = {
        ...stateValue,
        authoringPackage: loaded.draft,
        runtimePackage,
        runtimeBody,
        requestedBy: "netlify-rules-engine-pilot"
      };
      await store.publish(currentVersion, loaded.draft.revisions, releaseId, release, stateValue);
      return response(201, { status: "published", current: stateValue, warnings: result.warnings, runtimePackage, runtimeBytes: Buffer.byteLength(runtimeBody, "utf8") });
    } catch (error) {
      if (error?.name === "RulesEngineStoreConflictError") return response(409, { status: "error", code: "stale_draft" });
      if (error?.name === "RulesEngineReleaseNotFoundError") return response(404, { status: "error", code: "release_not_found" });
      if (error?.name === "RulesEngineIncompatibleReleaseError") return response(409, { status: "error", code: "incompatible_release_schema" });
      if (error instanceof RulesEngineReleaseError) return response(409, { status: "error", code: error.code });
      if (error?.name === "RulesEngineDeliveryError") return response(503, { status: "error", code: error.code });
      if (error?.code === "invalid_json" || error?.code === "payload_too_large") return response(400, { status: "error", code: error.code });
      const configurationError = error?.name === "ConfigurationError";
      // Preserve the intentionally generic browser response, but retain enough
      // non-sensitive information in the Netlify log to diagnose a Firestore
      // failure without logging release contents or credentials.
      const errorCode = typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : undefined;
      console.error("Rules Engine pilot failed", {
        category: configurationError ? "configuration" : "storage",
        errorName: error?.name || "Error",
        ...(errorCode ? { errorCode } : {})
      });
      return response(503, { status: "error", code: configurationError ? "configuration_missing" : "rules_engine_unavailable" });
    }
  };
}

exports.handler = createHandler();
exports._canonical = canonical;
exports._createHandler = createHandler;
exports._releaseIdAt = releaseIdAt;
