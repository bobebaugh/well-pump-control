"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin/firestore");
const {
  LEVEL_CARRY_LIMIT_MS, REFERENCE_DELIVERY, WINDOWS, buildSeries, deliveryFromFills, levelTrace,
  pumpCycles, pumpDeliveryGpm, quietStretches, recordField, samplesFromRecords, switchSummary,
  tankModelFromDraft, tankWaterGallons
} = require("../cloud/netlify/lib/observation-series");
const { createHandler } = require("../cloud/netlify/functions/observation-series");

// The live package's calc-tank parameters.
const MODEL = { effectiveTankGallons: 79.3, prechargeGaugePsi: 38, atmosphericPressurePsi: 13.07 };
const T0 = Date.parse("2026-09-16T12:00:00Z");

function v2(timeMs, fields) {
  return {
    schemaVersion: 2,
    time: { observedAt: new Date(timeMs).toISOString() },
    fields: Object.fromEntries(Object.entries(fields).map(([name, value]) =>
      [name, value === null ? { state: "unavailable", reason: "source-unavailable" }
                            : { state: "available", value }]))
  };
}

test("tank water follows Boyle's law on the precharged air volume", () => {
  // Air occupies 79.3 * (38 + 13.07) / (49.8 + 13.07) = 64.42 gal at 49.8 psi.
  assert.equal(tankWaterGallons(49.8, MODEL).toFixed(2), "14.88");
  // The working band: about 21 gallons between the usual cut-in and cut-out.
  const drawdown = tankWaterGallons(60, MODEL) - tankWaterGallons(40, MODEL);
  assert.equal(drawdown.toFixed(1), "20.9");
});

test("an empty tank at precharge pressure holds no water, and the model bounds it", () => {
  assert.equal(tankWaterGallons(38, MODEL), 0);
  // Below precharge the bladder is against the wall; the model cannot go negative.
  assert.equal(tankWaterGallons(20, MODEL), null);
  assert.equal(tankWaterGallons(50, null), null);
  assert.equal(tankWaterGallons(null, MODEL), null);
});

test("a tank model is only accepted when every parameter is present and numeric", () => {
  assert.deepEqual(tankModelFromDraft([{ id: "calc-tank", parameters: MODEL }]), MODEL);
  assert.equal(tankModelFromDraft([{ id: "calc-tank", parameters: { effectiveTankGallons: 79.3 } }]), null);
  assert.equal(tankModelFromDraft([{ id: "calc-pressure" }]), null);
  assert.equal(tankModelFromDraft(null), null);
});

test("fields are read from both record schemas", () => {
  assert.equal(recordField(v2(T0, { PumpWatts: 2800 }), "PumpWatts"), 2800);
  assert.equal(recordField(v2(T0, { PumpWatts: null }), "PumpWatts"), null);
  assert.equal(recordField({ schemaVersion: 1, values: { PumpWatts: 12 } }, "PumpWatts"), 12);
  assert.equal(recordField({ schemaVersion: 1, values: {}, status: {} }, "PumpWatts"), null);
});

test("the recorded gallons output is preferred, with pressure as the fallback", () => {
  const [recorded, derived] = samplesFromRecords([
    v2(T0, { TankWaterGallons: 17.5, PressurePSI: 49.8 }),
    v2(T0 + 1000, { TankWaterGallons: null, PressurePSI: 49.8 })
  ], MODEL);
  assert.equal(recorded.gallons, 17.5);
  assert.equal(derived.gallons.toFixed(2), "14.88");
});

test("records without a usable observation time are dropped, and the rest are ordered", () => {
  const samples = samplesFromRecords([
    v2(T0 + 5000, { TankWaterGallons: 10 }),
    { schemaVersion: 2, time: {}, fields: {} },
    v2(T0, { TankWaterGallons: 20 })
  ], MODEL);
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map(sample => sample.gallons), [20, 10]);
});

test("stored Firestore timestamps are retained for both observation schemas", () => {
  const second = v2(T0 + 5000, { TankWaterGallons: 10 });
  second.time.observedAt = Timestamp.fromMillis(T0 + 5000);
  const first = { schemaVersion: 1, observedAt: Timestamp.fromMillis(T0),
                  values: { TankWaterGallons: 20 } };
  const samples = samplesFromRecords([second, first], MODEL);
  assert.deepEqual(samples.map(sample => [sample.timeMs, sample.gallons]),
                   [[T0, 20], [T0 + 5000, 10]]);
});

function series(samples, bucketMs = 60000, spanMs = 600000) {
  return buildSeries(samples, { startMs: T0, endMs: T0 + spanMs, bucketMs });
}

