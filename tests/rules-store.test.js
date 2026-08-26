"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRulesStore, _approvedRtdbUrl } = require("../cloud/netlify/lib/rules-store");

const env = {
  FIREBASE_WEB_API_KEY: "test-api-key",
  FIREBASE_RTDB_URL: "https://well-pump-control-default-rtdb.firebaseio.com"
};

function jsonResponse(status, body, etag = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === "etag" ? etag : null; } },
    async json() { return body; }
  };
}

function harness(pointerStatus = 200) {
  const calls = [];
  const documents = new Map();
  const releaseDocument = {
    async get() { return { exists: false }; },
    async create(value) { documents.set(value.releaseId, value); }
  };
  const releases = { doc() { return releaseDocument; } };
  const adoptions = [
    { observedAt: { toDate: () => new Date("2026-08-25T14:00:00Z") }, activeRules: { version: 1 } },
    { observedAt: { toDate: () => new Date("2026-08-25T15:00:00Z") }, activeRules: { version: 2 } }
  ];
  const eventRecords = {
    where(field, operator, value) {
      calls.push({ query: [field, operator, value] });
      return { async get() { return { empty: false, docs: adoptions.map(data => ({ data: () => data })) }; } };
    }
  };
  const site = { collection(name) { return name === "eventRecords" ? eventRecords : releases; } };
  const sites = { doc() { return site; } };
  const db = { collection() { return sites; } };
  const firebase = {
    getPilotFirestore() {
      return { db };
    },
    getPilotAuth() {
      return { projectId: "well-pump-control", auth: { async createCustomToken() { return "custom-token"; } } };
    }
  };
  async function fetch(url, options) {
    calls.push({ url, options });
    if (url.startsWith("https://identitytoolkit.googleapis.com/")) return jsonResponse(200, { idToken: "id-token" });
    if (options.method === "GET") return jsonResponse(200, { rulesVersion: 1 }, '"pointer-v1"');
    return jsonResponse(pointerStatus, pointerStatus === 412 ? { error: "etag mismatch" } : null);
  }
  return { store: createRulesStore(env, { firebase, fetch }), calls, documents };
}

test("rules store uses a fixed custom identity and ETag guarded pointer update", async () => {
  const { store, calls, documents } = harness();
  assert.deepEqual(await store.getCurrentPointer(), { rulesVersion: 1 });
  await store.publish("20260825143045-rules-v2", "release bytes", {
    contentHash: "a".repeat(64), rulesVersion: 2, rulesSchemaVersion: 1, publishedAtMs: 1
  });
  assert.equal(documents.get("20260825143045-rules-v2").releaseBody, "release bytes");
  assert.equal(calls.filter(call => call.url.startsWith("https://identitytoolkit.googleapis.com/")).length, 1);
  const put = calls.find(call => call.options.method === "PUT");
  assert.equal(put.options.headers["If-Match"], '"pointer-v1"');
  assert.match(put.url, /\/v1\/sites\/well-main\/rules\/current\.json\?auth=id-token$/);
});

test("rules store selects the latest durable Tab5 adoption without a composite index", async () => {
  const { store, calls } = harness();
  const adoption = await store.getLatestRuleAdoption();
  assert.equal(adoption.activeRules.version, 2);
  assert.deepEqual(calls.find(call => call.query).query, ["recordType", "==", "rule-adoption"]);
});

test("rules store reports a concurrent pointer change and rejects other RTDB hosts", async () => {
  const { store } = harness(412);
  await store.getCurrentPointer();
  await assert.rejects(
    store.publish("20260825143045-rules-v2", "release bytes", {
      contentHash: "a".repeat(64), rulesVersion: 2, rulesSchemaVersion: 1, publishedAtMs: 1
    }),
    error => error.name === "RulesStoreConflictError"
  );
  assert.throws(() => _approvedRtdbUrl("https://example.com"), /approved project/);
});
