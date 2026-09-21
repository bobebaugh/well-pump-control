"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_POLICY, LEVEL_CARRY_LIMIT_MS, applyRetention, findAnchor, planRetention
} = require("../cloud/netlify/lib/record-retention");

const T0 = Date.parse("2026-09-20T04:00:00Z");
const FLAP = [{ kind: "change", field: "ShellyEMAvailable", from: true, to: false }];
// What pilot.py actually emits for the 10-minute heartbeat (pilot.py:5257).
const HEARTBEAT = [{ kind: "maximum-interval" }];
const NO_REASONS = [];

function v2(offsetMs, fields, { reasons = FLAP, sessionId = "boot_a", sequence = 0 } = {}) {
  return {
    recordId: `obs_${sessionId}_${String(sequence).padStart(7, "0")}`,
    schemaVersion: 2, sessionId, cycleSequence: sequence, recordType: "observation",
    time: { observedAt: new Date(T0 + offsetMs).toISOString() },
    triggerReasons: reasons,
    fields: Object.fromEntries(Object.entries(fields).map(([name, value]) =>
      [name, value === null ? { state: "unavailable", reason: "source-unavailable" }
                            : { state: "available", value }]))
  };
}

// A flap record two seconds apart, which is the real cadence, carrying the tank
// sample every consumer actually wants out of it.
function flapSeries(count, { start = 0, stepMs = 2000, gallons = 17.5, sessionId = "boot_a" } = {}) {
  return Array.from({ length: count }, (_, index) =>
    v2(start + index * stepMs, { TankWaterGallons: gallons, PumpWatts: 12 },
       { sessionId, sequence: index }));
}

test("the anchor is the first record carrying the field, not a remembered date", () => {
  const records = [
    v2(0, { PumpWatts: 12 }),
    v2(2000, { PumpWatts: 12 }),
    v2(4000, { TankWaterGallons: 17.5, PumpWatts: 12 }),
    v2(6000, { TankWaterGallons: 17.4, PumpWatts: 12 })
  ];
  assert.equal(findAnchor(records).recordId, records[2].recordId);

  const plan = planRetention(records, { floorMs: 300000 });
  assert.equal(plan.anchorTime, new Date(T0 + 4000).toISOString());
  assert.equal(plan.stats.preAnchor, 2);
  assert.deepEqual(plan.delete.map(item => item.reason), ["pre-anchor", "pre-anchor"]);
});

test("an unavailable anchor value does not count as the field showing up", () => {
  const records = [
    v2(0, { TankWaterGallons: null, PumpWatts: 12 }),
    v2(2000, { TankWaterGallons: 17.5, PumpWatts: 12 })
  ];
  assert.equal(findAnchor(records).recordId, records[1].recordId);
});

test("no anchor anywhere is a refusal, never a full sweep", () => {
  const plan = planRetention(flapSeries(50), { anchorField: "NoSuchField" });
  assert.equal(plan.safe, false);
  assert.equal(plan.refusal, "anchor_absent");
  assert.equal(plan.delete.length, 0);
  assert.equal(plan.stats.total, 50);
});

test("flap records are decimated to the floor, not deleted for being flap", () => {
  // Ten minutes of pure flap at 2s: 300 records, all carrying tank samples.
  // maxDeleteFraction is disabled to isolate decimation from the volume guard.
  const plan = planRetention(flapSeries(300), { floorMs: 300000, maxDeleteFraction: 1 });
  assert.equal(plan.stats.total, 300);
  // First, one at +5min, one at +10min: the series survives at floor spacing.
  assert.equal(plan.stats.keep, 3);
  assert.ok(plan.maxGapMs <= 300000, `worst gap ${plan.maxGapMs}ms`);
  assert.equal(plan.safe, true);
});

test("an empty reason list is unrecognised, and kept rather than decimated", () => {
  const records = flapSeries(300);
  records[100].triggerReasons = NO_REASONS;
  const plan = planRetention(records, { floorMs: 300000, maxDeleteFraction: 1 });
  assert.ok(plan.keep.some(item => item.record.recordId === records[100].recordId));
});

test("a record published for any other reason is kept whatever the floor", () => {
  const records = flapSeries(300);
  records[100].triggerReasons = [{ kind: "delta", field: "SupplyVoltage", from: 250, to: 253, threshold: 2 }];
  records[150].triggerReasons = HEARTBEAT;
  records[200].triggerReasons = [{ kind: "event-boundary", transition: "open", eventKey: "H001" }];

  const plan = planRetention(records, { floorMs: 300000 });
  const kept = new Set(plan.keep.map(item => item.record.recordId));
  for (const index of [100, 150, 200]) assert.ok(kept.has(records[index].recordId), `index ${index}`);
});

