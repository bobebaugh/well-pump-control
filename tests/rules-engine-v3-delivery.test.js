"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRulesEngineV3Delivery } = require("../cloud/netlify/lib/rules-engine-v3-delivery");

const env = { FIREBASE_WEB_API_KEY: "test-api-key", FIREBASE_RTDB_URL: "https://well-pump-control-default-rtdb.firebaseio.com" };
function jsonResponse(status, body, etag = null) { return { ok: status >= 200 && status < 300, status, headers: { get(name) { return name.toLowerCase() === "etag" ? etag : null; } }, async json() { return body; } }; }
function metadata() {
  return { schemaVersion: 3, kind: "well-pump-event-v3-staging-pointer", siteId: "well-main", releaseId: "20260830123456-event-v3-v1", packageVersion: 1, runtimeSchemaVersion: 3, contentHash: "a".repeat(64), hashAlgorithm: "sha256", byteLength: 1234, publishedAtMs: 1788266096000, executionEnabled: false, downloadPath: "/.netlify/functions/rules-engine-release?version=3&releaseId=20260830123456-event-v3-v1" };
}

test("V3 delivery uses isolated staging credentials and only the execution-disabled V3 pointer", async () => {
  const calls = [];
  const delivery = createRulesEngineV3Delivery({ env, firebase: { getPilotAuth() { return { projectId: "well-pump-control", auth: { async createCustomToken(uid, claims) { assert.equal(uid, "netlify-rules-publisher"); assert.deepEqual(claims, { siteId: "well-main", purpose: "rules-v3-publication" }); return "custom-token"; } } }; } }, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith("https://identitytoolkit.googleapis.com/")) return jsonResponse(200, { idToken: "id-token" });
    if (options.method === "GET") return jsonResponse(200, null, '"v3-pointer"');
    return jsonResponse(200, null);
  } });
  await delivery.publishPointer(metadata());
  const put = calls.find(call => call.options.method === "PUT");
  assert.equal(put.options.headers["If-Match"], '"v3-pointer"');
  assert.match(put.url, /\/v1\/sites\/well-main\/rules\/v3\/current\.json\?auth=id-token$/);
  assert.deepEqual(JSON.parse(put.options.body), metadata());
});

test("V3 delivery rejects any pointer that would claim execution authority before network access", async () => {
  let calls = 0;
  const delivery = createRulesEngineV3Delivery({ env, firebase: {}, fetch: async () => { calls += 1; throw new Error("unexpected network"); } });
  await assert.rejects(delivery.publishPointer({ ...metadata(), executionEnabled: true }), error => error.code === "execution_must_remain_disabled");
  assert.equal(calls, 0);
});
