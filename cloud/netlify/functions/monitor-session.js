"use strict";

const { timingSafeEqual } = require("node:crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");

const SITE_ID = "well-main";
const SESSION_DURATION_MS = 15 * 60 * 1000;
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
  if (!provided || !expected) {
    return false;
  }

  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function publicSessionState(data) {
  const expiresAtMs = data.expiresAt && typeof data.expiresAt.toMillis === "function"
    ? data.expiresAt.toMillis()
    : 0;
  const active = data.active === true && expiresAtMs > Date.now();

  return {
    active,
    until: active ? new Date(expiresAtMs).toISOString() : null,
    maximumMinutes: 15
  };
}

exports.handler = async function monitorSession(event) {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return {
      ...response(405, { status: "error", code: "method_not_allowed" }),
      headers: { ...jsonHeaders, "Allow": "GET, POST" }
    };
  }

  const expectedToken = process.env.PILOT_INGEST_TOKEN;

  if (!expectedToken) {
    return response(503, { status: "error", code: "configuration_missing" });
  }

  if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), expectedToken)) {
    return response(401, { status: "error", code: "unauthorized" });
  }

  try {
    const { db } = getPilotFirestore();
    const document = db.collection("sites").doc(SITE_ID).collection("control").doc("monitoring");

    if (event.httpMethod === "POST") {
      let payload;

      try {
        payload = JSON.parse(event.body || "{}");
      } catch {
        return response(400, { status: "error", code: "invalid_json" });
      }

      if (payload.action !== "start" && payload.action !== "stop") {
        return response(400, { status: "error", code: "invalid_action" });
      }

      const now = Date.now();
      const starting = payload.action === "start";
      const expiresAt = starting ? now + SESSION_DURATION_MS : now;

      await document.set({
        active: starting,
        expiresAt: Timestamp.fromMillis(expiresAt),
        updatedAt: FieldValue.serverTimestamp(),
        requestedBy: "netlify-hmi",
        maximumMinutes: 15
      });

      return response(200, {
        status: "ok",
        monitoring: {
          active: starting,
          until: starting ? new Date(expiresAt).toISOString() : null,
          maximumMinutes: 15
        }
      });
    }

    const snapshot = await document.get();
    return response(200, {
      status: "ok",
      monitoring: publicSessionState(snapshot.exists ? snapshot.data() : {})
    });
  } catch (error) {
    const configurationError = error instanceof ConfigurationError;
    console.error("Monitoring session request failed", {
      category: configurationError ? "configuration" : "firestore"
    });

    return response(503, {
      status: "error",
      code: configurationError ? "configuration_missing" : "firestore_unavailable"
    });
  }
};
