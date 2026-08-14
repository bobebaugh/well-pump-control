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
    const device = site.collection("devices").doc(telemetry.deviceId);
    const eventRecord = site.collection("events").doc();
    const monitoring = site.collection("control").doc("monitoring");
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
      values: telemetry.values
    };

    const outcome = await db.runTransaction(async transaction => {
      const [previous, monitoringSnapshot] = await Promise.all([
        transaction.get(current),
        transaction.get(monitoring)
      ]);
      const previousRunning = previous.exists && typeof previous.data().pumpRunning === "boolean"
        ? previous.data().pumpRunning
        : null;
      const monitoringData = monitoringSnapshot.exists ? monitoringSnapshot.data() : {};
      const monitoringExpiresAt = monitoringData.expiresAt && typeof monitoringData.expiresAt.toMillis === "function"
        ? monitoringData.expiresAt.toMillis()
        : 0;
      const monitoringActive = monitoringData.active === true && monitoringExpiresAt > Date.now();
      const pumpRunning = classifyPumpRunning(
        telemetry.values.powerW,
        previousRunning,
        startThresholdW,
        stopThresholdW
      );
      const stateChanged = previousRunning !== null && pumpRunning !== previousRunning;

      transaction.set(current, {
        ...common,
        pumpRunning,
        thresholds: { startW: startThresholdW, stopW: stopThresholdW }
      });
      // Current telemetry already proves liveness. Keep the device metadata
      // document sparse so a 1 Hz live session costs one write, not two.
      if (stateChanged || telemetry.publishReason === "manual-test") {
        transaction.set(device, {
          deviceType: "shelly-em-gen1",
          channel: 0,
          gateway: "tab5",
          lastSeenAt: FieldValue.serverTimestamp(),
          pumpRunning
        }, { merge: true });
      }

      if (stateChanged) {
        transaction.create(eventRecord, {
          schemaVersion: 1,
          eventType: pumpRunning ? "pump-started" : "pump-stopped",
          deviceId: telemetry.deviceId,
          observedAt: Timestamp.fromDate(telemetry.observedAt),
          receivedAt: FieldValue.serverTimestamp(),
          powerW: telemetry.values.powerW,
          voltageV: telemetry.values.voltageV
        });
      }

      return {
        pumpRunning,
        stateChanged,
        eventId: stateChanged ? eventRecord.id : null,
        monitoringActive,
        monitoringUntil: monitoringActive ? new Date(monitoringExpiresAt).toISOString() : null
      };
    });

    return response(201, {
      status: "ok",
      accepted: true,
      siteId: SITE_ID,
      measurementType: "well-power",
      currentDocument: "sites/well-main/current/well-power",
      pumpRunning: outcome.pumpRunning,
      stateChanged: outcome.stateChanged,
      eventId: outcome.eventId,
      monitoring: {
        active: outcome.monitoringActive,
        until: outcome.monitoringUntil
      }
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
