"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { defaults } = require("../cloud/netlify/lib/rules-engine-defaults");
const { createRulesEngineStore, RulesEngineStoreConflictError } = require("../cloud/netlify/lib/rules-engine-store");

function fakeFirestore(initial) {
  const values = new Map(Object.entries(initial));
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
  }
  function snapshot(path) {
    return { exists: values.has(path), data: () => structuredClone(values.get(path)) };
  }
  const db = {
    collection(name) { return new Collection(name); },
    async runTransaction(callback) {
      const writes = [];
      const result = await callback({
        get: async reference => snapshot(reference.path),
        create: (reference, value) => writes.push(["create", reference.path, value]),
        set: (reference, value) => writes.push(["set", reference.path, value])
      });
      for (const [operation, path, value] of writes) {
        if (operation === "create" && values.has(path)) throw new Error("already_exists");
        values.set(path, structuredClone(value));
      }
      return result;
    }
  };
  return { db, values };
}

test("loading replaces first-iteration draft documents with schema-two defaults", async () => {
  const base = "sites/well-main/rulesEngineDraft";
  const { db, values } = fakeFirestore({
    [`${base}/devices`]: { schemaVersion: 1, draftRevision: 9, items: [] },
    [`${base}/calculatedFields`]: { schemaVersion: 1, draftRevision: 9, items: [] },
    [`${base}/events`]: { schemaVersion: 1, draftRevision: 9, items: [] }
  });
  const store = createRulesEngineStore({ firebase: { getPilotFirestore: () => ({ db }) } });
  const loaded = await store.loadOrSeed(defaults(), 123);
  assert.equal(loaded.draft.schemaVersion, 2);
  assert.deepEqual(loaded.draft.revisions, { devices: 1, calculatedFields: 1, events: 1 });
  assert.equal(loaded.draft.calculatedFields.filter(calculation => calculation.kind === "function").length, 1);
  assert.equal(values.get(`${base}/events`).schemaVersion, 2);
});

test("publication checks every draft revision in the same transaction", async () => {
  const base = "sites/well-main";
  const { db, values } = fakeFirestore({
    [`${base}/rulesEngineDraft/devices`]: { draftRevision: 2 },
    [`${base}/rulesEngineDraft/calculatedFields`]: { draftRevision: 3 },
    [`${base}/rulesEngineDraft/events`]: { draftRevision: 4 },
    [`${base}/rulesEngineState/current`]: { packageVersion: 7 }
  });
  const store = createRulesEngineStore({ firebase: { getPilotFirestore: () => ({ db }) } });
  const state = { packageVersion: 8 };
  await store.publish(7, { devices: 2, calculatedFields: 3, events: 4 }, "release-8", { ok: true }, state);
  assert.deepEqual(values.get(`${base}/rulesEngineReleases/release-8`), { ok: true });
  assert.deepEqual(values.get(`${base}/rulesEngineState/current`), state);

  await assert.rejects(
    store.publish(8, { devices: 1, calculatedFields: 3, events: 4 }, "release-9", {}, { packageVersion: 9 }),
    RulesEngineStoreConflictError
  );
  assert.equal(values.has(`${base}/rulesEngineReleases/release-9`), false);
});
