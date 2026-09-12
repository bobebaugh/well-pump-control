"use strict";

const { stableJson } = require("./ingest-record-contract");
const { reduceEventBoard } = require("./event-board-reducer");

class EventBoardStoreError extends Error {
  constructor(code) { super(code); this.name = "EventBoardStoreError"; this.code = code; }
}

function historyIdentity(record) {
  const copy = JSON.parse(JSON.stringify(record));
  delete copy.firstReportedAt;
  delete copy.detectedAt;
  delete copy.restartDetectedAt;
  return copy;
}

function createEventBoardStore(db, siteId, deviceId) {
  const site = db.collection("sites").doc(siteId);
  const projectionRef = site.collection("eventBoardState").doc(deviceId);
  const history = site.collection("eventRecords");
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
    }
  };
}

module.exports = { EventBoardStoreError, createEventBoardStore, historyIdentity };