test("water used counts falls in tank level and ignores the pump refilling it", () => {
  const result = series([
    { timeMs: T0 + 1000, gallons: 24, watts: 12 },
    { timeMs: T0 + 61000, gallons: 20, watts: 12 },
    { timeMs: T0 + 121000, gallons: 23, watts: 2800 }
  ]);
  assert.equal(result.totals.usedGallons, 4);
  // The fall opens one second into the first bucket, so almost all of it lands there.
  assert.equal(result.buckets[0].used, 3.933);
  assert.equal(result.buckets[1].used, 0.067);
  // The rise is not negative consumption.
  assert.equal(result.buckets[2].used, 0);
});

test("a drawdown spanning a bucket edge is split across both buckets", () => {
  const result = series([
    { timeMs: T0 + 30000, gallons: 20, watts: 12 },
    { timeMs: T0 + 90000, gallons: 14, watts: 12 }
  ]);
  assert.equal(result.buckets[0].used, 3);
  assert.equal(result.buckets[1].used, 3);
  assert.equal(result.totals.usedGallons, 6);
});

test("a pump start is counted once per run, not once per record", () => {
  const result = series([
    { timeMs: T0, gallons: 20, watts: 12 },
    { timeMs: T0 + 10000, gallons: 21, watts: 2800 },
    { timeMs: T0 + 20000, gallons: 22, watts: 2790 },
    { timeMs: T0 + 30000, gallons: 23, watts: 2810 },
    { timeMs: T0 + 40000, gallons: 24, watts: 12 },
    { timeMs: T0 + 90000, gallons: 20, watts: 2800 }
  ]);
  assert.equal(result.totals.starts, 2);
  assert.equal(result.buckets[0].starts, 1);
  assert.equal(result.buckets[1].starts, 1);
  // Running from +10s to +40s is 30 seconds of run time.
  assert.equal(result.buckets[0].runSeconds, 30);
});

test("a Shelly dropout mid-run is not a stop, and does not invent a second start", () => {
  // The Sep 15 5:31:25 PM record: PumpWatts and ContactorFlag both unavailable.
  const result = series([
    { timeMs: T0, gallons: 20, watts: 12 },
    { timeMs: T0 + 10000, gallons: 21, watts: 2900 },
    { timeMs: T0 + 20000, gallons: 22, watts: null },
    { timeMs: T0 + 30000, gallons: 23, watts: 2890 },
    { timeMs: T0 + 40000, gallons: 24, watts: 12 }
  ]);
  assert.equal(result.totals.starts, 1);
});

test("the pump is on or off, so one threshold separates the states", () => {
  // Idle at the well head is ~12 W; the motor runs at ~2900 W.
  const result = series([
    { timeMs: T0, gallons: 20, watts: 12.24 },
    { timeMs: T0 + 2000, gallons: 20, watts: 2961.39 },
    { timeMs: T0 + 120000, gallons: 26, watts: 12.2 }
  ]);
  assert.equal(result.totals.starts, 1);
  assert.equal(result.totals.runSeconds, 118);
});

test("run time is attributed to the state the interval opened in", () => {
  const result = series([
    { timeMs: T0, gallons: 20, watts: 2800 },
    { timeMs: T0 + 45000, gallons: 26, watts: 12 }
  ]);
  assert.equal(result.totals.runSeconds, 45);
});

test("a level is carried into silent buckets, but only as far as reporting vouches for it", () => {
  const result = buildSeries(
    [{ timeMs: T0 + 1000, gallons: 18, watts: 12 }],
    { startMs: T0, endMs: T0 + LEVEL_CARRY_LIMIT_MS + 600000, bucketMs: 300000 });
  assert.equal(result.buckets[0].gallons, 18);
  assert.equal(result.buckets[1].gallons, 18);
  // Past the carry limit the chart shows a gap rather than a flat line.
  assert.equal(result.buckets.at(-1).gallons, null);
});

test("the day trace keeps a fill's rise a gallon at a time, where a bucket keeps one reading", () => {
  // The 28 September 4:37-4:43 pm refill: 11.65 to 24.87 gal in about a minute
  // and a half, then settling. All of it falls in one 5-minute bucket.
  const at = seconds => T0 + seconds * 1000;
  const samples = [
    [0, 11.65], [6, 12.78], [10, 13.57], [16, 14.67], [22, 15.76], [28, 16.85], [34, 17.86],
    [40, 18.92], [46, 20.04], [53, 21.05], [59, 22.12], [65, 23.15], [71, 24.18], [75, 24.87],
    [77, 24.47], [81, 24.31], [112, 23.29], [249, 22.28]
  ].map(([seconds, gallons]) => ({ timeMs: at(seconds), gallons }));
  const trace = levelTrace(samples, { startMs: T0, endMs: at(300) });
  assert.deepEqual(trace.map(point => point.gallons),
    [11.65, 12.78, 14.67, 15.76, 16.85, 17.86, 18.92, 20.04, 21.05, 22.12, 23.15, 24.18, 22.28]);
  assert.ok(trace.every((point, index) => !index || Math.abs(point.gallons - trace[index - 1].gallons) >= 1));
  assert.equal(trace[4].timeMs, at(28), "a kept reading keeps its own time");
  const bucketed = buildSeries(samples, { startMs: T0, endMs: at(300), bucketMs: 300000 });
  assert.equal(bucketed.buckets[0].gallons, 22.28);
});

