"use strict";

const SITE_ID = "well-main";
const SECTIONS = ["devices", "calculatedFields", "events"];

class RulesEngineStoreConflictError extends Error {
  constructor() { super("rules_engine_draft_changed"); this.name = "RulesEngineStoreConflictError"; }
}

function createRulesEngineStore(dependencies = {}) {
  const firebase = dependencies.firebase || require("./firebase");
  const { db } = firebase.getPilotFirestore();
  const site = db.collection("sites").doc(SITE_ID);
  const drafts = site.collection("rulesEngineDraft");
  const releases = site.collection("rulesEngineReleases");
  const state = site.collection("rulesEngineState").doc("current");

  return {
    async loadOrSeed(defaultDraft, nowMs) {
      const result = { schemaVersion: 1, revisions: {} };
      for (const section of SECTIONS) {
        const reference = drafts.doc(section);
        let snapshot = await reference.get();
        if (!snapshot.exists) {
          const seeded = { schemaVersion: 1, draftRevision: 1, updatedAtMs: nowMs, items: defaultDraft[section] };
          try { await reference.create(seeded); }
          catch { /* Another request may have seeded the same document. */ }
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
        transaction.set(reference, { schemaVersion: 1, draftRevision: nextRevision, updatedAtMs: nowMs, items });
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
    }
  };
}

module.exports = { createRulesEngineStore, RulesEngineStoreConflictError, SECTIONS };
