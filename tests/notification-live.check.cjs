"use strict";

// Drive the real notification path end to end against the live Resend API.
//
//   RESEND_API_KEY=... NOTIFY_EMAIL_TO=... NOTIFY_SMS_TO=... \
//     node tests/notification-live.check.cjs [--send]
//
// The unit tests pin behaviour against an injected fetch. This pins it against
// Resend as it actually is, which is the only thing that can answer the question
// that matters before the house is empty: does a message reach the phone, and
// does a retried board send a second one.
//
// Without --send it is a dry run: it composes both legs, reports them and sends
// nothing, so it is safe to run at any time. With --send it delivers two real
// messages to the configured addresses. It uses T010, whose display name begins
// "TEST -", so a message arriving at 4am says in its first word that it is not
// the well. It touches no live database - Firestore and the RTDB mirror are
// in-memory - so a run here is not a real write.
//
// The key is read from the environment and is never written, logged or echoed.
// Exit status is 1 if any checked property fails, so it can gate a review.

const { _createHandler } = require("../cloud/netlify/functions/event-board");
const { createEventNotifier } = require("../cloud/netlify/lib/event-notifier");
const { fakeFirestore } = require("./fixtures/memory-firestore");

const send = process.argv.includes("--send");
const failures = [];
function check(description, condition, detail) {
  console.log(`${condition ? "ok  " : "FAIL"}  ${description}${detail === undefined ? "" : `  (${detail})`}`);
  if (!condition) failures.push(description);
}

const RELEASE = { releaseId: "20260912001035-event-v3-v15", packageVersion: 15, contentHash: "a".repeat(64) };
const SLOT = {
  occurrenceId: `r15:T010:${Date.now()}`, displayName: "TEST — high voltage above 260 V",
  severity: "Red", eventClass: "transient",
  opening: { kind: "condition-qualified", cycleSequence: 20, uptimeMs: 20000, observedAt: new Date().toISOString().replace(/\.\d+Z$/, ".000Z") }
};

let requests = 0;
const { db, values } = fakeFirestore();
const notifier = createEventNotifier({
  env: {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    NOTIFY_FROM: process.env.NOTIFY_FROM || "Well Pump <well@resend.ebaugh.net>",
    NOTIFY_EMAIL_TO: process.env.NOTIFY_EMAIL_TO, NOTIFY_SMS_TO: process.env.NOTIFY_SMS_TO,
    NOTIFY_DRY_RUN: send ? "" : "1"
  },
  log: { error: (message, detail) => console.log(`      ${message}: ${JSON.stringify(detail)}`), warn: () => {} },
  fetch: (url, options) => { requests += 1; return globalThis.fetch(url, options); }
});
const handler = _createHandler({
  env: { PILOT_INGEST_TOKEN: "local-check" },
  getPilotFirestore: () => ({ db, projectId: "well-pump-control", databaseId: "(default)" }),
  createMirror: () => ({ mirror: async () => ({ written: true }) }),
  createNotifier: () => notifier
});
function post(boardSequence, openEvents) {
  return handler({
    httpMethod: "POST", headers: { "x-pilot-key": "local-check" },
    body: JSON.stringify({
      schemaVersion: 1, kind: "current-event-board", siteId: "well-main", deviceId: "tab5-well-main",
      sessionId: "boot_LIVECHECK01", boardSequence, complete: true, producedUptimeMs: boardSequence * 1000,
      rulesRelease: RELEASE, openEvents
    })
  });
}
const markerFor = fragment => [...values.entries()]
  .filter(([path]) => path.includes(`/eventRecords/${fragment}`)).map(([, value]) => value.notification)[0];

(async () => {
  console.log(`${send ? "LIVE SEND" : "DRY RUN"} — T010 open, retry, persistence, close\n`);

  const opened = await post(2, { T010: SLOT });
  check("a qualifying open is accepted", opened.statusCode === 201, `HTTP ${opened.statusCode}`);
  check("the open reaches Resend once", requests === (send ? 1 : 0), `${requests} request(s)`);
  const openMarker = markerFor("event-open");
  check("the open record carries its delivery outcome", openMarker !== undefined, JSON.stringify(openMarker));
  if (send) {
    check("both legs were accepted by Resend", openMarker?.status === "sent" && Boolean(openMarker.email) && Boolean(openMarker.sms));
    check("the criteria came from the table, not the unknown default", openMarker?.criteria === "table");
  }

  const before = requests;
  const retried = await post(2, { T010: SLOT });
  check("a retried board reduces to a duplicate", JSON.parse(retried.body).decision === "duplicate");
  check("a retried board sends nothing", requests === before, `${requests - before} extra request(s)`);

  const still = requests;
  await post(3, { T010: SLOT });
  check("an unchanged open on a later board sends nothing", requests === still, `${requests - still} extra request(s)`);

  const beforeClose = requests;
  const closed = await post(4, {});
  check("the close is reconciled", JSON.parse(closed.body).decision === "accepted");
  check("T010's close is muted by the table", requests === beforeClose, `${requests - beforeClose} extra request(s)`);
  check("the close record has no delivery outcome", markerFor("event-close") === undefined);

  console.log(`\n${failures.length === 0 ? "All checks passed" : `${failures.length} check(s) failed`}.`);
  if (!send) console.log("Re-run with --send to deliver two real messages.");
  process.exit(failures.length === 0 ? 0 : 1);
})();
