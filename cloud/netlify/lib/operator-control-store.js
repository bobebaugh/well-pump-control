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

function createOperatorControlStore(dependencies = {}) {
  const databaseProvider = dependencies.getPilotDatabase || getPilotDatabase;
  const now = dependencies.now || (() => Date.now());
  const nonce = dependencies.nonce || (() => randomBytes(12).toString("hex"));

  async function readSnapshot() {
    const { database, projectId } = databaseProvider();
    if (projectId !== "well-pump-control") throw new Error("unapproved_project");
    const root = database.ref(DEVICE_PATH);
    const [control, presence, rulesV3State, currentObservation] = await Promise.all([
      root.child("operatorControl").once("value"),
      root.child("presence").once("value"),
      root.child("rulesV3State").once("value"),
      root.child("currentObservation").once("value")
    ]);
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
    const { database } = databaseProvider();
    const ref = database.ref(`${DEVICE_PATH}/operatorControl`);
    let busy = false;
    let idempotent = false;
    const transaction = await ref.transaction(current => {
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
