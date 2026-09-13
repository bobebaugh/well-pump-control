"use strict";

const { randomBytes } = require("node:crypto");
const { getPilotDatabase } = require("./firebase");
const {
  buildOperatorCommand,
  deriveOperatorStatus,
  freshPresence
} = require("./operator-control-contract");

const DEVICE_PATH = "v1/sites/well-main/devices/tab5-well-main";

function valueOf(snapshot) {
  return snapshot && typeof snapshot.val === "function" ? snapshot.val() : null;
}

function annotateStage(error, stage) {
  if (error && typeof error === "object" && !error.operatorControlStage) {
    error.operatorControlStage = stage;
  }
  throw error;
}

function databaseAtStage(provider) {
  try { return provider(); }
  catch (error) { annotateStage(error, "database-initialization"); }
}

function createOperatorControlStore(dependencies = {}) {
  const databaseProvider = dependencies.getPilotDatabase || getPilotDatabase;
  const now = dependencies.now || (() => Date.now());
  const nonce = dependencies.nonce || (() => randomBytes(12).toString("hex"));

  async function readSnapshot() {
    const { database, projectId } = databaseAtStage(databaseProvider);
    if (projectId !== "well-pump-control") throw new Error("unapproved_project");
    const root = database.ref(DEVICE_PATH);
    let snapshots;
    try {
      snapshots = await Promise.all([
        root.child("operatorControl").once("value"),
        root.child("presence").once("value"),
        root.child("rulesV3State").once("value"),
        root.child("currentObservation").once("value")
      ]);
    } catch (error) { annotateStage(error, "status-read"); }
    const [control, presence, rulesV3State, currentObservation] = snapshots;
    const controlValue = valueOf(control) || {};
    return {
      command: controlValue.command || null,
      result: controlValue.result || null,
      sequence: controlValue.sequence || 0,
      presence: valueOf(presence),
      rulesV3State: valueOf(rulesV3State),
      currentObservation: valueOf(currentObservation)
    };
  }

  async function issue(request) {
    const requestedAtMs = now();
    const initial = await readSnapshot();
    if (!freshPresence(initial.presence, requestedAtMs)) {
      return { issued: false, code: "device-presence-not-fresh", snapshot: initial };
    }
    const { database } = databaseAtStage(databaseProvider);
    const ref = database.ref(`${DEVICE_PATH}/operatorControl`);
    let busy = false;
    let idempotent = false;
    let transaction;
    try {
      transaction = await ref.transaction(current => {
        const value = current && typeof current === "object" ? current : {};
        if (value.command?.clientRequestId === request.clientRequestId) {
          idempotent = true;
          return value;
        }
        const matching = value.result && value.command &&
          value.result.commandId === value.command.commandId;
        const terminal = matching && ["not-delivered", "confirmed-completed", "failed", "unknown"].includes(value.result.outcome);
        if (value.command && value.command.expiresAtMs >= requestedAtMs && !terminal) {
          busy = true;
          return;
        }
        const commandSequence = Number.isInteger(value.sequence) ? value.sequence + 1 : 1;
        const command = buildOperatorCommand(request, {
          commandId: `op_${nonce()}`,
          commandSequence,
          targetSessionId: initial.presence.sessionId,
          requestedAtMs
        });
        return { sequence: commandSequence, command, result: null };
      }, undefined, false);
    } catch (error) { annotateStage(error, "command-write"); }
    if (!transaction.committed) {
      return { issued: false, code: busy ? "command-already-active" : "command-write-conflict", snapshot: initial };
    }
    const value = valueOf(transaction.snapshot) || {};
    return {
      issued: true,
      idempotent,
      snapshot: { ...initial, command: value.command, result: value.result || null, sequence: value.sequence }
    };
  }

  return {
    issue,
    status: async () => deriveOperatorStatus(await readSnapshot(), now())
  };
}

module.exports = { DEVICE_PATH, createOperatorControlStore };
