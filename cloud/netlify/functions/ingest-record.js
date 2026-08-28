"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");
const {
  IngestRecordError,
  canonicalRecord,
  stableJson,
  validateIngestRecord
} = require("../lib/ingest-record-contract");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";
const MAX_BODY_BYTES = 65536;
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

function parseBody(event) {
  const text = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new IngestRecordError("payload_too_large", "body");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new IngestRecordError("invalid_json", "body");
  }
}

function storedCanonical(data) {
  const value = { ...data };
  delete value.receivedAt;
  if (value.observedAt && typeof value.observedAt.toDate === "function") {
    value.observedAt = value.observedAt.toDate().toISOString();
  }
  return value;
}

function createHandler(dependencies = {}) {
  const firestoreProvider = dependencies.getPilotFirestore || getPilotFirestore;
  const toTimestamp = dependencies.toTimestamp || (date => Timestamp.fromDate(date));
  const serverTimestamp = dependencies.serverTimestamp || (() => FieldValue.serverTimestamp());
  const env = dependencies.env || process.env;

  return async function ingestRecord(event) {
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
      const record = validateIngestRecord(parseBody(event));
      if (record.siteId !== SITE_ID || record.deviceId !== DEVICE_ID) {
        return response(403, { status: "error", code: "device_not_allowed" });
      }

      const { db, projectId, databaseId } = firestoreProvider();
      if (projectId !== "well-pump-control" || databaseId !== "(default)") {
        throw new ConfigurationError("Firestore target is not the approved pilot database");
      }
      const collectionName = record.recordType === "observation" ? "observations" : "eventRecords";
      const document = db.collection("sites").doc(SITE_ID).collection(collectionName).doc(record.recordId);
      const instance = (record.recordType === "event-open" || record.recordType === "event-close")
        ? db.collection("sites").doc(SITE_ID).collection("eventInstances").doc(record.eventId)
        : null;
      const canonical = canonicalRecord(record);

      const outcome = await db.runTransaction(async transaction => {
        const existing = await transaction.get(document);
        if (existing.exists) {
          if (stableJson(storedCanonical(existing.data())) !== stableJson(canonical)) {
            throw new IngestRecordError("idempotency_conflict", "recordId");
          }
          return { duplicate: true };
        }
        const priorInstance = instance ? await transaction.get(instance) : null;
        transaction.create(document, {
          ...canonical,
          observedAt: toTimestamp(new Date(record.observedAt)),
          receivedAt: serverTimestamp()
        });
        if (record.recordType === "event-open") {
          // A delayed retry of the opening record must never reopen an instance
          // that already has an independently delivered close record.
          if (!priorInstance.exists || priorInstance.data().status !== "closed") {
            transaction.set(instance, {
              eventId: record.eventId, ruleId: record.ruleId, deviceId: record.deviceId,
              sessionId: record.sessionId, rulesRelease: record.rulesRelease,
              status: "open", openRecordId: record.recordId,
              openedAt: toTimestamp(new Date(record.observedAt)), updatedAt: serverTimestamp()
            }, { merge: true });
          }
        } else if (record.recordType === "event-close") {
          transaction.set(instance, {
            eventId: record.eventId, ruleId: record.ruleId, deviceId: record.deviceId,
            status: "closed", closeRecordId: record.recordId,
            closeReason: record.closeReason, commandId: record.commandId || null,
            closedAt: toTimestamp(new Date(record.observedAt)), updatedAt: serverTimestamp()
          }, { merge: true });
        }
        return { duplicate: false };
      });

      return response(outcome.duplicate ? 200 : 201, {
        status: "ok",
        accepted: true,
        duplicate: outcome.duplicate,
        recordType: record.recordType,
        recordId: record.recordId,
        document: `sites/${SITE_ID}/${collectionName}/${record.recordId}`
      });
    } catch (error) {
      if (error instanceof IngestRecordError) {
        return response(error.code === "idempotency_conflict" ? 409 : 400, {
          status: "error",
          code: error.code,
          field: error.field
        });
      }
      const configurationError = error instanceof ConfigurationError;
      console.error("Durable record ingestion failed", {
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
exports._storedCanonical = storedCanonical;
exports._tokenMatches = tokenMatches;