test("the day trace ends its line at an unavailable reading and at a reporting silence", () => {
  const trace = levelTrace([
    { timeMs: T0, gallons: 9.72 },
    { timeMs: T0 + 60000, gallons: 9.7 },
    { timeMs: T0 + 90000, gallons: 0.06 },
    { timeMs: T0 + 120000, gallons: 0.05 },
    { timeMs: T0 + 150000, gallons: null },
    { timeMs: T0 + 600000, gallons: 21 },
    { timeMs: T0 + 600000 + LEVEL_CARRY_LIMIT_MS + 60000, gallons: 21.5 }
  ], { startMs: T0, endMs: T0 + 2 * 3600000 });
  assert.deepEqual(trace, [
    { timeMs: T0, gallons: 9.72 },
    { timeMs: T0 + 90000, gallons: 0.06 },
    // The last reading before the break is kept whatever its step.
    { timeMs: T0 + 120000, gallons: 0.05 },
    { timeMs: T0 + 150000, gallons: null },
    { timeMs: T0 + 600000, gallons: 21 },
    { timeMs: T0 + 600000 + LEVEL_CARRY_LIMIT_MS, gallons: null },
    { timeMs: T0 + 600000 + LEVEL_CARRY_LIMIT_MS + 60000, gallons: 21.5 }
  ]);
});

test("the day trace always ends on the window's latest reading", () => {
  const trace = levelTrace([
    { timeMs: T0, gallons: 21 }, { timeMs: T0 + 60000, gallons: 20.6 }, { timeMs: T0 + 120000, gallons: 20.4 }
  ], { startMs: T0, endMs: T0 + 3600000 });
  assert.deepEqual(trace.map(point => point.gallons), [21, 20.4]);
});

test("an empty window yields empty buckets rather than zeroes on the level", () => {
  const result = series([]);
  assert.equal(result.buckets.length, 10);
  assert.ok(result.buckets.every(bucket => bucket.gallons === null));
  assert.equal(result.totals.latestGallons, null);
  assert.equal(result.totals.usedGallons, 0);
});

test("the configured windows stay a bounded number of buckets", () => {
  assert.equal(WINDOWS["1d"].spanMs / WINDOWS["1d"].bucketMs, 288);
  assert.equal(WINDOWS["7d"].spanMs / WINDOWS["7d"].bucketMs, 168);
});

function handlerFor({ records = [], draft = { items: [{ id: "calc-tank", parameters: MODEL }] } } = {}) {
  const docs = records.map(data => ({ data: () => data }));
  const query = { docs };
  const chain = {
    where: () => chain, orderBy: () => chain, limit: () => chain, select: () => chain,
    get: async () => query
  };
  const site = {
    collection: name => name === "observations"
      ? chain
      : { doc: () => ({ get: async () => ({ exists: Boolean(draft), data: () => draft }) }) }
  };
  return createHandler({
    firestore: () => ({
      projectId: "well-pump-control", databaseId: "(default)",
      db: { collection: () => ({ doc: () => site }) }
    }),
    now: () => T0
  });
}

async function call(options, query = {}) {
  const reply = await handlerFor(options)({ httpMethod: "GET", queryStringParameters: query });
  return { statusCode: reply.statusCode, headers: reply.headers, ...JSON.parse(reply.body) };
}

test("the endpoint serves a bucketed day by default", async () => {
  const reply = await call({ records: [v2(T0 - 60000, { TankWaterGallons: 21, PumpWatts: 12 })] });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.status, "ok");
  assert.equal(reply.window, "1d");
  assert.equal(reply.buckets.length, 288);
  assert.deepEqual(reply.tankModel, MODEL);
  assert.equal(reply.totals.latestGallons, 21);
});

test("the endpoint charts an observation as Firestore returns it", async () => {
  const record = v2(T0 - 60000, { TankWaterGallons: 21, PumpWatts: 12 });
  record.time.observedAt = Timestamp.fromMillis(T0 - 60000);
  const reply = await call({ records: [record] });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.status, "ok");
  assert.equal(reply.totals.latestGallons, 21);
  assert.ok(reply.buckets.some(bucket => bucket.gallons === 21));
});

