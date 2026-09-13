"use strict";

const { randomBytes } = require("node:crypto");
const { _approvedRtdbUrl } = require("./rules-store");
const {
  buildOperatorCommand,
  deriveOperatorStatus,
  freshPresence
} = require("./operator-control-contract");

const DEVICE_PATH = "v1/sites/well-main/devices/tab5-well-main";
const OPERATOR_UID = "netlify-operator-control";
const OPERATOR_CLAIMS = {
  siteId: "well-main",
  deviceId: "tab5-well-main",
  purpose: "operator-control"
};
// Netlify terminates a function at 30s. Every backend call is individually
// aborted well inside that, so an authentication or connectivity failure
// returns a reportable outcome instead of an empty 502.
const REQUEST_TIMEOUT_MS = 6000;
const TERMINAL_OUTCOMES = ["not-delivered", "confirmed-completed", "failed", "unknown"];

class OperatorControlTransportError extends Error {
  constructor(code, stage, commandMayHaveBeenWritten = false) {
    super(code);
    this.name = "OperatorControlTransportError";
    this.code = code;
    this.operatorControlStage = stage;
    // Only an aborted or failed command PUT is indeterminate. A rejected
    // request that produced an HTTP status did not apply.
    this.commandMayHaveBeenWritten = commandMayHaveBeenWritten === true;
  }
}

class OperatorControlConfigurationError extends Error {
  constructor(message) { super(message); this.name = "ConfigurationError"; }
}

async function boundedFetch(fetchImpl, url, options, stage, indeterminateOnFailure) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    const aborted = error?.name === "AbortError";
    throw new OperatorControlTransportError(
      aborted ? `${stage}_timeout` : `${stage}_unreachable`,
      stage,
      indeterminateOnFailure
    );
  } finally {
    clearTimeout(timer);
  }
}

