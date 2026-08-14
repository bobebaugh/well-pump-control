"use strict";

const { createPrivateKey } = require("node:crypto");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseServiceAccount(raw) {
  if (!raw) {
    throw new ConfigurationError("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new ConfigurationError("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  const required = ["project_id", "client_email", "private_key"];

  for (const field of required) {
    if (!serviceAccount[field]) {
      throw new ConfigurationError(`Service account field ${field} is missing`);
    }
  }

  try {
    createPrivateKey(serviceAccount.private_key);
  } catch {
    throw new ConfigurationError("Service account private key is not a valid PEM key");
  }

  return serviceAccount;
}

function getPilotFirestore() {
  const configuredProjectId = process.env.FIREBASE_PROJECT_ID || "well-pump-control";
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";

  if (databaseId !== "(default)") {
    throw new ConfigurationError("The pilot currently supports only the (default) Firestore database");
  }

  const serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

  if (serviceAccount.project_id !== configuredProjectId || configuredProjectId !== "well-pump-control") {
    throw new ConfigurationError("Firebase project ID does not match the approved pilot project");
  }

  const app = getApps()[0] || initializeApp({
    credential: cert(serviceAccount),
    projectId: configuredProjectId
  });

  return {
    db: getFirestore(app),
    projectId: configuredProjectId,
    databaseId
  };
}

module.exports = {
  ConfigurationError,
  getPilotFirestore
};
