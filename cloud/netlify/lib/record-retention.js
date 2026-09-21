"use strict";

// Retention for durable observations.
//
// STATUS: planning is implemented and testable; applyRetention is a STUB that
// deletes nothing. Nothing here runs until an owner wires it to a route.
//
// Why this exists. Deleting the whole observations collection used to be the
// cleanup, and that is no longer acceptable: the tank series lives in these
// records and nowhere else. So cleanup is now two rules against one collection.
//
//   1. Everything before the tank model started reporting is worthless and goes.
//      The boundary is not a date to remember - it is the first record that
//      actually carries the anchor field, read from the data itself.
//   2. After that boundary the volume problem is the ShellyEMAvailable flap: a
//      single lost EM poll writes a false record and a true record, and on
//      2026-09-20 that was 3564 of 3728 records, 95.6% of the day. Those are
//      excess AS EVENTS, but they are not empty - every durable record carries
//      the whole logging-enabled field set, so the flap records are also the
//      carriers of the tank samples. Deleting them by reason alone would throw
//      away the history this function exists to protect.
//
// So rule 2 is decimation in TIME, not deletion by reason. Keep everything that
// says something, then keep a floor sample of the remainder so the series stays
// continuous. Measured against the 2026-09-20 export:
//
//     floor     kept    of total    worst gap
//     60s        824      22.1%       6.3 min
//     120s       552      14.8%       6.2 min
//     300s       332       8.9%       7.7 min   <- default
//     600s       250       6.7%      12.9 min
//     900s       220       5.9%      18.6 min
//
// The worst gap matters because observation-series carries the tank level
// forward for at most LEVEL_CARRY_LIMIT_MS (20 min) before the chart breaks
// into a gap. The device's own 10-minute heartbeat is what keeps the worst gap
// bounded well under the floor. Every floor above passes the guard, so this is
// a margin choice, not a correctness one: 300s leaves 12.3 min of headroom
// against the carry limit and still removes 11 records in 12, while 900s buys
// only 112 more deletions and leaves 1.4 min - one late heartbeat from a
// broken chart.

const { fieldState } = require("./record-browser");

// Matches PUMP_RUNNING_WATTS in observation-series: idle at the well head is
// about 12 W and the motor runs at about 2900 W, so anything between separates
// them. Kept in step with that module on purpose - a record the series counts
// as a pump start must never be a record retention threw away.
const PUMP_RUNNING_WATTS = 500;

// observation-series.LEVEL_CARRY_LIMIT_MS. Duplicated as a ceiling rather than
// imported as a target: this is the line the plan must not cross, and crossing
// it is a refusal, not a warning.
const LEVEL_CARRY_LIMIT_MS = 20 * 60 * 1000;

const DEFAULT_POLICY = {
  // The field whose first appearance is the epoch. Everything strictly earlier
  // is deleted. If no record carries it, NOTHING is deleted - see planRetention.
  anchorField: "TankWaterGallons",
  floorMs: 5 * 60 * 1000,
  pumpRunningWatts: PUMP_RUNNING_WATTS,
  maxGapMs: LEVEL_CARRY_LIMIT_MS,
  // A plan that wants to delete more than this fraction is returned unsafe and
  // must be acknowledged explicitly. The expected figure is ~0.9; a sudden 0.99
  // means the anchor moved or the package changed, not that cleanup got better.
  maxDeleteFraction: 0.97
};

function observedMs(record) {
  const raw = record?.schemaVersion === 2 ? record?.time?.observedAt : record?.observedAt;
  if (!raw) return null;
  if (typeof raw === "string") { const ms = Date.parse(raw); return Number.isFinite(ms) ? ms : null; }
  if (typeof raw.toDate === "function") return raw.toDate().getTime();
  if (raw instanceof Date) return raw.getTime();
  return null;
}

function available(record, name) {
  const state = fieldState(record, name);
  return state?.state === "available" ? state : null;
}

// A record says something in its own right when it was published for a reason
// other than the EM flap, or when it was taken while the pump was running.
//
// Pump cycles are kept at FULL resolution deliberately. They are a few minutes a
// day, they are what the water-used and short-cycle analysis is computed from,
// and decimating them would change answers rather than just coarsen a chart.
function significant(record, policy) {
  const reasons = Array.isArray(record?.triggerReasons) ? record.triggerReasons : [];
  const flapOnly = reasons.length > 0 && reasons.every(
    reason => reason?.kind === "change" && reason?.field === "ShellyEMAvailable");
  if (reasons.length === 0 || !flapOnly) return true;   // heartbeat, delta, event boundary
  if (record?.recordType && record.recordType !== "observation") return true;

  const contactor = available(record, "ContactorFlag");
  if (contactor?.value === true) return true;
  const watts = available(record, "PumpWatts");
  if (typeof watts?.value === "number" && watts.value > policy.pumpRunningWatts) return true;
  return false;
}

