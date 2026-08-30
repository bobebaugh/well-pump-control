"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { defaults } = require("../cloud/netlify/lib/rules-engine-v3-defaults");
const { createRulesEngineV3Store } = require("../cloud/netlify/lib/rules-engine-v3-store");

function fakeFirestore() {
  const values = new Map();
  class Reference {
    constructor(path) { this.path = path; }
    collection(name) { return new Collection(`${this.path}/${name}`); }
    async get() { return snapshot(this.path); }
    async set(value) { values.set(this.path, structuredClone(value)); }
    async create(value) { if (values.has(this.path)) throw new Error("already_exists"); values.set(this.path, structuredClone(value)); }
  }
  class Collection {
    constructor(path) { this.path = path; }
    doc(id) { return new Reference(`${this.path}/${id}`); }
    orderBy(field, direction) {
      return { get: async () => ({ docs: [...values.keys()].filter(path => path.startsWith(`${this.path}/`) && !path.slice(this.path.length + 1).includes("/")).map(snapshot).sort((a, b) => (a.data()[field] - b.data()[field]) * (direction === "desc" ? -1 : 1)) }) };
    }
  }
  function snapshot(path) { return { id: path.split("/").at(-1), exists: values.has(path), data: () => structuredClone(values.get(path)) }; }
  const db = {
    collection(name) { return new Collection(name); },
    async runTransaction(callback) {
      const writes = [];
      const result = await callback({
        get: async reference => snapshot(reference.path),
        create: (reference, value) => writes.push(["create", reference.path, value]),
        set: (reference, value) => writes.push(["set", reference.path, value])
      });
      writes.forEach(([operation, path, value]) => { if (operation === "create" && values.has(path)) throw new Error("already_exists"); values.set(path, structuredClone(value)); });
      return result;
    }
  };
  return { db, values };
}

test("V3 store seeds, saves, publishes, reopens, and restores only V3 Firestore names", async () => {
  const { db, values } = fakeFirestore();
  const store = createRulesEngineV3Store({ firebase: { getPilotFirestore: () => ({ db }) } });
  const seeded = await store.loadOrSeed(defaults(), 100);
  assert.deepEqual(seeded.draft.revisions, { devices: 1, calculatedFields: 1, systemFields: 1, events: 1 });
  assert.equal(values.has("sites/well-main/rulesEngineDraft/devices"), false);
  assert.equal(values.has("sites/well-main/rulesEngineV3Draft/devices"), true);

  const systemFields = structuredClone(seeded.draft.systemFields);
  systemFields[0].label = "Restored operating mode";
  assert.equal(await store.saveSection("systemFields", 1, systemFields, 110), 2);
  const saved = await store.loadOrSeed(defaults(), 120);
  const runtimeBody = "{\"schemaVersion\":3}";
  const state = { schemaVersion: 3, packageVersion: 1, releaseId: "20260830123456-event-v3-v1", contentHash: "a".repeat(64), publishedAtMs: 120, deliveryEnabled: false };
  await store.publish(0, saved.draft.revisions, state.releaseId, { ...state, authoringPackage: saved.draft, runtimeBody }, state);
  assert.equal((await store.getRelease(state.releaseId)).runtimePackage.schemaVersion, 3);
  assert.equal(values.has(`sites/well-main/rulesEngineV3Releases/${state.releaseId}`), true);
  assert.equal(values.has(`sites/well-main/rulesEngineReleases/${state.releaseId}`), false);

  const restored = await store.restoreRelease(state.releaseId, saved.draft.revisions, 130);
  assert.equal(restored.systemFields[0].label, "Restored operating mode");
  assert.deepEqual(restored.revisions, { devices: 2, calculatedFields: 2, systemFields: 3, events: 2 });
});
