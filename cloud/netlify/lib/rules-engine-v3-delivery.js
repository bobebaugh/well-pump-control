"use strict";

const { _approvedRtdbUrl } = require("./rules-store");

const SITE_ID = "well-main";

class RulesEngineV3DeliveryError extends Error {
  constructor(code) { super(code); this.name = "RulesEngineV3DeliveryError"; this.code = code; }
}

function createRulesEngineV3Delivery(dependencies = {}) {
  const env = dependencies.env || process.env;
  const firebase = dependencies.firebase || require("./firebase");
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (!env.FIREBASE_WEB_API_KEY || !env.FIREBASE_RTDB_URL) throw new RulesEngineV3DeliveryError("configuration_missing");
  const rtdbUrl = _approvedRtdbUrl(env.FIREBASE_RTDB_URL);
  let idTokenPromise;

  async function publisherToken() {
    if (!idTokenPromise) idTokenPromise = (async () => {
      const { auth, projectId } = firebase.getPilotAuth();
      if (projectId !== "well-pump-control") throw new RulesEngineV3DeliveryError("configuration_missing");
      const customToken = await auth.createCustomToken("netlify-rules-publisher", { siteId: SITE_ID, purpose: "rules-v3-publication" });
      const response = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
      const body = await response.json().catch(() => null);
      if (!response.ok || typeof body?.idToken !== "string") throw new RulesEngineV3DeliveryError("publisher_auth_failed");
      return body.idToken;
    })();
    return idTokenPromise;
  }

  return {
    async publishPointer(metadata) {
      // Event V3 is staging only.  Its RTDB pointer is never execution-enabled.
      if (!metadata || metadata.executionEnabled !== false) throw new RulesEngineV3DeliveryError("execution_must_remain_disabled");
      const token = await publisherToken();
      const path = `${rtdbUrl}/v1/sites/${SITE_ID}/rules/v3/current.json?auth=${encodeURIComponent(token)}`;
      const current = await fetchImpl(path, { method: "GET", headers: { "X-Firebase-ETag": "true" } });
      await current.json().catch(() => null);
      if (!current.ok) throw new RulesEngineV3DeliveryError("pointer_read_failed");
      const etag = current.headers.get("etag");
      const response = await fetchImpl(path, { method: "PUT", headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) }, body: JSON.stringify(metadata) });
      if (response.status === 412) throw new RulesEngineV3DeliveryError("pointer_changed");
      await response.json().catch(() => null);
      if (!response.ok) throw new RulesEngineV3DeliveryError("pointer_write_failed");
      return metadata;
    }
  };
}

module.exports = { RulesEngineV3DeliveryError, createRulesEngineV3Delivery };
