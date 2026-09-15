"use strict";

// The live observation, read from RTDB rather than Firestore.
//
// Tab5 mirrors its COMPLETE observation to
// v1/sites/well-main/devices/tab5-well-main/currentObservation on its own
// cadence, which is far faster than the Firestore current document that
// current-power reads. Everything the home screen shows live comes from here:
// pressure, power, voltage, power factor and the Shelly 1 contacts, all from
// one record so they are the same instant rather than assembled from two reads.

const { _approvedRtdbUrl } = require("../lib/rules-store");

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

  async function readerToken() {
    const { auth, projectId } = firebase.getPilotAuth();
    if (projectId !== "well-pump-control") throw new Error("configuration_missing");
    const customToken = await auth.createCustomToken("netlify-observation-reader", {
      siteId: "well-main", deviceId: "tab5-well-main", purpose: "current-observation"
    });
    const reply = await fetchImpl(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
    const body = await reply.json().catch(() => null);
    if (!reply.ok || typeof body?.idToken !== "string") throw new Error("reader_auth_failed");
    return body.idToken;
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
        batteryPercent: numberOrNull(values.battery_percent)
      },
      shelly1: {
        available: booleanOrNull(status.shelly1_available),
        sw0: booleanOrNull(values.shelly1_sw0),
        rly0: booleanOrNull(values.shelly1_rly0),
        isLocked: numberOrNull(values.shelly1_lock),
        lockoutCount: numberOrNull(values.shelly1_lockout_count),
        tab5IsLocked: booleanOrNull(values.shelly1_tab5lock)
      },
      pressureCommissioned: booleanOrNull(status.pressure_sensor_commissioned),
      pressureValid: booleanOrNull(status.pressure_valid),
      shellyAvailable: booleanOrNull(status.shelly_available)
    });
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