test("the week window is served at its own bucket size", async () => {
  const reply = await call({}, { window: "7d" });
  assert.equal(reply.buckets.length, 168);
  assert.equal(reply.status, "empty");
  assert.equal(reply.levelTrace, undefined, "only the day carries the reading-time trace");
});

test("the day carries the tank trace at the readings' own times", async () => {
  const reply = await call({ records: [
    v2(T0 - 120000, { TankWaterGallons: 12, PumpWatts: 2900 }),
    v2(T0 - 114000, { TankWaterGallons: 13.2, PumpWatts: 2900 }),
    v2(T0 - 110000, { TankWaterGallons: 13.5, PumpWatts: 2900 })
  ] });
  assert.deepEqual(reply.levelTrace, [
    { timeMs: T0 - 120000, gallons: 12 }, { timeMs: T0 - 114000, gallons: 13.2 }, { timeMs: T0 - 110000, gallons: 13.5 }
  ]);
});

test("an unknown window is rejected rather than silently served as a day", async () => {
  const reply = await call({}, { window: "90d" });
  assert.equal(reply.statusCode, 400);
  assert.equal(reply.code, "invalid_window");
});

test("only GET is served", async () => {
  const reply = await handlerFor()({ httpMethod: "POST" });
  assert.equal(reply.statusCode, 405);
  assert.equal(reply.headers.Allow, "GET");
});

test("history is cached briefly so the two-second live poll does not drag it along", async () => {
  const day = await call({});
  const week = await call({}, { window: "7d" });
  assert.equal(day.headers["Cache-Control"], "public, max-age=60");
  assert.equal(week.headers["Cache-Control"], "public, max-age=300");
});

test("a missing tank draft degrades the live reading, not the recorded history", async () => {
  const reply = await call({
    draft: null,
    records: [v2(T0 - 60000, { TankWaterGallons: 19, PumpWatts: 12 })]
  });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.tankModel, null);
  assert.equal(reply.totals.latestGallons, 19);
});

test("the reply carries the precharge disagreement the gallons output cannot show", async () => {
  const reply = await call({});
  assert.equal(reply.prechargeCheck.stored, 38);
  // No completed cycle in this fixture, so nothing is implied and nothing is claimed.
  assert.equal(reply.prechargeCheck.implied, null);
  assert.equal(reply.prechargeCheck.deltaPsi, null);
});

test("energy is reported unavailable, because no record has ever carried it", async () => {
  const reply = await call({});
  assert.equal(reply.energyAvailable, false);
});


// A pump cycle as the records actually carry one: settled idle, the fill, then
// settled idle again. The sensor reads discharge pressure through the run, so a
// realistic fixture has to bracket it with readings that are not dynamic.
function cycle(fromPsi, toPsi, bleedGpm = 0, offsetMs = 0) {
  const samples = [];
  const at = second => T0 + offsetMs + second * 1000;
  const psiOf = level =>
    MODEL.effectiveTankGallons * (MODEL.prechargeGaugePsi + MODEL.atmosphericPressurePsi)
      / (MODEL.effectiveTankGallons - level) - MODEL.atmosphericPressurePsi;
  // The dynamic offset appears the instant the pump draws current and is gone
  // once it settles, so it is in the running readings and in neither anchor.
  const OFFSET_PSI = 1.35;

  let level = tankWaterGallons(fromPsi, MODEL);
  let second = 0;
  for (; second < 20; second += 1) {
    samples.push({ timeMs: at(second), gallons: level, psi: psiOf(level), watts: 12 });
  }
  for (; psiOf(level) < toPsi && second < 600; second += 1) {
    const psi = psiOf(level);
    samples.push({ timeMs: at(second), psi: psi + OFFSET_PSI,
                   gallons: tankWaterGallons(psi + OFFSET_PSI, MODEL), watts: 2900 });
    // Water is conserved: a house drawing during the fill makes the tank rise
    // more slowly, it does not merely relabel the level.
    level += (pumpDeliveryGpm(psi, REFERENCE_DELIVERY) - bleedGpm) / 60;
  }
  // The offset does not vanish the instant the contactor opens; it decays with
  // the 5.7 s time constant measured on the 2026-08-26 capture.
  for (let rest = 0; rest < 60; rest += 1, second += 1) {
    const psi = psiOf(level) + OFFSET_PSI * Math.exp(-rest / 5.7);
    samples.push({ timeMs: at(second), gallons: tankWaterGallons(psi, MODEL), psi, watts: 12 });
  }
  return samples;
}

const fill = cycle;

test("delivery never goes negative however far the curve is extrapolated", () => {
  assert.equal(pumpDeliveryGpm(500, REFERENCE_DELIVERY), 0);
  assert.equal(pumpDeliveryGpm(null, REFERENCE_DELIVERY), 0);
});

