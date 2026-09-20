"use strict";

const { timingSafeEqual } = require("node:crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");
const {
  ContractError,
  classifyPumpRunning,
  validatePowerTelemetry
} = require("../lib/power-contract");

const SITE_ID = "well-main";
const MAX_BODY_BYTES = 4096;
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

function parseBody(event) {
  const text = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new ContractError("payload_too_large", "body");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ContractError("invalid_json", "body");
  }
}

function configuredThreshold(name, fallback, minimum, maximum) {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${name} is outside the supported pilot range`);
  }

  return value;
}

exports.handler = async function ingestPower(event) {
  if (event.httpMethod !== "POST") {
    return {
      ...response(405, { status: "error", code: "method_not_allowed" }),
      headers: { ...jsonHeaders, "Allow": "POST" }
    };
  }

  const expectedToken = process.env.PILOT_INGEST_TOKEN;
  const expectedDeviceId = process.env.PILOT_DEVICE_ID || "shelly-em-well";

  if (!expectedToken) {
    console.error("Power ingestion is not configured", { category: "configuration" });
    return response(503, { status: "error", code: "configuration_missing" });
  }

  if (!tokenMatches(getHeader(event.headers, "x-pilot-key"), expectedToken)) {
    return response(401, { status: "error", code: "unauthorized" });
  }

  try {
    const telemetry = validatePowerTelemetry(parseBody(event), expectedDeviceId);
    const { db } = getPilotFirestore();
    const site = db.collection("sites").doc(SITE_ID);
    const current = site.collection("current").doc("well-power");
    const startThresholdW = configuredThreshold("PUMP_START_THRESHOLD_W", 1000, 100, 10000);
    const stopThresholdW = configuredThreshold("PUMP_STOP_THRESHOLD_W", 100, 0, 9999);

    if (stopThresholdW >= startThresholdW) {
      throw new ConfigurationError("Pump stop threshold must be below the start threshold");
    }

    const common = {
      schemaVersion: telemetry.schemaVersion,
      measurementType: "well-power",
      deviceId: telemetry.deviceId,
      source: "shelly-em-gen1-channel-0",
      observedAt: Timestamp.fromDate(telemetry.observedAt),
      receivedAt: FieldValue.serverTimestamp(),
      publishReason: telemetry.publishReason,
      values: telemetry.values,
      ...(telemetry.observation === undefined ? {} : { observation: telemetry.observation })
    };

    // The devices/{id} and events/{auto-id} writes are gone: neither had a reader
    // anywhere in cloud/ or web/. The control/monitoring read went with the 1 Hz
    // live view, so the transaction is one read rather than two. The device
    // treats an absent monitoring object in the reply as success by design, so
    // dropping it from the response cannot turn an accepted write into a retry.
    //
    // The current/well-power write stays deliberately. Nothing reads it now that
    // the dashboard is sourced from the RTDB observation -- it is not a write the
    // cleanup missed. Retiring this endpoint is Phase 2 and needs the device's
    // cloud_available formula re-referenced first; minimal change wins until then.
    const outcome = await db.runTransaction(async transaction => {
      const previous = await transaction.get(current);
      const previousRunning = previous.exists && typeof previous.data().pumpRunning === "boolean"
        ? previous.data().pumpRunning
        : null;
      const pumpRunning = classifyPumpRunning(
        telemetry.values.powerW,
        previousRunning,
        startThresholdW,
        stopThresholdW
      );

      transaction.set(current, {
        ...common,
        pumpRunning,
        thresholds: { startW: startThresholdW, stopW: stopThresholdW }
      });

      return {
        pumpRunning,
        stateChanged: previousRunning !== null && pumpRunning !== previousRunning
      };
    });

    return response(201, {
      status: "ok",
      accepted: true,
      siteId: SITE_ID,
      measurementType: "well-power",
      currentDocument: "sites/well-main/current/well-power",
      pumpRunning: outcome.pumpRunning,
      stateChanged: outcome.stateChanged
    });
  } catch (error) {
    if (error instanceof ContractError) {
      return response(400, {
        status: "error",
        code: error.code,
        field: error.field
      });
    }

    const configurationError = error instanceof ConfigurationError;
    console.error("Power ingestion failed", {
      category: configurationError ? "configuration" : "firestore"
    });

    return response(503, {
      status: "error",
      code: configurationError ? "configuration_missing" : "firestore_unavailable"
    });
  }
};
