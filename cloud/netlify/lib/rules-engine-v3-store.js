"use strict";

const SITE_ID = "well-main";
const SECTIONS = ["devices", "calculatedFields", "systemFields", "events"];

class RulesEngineV3StoreConflictError extends Error {
  constructor() { super("rules_engine_v3_draft_changed"); this.name = "RulesEngineV3StoreConflictError"; }
}
class RulesEngineV3ReleaseNotFoundError extends Error {
  constructor() { super("rules_engine_v3_release_not_found"); this.name = "RulesEngineV3ReleaseNotFoundError"; }
}
class RulesEngineV3IncompatibleReleaseError extends Error {
  constructor() { super("rules_engine_v3_release_schema_incompatible"); this.name = "RulesEngineV3IncompatibleReleaseError"; }
}

function releaseSummary(snapshot) {
  const value = snapshot.data();
  return {
    releaseId: value.releaseId || snapshot.id,
    packageVersion: value.packageVersion,
    schemaVersion: value.schemaVersion,
    publishedAtMs: value.publishedAtMs,
    contentHash: value.contentHash,
    deliveryEnabled: false,
    runtimeBytes: typeof value.runtimeBody === "string" ? Buffer.byteLength(value.runtimeBody, "utf8") : null
  };
}
function hydrateRuntimePackage(value) {
  if (!value || typeof value.runtimeBody !== "string") return value;
  try { return { ...value, runtimePackage: JSON.parse(value.runtimeBody) }; }
  catch { return value; }
}

function createRulesEngineV3Store(dependencies = {}) {
  const firebase = dependencies.firebase || require("./firebase");
  const { db } = firebase.getPilotFirestore();
  const site = db.collection("sites").doc(SITE_ID);
  // V3 authoring state is intentionally separate from V2.  Checkpoint 1 must
  // be incapable of reseeding or restoring V2 authoring documents.
  const drafts = site.collection("rulesEngineV3Draft");
  const releases = site.collection("rulesEngineV3Releases");
  const state = site.collection("rulesEngineV3State").doc("current");

  return {
    async listReleases() {
      const snapshot = await releases.orderBy("packageVersion", "desc").get();
      return snapshot.docs.map(releaseSummary);
    },
    async getRelease(releaseId) {
      const snapshot = await releases.doc(releaseId).get();
      return snapshot.exists ? hydrateRuntimePackage(snapshot.data()) : null;
    },
    async loadOrSeed(defaultDraft, nowMs) {
      const result = { schemaVersion: 3, revisions: {} };
      for (const section of SECTIONS) {
        const reference = drafts.doc(section);
        let snapshot = await reference.get();
        if (!snapshot.exists || snapshot.data().schemaVersion !== 3) {
          const seeded = { schemaVersion: 3, draftRevision: 1, updatedAtMs: nowMs, items: defaultDraft[section] };
          if (snapshot.exists) await reference.set(seeded);
          else { try { await reference.create(seeded); } catch { /* concurrent seed */ } }
          snapshot = await reference.get();
        }
        if (!snapshot.exists) throw new Error("rules_engine_v3_seed_failed");
        const data = snapshot.data();
        result[section] = data.items;
        result.revisions[section] = data.draftRevision;
      }
      const current = await state.get();
      return { draft: result, current: current.exists ? current.data() : null };
    },
    async saveSection(section, expectedRevision, items, nowMs) {
      if (!SECTIONS.includes(section)) throw new Error("invalid_rules_engine_v3_section");
      const reference = drafts.doc(section);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists || snapshot.data().draftRevision !== expectedRevision) throw new RulesEngineV3StoreConflictError();
        const nextRevision = expectedRevision + 1;
        transaction.set(reference, { schemaVersion: 3, draftRevision: nextRevision, updatedAtMs: nowMs, items });
        return nextRevision;
      });
    },
    async publish(expectedPackageVersion, expectedRevisions, releaseId, release, stateValue) {
      return db.runTransaction(async transaction => {
        const current = await transaction.get(state);
        const actualVersion = current.exists ? current.data().packageVersion : 0;
        if (actualVersion !== expectedPackageVersion) throw new RulesEngineV3StoreConflictError();
        for (const section of SECTIONS) {
          const draft = await transaction.get(drafts.doc(section));
          if (!draft.exists || draft.data().draftRevision !== expectedRevisions[section]) throw new RulesEngineV3StoreConflictError();
        }
        transaction.create(releases.doc(releaseId), release);
        transaction.set(state, stateValue);
      });
    },
    async restoreRelease(releaseId, expectedRevisions, nowMs) {
      const reference = releases.doc(releaseId);
      return db.runTransaction(async transaction => {
        const releaseSnapshot = await transaction.get(reference);
        if (!releaseSnapshot.exists) throw new RulesEngineV3ReleaseNotFoundError();
        const authoringPackage = releaseSnapshot.data().authoringPackage;
        if (!authoringPackage || authoringPackage.schemaVersion !== 3 || SECTIONS.some(section => !Array.isArray(authoringPackage[section]))) throw new RulesEngineV3IncompatibleReleaseError();
        const snapshots = {};
        for (const section of SECTIONS) snapshots[section] = await transaction.get(drafts.doc(section));
        const revisions = {};
        for (const section of SECTIONS) {
          const actual = snapshots[section].exists ? snapshots[section].data().draftRevision : 0;
          if (actual !== expectedRevisions[section]) throw new RulesEngineV3StoreConflictError();
          revisions[section] = actual + 1;
        }
        for (const section of SECTIONS) transaction.set(drafts.doc(section), {
          schemaVersion: 3,
          draftRevision: revisions[section],
          updatedAtMs: nowMs,
          restoredFromReleaseId: releaseId,
          items: authoringPackage[section]
        });
        return { schemaVersion: 3, revisions, ...Object.fromEntries(SECTIONS.map(section => [section, authoringPackage[section]])) };
      });
    }
  };
}

module.exports = {
  RulesEngineV3IncompatibleReleaseError,
  RulesEngineV3ReleaseNotFoundError,
  RulesEngineV3StoreConflictError,
  SECTIONS,
  _hydrateRuntimePackage: hydrateRuntimePackage,
  createRulesEngineV3Store
};