test("draw during a fill is counted, where the tank's rise alone would hide it", () => {
  const window = { startMs: T0, endMs: T0 + 600000, bucketMs: 300000, curve: REFERENCE_DELIVERY };
  const quiet = buildSeries(cycle(40, 60), window).totals.usedGallons;
  const result = buildSeries(cycle(40, 60, 3), window);
  const drawn = result.totals.usedGallons;
  // Three GPM through the fill is water that counting only the falls in level
  // would have missed entirely, and the figure has to be right, not merely
  // non-zero: closing the cycle before the tank settles undercounts it by about
  // a gallon of still-decaying discharge pressure.
  const expected = 3 * (result.totals.runSeconds / 60);
  assert.ok(drawn - quiet > 4, `expected the draw to show, got ${drawn} against ${quiet}`);
  assert.ok(Math.abs(drawn - expected) < 0.8,
    `expected about ${expected.toFixed(2)} gal drawn, got ${drawn}`);
});

test("the pump's own discharge pressure does not become water used", () => {
  // A cycle with nobody drawing. Every psi of the 1.35 dynamic offset appears
  // as a fall in level the moment the pump cuts; differencing a dynamic reading
  // against a settled one would charge about a gallon of it to consumption.
  const window = { startMs: T0, endMs: T0 + 600000, bucketMs: 300000, curve: REFERENCE_DELIVERY };
  const used = buildSeries(cycle(40, 60), window).totals.usedGallons;
  assert.ok(used < 0.5, `a quiet cycle should use almost nothing, got ${used} gal`);
});

test("the pressure switch is measured, not assumed to be 40/60", () => {
  const window = { startMs: T0, endMs: T0 + 600000, bucketMs: 300000, curve: REFERENCE_DELIVERY };
  // A switch set nowhere near nominal. Nothing in the reading depends on the
  // textbook pair, so an adjusted or drifted switch reports itself.
  const result = buildSeries(cycle(46, 68), window).pressureSwitch;
  assert.equal(result.cycles, 1);
  assert.equal(Math.round(result.cutInPsi), 46);
  // The switch trips on discharge pressure, which sits above where the tank
  // comes to rest, so cut-out and settled are different numbers.
  assert.ok(result.cutOutPsi > result.settledPsi,
    `${result.cutOutPsi} should exceed the settled ${result.settledPsi}`);
  assert.ok(Math.abs(result.cutOutPsi - result.settledPsi - 1.35) < 0.3);
  assert.equal(result.fullPsi, result.settledPsi);
});

test("cut-in implies the precharge, which pressure alone can never check", () => {
  const window = { startMs: T0, endMs: T0 + 600000, bucketMs: 300000, curve: REFERENCE_DELIVERY };
  // A bladder tank is charged 2 psi below cut-in.
  const result = buildSeries(cycle(40, 60), window).pressureSwitch;
  assert.equal(result.impliedPrechargePsi, Number((result.cutInPsi - 2).toFixed(2)));

  // The rule holds wherever the switch is set. A tank in a garage might run
  // 30/50, one feeding an upstairs 40/60 or higher; nothing here is tied to a
  // band, and the 150 psi tank rating is not a full mark for any of them.
  const garage = switchSummary([{ cutInPsi: 30, tripPsi: 51.3, settledPsi: 50 }]);
  assert.equal(garage.impliedPrechargePsi, 28);
  assert.equal(garage.fullPsi, 50);
  const upstairs = switchSummary([{ cutInPsi: 60, tripPsi: 91.3, settledPsi: 90 }]);
  assert.equal(upstairs.impliedPrechargePsi, 58);
});

test("a window with no completed cycle reports no switch reading rather than a default", () => {
  const result = buildSeries([], { startMs: T0, endMs: T0 + 600000,
                                   bucketMs: 300000, curve: REFERENCE_DELIVERY });
  assert.equal(result.pressureSwitch.cycles, 0);
  assert.equal(result.pressureSwitch.cutInPsi, null);
  assert.equal(result.pressureSwitch.fullPsi, null);
  assert.equal(result.pressureSwitch.impliedPrechargePsi, null);
});

test("switch readings average across the cycles in the window", () => {
  const window = { startMs: T0, endMs: T0 + 1800000, bucketMs: 300000, curve: REFERENCE_DELIVERY };
  const result = buildSeries([...cycle(40, 60), ...cycle(42, 62, 0, 600000)], window).pressureSwitch;
  assert.equal(result.cycles, 2);
  assert.equal(Math.round(result.cutInPsi), 41);
});

