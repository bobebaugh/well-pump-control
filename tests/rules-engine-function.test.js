"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { defaults } = require("../cloud/netlify/lib/rules-engine-defaults");
const { _createHandler, _releaseIdAt } = require("../cloud/netlify/functions/rules-engine");

function request(method, payload, token = "test-key") {
  return { httpMethod: method, headers: { "X-Pilot-Key": token }, body: payload === undefined ? "" : JSON.stringify(payload) };
}

function harness(customize) {
  const draft = defaults();
  const revisions = { devices: 1, calculatedFields: 1, events: 1 };
  let current = null;
  const published = [];
  const deliveries = [];
  const store = {
    async loadOrSeed() { return { draft: { ...structuredClone(draft), revisions: { ...revisions } }, current }; },
    async listReleases() { return published.map(item => ({ releaseId: item.releaseId, packageVersion: item.release.packageVersion })).reverse(); },
    async getRelease(releaseId) { return published.find(item => item.releaseId === releaseId)?.release || null; },
    async saveSection(section, expectedRevision, items) {
      assert.equal(expectedRevision, revisions[section]);
      draft[section] = structuredClone(items); revisions[section] += 1; return revisions[section];
    },
    async publish(expectedVersion, expectedRevisions, releaseId, release, stateValue) {
      assert.equal(expectedVersion, current?.packageVersion || 0);
      assert.deepEqual(expectedRevisions, revisions);
      published.push({ releaseId, release, stateValue }); current = stateValue;
    },
    async markDelivered(releaseId, contentHash, metadata, nowMs) {
      assert.equal(releaseId, current?.releaseId);
      assert.equal(contentHash, current?.contentHash);
      current = { ...current, deliveryEnabled: true, deliveredAtMs: nowMs, delivery: metadata };
      return current;
    },
    async restoreRelease(releaseId, expectedRevisions) {
      assert.deepEqual(expectedRevisions, revisions);
      const release = published.find(item => item.releaseId === releaseId)?.release;
      if (!release) { const error = new Error(); error.name = "RulesEngineReleaseNotFoundError"; throw error; }
      for (const section of Object.keys(revisions)) { draft[section] = structuredClone(release.authoringPackage[section]); revisions[section] += 1; }
      return { ...structuredClone(draft), schemaVersion: 2, revisions: { ...revisions } };
    }
  };
  if (customize) customize(draft, store);
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-key" }, createStore: () => store,
    createDelivery: () => ({ async publishPointer(metadata) { deliveries.push(metadata); } }),
    now: () => new Date("2026-08-27T16:30:45.000Z")
  });
  return { handler, draft, published, deliveries };
}

test("loads seeded sections and advertises only disabled delivery", async () => {
  const { handler } = harness();
  const result = await handler(request("GET"));
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.draft.devices.length, 3);
  assert.equal(body.draft.schemaVersion, 2);
  assert.deepEqual(body.releases, []);
  assert.equal(body.capabilities.functions.boyle_tank.label, "Boyle-law tank model");
  assert.equal(body.capabilities.summaryOperations.average, "Average while active");
  assert.equal(body.delivery.enabled, false);
});

test("saves one independently revisioned draft section", async () => {
  const { handler, draft } = harness();
  draft.devices[0].address = "192.168.50.142";
  const result = await handler(request("PUT", { section: "devices", baseRevision: 1, items: draft.devices }));
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).revision, 2);
});

test("validates then publishes one immutable cross-section version", async () => {
  const { handler, published } = harness();
  const validation = await handler(request("POST", { action: "validate" }));
  assert.equal(validation.statusCode, 200);
  const validationBody = JSON.parse(validation.body);
  assert.equal(validationBody.status, "valid");
  assert.ok(validationBody.runtimeBytes < 65536);

  const result = await handler(request("POST", { action: "publish", basePackageVersion: 0 }));
  assert.equal(result.statusCode, 201);
  const body = JSON.parse(result.body);
  assert.equal(body.current.packageVersion, 1);
  assert.equal(body.current.deliveryEnabled, false);
  assert.equal(published[0].releaseId, "20260827163045-parameters-v1");
  assert.equal(published[0].release.runtimePackage.events[0].web, undefined);
  assert.equal(published[0].stateValue.contentHash, createHash("sha256").update(published[0].release.runtimeBody).digest("hex"));
});

test("lists, reads, and restores any published package without moving the current pointer", async () => {
  const { handler } = harness();
  await handler(request("POST", { action: "publish", basePackageVersion: 0 }));
  const loaded = JSON.parse((await handler(request("GET"))).body);
  assert.equal(loaded.releases.length, 1);
  const releaseId = loaded.releases[0].releaseId;
  const detail = await handler({ ...request("GET"), queryStringParameters: { releaseId } });
  assert.equal(detail.statusCode, 200);
  assert.equal(JSON.parse(detail.body).release.authoringPackage.schemaVersion, 2);

  const restored = await handler(request("POST", { action: "restore", releaseId, baseRevisions: { devices: 1, calculatedFields: 1, events: 1 } }));
  assert.equal(restored.statusCode, 200);
  const body = JSON.parse(restored.body);
  assert.deepEqual(body.draft.revisions, { devices: 2, calculatedFields: 2, events: 2 });
  const after = JSON.parse((await handler(request("GET"))).body);
  assert.equal(after.current.packageVersion, 1);
});

test("delivers only the current immutable package after rechecking exact bytes", async () => {
  const { handler, deliveries } = harness();
  const published = JSON.parse((await handler(request("POST", { action: "publish", basePackageVersion: 0 }))).body);
  const delivered = await handler(request("POST", { action: "deliver", releaseId: published.current.releaseId }));
  assert.equal(delivered.statusCode, 200);
  const body = JSON.parse(delivered.body);
  assert.equal(body.status, "delivered");
  assert.equal(body.current.deliveryEnabled, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].packageVersion, 1);
  assert.equal(deliveries[0].runtimeSchemaVersion, 2);
  assert.equal(deliveries[0].contentHash, published.current.contentHash);
  assert.match(deliveries[0].downloadPath, /rules-engine-release\?releaseId=/);
});

test("does not point RTDB backward to a historical immutable package", async () => {
  const { handler, deliveries } = harness();
  const first = JSON.parse((await handler(request("POST", { action: "publish", basePackageVersion: 0 }))).body);
  const second = JSON.parse((await handler(request("POST", { action: "publish", basePackageVersion: 1 }))).body);
  const old = await handler(request("POST", { action: "deliver", releaseId: first.current.releaseId }));
  assert.equal(old.statusCode, 409);
  assert.equal(JSON.parse(old.body).code, "delivery_not_current");
  assert.equal(deliveries.length, 0);
  const current = await handler(request("POST", { action: "deliver", releaseId: second.current.releaseId }));
  assert.equal(current.statusCode, 200);
});

test("rejects invalid drafts, stale publication, and unauthorized access", async () => {
  const { handler } = harness(draft => { draft.events[0].open.observationCount = 0; });
  assert.equal((await handler(request("GET", undefined, "wrong"))).statusCode, 401);
  const invalid = await handler(request("POST", { action: "validate" }));
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.parse(invalid.body).errors.some(error => error.code === "invalid_observation_count"), true);
  const stale = await handler(request("POST", { action: "publish", basePackageVersion: 4 }));
  assert.equal(stale.statusCode, 400);
});

test("release IDs use the package version", () => {
  assert.equal(_releaseIdAt(new Date("2026-08-27T16:30:45.000Z"), 3), "20260827163045-parameters-v3");
});
