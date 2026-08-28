"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { defaults } = require("../cloud/netlify/lib/rules-engine-defaults");
const { validateAndCompile } = require("../cloud/netlify/lib/rules-engine-contract");
const { _canonical } = require("../cloud/netlify/functions/rules-engine");
const { _createHandler } = require("../cloud/netlify/functions/rules-engine-release");
const { verifiedRuntimeRelease } = require("../cloud/netlify/lib/rules-engine-release-contract");

function release() {
  const compiled = validateAndCompile(defaults());
  assert.equal(compiled.valid, true);
  const runtimePackage = { ...compiled.runtimePackage, releaseId: "20260828170000-parameters-v1", packageVersion: 1 };
  const runtimeBody = `${JSON.stringify(_canonical(runtimePackage), null, 2)}\n`;
  return {
    schemaVersion: 2,
    releaseId: runtimePackage.releaseId,
    packageVersion: runtimePackage.packageVersion,
    publishedAtMs: 1787936400000,
    contentHash: createHash("sha256").update(runtimeBody, "utf8").digest("hex"),
    runtimePackage,
    runtimeBody
  };
}

function request(releaseId, token = "test-key") {
  return { httpMethod: "GET", headers: { "X-Pilot-Key": token }, queryStringParameters: { releaseId } };
}

test("serves exactly the immutable Rules Engine runtime bytes and pointer identity", async () => {
  const immutable = release();
  const handler = _createHandler({ env: { PILOT_INGEST_TOKEN: "test-key" }, createStore: () => ({ async getRelease(id) { return id === immutable.releaseId ? immutable : null; } }) });
  const result = await handler(request(immutable.releaseId));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, immutable.runtimeBody);
  const verified = verifiedRuntimeRelease(immutable, immutable.releaseId);
  assert.equal(verified.metadata.byteLength, Buffer.byteLength(result.body, "utf8"));
  assert.equal(verified.metadata.downloadPath, `/.netlify/functions/rules-engine-release?releaseId=${immutable.releaseId}`);
});

test("does not serve malformed, mismatched, or unauthorized runtime releases", async () => {
  const immutable = release();
  const bad = { ...immutable, contentHash: "a".repeat(64) };
  const handler = _createHandler({ env: { PILOT_INGEST_TOKEN: "test-key" }, createStore: () => ({ async getRelease() { return bad; } }) });
  assert.equal((await handler(request(immutable.releaseId))).statusCode, 404);
  assert.equal((await handler(request(immutable.releaseId, "wrong"))).statusCode, 401);
  assert.equal((await handler(request("20260828170000-rules-v1"))).statusCode, 404);
});
