"use strict";

const { createPrivateKey } = require("node:crypto");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { getDatabase } = require("firebase-admin/database");

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

function getPilotApp() {
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

  return { app, projectId: configuredProjectId, databaseId };
}

function getPilotFirestore() {
  const { app, projectId, databaseId } = getPilotApp();

  return {
    db: getFirestore(app),
    projectId,
    databaseId
  };
}

function getPilotAuth() {
  const { app, projectId } = getPilotApp();
  return { auth: getAuth(app), projectId };
}

function approvedDatabaseUrl(value, projectId) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new ConfigurationError("FIREBASE_RTDB_URL is not a valid URL"); }
  const approved = new Set([
    `https://${projectId}-default-rtdb.firebaseio.com`,
    `https://${projectId}-default-rtdb.firebasedatabase.app`
  ]);
  if (parsed.protocol !== "https:" || !approved.has(parsed.origin) ||
      (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new ConfigurationError("FIREBASE_RTDB_URL is not the approved pilot project database");
  }
  return parsed.origin;
}

function getPilotDatabase() {
  const { app, projectId } = getPilotApp();
  const databaseUrl = approvedDatabaseUrl(process.env.FIREBASE_RTDB_URL, projectId);
  return { db: getDatabase(app, databaseUrl), projectId, databaseUrl };
}

module.exports = {
  ConfigurationError,
  approvedDatabaseUrl,
  getPilotAuth,
  getPilotDatabase,
  getPilotFirestore
};
