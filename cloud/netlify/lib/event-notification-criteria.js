"use strict";

// Authoritative notification criteria. This table, and nothing else, decides whether an
// event open or close is delivered. It is cloud-side on purpose: changing it is an edit
// here plus a deploy - no package republish, no runtime release, no device restart.
//
// The `web` blocks in the V3 authoring package carry the same intent so the package reads
// completely on its own, but they are stripped at compile and never reach the device or
// this function. The two copies can drift silently and nothing reports it. This copy wins.
// Rows are issue #24, "Notification criteria".
//
// Muting P001 and P013 at departure - the pump should go to zero runs over the winter - is
// two `open: false` edits below and a deploy. No package change, no device involvement.

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

function notificationDecision(eventDefinitionId, recordType) {
  if (recordType !== "event-open" && recordType !== "event-close") {
    return { send: false, criteria: "not-an-event", transition: null };
  }
  const transition = recordType === "event-open" ? "open" : "close";
  const listed = typeof eventDefinitionId === "string" && Object.hasOwn(CRITERIA, eventDefinitionId)
    ? CRITERIA[eventDefinitionId] : null;
  return { send: (listed || UNKNOWN_DEFAULT)[transition], criteria: listed ? "table" : "unknown", transition };
}

module.exports = { CRITERIA, UNKNOWN_DEFAULT, notificationDecision };