test("a dropped reading just before a start does not lose the cycle", () => {
  // The record immediately before the pump starts has no tank level -- the
  // 5:31:25 PM case, where the Shelly read failed. The anchor is the last level
  // actually known to be settled, not whichever record happens to sit adjacent.
  const full = cycle(40, 60, 3);
  const firstRun = full.findIndex(sample => sample.watts > 500);
  const gapped = full.map((sample, index) =>
    index === firstRun - 1 ? { ...sample, gallons: null } : sample);
  const window = { startMs: T0, endMs: T0 + 600000, bucketMs: 300000, curve: REFERENCE_DELIVERY };
  const intact = buildSeries(full, window).totals.usedGallons;
  const dropped = buildSeries(gapped, window).totals.usedGallons;
  assert.ok(dropped > 4, `one missing record should not zero the cycle, got ${dropped}`);
  assert.ok(Math.abs(dropped - intact) < 0.3, `${dropped} against ${intact}`);
});

test("a run already under way when the window opens has no settled anchor", () => {
  // Records begin mid-fill, so the earliest level is discharge pressure. There
  // is no honest opening anchor and the cycle is not charged, rather than being
  // anchored on a reading inflated by about a gallon.
  const full = cycle(40, 60);
  const midRun = full.slice(full.findIndex(sample => sample.watts > 500) + 10);
  const result = buildSeries(midRun, { startMs: T0, endMs: T0 + 600000,
                                       bucketMs: 300000, curve: REFERENCE_DELIVERY });
  assert.equal(result.totals.usedGallons, 0);
});

test("a cycle still open at the window edge is not charged on a dynamic reading", () => {
  // The run has started but never settled again, so there is no honest closing
  // anchor and nothing is attributed rather than a guess from discharge pressure.
  const open = cycle(40, 60).filter(sample => sample.watts > 500);
  const result = buildSeries(open, { startMs: T0, endMs: T0 + 600000,
                                     bucketMs: 300000, curve: REFERENCE_DELIVERY });
  assert.equal(result.totals.usedGallons, 0);
  assert.equal(result.totals.starts, 1);
});

test("with the pump off the estimate collapses to the fall in level", () => {
  const result = buildSeries([
    { timeMs: T0, gallons: 24, psi: 60, watts: 12 },
    { timeMs: T0 + 60000, gallons: 20, psi: 55, watts: 12 }
  ], { startMs: T0, endMs: T0 + 300000, bucketMs: 300000, curve: REFERENCE_DELIVERY });
  assert.equal(result.totals.usedGallons, 4);
});

test("pressure comes off the record, or is inverted from gallons when it is not", () => {
  const [recorded, inverted] = samplesFromRecords([
    v2(T0, { PressurePSI: 49.8, TankWaterGallons: 14.88 }),
    v2(T0 + 1000, { TankWaterGallons: 14.88 })
  ], MODEL);
  assert.equal(recorded.psi, 49.8);
  assert.equal(inverted.psi.toFixed(1), "49.8");
});


// The pump run of 2026-09-25 as the durable records carried it (UTC).
const RUN_0925 = [
  ["12:48:26", 12.21, 39.746, 2.62], ["12:48:39", 12.19, 39.202, 1.82], ["12:48:41", 2972.33, 39.783, 2.68],
  ["12:48:43", 2965.57, 40.166, 3.23], ["12:49:03", 2952.24, 44.516, 8.97], ["12:49:30", 2941.69, 50.351, 15.44],
  ["12:50:00", 2919.58, 57.278, 21.73], ["12:50:12", 2914.25, 60.238, 24.06], ["12:50:18", 12.58, 61.77, 25.19],
  ["12:50:24", 12.17, 60.687, 24.39], ["12:50:27", 12.07, 60.579, 24.31], ["12:51:02", 12.16, 59.203, 23.26]
].map(([clock, watts, psi, gallons]) => ({ timeMs: Date.parse(`2026-09-25T${clock}Z`), watts, psi, gallons }));

test("each run is kept with its times and the pressures the switch actually used", () => {
  const startMs = Date.parse("2026-09-25T12:00:00Z");
  const series = buildSeries(RUN_0925, { startMs, endMs: startMs + 3600000, bucketMs: 300000 });
  assert.equal(series.runs.length, 1);
  const [run] = series.runs;
  assert.equal(new Date(run.startMs).toISOString(), "2026-09-25T12:48:41.000Z");
  assert.equal(new Date(run.stopMs).toISOString(), "2026-09-25T12:50:18.000Z");
  assert.equal(run.seconds, 97);
  assert.equal(run.cutInPsi, 39.2, "the last settled reading before current flowed");
  assert.equal(run.tripPsi, 60.2, "the last reading while running");
  assert.equal(run.settledPsi, 59.2);
  assert.ok(run.averageWatts > 2900 && run.averageWatts < 2960);
  assert.ok(run.deliveredGallons > 20);
  assert.equal(run.complete, true);
  assert.equal(run.running, false);
});

