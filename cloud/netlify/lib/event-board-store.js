"use strict";

const { stableJson } = require("./ingest-record-contract");
const { reduceEventBoard } = require("./event-board-reducer");
const { releaseNotificationPolicy } = require("./event-notification-criteria");

class EventBoardStoreError extends Error {
  constructor(code) { super(code); this.name = "EventBoardStoreError"; this.code = code; }
}

function historyIdentity(record) {
  const copy = JSON.parse(JSON.stringify(record));
  delete copy.firstReportedAt;
  delete copy.detectedAt;
  delete copy.restartDetectedAt;
  delete copy.notification;
  return copy;
}

function createEventBoardStore(db, siteId, deviceId) {
  const site = db.collection("sites").doc(siteId);
  const projectionRef = site.collection("eventBoardState").doc(deviceId);
  const history = site.collection("eventRecords");
  const releases = site.collection("rulesEngineV3Releases");
  return {
    async reconcile(board, receivedAt) {
      return db.runTransaction(async transaction => {
        const storedSnapshot = await transaction.get(projectionRef);
        const outcome = reduceEventBoard(
          storedSnapshot.exists ? storedSnapshot.data() : null, board, receivedAt);
        if (outcome.conflict) throw new EventBoardStoreError(outcome.decision);
        if (!outcome.changed) return outcome;

        const recordRefs = outcome.records.map(record => history.doc(record.recordId));
        const existing = [];
        for (const reference of recordRefs) existing.push(await transaction.get(reference));
        outcome.records.forEach((record, index) => {
          if (existing[index].exists) {
            if (stableJson(historyIdentity(existing[index].data())) !==
                stableJson(historyIdentity(record))) {
              throw new EventBoardStoreError("history_conflict");
            }
          } else {
            transaction.create(recordRefs[index], record);
          }
        });
        transaction.set(projectionRef, outcome.projection);
        return outcome;
      });
    },
    // Delivery outcome for a record that has already been committed. Best effort and
    // never part of the transaction: it exists so a failed send is visible beside the
    // event it belongs to, not so anything can depend on it. historyIdentity ignores the
    // field, so a later recomputation of the same record still compares equal.
    // Each record's notification settings from the release it names, read once per release
    // and outside the transaction. Any failure reads as null, which is the table fallback:
    // a Firestore problem must never mean no notification.
    async notificationPolicies(records) {
      const loaded = new Map();
      for (const record of records) {
        const releaseId = record?.rulesRelease?.releaseId;
        if (typeof releaseId !== "string" || !releaseId || loaded.has(releaseId)) continue;
        loaded.set(releaseId, releases.doc(releaseId).get()
          .then(snapshot => (snapshot.exists ? snapshot.data() : null), () => null));
      }
      return Promise.all(records.map(async record => releaseNotificationPolicy(
        await loaded.get(record?.rulesRelease?.releaseId), record)));
    },
    async markNotified(outcomes) {
      const written = await Promise.all(outcomes.map(outcome => history.doc(outcome.recordId)
        .update({ notification: outcome.notification }).then(() => true, () => false)));
      return { written: written.filter(Boolean).length, failed: written.filter(value => !value).length };
    }
  };
}

module.exports = { EventBoardStoreError, createEventBoardStore, historyIdentity };
