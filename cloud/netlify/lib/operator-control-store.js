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
// aborted well inside that, and the whole endpoint operation shares a budget,
// so an authentication or connectivity failure returns a reportable outcome
// instead of an empty 502.
const REQUEST_TIMEOUT_MS = 6000;
const TOTAL_BUDGET_MS = 20000;
// Renew before the exchange's own expiry rather than caching for the life of
// the container.
const TOKEN_RENEWAL_MARGIN_MS = 60000;
const DEFAULT_TOKEN_LIFETIME_MS = 3600000;
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

// The timeout covers the complete operation, including body consumption. A
// response whose headers arrive and whose body then stalls is still bounded.
async function boundedJson(fetchImpl, url, options, stage, settings) {
  const { indeterminateOnFailure = false, requireBody = true, remainingMs, timeoutMs } = settings;
  const budget = Math.min(timeoutMs, remainingMs());
  if (budget <= 0) {
    throw new OperatorControlTransportError(`${stage}_timeout`, stage, false);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      const aborted = error?.name === "AbortError";
      throw new OperatorControlTransportError(
        aborted ? `${stage}_timeout` : `${stage}_unreachable`, stage, indeterminateOnFailure);
    }
    // Headers arrived, so the status is authoritative from here on. A stalled
    // body can never turn a definitive write rejection into an unknown outcome.
    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      if (error?.name === "AbortError" && requireBody) {
        throw new OperatorControlTransportError(`${stage}_timeout`, stage, false);
      }
      body = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      etag: response.headers.get("etag"),
      body
    };
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
  const requestTimeoutMs = dependencies.requestTimeoutMs || REQUEST_TIMEOUT_MS;
  const totalBudgetMs = dependencies.totalBudgetMs || TOTAL_BUDGET_MS;
  // Elapsed time is real time, independent of the injected command clock.
  const elapsed = dependencies.monotonic || (() => Date.now());
  let cachedToken = null;
  let exchangeInFlight = null;

  function newBudget() {
    const endsAt = elapsed() + totalBudgetMs;
    return () => endsAt - elapsed();
  }

  function invalidateToken() {
    cachedToken = null;
    exchangeInFlight = null;
  }

  // An explicit authentication rejection must not be served from cache on the
  // next request, or the function stays broken until the container recycles.
  function failIfDenied(result, stage) {
    if (result.status === 401 || result.status === 403) invalidateToken();
  }

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
  async function operatorToken(webApiKey, remainingMs) {
    if (cachedToken && elapsed() < cachedToken.renewAtMs) return cachedToken.idToken;
    if (!exchangeInFlight) {
      exchangeInFlight = (async () => {
        const { auth, projectId } = authProvider();
        if (projectId !== "well-pump-control") {
          throw new OperatorControlConfigurationError("Firebase Auth project is not approved");
        }
        const customToken = await auth.createCustomToken(OPERATOR_UID, OPERATOR_CLAIMS);
        const result = await boundedJson(
          fetchImpl,
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(webApiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: customToken, returnSecureToken: true })
          },
          "token-exchange",
          { remainingMs, timeoutMs: requestTimeoutMs }
        );
        if (!result.ok || typeof result.body?.idToken !== "string") {
          throw new OperatorControlTransportError("operator_token_exchange_failed", "token-exchange");
        }
        // expiresIn is seconds as a string. Renew ahead of it so a request
        // never carries a token that expires mid-operation.
        const seconds = Number(result.body.expiresIn);
        const lifetimeMs = Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
        cachedToken = {
          idToken: result.body.idToken,
          renewAtMs: elapsed() + Math.max(lifetimeMs - TOKEN_RENEWAL_MARGIN_MS, Math.floor(lifetimeMs / 2))
        };
        return cachedToken.idToken;
      })().finally(() => { exchangeInFlight = null; });
    }
    return exchangeInFlight;
  }

  function childUrl(rtdbUrl, token, child) {
    return `${rtdbUrl}/${DEVICE_PATH}/${child}.json?auth=${encodeURIComponent(token)}`;
  }

  async function readChild(rtdbUrl, token, child, remainingMs) {
    const result = await boundedJson(
      fetchImpl, childUrl(rtdbUrl, token, child), { method: "GET" }, "status-read",
      { remainingMs, timeoutMs: requestTimeoutMs });
    if (!result.ok) {
      failIfDenied(result, "status-read");
      throw new OperatorControlTransportError(
        `status_read_http_${result.status}`, "status-read");
    }
    return result.body;
  }

  async function readSnapshot(remainingMs) {
    const { rtdbUrl, webApiKey } = configuration();
    const token = await operatorToken(webApiKey, remainingMs);
    const [control, presence, rulesV3State, currentObservation] = await Promise.all([
      readChild(rtdbUrl, token, "operatorControl", remainingMs),
      readChild(rtdbUrl, token, "presence", remainingMs),
      readChild(rtdbUrl, token, "rulesV3State", remainingMs),
      readChild(rtdbUrl, token, "currentObservation", remainingMs)
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
    const remainingMs = newBudget();
    const requestedAtMs = now();
    const initial = await readSnapshot(remainingMs);
    if (!freshPresence(initial.presence, requestedAtMs)) {
      return { issued: false, code: "device-presence-not-fresh", snapshot: initial };
    }
    const { rtdbUrl, webApiKey } = configuration();
    const token = await operatorToken(webApiKey, remainingMs);
    const url = childUrl(rtdbUrl, token, "operatorControl/command");

    // Compare-and-set on the command node alone. The result node stays
    // device-owned, and the ETag makes a concurrent issue fail rather than
    // silently reuse a command sequence.
    const currentResult = await boundedJson(
      fetchImpl, url, { method: "GET", headers: { "X-Firebase-ETag": "true" } },
      "command-read", { remainingMs, timeoutMs: requestTimeoutMs });
    const current = currentResult.body;
    if (!currentResult.ok) {
      failIfDenied(currentResult, "command-read");
      throw new OperatorControlTransportError(
        `command_read_http_${currentResult.status}`, "command-read");
    }
    const etag = currentResult.etag;
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
    // requireBody is false: once RTDB answers, its status decides the outcome,
    // so a slow body cannot downgrade a definitive result to unknown. Only a
    // write that never returned headers is indeterminate, and it is never
    // replayed automatically.
    const write = await boundedJson(fetchImpl, url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify(command)
    }, "command-write", {
      remainingMs, timeoutMs: requestTimeoutMs,
      indeterminateOnFailure: true, requireBody: false
    });
    if (write.status === 412) {
      return { issued: false, code: "command-write-conflict", snapshot: initial };
    }
    if (!write.ok) {
      failIfDenied(write, "command-write");
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
    status: async () => deriveOperatorStatus(await readSnapshot(newBudget()), now())
  };
}

module.exports = {
  DEVICE_PATH,
  OPERATOR_UID,
  OperatorControlTransportError,
  createOperatorControlStore
};
