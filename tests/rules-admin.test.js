"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { _createHandler } = require("../cloud/netlify/functions/rules-admin");

const root = path.resolve(__dirname, "..");
const body = readFileSync(path.join(root, "cloud/netlify/rules-releases/20260825010000-rules-v1.json"), "utf8");
const rulesPackage = JSON.parse(body);
const pointer = JSON.parse(readFileSync(path.join(root, "cloud/netlify/rules-releases/current.json"), "utf8"));

function request(method, payload, token = "test-key") {
  return {
    httpMethod: method,
    headers: { "X-Pilot-Key": token },
    body: payload === undefined ? "" : JSON.stringify(payload)
  };
}

function harness() {
  const published = [];
  const store = {
    async getCurrentPointer() { return { ...pointer }; },
    async getReleaseBody() { return null; },
    async publish(...args) { published.push(args); }
  };
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-key" },
    createRulesStore: () => store,
    now: () => new Date("2026-08-25T14:30:45.000Z")
  });
  return { handler, published };
}

test("loads the exact currently published rules package", async () => {
  const { handler } = harness();
  const result = await handler(request("GET"));
  assert.equal(result.statusCode, 200);
  const response = JSON.parse(result.body);
  assert.deepEqual(response.pointer, pointer);
  assert.equal(response.rulesPackage.releaseId, pointer.releaseId);
  assert.equal(response.rulesPackage.rules.length, 59);
});

test("publishes an immutable incremented release before returning its pointer", async () => {
  const { handler, published } = harness();
  const changed = structuredClone(rulesPackage.rules);
  changed[0].enabled = true;
  const result = await handler(request("POST", { baseContentHash: pointer.contentHash, rules: changed }));
  assert.equal(result.statusCode, 201);
  assert.equal(published.length, 1);
  const [releaseId, releaseBody, metadata] = published[0];
  assert.equal(releaseId, "20260825143045-rules-v2");
  assert.equal(JSON.parse(releaseBody).rules[0].enabled, true);
  assert.equal(metadata.rulesVersion, 2);
  assert.equal(metadata.contentHash, createHash("sha256").update(releaseBody).digest("hex"));
  assert.equal(metadata.downloadPath, `/.netlify/functions/rules-release/${releaseId}.json`);
});

test("rejects stale, unauthorized, and incomplete drafts", async () => {
  const { handler, published } = harness();
  assert.equal((await handler(request("GET", undefined, "wrong"))).statusCode, 401);
  assert.equal((await handler(request("POST", { baseContentHash: "0".repeat(64), rules: rulesPackage.rules }))).statusCode, 409);
  const unchanged = await handler(request("POST", { baseContentHash: pointer.contentHash, rules: rulesPackage.rules }));
  assert.equal(unchanged.statusCode, 400);
  assert.equal(JSON.parse(unchanged.body).code, "no_changes");
  const result = await handler(request("POST", { baseContentHash: pointer.contentHash, rules: rulesPackage.rules.slice(1) }));
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).code, "invalid_rule_count");
  assert.equal(published.length, 0);
});