test("a run with a silence inside it is marked incomplete, and one still going has no duration", () => {
  const gap = RUN_0925.filter(sample => sample.timeMs < Date.parse("2026-09-25T12:49:03Z") || sample.timeMs >= Date.parse("2026-09-25T12:50:12Z"));
  const startMs = Date.parse("2026-09-25T12:00:00Z");
  assert.equal(buildSeries(gap, { startMs, endMs: startMs + 3600000, bucketMs: 300000 }).runs[0].complete, false);
  const open = RUN_0925.slice(0, 6);
  const [running] = buildSeries(open, { startMs, endMs: startMs + 3600000, bucketMs: 300000 }).runs;
  assert.equal(running.running, true);
  assert.equal(running.seconds, null);
});

test("energy is the rise in the meter's total, skipping a reset, and load averages only running readings", () => {
  const startMs = Date.parse("2026-09-25T12:00:00Z");
  const at = minutes => startMs + minutes * 60000;
  const samples = [
    { timeMs: at(1), watts: 12, psi: 44, gallons: 9, energyWh: 1000, loadRatio: 0.4 },
    { timeMs: at(2), watts: 2950, psi: 44, gallons: 9, energyWh: 1002, loadRatio: 101.8 },
    { timeMs: at(3), watts: 2930, psi: 50, gallons: 15, energyWh: 1050, loadRatio: 101.0 },
    { timeMs: at(4), watts: 12, psi: 60, gallons: 24, energyWh: 1100, loadRatio: 0.4 },
    { timeMs: at(6), watts: 12, psi: 60, gallons: 24, energyWh: 3, loadRatio: 0.4 },
    { timeMs: at(7), watts: 12, psi: 60, gallons: 24, energyWh: 5, loadRatio: 0.4 }
  ];
  const series = buildSeries(samples, { startMs, endMs: startMs + 3600000, bucketMs: 300000 });
  assert.equal(series.totals.energyKWh, 0.1, "1000 -> 1100 Wh, then the reset is skipped and 3 -> 5 adds 2 Wh");
  assert.equal(series.buckets[0].loadRatio, 101.4);
  assert.equal(series.buckets[0].loadCount, 2);
  assert.equal(series.buckets[1].loadRatio, null);
});

// Fill time, switch pressures, delivery and leak-down, the trend views.

const NEVER_NOW = { nowMs: Infinity };

test("a clean fill is timed through 48-58 psi and gives the pump's delivery", () => {
  const [cycle] = pumpCycles(fill(40, 60), NEVER_NOW);
  // About 9.3 gallons at 12-13 GPM on the measured curve.
  assert.ok(cycle.fillSeconds > 40 && cycle.fillSeconds < 50, `fill took ${cycle.fillSeconds}s`);
  assert.ok(Math.abs(cycle.fillGpm - pumpDeliveryGpm(53 - 1.35, REFERENCE_DELIVERY)) < 0.6,
    `fill rate ${cycle.fillGpm} GPM`);
  assert.equal(cycle.clean, true);
  assert.ok(cycle.afterFallGallons < 0.5);
});

test("draw during a fill slows it, and draw after cut-out marks it not clean", () => {
  const [quiet] = pumpCycles(fill(40, 60), NEVER_NOW);
  const [drawn] = pumpCycles(fill(40, 60, 4), NEVER_NOW);
  assert.ok(drawn.fillSeconds > quiet.fillSeconds + 10);
  // The same fill, then three gallons leave in the minutes after it settled.
  const samples = fill(40, 60);
  const last = samples.at(-1);
  for (let minute = 1; minute <= 4; minute += 1) {
    samples.push({ ...last, timeMs: last.timeMs + minute * 60000, gallons: last.gallons - minute * 0.75 });
  }
  const [after] = pumpCycles(samples, NEVER_NOW);
  assert.equal(after.clean, false);
  assert.ok(after.afterFallGallons >= 2.9);
});

test("a fill is not called clean until five minutes after cut-out have passed", () => {
  const samples = fill(40, 60);
  const [pending] = pumpCycles(samples, { nowMs: samples.at(-1).timeMs });
  assert.equal(pending.clean, null);
  assert.equal(pending.afterFallGallons, null);
  const [decided] = pumpCycles(samples, { nowMs: samples.at(-1).timeMs + 5 * 60000 });
  assert.equal(decided.clean, true);
});

test("a record gap inside the band leaves the fill untimed rather than guessed", () => {
  const samples = fill(40, 60).filter(sample => !(sample.watts > 500 && sample.psi > 50 && sample.psi < 57));
  const [cycle] = pumpCycles(samples, NEVER_NOW);
  assert.equal(cycle.fillSeconds, null);
  assert.equal(cycle.clean, false);
});

