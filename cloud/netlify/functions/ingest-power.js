"use strict";

const { timingSafeEqual } = require("node:crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");
const { ContractError, validatePowerTelemetry } = require("../lib/power-contract");

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
    const sample = site.collection("telemetry").doc();
    const current = site.collection("current").doc("well-power");
    const device = site.collection("devices").doc(telemetry.deviceId);
    const common = {
      schemaVersion: telemetry.schemaVersion,
      measurementType: "well-power",
      deviceId: telemetry.deviceId,
      source: "shelly-em-gen1-channel-0",
      observedAt: Timestamp.fromDate(telemetry.observedAt),
      receivedAt: FieldValue.serverTimestamp(),
      values: telemetry.values
    };

    const batch = db.batch();
    batch.create(sample, common);
    batch.set(current, { ...common, sampleId: sample.id });
    batch.set(device, {
      deviceType: "shelly-em-gen1",
      channel: 0,
      gateway: "tab5",
      lastSeenAt: FieldValue.serverTimestamp(),
      latestSampleId: sample.id
    }, { merge: true });
    await batch.commit();

    return response(201, {
      status: "ok",
      accepted: true,
      sampleId: sample.id,
      siteId: SITE_ID,
      measurementType: "well-power"
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
