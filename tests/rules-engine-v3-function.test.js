"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { defaults } = require("../cloud/netlify/lib/rules-engine-v3-defaults");
const { _createHandler } = require("../cloud/netlify/functions/rules-engine");

function request(method, payload, query = { version: "3" }) {
  return { httpMethod: method, headers: { "X-Pilot-Key": "test-key" }, queryStringParameters: query, body: payload === undefined ? "" : JSON.stringify(payload) };
}

function harness(options = {}) {
  const draft = defaults();
  const revisions = { devices: 1, calculatedFields: 1, systemFields: 1, events: 1 };
  const published = [];
  let current = null;
  let deliveryFactoryCalls = 0;
  const store = {
    async loadOrSeed() { return { draft: { ...structuredClone(draft), revisions: { ...revisions } }, current }; },
    async listReleases() { return published.map(item => ({ releaseId: item.releaseId, packageVersion: item.release.packageVersion, schemaVersion: 3 })).reverse(); },
    async getRelease(releaseId) { return published.find(item => item.releaseId === releaseId)?.release || null; },
    async saveSection(section, expectedRevision, items) { assert.equal(expectedRevision, revisions[section]); draft[section] = structuredClone(items); revisions[section] += 1; return revisions[section]; },
    async publish(expectedVersion, expectedRevisions, releaseId, release, stateValue) {
      assert.equal(expectedVersion, current?.packageVersion || 0); assert.deepEqual(expectedRevisions, revisions);
      published.push({ releaseId, release, stateValue }); current = stateValue;
    },
    async markDelivered(releaseId, contentHash, metadata, nowMs) {
      assert.equal(releaseId, current?.releaseId);
      assert.equal(contentHash, current?.contentHash);
      assert.equal(metadata.executionEnabled, false);
      current = { ...current, deliveryEnabled: true, executionEnabled: false, deliveredAtMs: nowMs, delivery: metadata };
      return current;
    },
    async restoreRelease(releaseId, expectedRevisions) {
      assert.deepEqual(expectedRevisions, revisions);
      const release = published.find(item => item.releaseId === releaseId)?.release;
      if (!release) { const error = new Error(); error.name = "RulesEngineV3ReleaseNotFoundError"; throw error; }
      for (const section of Object.keys(revisions)) { draft[section] = structuredClone(release.authoringPackage[section]); revisions[section] += 1; }
      return { ...structuredClone(draft), schemaVersion: 3, revisions: { ...revisions } };
    }
  };
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-key" },
    createV3Store: () => store,
    createStore: () => { throw new Error("V2 store must not serve V3 request"); },
    createDelivery: () => { deliveryFactoryCalls += 1; throw new Error("V2 delivery factory must not serve V3 request"); },
    createV3Delivery: options.createV3Delivery,
    now: () => new Date("2026-08-30T12:34:56.000Z")
  });
  return { handler, published, get deliveryFactoryCalls() { return deliveryFactoryCalls; } };
}

test("V3 endpoint validates, publishes, reopens, and restores an isolated immutable package", async () => {
  const { handler, published } = harness();
  const loaded = JSON.parse((await handler(request("GET"))).body);
  const loadedAuthoringPackage = { schemaVersion: 3, devices: loaded.draft.devices, calculatedFields: loaded.draft.calculatedFields, systemFields: loaded.draft.systemFields, events: loaded.draft.events };
  assert.equal(loaded.draft.schemaVersion, 3);
  assert.deepEqual(Object.keys(loaded.draft.revisions), ["devices", "calculatedFields", "systemFields", "events"]);
  assert.equal(loaded.delivery.enabled, false);
  assert.equal(loaded.capabilities.deliveryAvailable, true);

  const validation = JSON.parse((await handler(request("POST", { action: "validate" }))).body);
  assert.equal(validation.status, "valid");
  assert.equal(validation.runtimePackage.schemaVersion, 3);
  assert.equal(validation.runtimePackage.releaseId, undefined);

  const publishedResponse = await handler(request("POST", { action: "publish", basePackageVersion: 0 }));
  assert.equal(publishedResponse.statusCode, 201);
  const body = JSON.parse(publishedResponse.body);
  assert.equal(body.current.releaseId, "20260830123456-event-v3-v1");
  assert.equal(body.current.deliveryEnabled, false);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].release.authoringPackage, loadedAuthoringPackage);
  assert.equal(published[0].release.authoringPackage.schemaVersion, 3);
  assert.equal(published[0].release.authoringPackage.events[0].web.notifyOnOpen, false);
  const runtime = JSON.parse(published[0].release.runtimeBody);
  assert.equal(runtime.kind, "well-pump-event-runtime-v3");
  assert.equal(runtime.calculations.length, 3);
  assert.equal(Object.hasOwn(runtime, "calculatedFields"), false);
  assert.equal(runtime.events.some(event => Object.hasOwn(event, "web")), false);
  assert.equal(body.current.contentHash, createHash("sha256").update(published[0].release.runtimeBody).digest("hex"));

  const read = await handler(request("GET", undefined, { version: "3", releaseId: body.current.releaseId }));
  assert.equal(read.statusCode, 200);
  const reopened = JSON.parse(read.body).release;
  assert.equal(reopened.runtimeBody, published[0].release.runtimeBody);
  assert.deepEqual(reopened.authoringPackage, loadedAuthoringPackage);

  const restored = await handler(request("POST", { action: "restore", releaseId: body.current.releaseId, baseRevisions: { devices: 1, calculatedFields: 1, systemFields: 1, events: 1 } }));
  assert.equal(restored.statusCode, 200);
  const restoredBody = JSON.parse(restored.body);
  assert.deepEqual(restoredBody.draft.revisions, { devices: 2, calculatedFields: 2, systemFields: 2, events: 2 });
  assert.deepEqual({ schemaVersion: 3, devices: restoredBody.draft.devices, calculatedFields: restoredBody.draft.calculatedFields, systemFields: restoredBody.draft.systemFields, events: restoredBody.draft.events }, loadedAuthoringPackage);
  assert.equal(restoredBody.draft.events[0].web.notifyOnClose, false);
});