function createOperatorControlStore(dependencies = {}) {
  const env = dependencies.env || process.env;
  const firebase = dependencies.firebase || require("./firebase");
  const authProvider = dependencies.getPilotAuth || firebase.getPilotAuth;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || (() => Date.now());
  const nonce = dependencies.nonce || (() => randomBytes(12).toString("hex"));
  let idTokenPromise;

  // Resolved lazily so a missing variable is a reported configuration failure
  // rather than a module that cannot load.
  function configuration() {
    if (!env.FIREBASE_WEB_API_KEY || !env.FIREBASE_RTDB_URL) {
      throw new OperatorControlConfigurationError("FIREBASE_WEB_API_KEY and FIREBASE_RTDB_URL are required");
    }
    return { rtdbUrl: _approvedRtdbUrl(env.FIREBASE_RTDB_URL), webApiKey: env.FIREBASE_WEB_API_KEY };
  }

  // Same proven identity exchange the rules publisher and event-board mirror
  // use: a purpose-scoped custom token traded for an ID token, then RTDB REST.
  // The device path is reached under published security rules, not through an
  // Admin SDK privilege bypass.
  async function operatorToken(webApiKey) {
    if (!idTokenPromise) {
      idTokenPromise = (async () => {
        const { auth, projectId } = authProvider();
        if (projectId !== "well-pump-control") {
          throw new OperatorControlConfigurationError("Firebase Auth project is not approved");
        }
        const customToken = await auth.createCustomToken(OPERATOR_UID, OPERATOR_CLAIMS);
        const response = await boundedFetch(
          fetchImpl,
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(webApiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: customToken, returnSecureToken: true })
          },
          "token-exchange",
          false
        );
        const body = await response.json().catch(() => null);
        if (!response.ok || typeof body?.idToken !== "string") {
          throw new OperatorControlTransportError("operator_token_exchange_failed", "token-exchange");
        }
        return body.idToken;
      })().catch(error => { idTokenPromise = undefined; throw error; });
    }
    return idTokenPromise;
  }

  function childUrl(rtdbUrl, token, child) {
    return `${rtdbUrl}/${DEVICE_PATH}/${child}.json?auth=${encodeURIComponent(token)}`;
  }

  async function readChild(rtdbUrl, token, child) {
    const response = await boundedFetch(
      fetchImpl, childUrl(rtdbUrl, token, child), { method: "GET" }, "status-read", false);
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      throw new OperatorControlTransportError(
        `status_read_http_${response.status}`, "status-read");
    }
    return value;
  }

  async function readSnapshot() {
    const { rtdbUrl, webApiKey } = configuration();
    const token = await operatorToken(webApiKey);
    const [control, presence, rulesV3State, currentObservation] = await Promise.all([
      readChild(rtdbUrl, token, "operatorControl"),
      readChild(rtdbUrl, token, "presence"),
      readChild(rtdbUrl, token, "rulesV3State"),
      readChild(rtdbUrl, token, "currentObservation")
    ]);
    const controlValue = control && typeof control === "object" ? control : {};
    return {
      command: controlValue.command || null,
      result: controlValue.result || null,
      sequence: Number.isInteger(controlValue.sequence) ? controlValue.sequence : 0,
      presence,
      rulesV3State,
      currentObservation
    };
  }

  async function issue(request) {
    const requestedAtMs = now();
    const initial = await readSnapshot();
    if (!freshPresence(initial.presence, requestedAtMs)) {
      return { issued: false, code: "device-presence-not-fresh", snapshot: initial };
    }
    const { rtdbUrl, webApiKey } = configuration();
    const token = await operatorToken(webApiKey);
    const url = childUrl(rtdbUrl, token, "operatorControl/command");

    // Compare-and-set on the command node alone. The result node stays
    // device-owned, and the ETag makes a concurrent issue fail rather than
    // silently reuse a command sequence.
    const currentResponse = await boundedFetch(
      fetchImpl, url, { method: "GET", headers: { "X-Firebase-ETag": "true" } }, "command-read", false);
    const current = await currentResponse.json().catch(() => null);
    if (!currentResponse.ok) {
      throw new OperatorControlTransportError(
        `command_read_http_${currentResponse.status}`, "command-read");
    }
    const etag = currentResponse.headers.get("etag");
    if (!etag) throw new OperatorControlTransportError("command_etag_missing", "command-read");

    if (current && current.clientRequestId === request.clientRequestId) {
      return { issued: true, idempotent: true, snapshot: { ...initial, command: current } };
    }
    const matching = initial.result && current &&
      initial.result.commandId === current.commandId;
    const terminal = matching && TERMINAL_OUTCOMES.includes(initial.result.outcome);
    if (current && current.expiresAtMs >= requestedAtMs && !terminal) {
      return { issued: false, code: "command-already-active", snapshot: initial };
    }
    // The stored command carries the high-water mark. The legacy sequence node
    // is still honored so numbering cannot go backwards across this change.
    const commandSequence = Math.max(
      Number.isInteger(current?.commandSequence) ? current.commandSequence : 0,
      initial.sequence
    ) + 1;
    const command = buildOperatorCommand(request, {
      commandId: `op_${nonce()}`,
      commandSequence,
      targetSessionId: initial.presence.sessionId,
      requestedAtMs
    });
    const write = await boundedFetch(fetchImpl, url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify(command)
    }, "command-write", true);
    await write.json().catch(() => null);
    if (write.status === 412) {
      return { issued: false, code: "command-write-conflict", snapshot: initial };
    }
    if (!write.ok) {
      throw new OperatorControlTransportError(
        `command_write_http_${write.status}`, "command-write");
    }
    return {
      issued: true,
      idempotent: false,
      snapshot: { ...initial, command, sequence: commandSequence }
    };
  }

  return {
    issue,
    status: async () => deriveOperatorStatus(await readSnapshot(), now())
  };
}

module.exports = {
  DEVICE_PATH,
  OPERATOR_UID,
  OperatorControlTransportError,
  createOperatorControlStore
};
