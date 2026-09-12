"use strict";

const { _approvedRtdbUrl } = require("./rules-store");
const { stableJson } = require("./ingest-record-contract");

class EventBoardMirrorError extends Error {
  constructor(code) { super(code); this.name = "EventBoardMirrorError"; this.code = code; }
}

function createEventBoardMirror(dependencies = {}) {
  const env = dependencies.env || process.env;
  const firebase = dependencies.firebase || require("./firebase");
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (!env.FIREBASE_WEB_API_KEY || !env.FIREBASE_RTDB_URL) throw new EventBoardMirrorError("configuration_missing");
  const rtdbUrl = _approvedRtdbUrl(env.FIREBASE_RTDB_URL);
  let idTokenPromise;
  async function writerToken() {
    if (!idTokenPromise) idTokenPromise = (async () => {
      const { auth, projectId } = firebase.getPilotAuth();
      if (projectId !== "well-pump-control") throw new EventBoardMirrorError("configuration_missing");
      const customToken = await auth.createCustomToken("netlify-event-board-writer", {
        siteId: "well-main", deviceId: "tab5-well-main", purpose: "event-board-mirror"
      });
      const response = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken, returnSecureToken: true })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || typeof body?.idToken !== "string") throw new EventBoardMirrorError("writer_auth_failed");
      return body.idToken;
    })();
    return idTokenPromise;
  }
  return {
    async mirror(board, acceptedBoardRevision, receivedAtMs) {
      const token = await writerToken();
      const path = `${rtdbUrl}/v1/sites/well-main/devices/tab5-well-main/currentEventBoard.json?auth=${encodeURIComponent(token)}`;
      const payload = { ...board, receivedAtMs, acceptedBoardRevision,
        openEventCount: Object.keys(board.openEvents).length };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const currentResponse = await fetchImpl(path, { method: "GET", headers: { "X-Firebase-ETag": "true" } });
        const current = await currentResponse.json().catch(() => null);
        if (!currentResponse.ok) throw new EventBoardMirrorError("mirror_read_failed");
        const currentRevision = current?.acceptedBoardRevision;
        if (Number.isInteger(currentRevision) && currentRevision > acceptedBoardRevision) return { superseded: true };
        if (currentRevision === acceptedBoardRevision) {
          const comparableCurrent = current && current.openEventCount === 0 && current.openEvents === undefined
            ? { ...current, openEvents: {} } : current;
          if (stableJson(comparableCurrent) !== stableJson(payload)) throw new EventBoardMirrorError("mirror_conflict");
          return { duplicate: true };
        }
        const etag = currentResponse.headers.get("etag");
        if (!etag) throw new EventBoardMirrorError("mirror_etag_missing");
        const write = await fetchImpl(path, {
          method: "PUT", headers: { "Content-Type": "application/json", "If-Match": etag },
          body: JSON.stringify(payload)
        });
        await write.json().catch(() => null);
        if (write.status === 412) continue;
        if (!write.ok) throw new EventBoardMirrorError("mirror_write_failed");
        return { written: true };
      }
      throw new EventBoardMirrorError("mirror_changed");
    }
  };
}

module.exports = { EventBoardMirrorError, createEventBoardMirror };
