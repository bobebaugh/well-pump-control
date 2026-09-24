"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CRITERIA, notificationDecision, releaseNotificationPolicy } = require("../cloud/netlify/lib/event-notification-criteria");
const { MAX_RECORDS, batchKey, composeMessage, createEventNotifier } = require("../cloud/netlify/lib/event-notifier");
const { historyIdentity } = require("../cloud/netlify/lib/event-board-store");
const { _createHandler } = require("../cloud/netlify/functions/event-board");
const { fakeFirestore } = require("./fixtures/memory-firestore");

const sessionA = "boot_AAAAAAAAAAAA";
const release = { releaseId: "20260912001035-event-v3-v15", packageVersion: 15, contentHash: "a".repeat(64) };
const configured = {
  RESEND_API_KEY: "test-key", NOTIFY_FROM: "well@resend.ebaugh.net",
  NOTIFY_EMAIL_TO: "owner@example.net", NOTIFY_SMS_TO: "0000000000@example-gateway.test"
};
const quiet = { error() {}, warn() {} };

function record(eventDefinitionId, recordType = "event-open", occurrence = "1") {
  return {
    recordType, recordId: `${recordType}--tab5-well-main--${sessionA}--${eventDefinitionId}:${occurrence}`,
    eventDefinitionId, displayName: `${eventDefinitionId} display name`
  };
}
function okResponse(count) {
  return { status: 200, ok: true, json: async () => ({ data: Array.from({ length: count }, (_, index) => ({ id: `id-${index}` })) }) };
}
function slot(occurrenceId, name) {
  return { occurrenceId, displayName: name, severity: "Red", eventClass: "transient",
    opening: { kind: "condition-qualified", cycleSequence: 20, uptimeMs: 20000, observedAt: "2026-09-12T16:00:20.000Z" } };
}
function board(sequence, openEvents = {}) {
  return { schemaVersion: 1, kind: "current-event-board", siteId: "well-main", deviceId: "tab5-well-main",
    sessionId: sessionA, boardSequence: sequence, complete: true, producedUptimeMs: sequence * 1000,
    producedAt: `2026-09-12T16:00:${String(sequence).padStart(2, "0")}.000Z`, rulesRelease: release, openEvents };
}

test("criteria table is #24's twenty rows and an unlisted id stays loud on both transitions", () => {
  assert.equal(Object.keys(CRITERIA).length, 20);
  assert.deepEqual(notificationDecision("P001", "event-open"), { send: true, criteria: "table", transition: "open" });
  assert.equal(notificationDecision("P001", "event-close").send, false);
  assert.equal(notificationDecision("H001", "event-close").send, true);
  assert.equal(notificationDecision("M001", "event-open").send, false);
  assert.equal(notificationDecision("T010", "event-open").send, true);
  assert.equal(notificationDecision("T010", "event-close").send, false);
  assert.deepEqual(notificationDecision("W99", "event-close"), { send: true, criteria: "unknown", transition: "close" });
  assert.equal(notificationDecision("constructor", "event-open").criteria, "unknown");
  assert.equal(notificationDecision("P001", "rule-adoption").send, false);
});

test("the message is the marker and event number in the subject, #24's display name in the body", () => {
  assert.deepEqual(composeMessage(record("W07")), { subject: "MF-Well Open: W07", text: "W07 display name" });
  assert.deepEqual(composeMessage(record("W07", "event-close")), { subject: "MF-Well Close: W07", text: "W07 display name" });
  const name = "Tank pressure above 70 psi — pump locked off, pressure switch may have failed";
  const longest = composeMessage({ recordType: "event-close", eventDefinitionId: "W07", displayName: name });
  assert.equal(longest.text, name);
  assert.ok(`${longest.subject} ${longest.text}`.length <= 160);
});

test("one batch carries both legs of every notified record and skips the ones the table mutes", async () => {
  const calls = [];
  const notifier = createEventNotifier({
    env: configured, log: quiet,
    fetch: async (url, options) => { calls.push({ url, options }); return okResponse(4); }
  });
  const outcomes = await notifier.notify([record("W07"), record("M001"), record("P001", "event-close"), record("H001")]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails/batch");
  const sent = JSON.parse(calls[0].options.body);
  assert.deepEqual(sent.map(mail => [mail.subject, mail.to[0]]), [
    ["MF-Well Open: W07", "owner@example.net"], ["MF-Well Open: W07", "0000000000@example-gateway.test"],
    ["MF-Well Open: H001", "owner@example.net"], ["MF-Well Open: H001", "0000000000@example-gateway.test"]
  ]);
  assert.ok(sent.every(mail => mail.from === "well@resend.ebaugh.net" && mail.html === undefined));
  assert.deepEqual(outcomes.map(outcome => outcome.notification.status), ["sent", "sent"]);
  assert.deepEqual(outcomes[0].notification, { status: "sent", criteria: "table", email: "id-0", sms: "id-1" });
});

test("a rate-limited batch retries once under the same idempotency key and never a third time", async () => {
  const keys = [];
  const notifier = createEventNotifier({
    env: configured, log: quiet,
    fetch: async (url, options) => {
      keys.push(options.headers["Idempotency-Key"]);
      return keys.length === 1 ? { status: 429, ok: false, json: async () => ({}) } : okResponse(2);
    }
  });
  const outcomes = await notifier.notify([record("W07")]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], batchKey([record("W07").recordId]));
  assert.equal(outcomes[0].notification.status, "sent");

  const rejected = createEventNotifier({
    env: configured, log: quiet, fetch: async () => ({ status: 422, ok: false, json: async () => ({}) })
  });
  const failed = await rejected.notify([record("W07")]);
  assert.deepEqual(failed[0].notification, { status: "failed", code: "resend_422", criteria: "table" });
});

