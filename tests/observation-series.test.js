"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LEVEL_CARRY_LIMIT_MS, REFERENCE_DELIVERY, WINDOWS, buildSeries, deliveryCurve,
  pumpDeliveryGpm, recordField, samplesFromRecords, tankModelFromDraft, tankWaterGallons
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
    where: () => chain, orderBy: () => chain, limit: () => chain,
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

test("the week window is served at its own bucket size", async () => {
  const reply = await call({}, { window: "7d" });
  assert.equal(reply.buckets.length, 168);
  assert.equal(reply.status, "empty");
});

test("an unknown window is rejected rather than silently served as a day", async () => {
  const reply = await call({}, { window: "30d" });
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

test("delivery is never nothing: too few fills falls back to the measured prior", () => {
  const curve = deliveryCurve([]);
  assert.equal(curve.basis, "reference");
  assert.equal(curve.intercept, REFERENCE_DELIVERY.intercept);
  // Every window yields a usable curve. Withholding an estimate is not an option
  // the charts have; without flow meters on either leg they are all estimates.
  assert.ok(Number.isFinite(pumpDeliveryGpm(50, curve)));
});

test("a window with its own fills derives its own curve, and flow falls with pressure", () => {
  const curve = deliveryCurve(fill(40, 60));
  assert.equal(curve.basis, "window");
  assert.ok(curve.bands >= 3, `expected several pressure bands, got ${curve.bands}`);
  assert.ok(curve.slopePerPsi < 0, "a centrifugal pump delivers less as head rises");
  // Recovered from the fill rather than read from the prior, so it tracks the
  // well's water level instead of freezing one August measurement.
  assert.ok(Math.abs(pumpDeliveryGpm(50, curve) - pumpDeliveryGpm(50, REFERENCE_DELIVERY)) < 1.5);
});

test("a sample cadence finer than the minimum span still yields a curve", () => {
  // Pairing only adjacent samples would find nothing in a 1 Hz capture.
  assert.equal(deliveryCurve(fill(40, 60)).basis, "window");
});

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


test("the curve follows the fastest fills, because those are the ones with no draw", () => {
  // Three fills in one window: two with the house drawing hard, one quiet. The
  // quiet one is the pump's actual delivery, and averaging them all would read
  // the pump as far weaker than it is.
  const busy = [
    ...fill(40, 60, 6, 0),
    ...fill(40, 60, 5, 1200000),
    ...fill(40, 60, 0, 2400000)
  ];
  const curve = deliveryCurve(busy);
  assert.equal(curve.basis, "window");
  const derived = pumpDeliveryGpm(50, curve);
  const quiet = pumpDeliveryGpm(50, deliveryCurve(fill(40, 60)));
  assert.ok(Math.abs(derived - quiet) < 1.5,
    `upper envelope should recover the quiet fill: ${derived.toFixed(2)} against ${quiet.toFixed(2)}`);
  // An average over all three would be dragged down by the drawn fills.
  assert.ok(derived > quiet - 3);
});

test("two pressure bands are not enough to fit a line through", () => {
  // A fill spanning barely one band: a two-point fit would be confidently wrong.
  const curve = deliveryCurve(fill(40, 44));
  assert.equal(curve.basis, "reference");
});
