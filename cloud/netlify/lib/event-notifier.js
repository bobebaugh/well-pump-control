"use strict";

const { createHash } = require("node:crypto");
const { notificationDecision } = require("./event-notification-criteria");

// Resend's batch endpoint carries both legs of every record in one request, which keeps
// this off the default 2-requests-per-second limit and off the function's clock.
const BATCH_URL = "https://api.resend.com/emails/batch";
const SUBJECT_MARKER = "MF-Well";
const MAX_RECORDS = 4;
const REQUIRED = ["RESEND_API_KEY", "NOTIFY_FROM", "NOTIFY_EMAIL_TO", "NOTIFY_SMS_TO"];

function transition(recordType) { return recordType === "event-open" ? "Open" : "Close"; }

// Event number in the subject, display name in the body, nothing else. The marker is what
// the mailbox filters on. The display name is #24's wording, taken from the event record
// so it is the name the device actually ran rather than a second copy that can drift.
function composeMessage(record) {
  return {
    subject: `${SUBJECT_MARKER} ${transition(record.recordType)}: ${record.eventDefinitionId}`,
    text: record.displayName
  };
}

// Deterministic per set of records, so the one retry below cannot deliver twice: Resend
// honours an Idempotency-Key for 24 hours and returns the original response instead.
function batchKey(recordIds) { return createHash("sha256").update(recordIds.join("\n")).digest("hex"); }

function mark(selected, notification) {
  return selected.map(({ record, decision }) => ({
    recordId: record.recordId, notification: { ...notification, criteria: decision.criteria }
  }));
}

function createEventNotifier(dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const log = dependencies.log || console;
  const dryRun = String(env.NOTIFY_DRY_RUN || "") === "1";
  const missing = REQUIRED.filter(name => !env[name]);

  async function post(body, key) {
    const response = await fetchImpl(BATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json", "Idempotency-Key": key
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, ok: response.ok, payload: await response.json().catch(() => null) };
  }

  return {
    // Never throws and never reports anything but outcomes: delivery is reporting, and no
    // caller may make ingestion or inhibition depend on it.
    async notify(records) {
      const selected = [];
      for (const record of records) {
        const decision = notificationDecision(record.eventDefinitionId, record.recordType);
        if (decision.send) selected.push({ record, decision });
      }
      if (selected.length === 0) return [];

      const sending = selected.slice(0, MAX_RECORDS);
      const skipped = mark(selected.slice(MAX_RECORDS), { status: "skipped", reason: "burst-cap" });
      const messages = sending.map(({ record }) => composeMessage(record));
      const key = batchKey(sending.map(({ record }) => record.recordId));

      if (missing.length > 0) {
        log.error("Event notification not configured", { missing: missing.join(",") });
        return [...mark(sending, { status: "not-configured" }), ...skipped];
      }
      if (dryRun) {
        log.warn("Event notification dry run", { subjects: messages.map(message => message.subject) });
        return [...mark(sending, { status: "dry-run" }), ...skipped];
      }

      const body = sending.flatMap((entry, index) => [
        { from: env.NOTIFY_FROM, to: [env.NOTIFY_EMAIL_TO], ...messages[index] },
        { from: env.NOTIFY_FROM, to: [env.NOTIFY_SMS_TO], ...messages[index] }
      ]);
      let result = { status: 0, ok: false, payload: null };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { result = await post(body, key); } catch { result = { status: 0, ok: false, payload: null }; }
        if (result.ok) break;
        if (result.status !== 0 && result.status !== 429 && result.status < 500) break;
      }
      if (!result.ok) {
        log.error("Event notification send failed", { status: result.status, records: sending.length });
        return [...mark(sending, { status: "failed", code: `resend_${result.status}` }), ...skipped];
      }
      const ids = Array.isArray(result.payload?.data) ? result.payload.data : [];
      const sent = sending.map(({ record, decision }, index) => ({
        recordId: record.recordId,
        notification: {
          status: "sent", criteria: decision.criteria,
          email: ids[index * 2]?.id || null, sms: ids[index * 2 + 1]?.id || null
        }
      }));
      return [...sent, ...skipped];
    }
  };
}

module.exports = { MAX_RECORDS, SUBJECT_MARKER, batchKey, composeMessage, createEventNotifier };