test("a thrown send, a missing key and a dry run all resolve to outcomes rather than an exception", async () => {
  const thrown = createEventNotifier({ env: configured, log: quiet, fetch: async () => { throw new Error("socket"); } });
  assert.deepEqual((await thrown.notify([record("W07")]))[0].notification,
    { status: "failed", code: "resend_0", criteria: "table" });

  const missing = [];
  const unconfigured = createEventNotifier({
    env: { NOTIFY_FROM: "well@resend.ebaugh.net" }, log: { error: (_, detail) => missing.push(detail.missing) },
    fetch: async () => { throw new Error("must not send"); }
  });
  assert.deepEqual((await unconfigured.notify([record("W07")]))[0].notification,
    { status: "not-configured", missing: "RESEND_API_KEY,NOTIFY_EMAIL_TO,NOTIFY_SMS_TO", criteria: "table" });
  assert.equal(missing[0], "RESEND_API_KEY,NOTIFY_EMAIL_TO,NOTIFY_SMS_TO");

  const dry = createEventNotifier({
    env: { ...configured, NOTIFY_DRY_RUN: "1" }, log: quiet,
    fetch: async () => { throw new Error("must not send"); }
  });
  assert.deepEqual((await dry.notify([record("W07"), record("M001")]))[0].notification,
    { status: "dry-run", criteria: "table" });

  // A dry run composes without a key, and still reports that it could not have sent.
  const dryUnconfigured = createEventNotifier({
    env: { NOTIFY_DRY_RUN: "1" }, log: quiet, fetch: async () => { throw new Error("must not send"); }
  });
  assert.deepEqual((await dryUnconfigured.notify([record("W07")]))[0].notification,
    { status: "dry-run", missing: "RESEND_API_KEY,NOTIFY_FROM,NOTIFY_EMAIL_TO,NOTIFY_SMS_TO", criteria: "table" });
});

test("more than four notifiable records in one reconciliation send four and mark the rest", async () => {
  const calls = [];
  const notifier = createEventNotifier({
    env: configured, log: quiet,
    fetch: async (url, options) => { calls.push(JSON.parse(options.body)); return okResponse(8); }
  });
  const many = ["W07", "W02", "W08", "W09", "W06", "W03"].map(id => record(id));
  const outcomes = await notifier.notify(many);
  assert.equal(MAX_RECORDS, 4);
  assert.equal(calls[0].length, 8);
  assert.deepEqual(outcomes.map(outcome => outcome.notification.status),
    ["sent", "sent", "sent", "sent", "skipped", "skipped"]);
  assert.equal(outcomes[4].notification.reason, "burst-cap");
});

test("the endpoint sends once per occurrence, before the mirror, and a send failure changes nothing", async () => {
  const { db, values } = fakeFirestore();
  const order = [];
  let mirrorFails = true;
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-token" },
    getPilotFirestore: () => ({ db, projectId: "well-pump-control", databaseId: "(default)" }),
    clock: () => new Date("2026-09-12T16:00:02.100Z"),
    createMirror: () => ({ mirror: async () => {
      order.push("mirror");
      if (mirrorFails) { mirrorFails = false; throw new Error("mirror down"); }
      return { written: true };
    } }),
    createNotifier: () => ({ notify: async records => {
      order.push(`notify:${records.map(item => item.eventDefinitionId).join(",")}`);
      return records.map(item => ({ recordId: item.recordId, notification: { status: "sent", criteria: "table" } }));
    } })
  });
  const post = sequence => handler({ httpMethod: "POST", headers: { "x-pilot-key": "test-token" },
    body: JSON.stringify(board(sequence, { W07: slot("r15:W07:1", "Tank pressure above 70 psi") })) });

  const first = await post(2);
  assert.equal(first.statusCode, 503);
  assert.deepEqual(order, ["notify:W07", "mirror"]);

  const retry = await post(2);
  assert.equal(JSON.parse(retry.body).decision, "duplicate");
  assert.deepEqual(order, ["notify:W07", "mirror", "mirror"]);

  const stored = values.get(`sites/well-main/eventRecords/${[...values.keys()]
    .filter(path => path.includes("/eventRecords/")).map(path => path.split("/").at(-1))[0]}`);
  assert.equal(stored.notification.status, "sent");
  assert.deepEqual(historyIdentity(stored).notification, undefined);
});

