"use strict";

const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function response(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}

function timestampToIso(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

exports.handler = async function currentPower(event) {
  if (event.httpMethod !== "GET") {
    return {
      ...response(405, { status: "error", code: "method_not_allowed" }),
      headers: { ...jsonHeaders, "Allow": "GET" }
    };
  }

  try {
    const { db } = getPilotFirestore();
    const snapshot = await db.collection("sites").doc("well-main")
      .collection("current").doc("well-power").get();

    if (!snapshot.exists) {
      return response(404, { status: "empty", code: "telemetry_missing" });
    }

    const data = snapshot.data();
    const observedAt = timestampToIso(data.observedAt);
    const receivedAt = timestampToIso(data.receivedAt);
    const receivedAtMs = receivedAt ? Date.parse(receivedAt) : 0;

    return response(200, {
      status: "ok",
      siteId: "well-main",
      measurementType: "well-power",
      deviceId: data.deviceId,
      pumpRunning: data.pumpRunning === true,
      observedAt,
      receivedAt,
      ageSeconds: receivedAtMs ? Math.max(0, Math.round((Date.now() - receivedAtMs) / 1000)) : null,
      publishReason: data.publishReason || null,
      values: data.values || {}
    });
  } catch (error) {
    const configurationError = error instanceof ConfigurationError;
    console.error("Current power read failed", {
      category: configurationError ? "configuration" : "firestore"
    });

    return response(503, {
      status: "error",
      code: configurationError ? "configuration_missing" : "firestore_unavailable"
    });
  }
};
