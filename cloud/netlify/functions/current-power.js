"use strict";

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

function shelly1State(observation) {
  const values = observation && observation.values;
  const status = observation && observation.status;
  const available = status && typeof status.shelly1_available === "boolean"
    ? status.shelly1_available : null;
  return {
    available,
    sw0: values && typeof values.shelly1_sw0 === "boolean" ? values.shelly1_sw0 : null,
    rly0: values && typeof values.shelly1_rly0 === "boolean" ? values.shelly1_rly0 : null
  };
}

function createHandler(dependencies = {}) {
  const firestoreProvider = dependencies.getPilotFirestore || (() => require("../lib/firebase").getPilotFirestore());
  const now = dependencies.now || Date.now;

  return async function currentPower(event) {
  if (event.httpMethod !== "GET") {
    return {
      ...response(405, { status: "error", code: "method_not_allowed" }),
      headers: { ...jsonHeaders, "Allow": "GET" }
    };
  }

  try {
    const { db } = firestoreProvider();
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
      ageSeconds: receivedAtMs ? Math.max(0, Math.round((now() - receivedAtMs) / 1000)) : null,
      publishReason: data.publishReason || null,
      values: data.values || {},
      shelly1: shelly1State(data.observation)
    });
  } catch (error) {
    const configurationError = error && error.name === "ConfigurationError";
    console.error("Current power read failed", {
      category: configurationError ? "configuration" : "firestore"
    });

    return response(503, {
      status: "error",
      code: configurationError ? "configuration_missing" : "firestore_unavailable"
    });
  }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
exports._shelly1State = shelly1State;