test("pump cycles keep full resolution; decimating them would change answers", () => {
  const records = flapSeries(300);
  // A 60-second run in the middle, at the cadence, above the running threshold.
  for (let index = 100; index < 130; index += 1) {
    records[index].fields.PumpWatts = { state: "available", value: 2900 };
    records[index].fields.ContactorFlag = { state: "available", value: true };
  }
  const plan = planRetention(records, { floorMs: 300000 });
  const kept = new Set(plan.keep.map(item => item.record.recordId));
  for (let index = 100; index < 130; index += 1) {
    assert.ok(kept.has(records[index].recordId), `pump sample ${index} was decimated`);
  }
});

test("ContactorFlag true is kept even when the motor is not drawing", () => {
  // The flag leads power by about two seconds, and an inhibited cycle draws
  // nothing at all. Both are evidence and neither is excess.
  const records = flapSeries(300);
  records[120].fields.ContactorFlag = { state: "available", value: true };
  const plan = planRetention(records, { floorMs: 300000 });
  assert.ok(plan.keep.some(item => item.record.recordId === records[120].recordId));
});

test("session edges survive, so restart reconciliation still has both ends", () => {
  const records = [...flapSeries(120, { sessionId: "boot_a" }),
                   ...flapSeries(120, { sessionId: "boot_b", start: 240000 })];
  const plan = planRetention(records, { floorMs: 300000 });
  const kept = new Set(plan.keep.map(item => item.record.recordId));
  assert.ok(kept.has(records[0].recordId), "first of session a");
  assert.ok(kept.has(records[119].recordId), "last of session a");
  assert.ok(kept.has(records[120].recordId), "first of session b");
  assert.ok(kept.has(records[239].recordId), "last of session b");
});

test("the newest record is never deleted", () => {
  const plan = planRetention(flapSeries(300), { floorMs: 300000 });
  const newest = plan.keep.find(item => item.reason === "tail" || item.reason === "session-edge");
  assert.ok(newest, "the tail is retained");
  assert.ok(!plan.delete.some(item => item.record.cycleSequence === 299));
});

test("a plan that would outrun the chart's carry limit refuses", () => {
  // No heartbeat and a floor past the carry limit: the kept series would gap.
  const plan = planRetention(flapSeries(2000), { floorMs: LEVEL_CARRY_LIMIT_MS + 60000 });
  assert.equal(plan.safe, false);
  assert.equal(plan.refusal, "gap_exceeds_carry_limit");
});

test("the 10-minute heartbeat is what keeps a coarse floor safe", () => {
  // Same floor as the refusal above, but with the device's real heartbeat every
  // 300 cycles (10 min at 2s). The heartbeat alone holds the series together.
  const records = flapSeries(2000);
  for (let index = 0; index < records.length; index += 300) records[index].triggerReasons = HEARTBEAT;
  const plan = planRetention(records, { floorMs: LEVEL_CARRY_LIMIT_MS + 60000, maxDeleteFraction: 1 });
  assert.equal(plan.safe, true);
  assert.ok(plan.maxGapMs <= LEVEL_CARRY_LIMIT_MS, `worst gap ${plan.maxGapMs}ms`);
});

test("an implausible delete fraction is refused rather than run", () => {
  // The gap guard is satisfied by the heartbeat, so the volume guard is what
  // this exercises: the plan is geometrically fine and still too greedy.
  const records = flapSeries(3000);
  for (let index = 0; index < records.length; index += 300) records[index].triggerReasons = HEARTBEAT;
  const plan = planRetention(records, { floorMs: 300000, maxDeleteFraction: 0.5 });
  assert.ok(plan.maxGapMs <= LEVEL_CARRY_LIMIT_MS, `worst gap ${plan.maxGapMs}ms`);
  assert.equal(plan.safe, false);
  assert.equal(plan.refusal, "delete_fraction_exceeds_limit");
});

test("records without a usable observation time are skipped, not deleted", () => {
  const records = flapSeries(10);
  delete records[3].time;
  const plan = planRetention(records, { floorMs: 300000 });
  assert.equal(plan.skipped, 1);
  assert.equal(plan.stats.total, 9);
  assert.ok(!plan.delete.some(item => item.record === records[3]));
});

test("planning is pure: it reports, it does not act", () => {
  const records = flapSeries(300);
  const before = JSON.stringify(records);
  planRetention(records, { floorMs: 300000 });
  assert.equal(JSON.stringify(records), before);
});

test("applyRetention is a stub and deletes nothing", () => {
  assert.throws(() => applyRetention({ safe: true, delete: [] }), /stub/);
});

test("the default policy is the reviewed one", () => {
  assert.equal(DEFAULT_POLICY.anchorField, "TankWaterGallons");
  assert.equal(DEFAULT_POLICY.floorMs, 300000);
  assert.equal(DEFAULT_POLICY.maxGapMs, LEVEL_CARRY_LIMIT_MS);
});

// --- Resumption -----------------------------------------------------------
// The collection cannot be cleared in one invocation, so the planner has to
// survive being stopped and restarted. These pin the state that crosses a page.

