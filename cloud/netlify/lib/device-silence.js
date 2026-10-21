"use strict";

// Silent-device alert. The Tab5 writes a durable record at least every 10 minutes, so
// no record received for 30 minutes means the device, its network or one of its
// workers has stopped. One message when that starts and one when records resume.
// Receipt time, not observation time: records queued through an outage arrive late
// with old observation times, and their arrival is what "resumed" means.
const { createHash } = require("node:crypto");

const SILENCE_AFTER_MS = 30 * 60 * 1000;
const BATCH_URL = "https://api.resend.com/emails/batch";
const SUBJECT_MARKER = "MF-Well";
const REQUIRED = ["RESEND_API_KEY", "NOTIFY_FROM", "NOTIFY_EMAIL_TO", "NOTIFY_SMS_TO"];

function minutes(ms) { return Math.max(0, Math.round(ms / 60000)); }

// Plain ASCII: one non-GSM character turns a text message into short UCS-2 segments.
function localTime(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit", month: "short", day: "numeric", timeZoneName: "short"
    }).format(new Date(ms)).replace(/[^\x20-\x7e]/g, " ");
  } catch {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

// Pure. state is the stored {status, lastReceivedAt}; returns the next state and the
// message to send, if any. No record at all counts as silent.
function decideSilence({ lastReceivedMs, nowMs, state, timeZone = "America/New_York" }) {
  const wasSilent = state?.status === "silent";
  const silent = !Number.isFinite(lastReceivedMs) || nowMs - lastReceivedMs > SILENCE_AFTER_MS;
  const lastReceivedAt = Number.isFinite(lastReceivedMs) ? new Date(lastReceivedMs).toISOString() : null;
  const next = { status: silent ? "silent" : "ok", lastReceivedAt };
  if (silent && !wasSilent) {
    return { next, message: {
      kind: "silent",
      subject: `${SUBJECT_MARKER} Silent: Tab5`,
      text: lastReceivedAt
        ? `No record from the Tab5 since ${localTime(lastReceivedMs, timeZone)} (${minutes(nowMs - lastReceivedMs)} min). It may be off, offline or stopped. Check the Tab5 screen; power-cycle it if it does not return.`
        : "No record from the Tab5 has ever been received. Check the Tab5 and its network."
    } };
  }
  if (!silent && wasSilent) {
    const since = Date.parse(state.lastReceivedAt || "");
    return { next, message: {
      kind: "resumed",
      subject: `${SUBJECT_MARKER} Resumed: Tab5`,
      text: `Tab5 records resumed ${localTime(lastReceivedMs, timeZone)}${Number.isFinite(since) ? ` after ${minutes(lastReceivedMs - since)} min without one` : ""}.`
    } };
  }
  return { next, message: null };
}

// Same channel, settings and dry-run behaviour as the event notifier. The key makes a
// retry of the same transition idempotent at Resend for 24 hours.
async function sendPair(message, key, { env, fetchImpl }) {
  if (String(env.NOTIFY_DRY_RUN || "") === "1") return { status: "dry-run" };
  const missing = REQUIRED.filter(name => !env[name]);
  if (missing.length) return { status: "not-configured", missing: missing.join(",") };
  const body = [env.NOTIFY_EMAIL_TO, env.NOTIFY_SMS_TO].map(to => (
    { from: env.NOTIFY_FROM, to: [to], subject: message.subject, text: message.text }));
  try {
    const response = await fetchImpl(BATCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body)
    });
    return response.ok ? { status: "sent" } : { status: "failed", code: `resend_${response.status}` };
  } catch {
    return { status: "failed", code: "resend_0" };
  }
}

function transitionKey(kind, lastReceivedAt) {
  return createHash("sha256").update(`device-silence\n${kind}\n${lastReceivedAt || "none"}`).digest("hex");
}

// Save the transition and its exact message before sending. A lost response or a
// failed completion save then retries the same key/body. Recording silence before
// the attempt also preserves the Resumed transition when delivery is uncertain.
async function checkDeviceSilence({ readNewestReceivedMs, readState, writeState, nowMs, env, fetchImpl, log = console }) {
  const [lastReceivedMs, state] = await Promise.all([readNewestReceivedMs(), readState()]);
  const { next, message } = decideSilence({ lastReceivedMs, nowMs, state, timeZone: env.NOTIFY_TIME_ZONE || undefined });
  const checkedAt = new Date(nowMs).toISOString();
  let transition = state;
  if (message) {
    transition = { ...next, checkedAt, pending: {
      key: transitionKey(message.kind, next.lastReceivedAt), message
    } };
    await writeState(transition);
  } else if (!state) {
    await writeState({ ...next, checkedAt });
  }
  const pending = transition?.pending;
  if (!pending) {
    return { status: next.status, sent: null };
  }
  const outcome = await sendPair(pending.message, pending.key, { env, fetchImpl });
  if (outcome.status === "sent" || outcome.status === "dry-run") {
    await writeState({ ...transition, pending: null, checkedAt,
      notified: { kind: pending.message.kind, status: outcome.status, at: checkedAt } });
  } else {
    log.error("Device silence alert delivery unconfirmed", { kind: pending.message.kind, ...outcome });
  }
  return { status: next.status, sent: { kind: pending.message.kind, ...outcome } };
}

module.exports = { SILENCE_AFTER_MS, checkDeviceSilence, decideSilence, sendPair };
