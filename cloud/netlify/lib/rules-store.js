"use strict";

const SITE_ID = "well-main";

class RulesStoreConfigurationError extends Error {
  constructor(message) { super(message); this.name = "ConfigurationError"; }
}

class RulesStoreConflictError extends Error {
  constructor() { super("rules_pointer_changed"); this.name = "RulesStoreConflictError"; }
}

function approvedRtdbUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new RulesStoreConfigurationError("FIREBASE_RTDB_URL is not a valid URL"); }
  const hosts = new Set(["well-pump-control-default-rtdb.firebaseio.com", "well-pump-control-default-rtdb.firebasedatabase.app"]);
  if (parsed.protocol !== "https:" || !hosts.has(parsed.hostname) ||
      (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new RulesStoreConfigurationError("FIREBASE_RTDB_URL is not the approved project database host");
  }
  return parsed.origin;
}

function createRulesStore(env = process.env, dependencies = {}) {
  const firebase = dependencies.firebase || require("./firebase");
  const { db } = firebase.getPilotFirestore();
  const authProvider = dependencies.getPilotAuth || firebase.getPilotAuth;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (!env.FIREBASE_WEB_API_KEY || !env.FIREBASE_RTDB_URL) {
    throw new RulesStoreConfigurationError("FIREBASE_WEB_API_KEY and FIREBASE_RTDB_URL are required");
  }
  const rtdbUrl = approvedRtdbUrl(env.FIREBASE_RTDB_URL);
  const releases = db.collection("sites").doc(SITE_ID).collection("rulesReleases");
  let idTokenPromise;
  let currentEtag = null;

  async function publisherToken() {
    if (!idTokenPromise) idTokenPromise = (async () => {
      const { auth, projectId } = authProvider();
      if (projectId !== "well-pump-control") throw new RulesStoreConfigurationError("Firebase Auth project is not approved");
      const customToken = await auth.createCustomToken("netlify-rules-publisher", {
        siteId: SITE_ID,
        purpose: "rules-publication"
      });
      const response = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken, returnSecureToken: true })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body.idToken !== "string") throw new Error("publisher_token_exchange_failed");
      return body.idToken;
    })();
    return idTokenPromise;
  }

  async function pointerRequest(method, body) {
    const token = await publisherToken();
    const headers = { "Content-Type": "application/json" };
    if (method === "GET") headers["X-Firebase-ETag"] = "true";
    if (method === "PUT" && currentEtag) headers["If-Match"] = currentEtag;
    const response = await fetchImpl(`${rtdbUrl}/v1/sites/${SITE_ID}/rules/current.json?auth=${encodeURIComponent(token)}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const value = await response.json().catch(() => null);
    if (response.status === 412) throw new RulesStoreConflictError();
    if (!response.ok) throw new Error(`rules_pointer_http_${response.status}`);
    if (method === "GET") currentEtag = response.headers.get("etag");
    return value;
  }

  return {
    async getCurrentPointer() {
      return pointerRequest("GET");
    },
    async getReleaseBody(releaseId) {
      const snapshot = await releases.doc(releaseId).get();
      if (!snapshot.exists) return null;
      const body = snapshot.data().releaseBody;
      return typeof body === "string" ? body : null;
    },
    async publish(releaseId, releaseBody, metadata) {
      await releases.doc(releaseId).create({
        schemaVersion: 1,
        releaseId,
        releaseBody,
        contentHash: metadata.contentHash,
        rulesVersion: metadata.rulesVersion,
        rulesSchemaVersion: metadata.rulesSchemaVersion,
        publishedAtMs: metadata.publishedAtMs,
        requestedBy: "netlify-rules-editor"
      });
      await pointerRequest("PUT", metadata);
    }
  };
}

module.exports = { _approvedRtdbUrl: approvedRtdbUrl, createRulesStore, RulesStoreConflictError };
