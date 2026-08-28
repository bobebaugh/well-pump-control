"use strict";

const SITE_ID = "well-main";
const SECTIONS = ["devices", "calculatedFields", "events"];

class RulesEngineStoreConflictError extends Error {
  constructor() { super("rules_engine_draft_changed"); this.name = "RulesEngineStoreConflictError"; }
}

class RulesEngineReleaseNotFoundError extends Error {
  constructor() { super("rules_engine_release_not_found"); this.name = "RulesEngineReleaseNotFoundError"; }
}

class RulesEngineIncompatibleReleaseError extends Error {
  constructor() { super("rules_engine_release_schema_incompatible"); this.name = "RulesEngineIncompatibleReleaseError"; }
}

function releaseSummary(snapshot) {
  const value = snapshot.data();
  return {
    releaseId: value.releaseId || snapshot.id,
    packageVersion: value.packageVersion,
    schemaVersion: value.schemaVersion,
    publishedAtMs: value.publishedAtMs,
    contentHash: value.contentHash,
    deliveryEnabled: value.deliveryEnabled === true,
    runtimeBytes: typeof value.runtimeBody === "string" ? Buffer.byteLength(value.runtimeBody, "utf8") : null
  };
}

function createRulesEngineStore(dependencies = {}) {
  const firebase = dependencies.firebase || require("./firebase");
  const { db } = firebase.getPilotFirestore();
  const site = db.collection("sites").doc(SITE_ID);
  const drafts = site.collection("rulesEngineDraft");
  const releases = site.collection("rulesEngineReleases");
  const state = site.collection("rulesEngineState").doc("current");

  return {
    async listReleases() {
      const snapshot = await releases.orderBy("packageVersion", "desc").get();
      return snapshot.docs.map(releaseSummary);
    },

    async getRelease(releaseId) {
      const snapshot = await releases.doc(releaseId).get();
      return snapshot.exists ? snapshot.data() : null;
    },

    async loadOrSeed(defaultDraft, nowMs) {
      const result = { schemaVersion: defaultDraft.schemaVersion, revisions: {} };
      for (const section of SECTIONS) {
        const reference = drafts.doc(section);
        let snapshot = await reference.get();
        if (!snapshot.exists || snapshot.data().schemaVersion !== defaultDraft.schemaVersion) {
          const seeded = { schemaVersion: 1, draftRevision: 1, updatedAtMs: nowMs, items: defaultDraft[section] };
          seeded.schemaVersion = defaultDraft.schemaVersion;
          if (snapshot.exists) await reference.set(seeded);
          else {
            try { await reference.create(seeded); }
            catch { /* Another request may have seeded the same document. */ }
          }
          snapshot = await reference.get();
        }
        if (!snapshot.exists) throw new Error("rules_engine_seed_failed");
        const data = snapshot.data();
        result[section] = data.items;
        result.revisions[section] = data.draftRevision;
      }
      const current = await state.get();
      return { draft: result, current: current.exists ? current.data() : null };
    },

    async saveSection(section, expectedRevision, items, nowMs) {
      if (!SECTIONS.includes(section)) throw new Error("invalid_rules_engine_section");
      const reference = drafts.doc(section);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists || snapshot.data().draftRevision !== expectedRevision) throw new RulesEngineStoreConflictError();
        const nextRevision = expectedRevision + 1;
        transaction.set(reference, { schemaVersion: 2, draftRevision: nextRevision, updatedAtMs: nowMs, items });
        return nextRevision;
      });
    },

    async publish(expectedPackageVersion, expectedRevisions, releaseId, release, stateValue) {
      return db.runTransaction(async transaction => {
        const current = await transaction.get(state);
        const actualVersion = current.exists ? current.data().packageVersion : 0;
        if (actualVersion !== expectedPackageVersion) throw new RulesEngineStoreConflictError();
        for (const section of SECTIONS) {
          const draft = await transaction.get(drafts.doc(section));
          if (!draft.exists || draft.data().draftRevision !== expectedRevisions[section]) throw new RulesEngineStoreConflictError();
        }
        transaction.create(releases.doc(releaseId), release);
        transaction.set(state, stateValue);
      });
    },

    async markDelivered(releaseId, contentHash, metadata, nowMs) {
      return db.runTransaction(async transaction => {
        const current = await transaction.get(state);
        if (!current.exists || current.data().releaseId !== releaseId ||
            current.data().contentHash !== contentHash) {
          throw new RulesEngineStoreConflictError();
        }
        const next = {
          ...current.data(),
          deliveryEnabled: true,
          deliveredAtMs: nowMs,
          delivery: metadata
        };
        transaction.set(state, next);
        return next;
      });
    },

    async restoreRelease(releaseId, expectedRevisions, nowMs) {
      const releaseReference = releases.doc(releaseId);
      return db.runTransaction(async transaction => {
        const releaseSnapshot = await transaction.get(releaseReference);
        if (!releaseSnapshot.exists) throw new RulesEngineReleaseNotFoundError();
        const authoringPackage = releaseSnapshot.data().authoringPackage;
        if (!authoringPackage || authoringPackage.schemaVersion !== 2 || SECTIONS.some(section => !Array.isArray(authoringPackage[section]))) {
          throw new RulesEngineIncompatibleReleaseError();
        }

        const snapshots = {};
        for (const section of SECTIONS) snapshots[section] = await transaction.get(drafts.doc(section));
        const revisions = {};
        for (const section of SECTIONS) {
          const actualRevision = snapshots[section].exists ? snapshots[section].data().draftRevision : 0;
          if (actualRevision !== expectedRevisions[section]) throw new RulesEngineStoreConflictError();
          revisions[section] = actualRevision + 1;
        }
        for (const section of SECTIONS) {
          transaction.set(drafts.doc(section), {
            schemaVersion: 2,
            draftRevision: revisions[section],
            updatedAtMs: nowMs,
            restoredFromReleaseId: releaseId,
            items: authoringPackage[section]
          });
        }
        return { schemaVersion: 2, revisions, ...Object.fromEntries(SECTIONS.map(section => [section, authoringPackage[section]])) };
      });
    }
  };
}

module.exports = {
  createRulesEngineStore,
  RulesEngineStoreConflictError,
  RulesEngineReleaseNotFoundError,
  RulesEngineIncompatibleReleaseError,
  SECTIONS
};
