"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LEVEL_CARRY_LIMIT_MS, WINDOWS, buildSeries, recordField, samplesFromRecords,
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
