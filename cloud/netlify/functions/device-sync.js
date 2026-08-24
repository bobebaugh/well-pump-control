"use strict";

const { timingSafeEqual } = require("node:crypto");
const { ConfigurationError, getPilotAuth } = require("../lib/firebase");
const {
  DeviceSyncError,
  globalEnableValue,
  pendingCommands,
  rulesReference,
  validateDeviceSyncRequest
} = require("../lib/device-sync-contract");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";
const MAX_BODY_BYTES = 16384;
const CUSTOM_TOKEN_LIFETIME_MS = 55 * 60 * 1000;
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
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function parseBody(event) {
  const text = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new DeviceSyncError("payload_too_large", "body");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DeviceSyncError("invalid_json", "body");
  }
}

function requireConfiguration(env) {
  const firebaseApiKey = env.FIREBASE_WEB_API_KEY;
  const rtdbUrl = (env.FIREBASE_RTDB_URL || "").replace(/\/$/, "");
  if (!firebaseApiKey || !/^https:\/\//.test(rtdbUrl)) {
    throw new ConfigurationError("FIREBASE_WEB_API_KEY and FIREBASE_RTDB_URL are required");
  }
  return {
    firebaseApiKey,
    rtdbUrl,
    identityToolkitUrl: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken",
    secureTokenUrl: "https://securetoken.googleapis.com/v1/token"
  };
}

async function fetchJson(fetchImpl, url, options) {
  const result = await fetchImpl(url, options);
  let body;
  try {
    body = await result.json();
  } catch {
    body = null;
  }
  if (!result.ok) throw new Error(`upstream_http_${result.status}`);
  return body;
}

async function exchangeCustomToken(fetchImpl, config, customToken) {
  return fetchJson(fetchImpl, `${config.identityToolkitUrl}?key=${encodeURIComponent(config.firebaseApiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true })
  });
}

function rtdbPath(config, path, idToken) {
  return `${config.rtdbUrl}/${path}.json?auth=${encodeURIComponent(idToken)}`;
}

function createHandler(dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const authProvider = dependencies.getPilotAuth || getPilotAuth;
  const now = dependencies.now || (() => new Date());
  const env = dependencies.env || process.env;

  return async function deviceSync(event) {
    if (event.httpMethod !== "POST") {
      return { ...response(405, { status: "error", code: "method_not_allowed" }), headers: { ...jsonHeaders, Allow: "POST" } };
    }
    if (!env.PILOT_INGEST_TOKEN) {
      return response(503, { status: "error", code: "configuration_missing" });
    }
    if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), env.PILOT_INGEST_TOKEN)) {
      return response(401, { status: "error", code: "unauthorized" });
    }

    try {
      const request = validateDeviceSyncRequest(parseBody(event));
      if (request.siteId !== SITE_ID || request.deviceId !== DEVICE_ID) {
        return response(403, { status: "error", code: "device_not_allowed" });
      }

      const config = requireConfiguration(env);
      const { auth, projectId } = authProvider();
      // Firebase custom tokens are single-use. Use a distinct probe token for
      // the Security-Rules-scoped server read and return an unconsumed token
      // for CPU B's own exchange.
      const probeToken = await auth.createCustomToken(DEVICE_ID, {
        siteId: SITE_ID,
        deviceId: DEVICE_ID,
        purpose: "device-sync-probe",
        exchangeId: request.exchangeId
      });
      const customToken = await auth.createCustomToken(DEVICE_ID, {
        siteId: SITE_ID,
        deviceId: DEVICE_ID,
        purpose: "device-transport",
        exchangeId: request.exchangeId
      });
      const exchanged = await exchangeCustomToken(fetchImpl, config, probeToken);
      if (!exchanged || typeof exchanged.idToken !== "string") throw new Error("token_exchange_failed");

      const root = `v1/sites/${SITE_ID}`;
      const deviceRoot = `${root}/devices/${DEVICE_ID}`;
      const authQuery = exchanged.idToken;
      const [rawCommands, rawGlobalEnable, rawRules] = await Promise.all([
        fetchJson(fetchImpl, rtdbPath(config, `${deviceRoot}/commands`, authQuery)),
        fetchJson(fetchImpl, rtdbPath(config, `${root}/control/globalEnable`, authQuery)),
        fetchJson(fetchImpl, rtdbPath(config, `${root}/rules/current`, authQuery))
      ]);
      const commands = pendingCommands(rawCommands, request);
      const highWater = commands.reduce(
        (highest, command) => Math.max(highest, command.commandSequence),
        request.lastAppliedCommandSequence
      );
      const issuedAt = now();

      return response(200, {
        schemaVersion: 1,
        kind: "device-sync-response",
        exchangeId: request.exchangeId,
        siteId: SITE_ID,
        deviceId: DEVICE_ID,
        sessionId: request.sessionId,
        issuedAt: issuedAt.toISOString(),
        highWaterCommandSequence: highWater,
        currentRules: rulesReference(rawRules, request.appliedRules),
        // Durable event canonicalization begins with M4/M8. Until then the
        // transport round-trip preserves the device's declared set unchanged.
        canonicalOpenEvents: request.openEventIds,
        globalEnable: globalEnableValue(rawGlobalEnable, request.globalEnable),
        pendingCommands: commands,
        authenticationBootstrap: {
          firebaseCustomToken: customToken,
          firebaseApiKey: config.firebaseApiKey,
          firebaseProjectId: projectId,
          rtdbUrl: config.rtdbUrl,
          identityToolkitUrl: config.identityToolkitUrl,
          secureTokenUrl: config.secureTokenUrl,
          expiresAt: new Date(issuedAt.getTime() + CUSTOM_TOKEN_LIFETIME_MS).toISOString()
        }
      });
    } catch (error) {
      if (error instanceof DeviceSyncError) {
        return response(400, { status: "error", code: error.code, field: error.field });
      }
      const configurationError = error instanceof ConfigurationError;
      console.error("Device synchronization failed", { category: configurationError ? "configuration" : "upstream" });
      return response(503, { status: "error", code: configurationError ? "configuration_missing" : "sync_unavailable" });
    }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
exports._rtdbPath = rtdbPath;
