"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { defaults } = require("../cloud/netlify/lib/rules-engine-v3-defaults");
const { compileV3Release } = require("../cloud/netlify/lib/rules-engine-v3-contract");
const { _createHandler } = require("../cloud/netlify/functions/rules-engine-release");
const { verifiedRuntimeV3Release } = require("../cloud/netlify/lib/rules-engine-v3-release-contract");

function release() {
  const compiled = compileV3Release(defaults(), "20260830123456-event-v3-v1", 1);
  assert.equal(compiled.valid, true);
  return {
    schemaVersion: 3,
    releaseId: compiled.runtimePackage.releaseId,
    packageVersion: compiled.runtimePackage.packageVersion,
    publishedAtMs: 1788266096000,
    contentHash: createHash("sha256").update(compiled.runtimeBody, "utf8").digest("hex"),
    runtimeBody: compiled.runtimeBody
  };
}

function request(releaseId, query = { version: "3", releaseId }, token = "test-key") {
  return { httpMethod: "GET", headers: { "X-Pilot-Key": token }, queryStringParameters: query };
}

test("V3 release serves exact immutable bytes and a closed execution-disabled staging pointer", async () => {
  const immutable = release();
  let v2Calls = 0;
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-key" },
    createStore: () => ({ async getRelease() { v2Calls += 1; throw new Error("V2 store must not serve V3"); } }),
    createV3Store: () => ({ async getRelease(id) { return id === immutable.releaseId ? immutable : null; } })
  });
  const result = await handler(request(immutable.releaseId));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, immutable.runtimeBody);
  assert.equal(v2Calls, 0);
  const verified = verifiedRuntimeV3Release(immutable, immutable.releaseId);
  assert.deepEqual(verified.metadata, {
    schemaVersion: 3, kind: "well-pump-event-runtime-release-pointer-v3", siteId: "well-main",
    releaseId: immutable.releaseId, packageVersion: 1, runtimeSchemaVersion: 3,
    contentHash: immutable.contentHash, hashAlgorithm: "sha256", byteLength: Buffer.byteLength(immutable.runtimeBody, "utf8"),
    publishedAtMs: immutable.publishedAtMs, executionEnabled: false,
    downloadPath: `/.netlify/functions/rules-engine-release?version=3&releaseId=${immutable.releaseId}`
  });
});

test("V3 release rejects malformed bytes, identity, closed-shape, and schema fencepost violations", async () => {
  const immutable = release();
  const mutateBody = mutate => {
    const body = JSON.parse(immutable.runtimeBody);
    mutate(body);
    const runtimeBody = `${JSON.stringify(body, null, 2)}\n`;
    return { ...immutable, runtimeBody, contentHash: createHash("sha256").update(runtimeBody, "utf8").digest("hex") };
  };
  assert.throws(() => verifiedRuntimeV3Release({ ...immutable, contentHash: "0".repeat(64) }), { code: "release_hash_mismatch" });
  assert.throws(() => verifiedRuntimeV3Release(mutateBody(body => { body.unreviewed = true; })), { code: "release_schema_invalid" });
  assert.throws(() => verifiedRuntimeV3Release(mutateBody(body => { body.systemFields = Array.from({ length: 33 }, () => body.systemFields[0]); })), { code: "release_schema_invalid" });
  assert.throws(() => verifiedRuntimeV3Release(mutateBody(body => { body.releaseId = "20260830123456-event-v3-v2"; })), { code: "release_identity_mismatch" });
  const oversizedBody = "x".repeat(65537);
  assert.throws(() => verifiedRuntimeV3Release({ ...immutable, runtimeBody: oversizedBody, contentHash: createHash("sha256").update(oversizedBody, "utf8").digest("hex") }), { code: "release_invalid" });
});

test("V3 release endpoint cannot cross-serve V2-style IDs or requests without version=3", async () => {
  const immutable = release();
  let v3Calls = 0;
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-key" },
    createStore: () => ({ async getRelease() { return null; } }),
    createV3Store: () => ({ async getRelease() { v3Calls += 1; return immutable; } })
  });
  assert.equal((await handler(request("20260830123456-parameters-v1"))).statusCode, 404);
  assert.equal((await handler(request(immutable.releaseId, { releaseId: immutable.releaseId }))).statusCode, 404);
  assert.equal(v3Calls, 0);
});
