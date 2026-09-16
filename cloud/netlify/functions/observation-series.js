"use strict";

// Bucketed history for the home-screen charts.
//
// The live readings come from RTDB through current-observation; this is the
// other half, reading durable observations out of Firestore over a 1-day or
// 7-day window and returning a fixed-size series regardless of how many records
// the window actually holds.

const { Timestamp } = require("firebase-admin/firestore");
const { ConfigurationError, getPilotFirestore } = require("../lib/firebase");
const {
  MAX_SERIES_ROWS, WINDOWS, buildSeries, samplesFromRecords, tankModelFromDraft
} = require("../lib/observation-series");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";

// A read-only aggregate that nothing acts on, so unlike the operator endpoints
// it is cached briefly. A week view can cost thousands of Firestore reads to
// assemble and the page polls live values every two seconds; without this the
// history would be re-read alongside them.
const CACHE_SECONDS = { "1d": 60, "7d": 300 };

function headers(window) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${CACHE_SECONDS[window] || 60}`
  };
}

function response(statusCode, body, window = "1d") {
  return { statusCode, headers: headers(window), body: JSON.stringify(body) };
}

function requireApprovedDb(provider) {
  const result = provider();
  if (result.projectId !== "well-pump-control" || result.databaseId !== "(default)") {
    throw new ConfigurationError("Firestore target is not the approved pilot database");
  }
  return result.db;
}

// Schema 1 stamps observedAt at the document root; schema 2 moved it under time.
// Both are read so the window does not silently lose the older records.
async function windowRecords(site, startMs, endMs) {
  const observations = site.collection("observations");
  const read = (schemaVersion, field) => observations
    .where("deviceId", "==", DEVICE_ID)
    .where("schemaVersion", "==", schemaVersion)
    .where(field, ">=", Timestamp.fromMillis(startMs))
    .where(field, "<=", Timestamp.fromMillis(endMs))
    .orderBy(field, "asc")
    .limit(MAX_SERIES_ROWS)
    .get();
  const [one, two] = await Promise.all([read(1, "observedAt"), read(2, "time.observedAt")]);
  return {
    records: [...one.docs, ...two.docs].map(snapshot => snapshot.data()),
    truncated: one.docs.length >= MAX_SERIES_ROWS || two.docs.length >= MAX_SERIES_ROWS
  };
}

async function savedTankModel(site) {
  const snapshot = await site.collection("rulesEngineV3Draft").doc("calculatedFields").get();
  return snapshot.exists ? tankModelFromDraft(snapshot.data().items) : null;
}

function createHandler(dependencies = {}) {
  const firestore = dependencies.firestore || getPilotFirestore;
  const now = dependencies.now || Date.now;

  return async function observationSeries(event) {
    if (event.httpMethod !== "GET") {
      return { ...response(405, { status: "error", code: "method_not_allowed" }),
               headers: { ...headers("1d"), "Allow": "GET" } };
    }
    const window = String(event.queryStringParameters?.window || "1d");
    if (!Object.hasOwn(WINDOWS, window)) {
      return response(400, { status: "error", code: "invalid_window" });
    }

    const { spanMs, bucketMs } = WINDOWS[window];
    const endMs = now();
    const startMs = endMs - spanMs;

    let db;
    try {
      db = requireApprovedDb(firestore);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        return response(503, { status: "error", code: "configuration_missing" }, window);
      }
      throw error;
    }

    const site = db.collection("sites").doc(SITE_ID);
    let model = null;
    let page;
    try {
      // The model is only needed to convert a record that lacks the recorded
      // Boyle output, and to give the page the parameters for its live tank
      // reading. A missing draft degrades the live number, not the history.
      [model, page] = await Promise.all([
        savedTankModel(site).catch(() => null),
        windowRecords(site, startMs, endMs)
      ]);
    } catch (error) {
      return response(502, { status: "error", code: "history_read_failed" }, window);
    }

    const samples = samplesFromRecords(page.records, model);
    const series = buildSeries(samples, { startMs, endMs, bucketMs });

    return response(200, {
      status: series.buckets.some(bucket => bucket.gallons !== null) ? "ok" : "empty",
      window,
      startMs,
      endMs,
      bucketMs,
      recordCount: page.records.length,
      truncated: page.truncated,
      tankModel: model,
      // ShellyEnergyWh is logging mode "none" in the live package, so no record
      // has ever carried it and energy cannot be totalled from history.
      energyAvailable: false,
      ...series
    }, window);
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
