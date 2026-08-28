"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRulesEngineDelivery } = require("../cloud/netlify/lib/rules-engine-delivery");

const env = { FIREBASE_WEB_API_KEY: "test-api-key", FIREBASE_RTDB_URL: "https://well-pump-control-default-rtdb.firebaseio.com" };
function jsonResponse(status, body, etag = null) {
  return { ok: status >= 200 && status < 300, status, headers: { get(name) { return name.toLowerCase() === "etag" ? etag : null; } }, async json() { return body; } };
}
function metadata() {
  return { schemaVersion: 2, kind: "well-pump-runtime-release-pointer", siteId: "well-main", releaseId: "20260828170000-parameters-v1", packageVersion: 1, runtimeSchemaVersion: 2, contentHash: "a".repeat(64), hashAlgorithm: "sha256", byteLength: 1234, publishedAtMs: 1787936400000, downloadPath: "/.netlify/functions/rules-engine-release?releaseId=20260828170000-parameters-v1" };
}

test("delivery uses the fixed publisher identity and ETag-protected v2 current pointer", async () => {
  const calls = [];
  const firebase = {
    getPilotAuth() {
      return {
        projectId: "well-pump-control",
        auth: {
          async createCustomToken(uid, claims) {
            assert.equal(uid, "netlify-rules-publisher");
            assert.deepEqual(claims, { siteId: "well-main", purpose: "rules-publication" });
            return "custom-token";
          }
        }
      };
    }
  };
  const delivery = createRulesEngineDelivery({ env, firebase, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith("https://identitytoolkit.googleapis.com/")) return jsonResponse(200, { idToken: "id-token" });
    if (options.method === "GET") return jsonResponse(200, null, '"pointer-v1"');
    return jsonResponse(200, null);
  } });
  await delivery.publishPointer(metadata());
  const put = calls.find(call => call.options.method === "PUT");
  assert.equal(put.options.headers["If-Match"], '"pointer-v1"');
  assert.match(put.url, /\/v1\/sites\/well-main\/rules\/current\.json\?auth=id-token$/);
  assert.deepEqual(JSON.parse(put.options.body), metadata());
});

test("delivery reports concurrent RTDB pointer changes", async () => {
  const firebase = {
    getPilotAuth() {
      return { projectId: "well-pump-control", auth: { async createCustomToken() { return "custom-token"; } } };
    }
  };
  const delivery = createRulesEngineDelivery({ env, firebase, fetch: async (_url, options) => {
    if (options.method === "GET") return jsonResponse(200, null, '"pointer-v1"');
    if (options.method === "PUT") return jsonResponse(412, { error: "etag mismatch" });
    return jsonResponse(200, { idToken: "id-token" });
  } });
  await assert.rejects(delivery.publishPointer(metadata()), error => error.code === "pointer_changed");
});