test("paging with carried state matches planning the whole window at once", () => {
  const records = flapSeries(900);
  for (let index = 0; index < records.length; index += 300) records[index].triggerReasons = HEARTBEAT;
  const whole = planRetention(records, { floorMs: 300000, maxDeleteFraction: 1 });

  const pages = [records.slice(0, 300), records.slice(300, 600), records.slice(600)];
  let carry = {};
  const kept = [];
  const deleted = [];
  pages.forEach((page, index) => {
    const finalPage = index === pages.length - 1;
    const plan = planRetention(page, {
      floorMs: 300000, evaluateFraction: false, finalPage,
      anchor: whole.keep[0].record,
      nextSessionId: finalPage ? undefined : pages[index + 1][0].sessionId,
      ...carry
    });
    kept.push(...plan.keep.map(item => item.record.recordId));
    deleted.push(...plan.delete.map(item => item.record.recordId));
    carry = plan.continuation;
  });

  // The invariant is one-directional and it is the one that matters: paging
  // may retain more at a boundary, but it must never delete a record the
  // whole-window plan would have kept.
  const wholeDeleted = new Set(whole.delete.map(item => item.record.recordId));
  for (const id of deleted) assert.ok(wholeDeleted.has(id), `${id} deleted only when paged`);
  assert.ok(deleted.length <= whole.stats.delete);
  assert.equal(new Set(kept).size + deleted.length, records.length);
  // Here the boundaries land on heartbeats, which both paths keep anyway.
  assert.equal(deleted.length, whole.stats.delete);
});

test("dropping the floor clock between pages would keep the page head; carrying it does not", () => {
  const page = flapSeries(150, { start: 60000 });
  const withoutCarry = planRetention(page, { floorMs: 300000, evaluateFraction: false, anchor: page[0] });
  const withCarry = planRetention(page, {
    floorMs: 300000, evaluateFraction: false, anchor: page[0],
    previousSessionId: "boot_a",
    lastKeptMs: T0 + 59000   // a record was kept one second before this page
  });
  // With no carry-in this is the start of the collection, so the head is a
  // genuine session start and is kept for that reason.
  assert.equal(withoutCarry.keep[0].reason, "session-edge");
  assert.ok(withCarry.stats.keep < withoutCarry.stats.keep,
    "the carried floor suppresses the duplicate head sample");
});

test("a gap straddling a page boundary is still caught", () => {
  const page = flapSeries(10, { start: 40 * 60 * 1000 });
  const plan = planRetention(page, {
    floorMs: 300000, evaluateFraction: false, anchor: page[0],
    lastKeptMs: T0   // 40 minutes since anything was kept
  });
  assert.equal(plan.safe, false);
  assert.equal(plan.refusal, "gap_exceeds_carry_limit");
});

test("a partial page retains its last record, whose successor is not visible", () => {
  const page = flapSeries(150);
  const plan = planRetention(page, {
    floorMs: 300000, evaluateFraction: false, anchor: page[0], finalPage: false
  });
  assert.equal(plan.keep.at(-1).record.recordId, page.at(-1).recordId);
  assert.equal(plan.keep.at(-1).reason, "page-edge",
    "an unseen successor is a paging artefact, not a session end");
  assert.equal(plan.continuation.lastRecordId, page.at(-1).recordId);
  assert.equal(plan.continuation.lastKeptMs, T0 + 149 * 2000);
});

test("the continuation carries the session across the boundary", () => {
  const page = flapSeries(50, { sessionId: "boot_b" });
  const plan = planRetention(page, { floorMs: 300000, evaluateFraction: false, anchor: page[0], finalPage: false });
  assert.equal(plan.continuation.previousSessionId, "boot_b");

  // Fed back in, the next page's head is not mistaken for a session start.
  const next = flapSeries(50, { sessionId: "boot_b", start: 100000 });
  const second = planRetention(next, {
    floorMs: 300000, evaluateFraction: false, anchor: page[0], finalPage: false,
    ...plan.continuation, nextSessionId: "boot_b"
  });
  // Same session, floor not yet elapsed, both neighbours known: the head is
  // ordinary excess and nothing in this page survives.
  assert.ok(second.keep.every(item => item.reason !== "session-edge"));
  assert.equal(second.delete[0].record.recordId, next[0].recordId);
});

test("the volume guard can be disabled per page but the gap guard cannot", () => {
  const page = flapSeries(2000);
  const plan = planRetention(page, { floorMs: 300000, evaluateFraction: false, anchor: page[0] });
  assert.equal(plan.stats.deleteFraction > 0.97, true);
  assert.equal(plan.safe, true, "volume guard is off");

  const gapped = planRetention(page, {
    floorMs: LEVEL_CARRY_LIMIT_MS + 60000, evaluateFraction: false, anchor: page[0]
  });
  assert.equal(gapped.refusal, "gap_exceeds_carry_limit", "gap guard still applies");
});