test("V3 endpoint delivers only an execution-disabled staging pointer without constructing the V2 factory", async () => {
  const delivered = [];
  const harnessed = harness({ createV3Delivery: () => ({ async publishPointer(metadata) { delivered.push(metadata); } }) });
  const published = JSON.parse((await harnessed.handler(request("POST", { action: "publish", basePackageVersion: 0 }))).body);
  const result = await harnessed.handler(request("POST", { action: "deliver", releaseId: published.current.releaseId }));
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.current.deliveryEnabled, true);
  assert.equal(body.current.executionEnabled, false);
  assert.equal(body.metadata.executionEnabled, false);
  assert.equal(body.metadata.downloadPath, `/.netlify/functions/rules-engine-release?version=3&releaseId=${published.current.releaseId}`);
  assert.equal(delivered.length, 1);
  assert.equal(harnessed.deliveryFactoryCalls, 0);
});

test("V3 Boolean working field is compiled, published, reopened, and restored", async () => {
  const { handler, published } = harness();
  const loaded = JSON.parse((await handler(request("GET"))).body);
  const systemFields = structuredClone(loaded.draft.systemFields);
  systemFields.push({
    id: "working-commissioning-hold",
    systemName: "CommissioningHold",
    label: "Commissioning hold",
    source: "session",
    runtimeRole: "working",
    type: "boolean",
    unit: null,
    initialValue: false,
    logging: { mode: "change" },
    assignmentTarget: true
  });
  const events = structuredClone(loaded.draft.events);
  const highVoltage = events.find(event => event.id === "E007");
  highVoltage.opening.trigger.condition.clauses.push({ field: "CommissioningHold", operator: "eq", value: false });
  highVoltage.onOpen.assignments.push({ target: "CommissioningHold", value: true, ownership: "transition" });

  assert.equal((await handler(request("PUT", { section: "systemFields", baseRevision: 1, items: systemFields }))).statusCode, 200);
  assert.equal((await handler(request("PUT", { section: "events", baseRevision: 1, items: events }))).statusCode, 200);
  const validation = await handler(request("POST", { action: "validate" }));
  assert.equal(validation.statusCode, 200);
  assert.equal(JSON.parse(validation.body).runtimePackage.systemFields.find(field => field.systemName === "CommissioningHold").initialValue, false);

  const publishedResponse = await handler(request("POST", { action: "publish", basePackageVersion: 0 }));
  assert.equal(publishedResponse.statusCode, 201);
  const body = JSON.parse(publishedResponse.body);
  assert.equal(published.length, 1);
  assert.equal(published[0].release.authoringPackage.systemFields.find(field => field.systemName === "CommissioningHold").assignmentTarget, true);
  assert.deepEqual(JSON.parse(published[0].release.runtimeBody).events.find(event => event.id === "E007").onOpen.assignments.at(-1), { target: "CommissioningHold", value: true, ownership: "transition" });

  const reopened = JSON.parse((await handler(request("GET", undefined, { version: "3", releaseId: body.current.releaseId }))).body).release;
  assert.deepEqual(reopened.authoringPackage.systemFields.find(field => field.systemName === "CommissioningHold"), systemFields.at(-1));
  const restored = await handler(request("POST", { action: "restore", releaseId: body.current.releaseId, baseRevisions: { devices: 1, calculatedFields: 1, systemFields: 2, events: 2 } }));
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(JSON.parse(restored.body).draft.systemFields.find(field => field.systemName === "CommissioningHold"), systemFields.at(-1));
});
