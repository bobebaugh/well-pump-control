"use strict";

const {
  ConfigurationError,
  getPilotFirestore
} = require("../lib/firebase");

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const grpcCodeNames = Object.freeze({
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED"
});

function safeDiagnostic(value) {
  if (typeof value !== "string") {
    return "unknown";
  }

  return /^[A-Za-z0-9_.:/-]{1,80}$/.test(value) ? value : "unknown";
}

function providerDiagnostic(value) {
  const numericCode = typeof value === "number"
    ? value
    : (typeof value === "string" && /^\d{1,2}$/.test(value) ? Number(value) : null);

  if (Number.isInteger(numericCode)) {
    return {
      providerCode: numericCode,
      providerCodeName: grpcCodeNames[numericCode] || "UNKNOWN_CODE"
    };
  }

  const providerCode = safeDiagnostic(value);

  return {
    providerCode,
    providerCodeName: providerCode === "unknown"
      ? "UNKNOWN"
      : providerCode.toUpperCase().replace(/[.\/:_-]+/g, "_")
  };
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
    const { providerCode, providerCodeName } = providerDiagnostic(error.code);
    const providerName = safeDiagnostic(error.name);
    const diagnosticStage = safeDiagnostic(stage);

    console.error("Firestore status check failed", {
      category: configurationError ? "configuration" : "firestore",
      providerCode,
      providerCodeName,
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
        providerCodeName,
        providerName
      })
    };
  }
};