test("a run that never reaches 58 psi has no fill time and no switch cut-out", () => {
  const [cycle] = pumpCycles(fill(40, 50), NEVER_NOW);
  assert.equal(cycle.fillSeconds, null);
  assert.equal(cycle.cutOutPsi, null, "it stopped some other way than the switch opening");
  assert.ok(cycle.cutInPsi > 39 && cycle.cutInPsi < 41);
});

test("the switch's cut-in and cut-out are the pressures it actually switched at", () => {
  const [cycle] = pumpCycles(RUN_0925, NEVER_NOW);
  assert.equal(cycle.cutInPsi, 39.2, "the reading as the contactor closed");
  assert.equal(cycle.cutOutPsi, 61.77, "the reading as it opened, above the last running one");
  // This excerpt keeps one record in 30 s through the band, too sparse to time.
  assert.equal(cycle.fillSeconds, null);
});

test("delivery is never nothing: too few clean fills falls back to the measured curve", () => {
  const curve = deliveryFromFills([]);
  assert.equal(curve.basis, "reference");
  assert.equal(curve.intercept, REFERENCE_DELIVERY.intercept);
  assert.equal(curve.fills, 0);
  const two = deliveryFromFills([{ clean: true, fillGpm: 12 }, { clean: true, fillGpm: 13 }]);
  assert.equal(two.basis, "reference");
});

test("delivery follows the fast clean fills, skipping the single fastest and any drawn one", () => {
  const cycles = [
    { clean: true, fillGpm: 12.6 }, { clean: true, fillGpm: 12.5 }, { clean: true, fillGpm: 11.0 },
    { clean: true, fillGpm: 14.9 }, { clean: false, fillGpm: 16 }, { clean: null, fillGpm: 17 }
  ];
  const curve = deliveryFromFills(cycles);
  assert.equal(curve.basis, "fills");
  assert.equal(curve.fills, 4);
  assert.equal(curve.slopePerPsi, REFERENCE_DELIVERY.slopePerPsi);
  assert.equal(pumpDeliveryGpm(53, curve).toFixed(2), "12.60");
});

test("a real fill's delivery lands on the measured curve", () => {
  const cycles = [0, 1, 2].map(index => pumpCycles(fill(40, 60, 0, index * 3600000), NEVER_NOW)[0]);
  const curve = deliveryFromFills(cycles);
  assert.equal(curve.basis, "fills");
  assert.ok(Math.abs(pumpDeliveryGpm(50, curve) - pumpDeliveryGpm(50, REFERENCE_DELIVERY)) < 0.8);
});

test("leak-down is read from quiet stretches that begin an hour after the last run or draw", () => {
  const at = minutes => T0 + minutes * 60000;
  const samples = [];
  // A run, then eight hours idle losing 0.1 gal an hour, with a one-gallon draw at hour four.
  samples.push({ timeMs: at(0), watts: 2900, psi: 55, gallons: 20 });
  let gallons = 22;
  for (let minute = 1; minute <= 480; minute += 10) {
    if (minute === 241) gallons -= 1;
    gallons -= 0.1 / 6;
    samples.push({ timeMs: at(minute), watts: 12, psi: 58, gallons });
  }
  const stretches = quietStretches(samples);
  assert.equal(stretches.length, 2);
  assert.ok(stretches[0].startMs >= at(60), "not before the air has cooled after cut-out");
  assert.ok(stretches[1].startMs >= at(241 + 60), "nor before it has recovered after a draw");
  for (const stretch of stretches) assert.ok(Math.abs(stretch.gallonsPerHour - 0.1) < 0.02, `${stretch.gallonsPerHour} gal/h`);
});

test("a reporting gap ends a quiet stretch rather than spanning it", () => {
  const at = minutes => T0 + minutes * 60000;
  const samples = [];
  for (let minute = 0; minute <= 600; minute += 10) {
    if (minute > 200 && minute < 260) continue;
    samples.push({ timeMs: at(minute), watts: 12, psi: 50, gallons: 15 });
  }
  const stretches = quietStretches(samples);
  assert.equal(stretches.length, 2);
  assert.equal(stretches[0].endMs, at(200));
});

test("the month window is served hourly, cached longer, with the runs and quiet stretches", async () => {
  const reply = await call({ records: [v2(T0 - 60000, { TankWaterGallons: 21, PumpWatts: 12 })] }, { window: "30d" });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.buckets.length, 720);
  assert.equal(reply.headers["Cache-Control"], "public, max-age=1800");
  assert.deepEqual(reply.cycles, []);
  assert.deepEqual(reply.quiet, []);
  assert.equal(reply.delivery.basis, "reference");
});
