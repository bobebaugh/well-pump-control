"use strict";

// Scheduled every 15 minutes in netlify.toml. Netlify runs a schedule only on the
// production deploy, so this is live with main's deploy; on a branch deploy it runs
// only when invoked. A check is idempotent: it sends only on a silent/resumed
// transition, so an extra invocation cannot repeat a message.
const { FieldPath } = require("firebase-admin/firestore");
const { getPilotFirestore } = require("../lib/firebase");
const { checkDeviceSilence } = require("../lib/device-silence");

const SITE_ID = "well-main";
const DEVICE_ID = "tab5-well-main";

function createHandler(dependencies = {}) {
  const firestoreProvider = dependencies.getPilotFirestore || getPilotFirestore;
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const now = dependencies.now || (() => Date.now());
  return async function deviceSilence() {
    try {
      const { db } = firestoreProvider();
      const site = db.collection("sites").doc(SITE_ID);
      const stateRef = site.collection("alerts").doc("device-silence");
      const result = await checkDeviceSilence({
        // The records page's receipt-time query, so it uses the same index.
        readNewestReceivedMs: async () => {
          const snapshot = await site.collection("observations")
            .where("deviceId", "==", DEVICE_ID).where("schemaVersion", "==", 2)
            .orderBy("receivedAt", "desc").orderBy(FieldPath.documentId(), "desc").limit(1).get();
          const received = snapshot.docs[0]?.data()?.receivedAt;
          return typeof received?.toMillis === "function" ? received.toMillis() : null;
        },
        readState: async () => {
          const snapshot = await stateRef.get();
          return snapshot.exists ? snapshot.data() : null;
        },
        writeState: state => stateRef.set(state),
        nowMs: now(), env, fetchImpl
      });
      return { statusCode: 200, body: JSON.stringify({ status: "ok", device: result.status, sent: result.sent }) };
    } catch (error) {
      console.error("Device silence check failed", { code: error?.code || "unknown" });
      return { statusCode: 503, body: JSON.stringify({ status: "error", code: "device_silence_unavailable" }) };
    }
  };
}

exports.handler = createHandler();
exports._createHandler = createHandler;