// The first record carrying the anchor field as an available value. Records are
// scanned in observation-time order; the anchor record itself is always kept.
function findAnchor(records, policy = DEFAULT_POLICY) {
  for (const record of records) {
    if (observedMs(record) === null) continue;
    if (available(record, policy.anchorField)) return record;
  }
  return null;
}

// Build a delete plan. Pure: reads records, writes nothing, decides nothing
// about how deletion would be executed.
//
// `records` is one page of observations, ascending by observation time.
//
// PAGING. The collection is far too large to delete in one invocation - see
// applyRetention - so this has to be callable page by page. Two pieces of state
// cross a page boundary and both are wrong if dropped:
//
//   - `lastKeptMs`, the floor clock. Restarting it per page keeps a spurious
//     extra record at every boundary, which is harmless, and more importantly
//     LOSING it after a resume would let the floor run from zero and keep the
//     first record of each page forever. Carried in, returned in continuation.
//   - `previousSessionId` / `nextSessionId`, because session-edge detection
//     needs the neighbours and a page cannot see past its own ends.
//
// Pass `finalPage: false` and the last record of the page is retained as a
// boundary rather than judged, since its successor is not visible yet. The bias
// is always toward keeping: an extra record costs storage, a wrongly deleted
// one is gone.
//
// The anchor must be computed ONCE over the whole collection and then frozen
// into the checkpoint and passed back in as `anchor`. Re-deriving it per page
// against a partial window computes a later boundary and deletes real history.
function planRetention(records, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...options };
  const finalPage = options.finalPage !== false;
  const ordered = [...records]
    .filter(record => observedMs(record) !== null)
    .sort((left, right) => observedMs(left) - observedMs(right));

  const skipped = records.length - ordered.length;
  const anchor = policy.anchor || findAnchor(ordered, policy);

  // No anchor means the tank model never reported in this window. That is the
  // one case where the historical "just delete it all" instinct is most wrong
  // and most tempting, so it is a hard refusal rather than a full sweep.
  if (!anchor) {
    return {
      safe: false, refusal: "anchor_absent", anchorField: policy.anchorField,
      anchorTime: null, keep: [], delete: [], skipped,
      stats: { total: records.length, keep: 0, delete: 0, preAnchor: 0, excess: 0 }
    };
  }

  const anchorMs = observedMs(anchor);
  const keep = [];
  const remove = [];
  let preAnchor = 0;
  let lastKeptMs = Number.isFinite(options.lastKeptMs) ? options.lastKeptMs : null;

  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index];
    const ms = observedMs(record);
    if (ms < anchorMs) { remove.push({ record, reason: "pre-anchor" }); preAnchor += 1; continue; }

    // Session edges are structural: restart reconciliation reads the first and
    // last record of a session, so neither is ever decimated.
    //
    // A neighbour the caller did not supply is UNKNOWN, not absent. Treating
    // unknown as a session change would relabel every resumed page head as a
    // session start. Unknown still keeps the record - a page boundary is not a
    // place to guess - but it is reported as page-edge, so a run's output can
    // be read without the paging artefacts masquerading as device restarts.
    const head = index === 0;
    const tail = index === ordered.length - 1;
    const resuming = Number.isFinite(options.lastKeptMs) || options.previousSessionId !== undefined;
    const beforeUnknown = head && options.previousSessionId === undefined && resuming;
    const afterUnknown = tail && !finalPage && options.nextSessionId === undefined;
    const unknownNeighbour = beforeUnknown || afterUnknown;

    // On the final page the last record genuinely has no successor, so it is a
    // real session end rather than an unknown.
    const before = head ? (options.previousSessionId ?? null) : ordered[index - 1]?.sessionId;
    const after = tail ? (finalPage ? null : (options.nextSessionId ?? null)) : ordered[index + 1]?.sessionId;
    const edge = !unknownNeighbour && Boolean(record.sessionId) &&
      (record.sessionId !== before || record.sessionId !== after);
    const says = significant(record, policy);

    if (says || edge || unknownNeighbour || lastKeptMs === null || ms - lastKeptMs >= policy.floorMs) {
      keep.push({
        record,
        reason: says ? "significant" : edge ? "session-edge"
          : unknownNeighbour ? "page-edge" : "floor"
      });
      lastKeptMs = ms;
      continue;
    }
    remove.push({ record, reason: "excess" });
  }

  // Never delete the newest record: the browser and the board read from the
  // tail. Only meaningful on the final page; earlier pages keep their last
  // record as a page-edge anyway.
  const newest = ordered.at(-1);
  if (finalPage) {
    const newestIndex = remove.findIndex(item => item.record === newest);
    if (newestIndex >= 0) { keep.push({ record: newest, reason: "tail" }); remove.splice(newestIndex, 1); }
  }

  // The gap is measured from the carry-in floor clock so a resumed run cannot
  // hide a gap that straddles a page boundary.
  const keptMs = keep.map(item => observedMs(item.record)).sort((a, b) => a - b);
  const gapFrom = Number.isFinite(options.lastKeptMs) ? [options.lastKeptMs, ...keptMs] : keptMs;
  const maxGapMs = gapFrom.slice(1).reduce((worst, ms, index) => Math.max(worst, ms - gapFrom[index]), 0);
  const fraction = ordered.length ? remove.length / ordered.length : 0;

  // The volume guard is a whole-collection property. Per page it is noise, so a
  // paged caller runs a full dry pass first and disables it here.
  const checkFraction = options.evaluateFraction !== false;
  const refusal =
    maxGapMs > policy.maxGapMs ? "gap_exceeds_carry_limit" :
    (checkFraction && fraction > policy.maxDeleteFraction) ? "delete_fraction_exceeds_limit" : null;

  return {
    safe: refusal === null, refusal,
    anchorField: policy.anchorField, anchorTime: new Date(anchorMs).toISOString(),
    anchorRecordId: anchor.recordId || null,
    floorMs: policy.floorMs, maxGapMs, skipped, finalPage,
    keep, delete: remove,
    // Feed straight back into the next page's options after checkpointing.
    continuation: {
      lastKeptMs,
      previousSessionId: newest?.sessionId ?? options.previousSessionId ?? null,
      lastObservedMs: newest ? observedMs(newest) : (options.lastObservedMs ?? null),
      lastRecordId: newest?.recordId ?? null
    },
    stats: {
      total: ordered.length, keep: keep.length, delete: remove.length,
      preAnchor, excess: remove.length - preAnchor,
      deleteFraction: Number(fraction.toFixed(4))
    }
  };
}

