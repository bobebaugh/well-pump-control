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
  const store = {
    async loadOrSeed() { return { draft: { ...structuredClone(draft), revisions: { ...revisions } }, current }; },
    async saveSection(section, expectedRevision, items) {
      assert.equal(expectedRevision, revisions[section]);
      draft[section] = structuredClone(items); revisions[section] += 1; return revisions[section];
    },
    async publish(expectedVersion, expectedRevisions, releaseId, release, stateValue) {
      assert.equal(expectedVersion, current?.packageVersion || 0);
      assert.deepEqual(expectedRevisions, revisions);
      published.push({ releaseId, release, stateValue }); current = stateValue;
    }
  };
  if (customize) customize(draft, store);
  const handler = _createHandler({ env: { PILOT_INGEST_TOKEN: "test-key" }, createStore: () => store, now: () => new Date("2026-08-27T16:30:45.000Z") });
  return { handler, draft, published };
}

test("loads seeded sections and advertises only disabled delivery", async () => {
  const { handler } = harness();
  const result = await handler(request("GET"));
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.draft.devices.length, 3);
  assert.equal(body.capabilities.functions.boyle_tank.label, "Boyle-law tank model");
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
