"use strict";

const {
  ConfigurationError,
  getPilotFirestore
} = require("../lib/firebase");

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

exports.handler = async function firebaseStatus(event) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { ...jsonHeaders, "Allow": "GET" },
      body: JSON.stringify({ status: "error", code: "method_not_allowed" })
    };
  }

  try {
    const { db, projectId, databaseId } = getPilotFirestore();
    const marker = await db.collection("_system").doc("pilot").get();

    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        status: "ok",
        connected: true,
        projectId,
        databaseId,
        location: "us-east1",
        markerExists: marker.exists,
        checkedAt: new Date().toISOString()
      })
    };
  } catch (error) {
    const configurationError = error instanceof ConfigurationError;

    console.error("Firestore status check failed", {
      category: configurationError ? "configuration" : "firestore",
      code: typeof error.code === "string" ? error.code : "unknown"
    });

    return {
      statusCode: 503,
      headers: jsonHeaders,
      body: JSON.stringify({
        status: "error",
        code: configurationError ? "configuration_missing" : "firestore_unavailable"
      })
    };
  }
};