test("a notifier that throws leaves ingestion and the mirror untouched", async () => {
  const { db } = fakeFirestore();
  let mirrored = 0;
  const handler = _createHandler({
    env: { PILOT_INGEST_TOKEN: "test-token" },
    getPilotFirestore: () => ({ db, projectId: "well-pump-control", databaseId: "(default)" }),
    clock: () => new Date("2026-09-12T16:00:02.100Z"),
    createMirror: () => ({ mirror: async () => { mirrored += 1; return { written: true }; } }),
    createNotifier: () => ({ notify: async () => { throw new Error("resend exploded"); } })
  });
  const result = await handler({ httpMethod: "POST", headers: { "x-pilot-key": "test-token" },
    body: JSON.stringify(board(2, { W07: slot("r15:W07:1", "Tank pressure above 70 psi") })) });
  assert.equal(result.statusCode, 201);
  assert.equal(JSON.parse(result.body).decision, "accepted-new-session");
  assert.equal(mirrored, 1);
});

function releaseDoc(web, overrides = {}) {
  return { ...release, authoringPackage: { schemaVersion: 3, events: [
    { id: "W07", displayName: "Tank pressure above 70 psi", web },
    { id: "P001", displayName: "Pump Cycle > 100W" }
  ] }, ...overrides };
}

test("the event's own settings in the reported release decide and word the message", () => {
  const web = { notifyOnOpen: true, notifyOnClose: false, openMessage: "  W07 - tank over 70 psi  ", closeMessage: "" };
  const opened = { ...record("W07"), rulesRelease: release };
  const policy = releaseNotificationPolicy(releaseDoc(web), opened);
  assert.deepEqual(policy, { notifyOnOpen: true, notifyOnClose: false, openMessage: "W07 - tank over 70 psi", closeMessage: "" });
  const openDecision = notificationDecision("W07", "event-open", policy);
  assert.deepEqual(openDecision, { send: true, criteria: "release", transition: "open", message: "W07 - tank over 70 psi" });
  assert.deepEqual(composeMessage(opened, openDecision), { subject: "MF-Well Open: W07", text: "W07 - tank over 70 psi" });
  // The table would send this close; the event's own setting says not to.
  assert.equal(notificationDecision("W07", "event-close", policy).send, false);
  // An empty message falls back to the display name the device ran.
  const emptied = releaseNotificationPolicy(releaseDoc({ ...web, openMessage: "" }), opened);
  assert.equal(composeMessage(opened, notificationDecision("W07", "event-open", emptied)).text, "W07 display name");

  // Anything that is not provably the package the device ran falls back to the table.
  assert.equal(releaseNotificationPolicy(releaseDoc(web, { contentHash: "b".repeat(64) }), opened), null);
  assert.equal(releaseNotificationPolicy(releaseDoc(web), { ...opened, rulesRelease: undefined }), null);
  assert.equal(releaseNotificationPolicy(releaseDoc(web), { ...record("P001"), rulesRelease: release }), null);
  assert.equal(releaseNotificationPolicy(null, opened), null);
});

test("the endpoint words an email from the release, and falls back to the table without one", async () => {
  const run = async seedRelease => {
    const { db, values } = fakeFirestore();
    if (seedRelease) values.set(`sites/well-main/rulesEngineV3Releases/${release.releaseId}`, seedRelease);
    const sent = [];
    const handler = _createHandler({
      env: { PILOT_INGEST_TOKEN: "test-token" },
      getPilotFirestore: () => ({ db, projectId: "well-pump-control", databaseId: "(default)" }),
      clock: () => new Date("2026-09-12T16:00:02.100Z"),
      createMirror: () => ({ mirror: async () => ({ written: true }) }),
      createNotifier: () => createEventNotifier({
        env: configured, log: quiet,
        fetch: async (url, options) => { sent.push(...JSON.parse(options.body)); return okResponse(2); }
      })
    });
    const post = (sequence, open) => handler({ httpMethod: "POST", headers: { "x-pilot-key": "test-token" },
      body: JSON.stringify(board(sequence, open ? { W07: slot("r15:W07:1", "Tank pressure above 70 psi") } : {})) });
    await post(2, true);
    await post(3, false);
    const stored = [...values.entries()].filter(([path]) => path.includes("/eventRecords/")).map(([, value]) => value);
    return { sent: sent.filter(mail => mail.to[0] === "owner@example.net"), stored };
  };

  const fromRelease = await run(releaseDoc({ notifyOnOpen: true, notifyOnClose: false, openMessage: "W07 - tank over 70 psi", closeMessage: "" }));
  assert.deepEqual(fromRelease.sent.map(mail => [mail.subject, mail.text]), [["MF-Well Open: W07", "W07 - tank over 70 psi"]]);
  assert.equal(fromRelease.stored.find(item => item.recordType === "event-open").notification.criteria, "release");

  const fallback = await run(null);
  assert.deepEqual(fallback.sent.map(mail => [mail.subject, mail.text]), [
    ["MF-Well Open: W07", "Tank pressure above 70 psi"], ["MF-Well Close: W07", "Tank pressure above 70 psi"]]);
  assert.equal(fallback.stored.find(item => item.recordType === "event-open").notification.criteria, "table");
});
