"use strict";

// The live observation, read from RTDB rather than Firestore.
//
// Tab5 mirrors its COMPLETE observation to
// v1/sites/well-main/devices/tab5-well-main/currentObservation on its own
// cadence, far faster than the 60s Firestore path this replaced. Everything the
// home screen shows live comes from here: pressure, power, voltage, power
// factor, meter validity, the Shelly 1 contacts, the pump badge and the health
// rows -- all from one record so they are the same instant rather than a state
// from one read sitting beside numbers from another.

const { _approvedRtdbUrl } = require("../lib/rules-store");
const { OPERATOR_UID } = require("../lib/operator-control-store");

// The RTDB rules grant read on currentObservation to exactly one cloud identity:
//
//   .read = auth.uid == 'netlify-operator-control'
//        && auth.token.purpose == 'operator-control'
//
// so this endpoint mints that identity rather than one of its own. A dedicated
// reader uid would be tidier, but it would need a hand-deployed rules change
// (ONLINE-5) and would be denied until that happened. The grant already exists
// to let the cloud read live device state, which is exactly what this does.
const READER_CLAIMS = {
  siteId: "well-main",
  deviceId: "tab5-well-main",
  purpose: "operator-control"
};

// An ID token is good for an hour, and Netlify reuses a warm container across
// invocations, so minting one per request meant a full custom-token mint plus an
// Identity Toolkit exchange on every poll -- tens of thousands of round trips a
// day for a token that had barely aged. Same shape the operator store already
// uses, renewed ahead of expiry so a request never carries one that dies mid-read.
const TOKEN_RENEWAL_MARGIN_MS = 60000;
const DEFAULT_TOKEN_LIFETIME_MS = 3600000;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function response(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const firebase = dependencies.firebase || require("../lib/firebase");
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || Date.now;

  let cachedToken = null;
  let exchangeInFlight = null;

  async function readerToken() {
    if (cachedToken && now() < cachedToken.renewAtMs) return cachedToken.idToken;
    // One exchange in flight at a time: concurrent invocations on a warm
    // container should share the mint rather than each start their own.
    if (!exchangeInFlight) {
      exchangeInFlight = (async () => {
        const { auth, projectId } = firebase.getPilotAuth();
        if (projectId !== "well-pump-control") throw new Error("configuration_missing");
        const customToken = await auth.createCustomToken(OPERATOR_UID, READER_CLAIMS);
        const reply = await fetchImpl(
          `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`,
          { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
        const body = await reply.json().catch(() => null);
        if (!reply.ok || typeof body?.idToken !== "string") throw new Error("reader_auth_failed");
        const seconds = Number(body.expiresIn);
        const lifetimeMs = Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
        cachedToken = {
          idToken: body.idToken,
          renewAtMs: now() + Math.max(lifetimeMs - TOKEN_RENEWAL_MARGIN_MS, Math.floor(lifetimeMs / 2))
        };
        return cachedToken.idToken;
      })().finally(() => { exchangeInFlight = null; });
    }
    return exchangeInFlight;
  }

  return async function currentObservation(event) {
    if (event.httpMethod !== "GET") {
      return { ...response(405, { status: "error", code: "method_not_allowed" }),
               headers: { ...jsonHeaders, "Allow": "GET" } };
    }
    if (!env.FIREBASE_WEB_API_KEY || !env.FIREBASE_RTDB_URL) {
      return response(503, { status: "error", code: "configuration_missing" });
    }

    let record;
    try {
      const rtdbUrl = _approvedRtdbUrl(env.FIREBASE_RTDB_URL);
      const token = await readerToken();
      const path = `${rtdbUrl}/v1/sites/well-main/devices/tab5-well-main/currentObservation.json?auth=${encodeURIComponent(token)}`;
      const reply = await fetchImpl(path, { method: "GET" });
      if (!reply.ok) return response(502, { status: "error", code: "rtdb_read_failed" });
      record = await reply.json().catch(() => null);
    } catch (error) {
      const code = error && error.code === "configuration_invalid"
        ? "configuration_missing" : "rtdb_read_failed";
      return response(code === "configuration_missing" ? 503 : 502,
                      { status: "error", code });
    }

    if (!record || typeof record !== "object") {
      return response(404, { status: "empty", code: "telemetry_missing" });
    }

    const values = record.values || {};
    const status = record.status || {};
    // Age from the server-stamped receive time, not the device clock: the device
    // clock can step at SNTP and this is what tells the page it has gone quiet.
    const receivedAtMs = numberOrNull(record.receivedAtMs);
    const ageSeconds = receivedAtMs === null
      ? null : Math.max(0, Math.round((now() - receivedAtMs) / 1000));

    return response(200, {
      status: "ok",
      siteId: record.siteId || "well-main",
      deviceId: record.deviceId || null,
      sessionId: record.sessionId || null,
      sequence: numberOrNull(record.sequence),
      observedAt: typeof record.observedAt === "string" ? record.observedAt : null,
      receivedAtMs,
      ageSeconds,
      values: {
        // Pressure is the reason this endpoint exists: it is produced every
        // cycle and was not reaching the home screen at all.
        pressurePsi: numberOrNull(values.pressure_psi),
        adcRaw: numberOrNull(values.adc_raw),
        powerW: numberOrNull(values.power),
        voltageV: numberOrNull(values.voltage),
        powerFactor: numberOrNull(values.pf),
        // The meter's own verdict on the reading beside it. Distinct from
        // status.shelly_available below: that says the meter answered, this says
        // the numbers it gave are usable. A dropout leaves this null rather than
        // false, so absent evidence never reads as a bad measurement.
        isValid: booleanOrNull(values.is_valid),
        batteryPercent: numberOrNull(values.battery_percent),
        // The rules engine's Boyle calculation, merged into the same record by
        // name. Net flow from the pressure slope: positive fills the tank,
        // negative drains it. The device writes a number only on a VALID
        // cycle, and the quality alongside it on every cycle it runs.
        tankNetFlowGpm: numberOrNull(values.TankNetFlowGPM),
        tankFlowQuality: typeof values.TankFlowQuality === "string"
          ? values.TankFlowQuality : null
      },
      shelly1: {
        available: booleanOrNull(status.shelly1_available),
        sw0: booleanOrNull(values.shelly1_sw0),
        rly0: booleanOrNull(values.shelly1_rly0),
        isLocked: numberOrNull(values.shelly1_lock),
        lockoutCount: numberOrNull(values.shelly1_lockout_count),
        tab5IsLocked: booleanOrNull(values.shelly1_tab5lock)
      },
      // Whether the Tab5 has released its hold (User Monitor), from the same
      // record, so the protection line and the numbers are one instant.
      userMonitor: booleanOrNull(status.user_monitor_active),
      relayRestoration: typeof status.tab5_relay_restoration === "string" ? status.tab5_relay_restoration : null,
      pressureCommissioned: booleanOrNull(status.pressure_sensor_commissioned),
      pressureValid: booleanOrNull(status.pressure_valid),
      shellyAvailable: booleanOrNull(status.shelly_available)
    });
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
