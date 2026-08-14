"use strict";

const {
  ConfigurationError,
  getPilotFirestore
} = require("../lib/firebase");

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function safeDiagnostic(value) {
  if (typeof value !== "string") {
    return "unknown";
  }

  return /^[A-Za-z0-9_.:/-]{1,80}$/.test(value) ? value : "unknown";
}

exports.handler = async function firebaseStatus(event) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { ...jsonHeaders, "Allow": "GET" },
      body: JSON.stringify({ status: "error", code: "method_not_allowed" })
    };
  }

  let stage = "initialize";

  try {
    const { db, projectId, databaseId } = getPilotFirestore();
    stage = "read";
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
    const providerCode = safeDiagnostic(error.code);
    const providerName = safeDiagnostic(error.name);
    const diagnosticStage = safeDiagnostic(stage);

    console.error("Firestore status check failed", {
      category: configurationError ? "configuration" : "firestore",
      providerCode,
      providerName,
      diagnosticStage
    });

    return {
      statusCode: 503,
      headers: jsonHeaders,
      body: JSON.stringify({
        status: "error",
        code: configurationError ? "configuration_missing" : "firestore_unavailable",
        diagnosticStage,
        providerCode,
        providerName
      })
    };
  }
};
