"use strict";

// Whether an event open or close is delivered, and what it says, comes from the event's own
// notification settings (its `web` block) in the release the device reported on the record.
// The compiler strips `web` from the runtime package, but every release in Firestore keeps
// its full authoring package, and the record's rulesRelease names exactly the one the Tab5
// ran. So the editor's Notify on open/close and Open/Close message are what gets sent.
//
// The table below is the fallback, used only when that release or event cannot be read -
// a Firestore failure, a hash mismatch, or a release older than its web block. Rows are
// issue #24, "Notification criteria".

const CRITERIA = {
  W07: { open: true, close: true },    // the one latch; the close means someone restarted Tab5
  W02: { open: true, close: true },    // the leak case; the close means pressure recovered
  W08: { open: true, close: true },
  W09: { open: true, close: true },
  E002: { open: true, close: false },  // fires alongside W09 between 100 and 500 W
  W01: { open: true, close: false },   // in winter every open is news; the close is not
  P001: { open: true, close: false },  // mute at departure
  P013: { open: true, close: true },   // mute at departure; the close carries how long it ran
  W06: { open: true, close: true },
  W03: { open: true, close: true },    // the close is news: the lock expired on its own
  W04: { open: true, close: true },
  W05: { open: true, close: true },
  H001: { open: true, close: true },
  E006: { open: true, close: true },   // touches the pump; the close says water is back
  E007: { open: true, close: true },
  M001: { open: false, close: false }, // the operator just pressed it
  T010: { open: true, close: false },  // the test events inhibit, so an open must be visible
  T020: { open: true, close: false },
  T030: { open: true, close: false },
  T040: { open: true, close: false }
};

// An ID absent from the table is delivered on both transitions and marked "unknown" on the
// record. An event nobody sees is the failure #20 exists to fix, so an unlisted ID is loud
// rather than silent.
const UNKNOWN_DEFAULT = { open: true, close: true };

// The event's web block from the release the record names, or null when it cannot be
// trusted: absent, a different package than the device reported, or malformed.
function releaseNotificationPolicy(release, record) {
  const reported = record?.rulesRelease;
  if (!release || typeof release !== "object" || !reported) return null;
  if (release.releaseId !== reported.releaseId || release.contentHash !== reported.contentHash) return null;
  const events = release.authoringPackage?.events;
  if (!Array.isArray(events)) return null;
  const event = events.find(item => item && item.id === record.eventDefinitionId);
  const web = event?.web;
  if (!web || typeof web.notifyOnOpen !== "boolean" || typeof web.notifyOnClose !== "boolean") return null;
  return {
    notifyOnOpen: web.notifyOnOpen, notifyOnClose: web.notifyOnClose,
    openMessage: typeof web.openMessage === "string" ? web.openMessage.trim() : "",
    closeMessage: typeof web.closeMessage === "string" ? web.closeMessage.trim() : ""
  };
}

function notificationDecision(eventDefinitionId, recordType, policy = null) {
  if (recordType !== "event-open" && recordType !== "event-close") {
    return { send: false, criteria: "not-an-event", transition: null };
  }
  const transition = recordType === "event-open" ? "open" : "close";
  if (policy) {
    const send = transition === "open" ? policy.notifyOnOpen : policy.notifyOnClose;
    const message = transition === "open" ? policy.openMessage : policy.closeMessage;
    return { send, criteria: "release", transition, message };
  }
  const listed = typeof eventDefinitionId === "string" && Object.hasOwn(CRITERIA, eventDefinitionId)
    ? CRITERIA[eventDefinitionId] : null;
  return { send: (listed || UNKNOWN_DEFAULT)[transition], criteria: listed ? "table" : "unknown", transition };
}

module.exports = { CRITERIA, UNKNOWN_DEFAULT, notificationDecision, releaseNotificationPolicy };