// Where a resumable run keeps its place. One document, so a restart is a read.
const CHECKPOINT_PATH = "sites/well-main/maintenance/recordRetention";

// STUB. Deletes nothing.
//
// This CANNOT be a single synchronous function invocation, and that is a
// property of the data rather than a matter of tuning. firestore.indexes.json
// carries 9 composite indexes on observations, and with no fieldOverrides
// Firestore also auto-indexes every field of every document - including all
// ~26 fields.* entries each durable record carries. A delete is charged for
// removing every one of those index entries, so deletion here is index-write
// bound, not document bound, and tens of thousands of records will not clear
// inside a request timeout. A Netlify background function (the -background
// name suffix) buys 15 minutes instead of 10 seconds and still may not finish.
//
// So the executor is a RESUMABLE CURSOR, not a sweep:
//
//   - keep progress in CHECKPOINT_PATH: { state, policyHash, anchorTime,
//     anchorRecordId, cursor: { observedMs, recordId }, continuation,
//     counters: { scanned, deleted, kept }, startedAt, updatedAt }
//   - each invocation resumes from cursor, reads one page ascending by
//     observation time, calls planRetention with finalPage:false and the
//     stored continuation, deletes that page's plan.delete, then writes the
//     cursor and continuation back BEFORE returning
//   - stop on a wall-clock budget well inside the platform limit, not on a
//     record count, and report { done: false } so a caller can re-invoke
//   - freeze the anchor on the first invocation and refuse to run if the
//     stored policyHash no longer matches the requested policy: a policy
//     changed mid-run would apply two different rules to one collection
//   - delete in batches well under Firestore's 500-write cap; with this index
//     load smaller batches (100-200) fail less often and resume more cheaply
//   - re-running is safe by construction: a deleted record cannot be planned
//     again, and the cursor only moves forward
//
// Before any of that is written:
//
//   - require the owner token the other mutation routes require
//     (tokenMatches(getHeader(event.headers, "x-pilot-key"), env.PILOT_INGEST_TOKEN))
//   - run a full dry pass first to agree the real numbers, then execute with
//     evaluateFraction:false per page since the volume guard is whole-collection
//   - refuse unless plan.safe, and require an explicit confirm flag on top
//   - export the doomed records to CSV first and verify the file before deleting
//   - scope strictly to sites/well-main/observations. eventRecords is a separate
//     collection with its own history and is NOT in scope here.
//
// Worth deciding before rather than after: adding fieldOverrides to exempt the
// fields.* map from single-field indexing would make this cleanup and every
// ingest write substantially cheaper. Nothing queries those subfields - the
// browser filters on deviceId, schemaVersion, observation time and session.
function applyRetention(plan, options = {}) {
  void plan; void options;
  throw new Error("record-retention.applyRetention is a stub: no deletion is implemented");
}

module.exports = {
  CHECKPOINT_PATH,
  DEFAULT_POLICY, LEVEL_CARRY_LIMIT_MS, PUMP_RUNNING_WATTS,
  applyRetention, findAnchor, planRetention,
  _observedMs: observedMs, _significant: significant
};
