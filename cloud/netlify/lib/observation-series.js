"use strict";

// History for the home-screen charts, built from durable observations.
//
// Every durable record carries every logging-enabled field: durable_field_states
// on the device writes the whole package-fixed field set into each record and the
// delta/change thresholds only decide WHETHER a record is published, not which
// fields it contains. So one pass over the window yields a consistent series for
// tank level, water used and pump starts without interpolating between fields
// that were sampled at different instants.
//
// ShellyEnergyWh, the meter's running total, is carried by current records
// (every record on 2026-09-25 had it), so energy per bucket is the rise in that
// total. Older records without it simply contribute nothing. The total resets
// when the meter restarts; a fall is skipped rather than counted as negative.

// The pump is on or off; there is no in between. Idle at the well head is about
// 12 W of network gear and the motor runs at about 2900 W, so one threshold
// anywhere between them separates the two states and no hysteresis band is
// needed. What the count needs is edge detection, not a dead zone: a run
// publishes a record every time its power drifts 50 W, and every one of those
// is the same start.
//
// Power is deliberately the signal rather than ContactorFlag, which leads it by
// about two seconds. The contactor flag is the pressure switch asking for the
// pump; power is the motor actually running. During a Tab5 inhibit or a Shelly
// lockout the switch closes and the pump correctly does not run, and counting
// that as a start would corrupt the very statistic used to judge short cycling.
const PUMP_RUNNING_WATTS = 500;

// Past this the tank level on screen would be a guess rather than a reading. The
// device publishes a durable record at least every 10 minutes, so a gap beyond
// twice that means reporting stopped, and the chart shows a gap instead of a
// flat line carried forward from before the silence.
const LEVEL_CARRY_LIMIT_MS = 20 * 60 * 1000;

// The pump curve measured on the 2026-08-26 uninterrupted fill:
// GPM = 28.477 - 0.3001 x psi, RMS residual 0.372 GPM over 81 points.
//
// This is a PRIOR, not a constant.  Well water level moves the curve -- the
// higher the water in the well, the less lift, the more flow -- so a stored fit
// goes stale across a season.  The trailing week's clean fills set the level
// of the curve (deliveryFromFills) and only its slope is taken from here.  The
// whole curve is used when the week has too few clean fills, because an
// educated guess from a real measured fill beats
// refusing to answer: without calibrated flow meters on the well-to-tank and
// tank-to-house legs, every number here is an estimate anyway, and withholding
// one is a bigger error than publishing it labelled.
const REFERENCE_DELIVERY = { intercept: 28.477, slopePerPsi: -0.3001 };

// While the pump runs the sensor reads pump discharge pressure, not settled tank
// pressure. On the 2026-08-26 capture, taken with the house off so the whole
// decline is the transient, the cut-out settles as
//
//   P(t) = 60.007 + 1.329 * exp(-t / 5.7 s)      RMS 0.038 psi
//
// a 1.265 psi step worth 0.94 gallons, with 1.449 psi the other way at cut-in.
// Differencing a dynamic reading against a settled one charges that step to
// consumption every cycle, which at ten cycles a day is thousands of phantom
// gallons a year. Three time constants covers it.
const PUMP_SETTLING_MS = 20000;

// Standard practice for a bladder tank: charge the air side 2 psi below the
// switch's cut-in.
const PRECHARGE_BELOW_CUT_IN_PSI = 2;

// The fill-time band. Every normal fill passes through it with the pump well
// clear of the cut-in step and the cut-out overshoot, inside the 40-61 psi the
// sensor fit is qualified for, and a couple of psi of switch drift at either end
// still leaves it whole. Readings in it are the sensor's while the pump runs,
// i.e. discharge pressure about 1.4 psi above the tank's, the same on every fill.
const FILL_LOW_PSI = 48;
const FILL_HIGH_PSI = 58;
// Records arrive about every gallon (about 5 s) through a fill; a longer silence
// inside the band means a crossing time would be a guess.
const FILL_MAX_GAP_MS = 15000;
// House draw can only slow a fill. Draw that is still running after cut-out
// usually ran through the fill too, so a fill is clean only if the settled tank
// then holds. On the 18-27 September records a quiet cut-out loses 0.3-1.5 gal
// in the next five minutes as the compressed air cools; draw shows as 2-6 gal.
const AFTER_FILL_MS = 5 * 60 * 1000;
const AFTER_FILL_CLEAN_GALLONS = 2;
// Delivery is taken from the clean fills of the trailing week whatever the view,
// so the day and week views estimate every run with the same pump.
const DELIVERY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_MIN_FILLS = 3;
// Leak-down is read only on stretches with nothing going on. After a cut-out the
// air cools and the pressure sags for most of an hour, and after a draw it warms
// and recovers, so a stretch starts an hour after the last run or draw. A record
// gap longer than two heartbeats ends it.
const QUIET_SETTLE_MS = 60 * 60 * 1000;
const QUIET_MIN_MS = 2 * 60 * 60 * 1000;
const QUIET_MAX_GAP_MS = 25 * 60 * 1000;
// A draw is half a gallon lost within ten minutes (3 gal/h and up); a slower
// fall stays in the stretch and is what leak-down measures. Readings jitter by a
// few hundredths of a gallon, which is not a fall.
const QUIET_MIN_DRAW_GALLONS = 0.5;
const QUIET_DRAW_LOOKBACK_MS = 10 * 60 * 1000;
const QUIET_JITTER_GALLONS = 0.1;

const WINDOWS = {
  "1d": { spanMs: 24 * 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 },
  "7d": { spanMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
  "30d": { spanMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 }
};

// The 18-27 September records ran 240-800 a day, so thirty days is up to about
// 24,000. This bounds one request per schema; beyond it the reply says it was
// truncated rather than quietly charting part of the window.
const MAX_SERIES_ROWS = 40000;

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Boyle's law against the precharged air volume. Air compresses, water does not,
// so the water in the tank is whatever the air is not occupying. The parameters
// belong to the package's calc-tank block and are read from the saved rules,
// never restated here: a fourth copy of the tank calibration is exactly the
// hazard V3-ISSUES TAB5-14 is about.
function tankWaterGallons(psi, model) {
  if (!model) return null;
  const pressure = numberOrNull(psi);
  const volume = numberOrNull(model.effectiveTankGallons);
  const precharge = numberOrNull(model.prechargeGaugePsi);
  const atmosphere = numberOrNull(model.atmosphericPressurePsi);
  if (pressure === null || volume === null || precharge === null || atmosphere === null) return null;
  if (volume <= 0 || atmosphere <= 0 || precharge + atmosphere <= 0) return null;
  if (pressure + atmosphere <= 0) return null;
  const air = volume * (precharge + atmosphere) / (pressure + atmosphere);
  const water = volume - air;
  if (!Number.isFinite(water) || water < 0 || water > volume) return null;
  return water;
}

function tankModelFromDraft(items) {
  const calculation = (Array.isArray(items) ? items : []).find(item => item?.id === "calc-tank");
  const parameters = calculation?.parameters;
  if (!parameters) return null;
  const model = {
    effectiveTankGallons: numberOrNull(parameters.effectiveTankGallons),
    prechargeGaugePsi: numberOrNull(parameters.prechargeGaugePsi),
    atmosphericPressurePsi: numberOrNull(parameters.atmosphericPressurePsi)
  };
  return Object.values(model).every(value => value !== null) ? model : null;
}

// Schema 2 records carry {state, value} per field; schema 1 records are flat.
function recordField(record, name) {
  if (record?.schemaVersion === 2) {
    const state = record.fields?.[name];
    return state?.state === "available" ? state.value : null;
  }
  if (Object.hasOwn(record?.values || {}, name)) return record.values[name];
  if (Object.hasOwn(record?.status || {}, name)) return record.status[name];
  return null;
}

function recordTimeMs(record) {
  const raw = record?.schemaVersion === 2 ? record.time?.observedAt : record.observedAt;
  // Ingestion stores observedAt as a Firestore Timestamp. ISO strings still
  // occur in fixtures and in records before they are written to Firestore.
  const parsed = raw && typeof raw.toMillis === "function" ? raw.toMillis()
    : typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

// Prefer the recorded TankWaterGallons: it is logged at a 1 gallon threshold
// where PressurePSI is logged at 2 psi, and near the working band a gallon is
// about a psi, so the recorded field is the finer of the two. PressurePSI is the
// fallback for a record whose Boyle outputs were unavailable.
function sampleFromRecord(record, model) {
  const timeMs = recordTimeMs(record);
  if (timeMs === null) return null;
  let gallons = numberOrNull(recordField(record, "TankWaterGallons"));
  if (gallons === null) gallons = tankWaterGallons(recordField(record, "PressurePSI"), model);
  return { timeMs, gallons, psi: samplePsi(record, gallons, model),
           watts: numberOrNull(recordField(record, "PumpWatts")),
           energyWh: numberOrNull(recordField(record, "ShellyEnergyWh")),
           loadRatio: numberOrNull(recordField(record, "LoadRatioPercent")) };
}

// Tank pressure per sample, for evaluating the delivery curve. PressurePSI is
// logged, so it is normally read straight off the record; inverting Boyle from
// the gallons output covers a record that carried one and not the other.
function samplePsi(record, gallons, model) {
  const recorded = numberOrNull(recordField(record, "PressurePSI"));
  if (recorded !== null) return recorded;
  if (gallons === null || !model) return null;
  const { effectiveTankGallons: volume, prechargeGaugePsi: precharge,
          atmosphericPressurePsi: atmosphere } = model;
  if (gallons >= volume) return null;
  const psi = volume * (precharge + atmosphere) / (volume - gallons) - atmosphere;
  return Number.isFinite(psi) ? psi : null;
}

function samplesFromRecords(records, model) {
  return (Array.isArray(records) ? records : [])
    .map(record => sampleFromRecord(record, model))
    .filter(sample => sample !== null)
    .sort((left, right) => left.timeMs - right.timeMs);
}

// Spread a quantity that accrued over [fromMs, toMs) across the buckets it
// spans, in proportion to the overlap. Without this a pump run or a drawdown
// that straddles a bucket edge lands wholly in one of them, which shows up as a
// spike beside an empty bucket on the hourly week view.
function spread(buckets, startMs, bucketMs, fromMs, toMs, amount, key) {
  const span = toMs - fromMs;
  if (!(span > 0) || !(amount > 0)) return;
  const first = Math.max(0, Math.floor((fromMs - startMs) / bucketMs));
  const last = Math.min(buckets.length - 1, Math.floor((toMs - 1 - startMs) / bucketMs));
  for (let index = first; index <= last; index += 1) {
    const edgeFrom = startMs + index * bucketMs;
    const overlap = Math.min(toMs, edgeFrom + bucketMs) - Math.max(fromMs, edgeFrom);
    if (overlap > 0) buckets[index][key] += amount * (overlap / span);
  }
}

function running(sample) {
  return sample.watts !== null && sample.watts >= PUMP_RUNNING_WATTS;
}

// Where a rising reading crossed a pressure, interpolated between the two
// records either side, with the gallons at that instant when both carry them.
function crossing(before, after, psi) {
  const share = (psi - before.psi) / (after.psi - before.psi);
  const gallons = before.gallons !== null && after.gallons !== null
    ? before.gallons + share * (after.gallons - before.gallons) : null;
  return { timeMs: before.timeMs + share * (after.timeMs - before.timeMs), gallons, gapMs: after.timeMs - before.timeMs };
}

// The 48-58 psi fill of one run, or null when the run never crossed the band
// cleanly: no rising crossing, a record gap inside it, or a fall in pressure
// part-way (a draw heavy enough to beat the pump).
function fillThroughBand(runSamples) {
  const readings = runSamples.filter(sample => sample.psi !== null);
  let low = null; let lowIndex = -1;
  for (let index = 1; index < readings.length; index += 1) {
    const [before, after] = [readings[index - 1], readings[index]];
    if (low === null && before.psi < FILL_LOW_PSI && after.psi >= FILL_LOW_PSI) {
      low = crossing(before, after, FILL_LOW_PSI); lowIndex = index - 1;
    }
    if (low !== null && before.psi < FILL_HIGH_PSI && after.psi >= FILL_HIGH_PSI) {
      const high = crossing(before, after, FILL_HIGH_PSI);
      const span = readings.slice(lowIndex, index + 1);
      let peak = -Infinity;
      for (let step = 0; step < span.length; step += 1) {
        if (step && span[step].timeMs - span[step - 1].timeMs > FILL_MAX_GAP_MS) return null;
        if (span[step].psi < peak - 1) return null;
        peak = Math.max(peak, span[step].psi);
      }
      const seconds = (high.timeMs - low.timeMs) / 1000;
      if (!(seconds > 0)) return null;
      const gallons = low.gallons !== null && high.gallons !== null ? high.gallons - low.gallons : null;
      return { atMs: low.timeMs, seconds, gpm: gallons !== null && gallons > 0 ? gallons / (seconds / 60) : null };
    }
  }
  return null;
}

/**
 * Every pump run in a sample series, with what the trend views need: the
 * switch's cut-in and cut-out as the sensor saw them, the 48-58 psi fill time,
 * and whether the tank then held (a clean fill) or kept falling (draw).
 *
 * clean is null while the five minutes after cut-out have not yet passed.
 */
function pumpCycles(samples, { nowMs = Infinity } = {}) {
  const cycles = [];
  let current = null;
  let state = false;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample.watts === null) { if (current) current.samples.push(sample); continue; }
    const on = running(sample);
    if (on && !state) {
      const before = samples.slice(0, index).reverse().find(item => item.psi !== null);
      current = { startIndex: index, samples: [sample], stop: null,
                  cutInPsi: before && sample.timeMs - before.timeMs <= 60000 ? before.psi : null };
      cycles.push(current);
    } else if (on && current) {
      current.samples.push(sample);
    } else if (!on && state && current) {
      current.stop = sample; current.stopIndex = index; current = null;
    }
    state = on;
  }

  return cycles.map((cycle, position) => {
    const last = cycle.samples.filter(running).at(-1) || cycle.samples[0];
    const trip = [...cycle.samples, ...(cycle.stop && cycle.stop.timeMs - last.timeMs <= 10000 ? [cycle.stop] : [])]
      .map(sample => sample.psi).filter(psi => psi !== null);
    const fill = fillThroughBand(cycle.samples);
    let afterFallGallons = null; let clean = null;
    if (cycle.stop) {
      const nextStart = cycles[position + 1]?.samples[0].timeMs ?? Infinity;
      const after = samples.slice(cycle.stopIndex).filter(sample =>
        sample.timeMs < nextStart && sample.gallons !== null && !running(sample));
      const settled = after.find(sample => sample.timeMs - cycle.stop.timeMs >= PUMP_SETTLING_MS);
      if (settled) {
        const until = settled.timeMs + AFTER_FILL_MS;
        const held = after.filter(sample => sample.timeMs >= settled.timeMs && sample.timeMs <= until);
        // Records are written on every gallon of change, so no record by then
        // means no gallon was lost. Only the passage of time can say so.
        const decided = nextStart <= until || nowMs >= until || after.some(sample => sample.timeMs > until);
        if (decided) {
          afterFallGallons = Math.max(0, settled.gallons - Math.min(...held.map(sample => sample.gallons)));
          clean = fill !== null && afterFallGallons <= AFTER_FILL_CLEAN_GALLONS;
        }
      }
    }
    const round = (value, places) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(places));
    return {
      startMs: cycle.samples[0].timeMs,
      stopMs: cycle.stop ? cycle.stop.timeMs : null,
      cutInPsi: round(cycle.cutInPsi, 2),
      // A run stopped short of the band's top ended some other way (a lockout,
      // an inhibit, the power) and says nothing about where the switch opens.
      cutOutPsi: trip.length && cycle.stop && Math.max(...trip) >= FILL_HIGH_PSI ? round(Math.max(...trip), 2) : null,
      fillSeconds: fill ? round(fill.seconds, 1) : null,
      fillGpm: fill ? round(fill.gpm, 2) : null,
      afterFallGallons: round(afterFallGallons, 2),
      clean
    };
  });
}

/**
 * Pump delivery for every run, from the clean fills rather than a fit.
 *
 * Draw can only slow a fill, so the fastest clean fills are the pump's own
 * delivery at the band's pressure. The second fastest of them is used, so one
 * lucky pair of records does not set it. The slope across pressure is the
 * measured 2026-08-26 one; a single band cannot give a slope. Too few clean
 * fills falls back to that whole measured curve -- never nothing.
 */
function deliveryFromFills(cycles) {
  const rates = (Array.isArray(cycles) ? cycles : [])
    .filter(cycle => cycle.clean === true && Number.isFinite(cycle.fillGpm))
    .map(cycle => cycle.fillGpm).sort((left, right) => right - left);
  if (rates.length < DELIVERY_MIN_FILLS) {
    return { ...REFERENCE_DELIVERY, basis: "reference", fills: rates.length };
  }
  const gpm = rates[1];
  const midPsi = (FILL_LOW_PSI + FILL_HIGH_PSI) / 2;
  return { intercept: gpm - REFERENCE_DELIVERY.slopePerPsi * midPsi,
           slopePerPsi: REFERENCE_DELIVERY.slopePerPsi, basis: "fills", fills: rates.length };
}

/**
 * Stretches of at least two hours with the pump off and nothing drawing, for
 * leak-down. A slow steady fall across one is a leak (check valve, fixture,
 * pipe); a steady tank reads about zero.
 */
function quietStretches(samples) {
  const stretches = [];
  let eligibleFromMs = -Infinity;
  let points = [];
  let recent = [];
  let wasRunning = false;
  const close = (end = points.at(-1)) => {
    const start = points[0];
    if (start && end && end.timeMs - start.timeMs >= QUIET_MIN_MS) {
      const hours = (end.timeMs - start.timeMs) / 3600000;
      const fall = start.gallons - end.gallons;
      stretches.push({ startMs: start.timeMs, endMs: end.timeMs,
                       fallGallons: Number(fall.toFixed(2)), gallonsPerHour: Number((fall / hours).toFixed(3)) });
    }
    points = [];
  };
  for (const sample of samples) {
    if (running(sample)) { close(); recent = []; eligibleFromMs = Infinity; wasRunning = true; continue; }
    if (wasRunning && sample.watts !== null) { eligibleFromMs = sample.timeMs + QUIET_SETTLE_MS; wasRunning = false; }
    if (sample.gallons === null) continue;
    if (points.length && sample.timeMs - points.at(-1).timeMs > QUIET_MAX_GAP_MS) close();
    // A draw is a real fall from a level held in the last few minutes, at more
    // than a trickle's rate. It may arrive as several small steps a few seconds
    // apart, so it is measured from that level, not from the previous record.
    recent = recent.filter(item => sample.timeMs - item.timeMs <= QUIET_DRAW_LOOKBACK_MS);
    const high = recent.reduce((best, item) => (best === null || item.gallons > best.gallons ? item : best), null);
    const fall = high ? high.gallons - sample.gallons : 0;
    if (fall >= QUIET_MIN_DRAW_GALLONS) {
      // End the stretch where the level last stood before the fall began.
      const onset = recent.filter(item => item.gallons >= high.gallons - QUIET_JITTER_GALLONS).at(-1);
      close(points.includes(onset) ? onset : undefined);
      points = [];
      eligibleFromMs = sample.timeMs + QUIET_SETTLE_MS;
    } else if (sample.timeMs >= eligibleFromMs) {
      points.push(sample);
    }
    recent.push(sample);
  }
  close();
  return stretches;
}

function mean(values) {
  const usable = values.filter(value => value !== null && Number.isFinite(value));
  return usable.length ? Number((usable.reduce((sum, value) => sum + value, 0) / usable.length).toFixed(2)) : null;
}

function switchSummary(switches) {
  const cutIn = mean(switches.map(item => item.cutInPsi));
  return {
    cycles: switches.length,
    cutInPsi: cutIn,
    cutOutPsi: mean(switches.map(item => item.tripPsi)),
    settledPsi: mean(switches.map(item => item.settledPsi)),
    // The tank graphic needs a full mark. The settled cut-out is where this tank
    // actually tops out; falling back on a constant would draw a picture of
    // somebody else's system. The tank is RATED to 150 psi and nobody runs one
    // there, so the rating is not a full mark either.
    fullPsi: mean(switches.map(item => item.settledPsi)),
    // A bladder tank is charged 2 psi below cut-in, so a measured cut-in implies
    // the precharge it was set up with. The stored parameter cannot be checked
    // against pressure any other way -- the gallons output is computed FROM it,
    // so it can never disagree with itself -- and a bladder that slowly loses
    // air over a year would otherwise bias every gallon on the screen with
    // nothing to show for it.
    impliedPrechargePsi: cutIn === null ? null : Number((cutIn - PRECHARGE_BELOW_CUT_IN_PSI).toFixed(2))
  };
}

function pumpDeliveryGpm(psi, curve) {
  if (psi === null || !curve) return 0;
  return Math.max(0, curve.intercept + curve.slopePerPsi * psi);
}

/**
 * Bucket a sorted sample series into the shape the charts draw.
 *
 * gallons  - tank level at the bucket's end, or null where reporting was silent
 * used     - water drawn from the tank, as the sum of falls in level
 * starts   - pump starts, counted on the rising crossing
 * runSeconds - time the pump was drawing running current
 */
function buildSeries(samples, { startMs, endMs, bucketMs, curve = REFERENCE_DELIVERY }) {
  const count = Math.max(0, Math.ceil((endMs - startMs) / bucketMs));
  const buckets = Array.from({ length: count }, (unused, index) => ({
    startMs: startMs + index * bucketMs,
    gallons: null,
    used: 0,
    starts: 0,
    runSeconds: 0,
    energyWh: 0,
    loadSum: 0,
    loadCount: 0
  }));

  let previous = null;
  let running = false;
  let startsTotal = 0;
  // The last reading known to be settled, and the open cycle if the pump is
  // running or still settling. Nothing outside a cycle is dynamic.
  let settled = null;
  let cycle = null;
  const switches = [];
  // Each run as its records show it, newest last. A run is timed from the first
  // record drawing running current to the first record that is not, so both
  // ends are within one record of the truth; records are written every few
  // seconds while the pump runs.
  const runs = [];
  let run = null;

  for (const sample of samples) {
    const index = Math.floor((sample.timeMs - startMs) / bucketMs);
    if (sample.gallons !== null && index >= 0 && index < count) {
      buckets[index].gallons = sample.gallons;
    }

    const wasRunning = previous !== null && previous.watts !== null &&
      previous.watts >= PUMP_RUNNING_WATTS;

    if (previous) {
      if (Number.isFinite(previous.energyWh) && Number.isFinite(sample.energyWh) && sample.energyWh > previous.energyWh) {
        spread(buckets, startMs, bucketMs, previous.timeMs, sample.timeMs, sample.energyWh - previous.energyWh, "energyWh");
      }
      if (wasRunning) {
        spread(buckets, startMs, bucketMs, previous.timeMs, sample.timeMs,
               (sample.timeMs - previous.timeMs) / 1000, "runSeconds");
      }
      if (cycle) {
        if (wasRunning) {
          // Delivery is integrated across the run; the level is not consulted
          // at all until the tank has settled again.
          cycle.delivered += pumpDeliveryGpm(previous.psi, curve) *
            ((sample.timeMs - previous.timeMs) / 60000);
          cycle.stoppedAtMs = null;
        } else if (cycle.stoppedAtMs === null) {
          cycle.stoppedAtMs = previous.timeMs;
        }
      } else if (previous.gallons !== null && sample.gallons !== null) {
        // Both ends settled, so the fall in level is the water that left.
        const fall = previous.gallons - sample.gallons;
        if (fall > 0) {
          spread(buckets, startMs, bucketMs, previous.timeMs, sample.timeMs, fall, "used");
        }
      }
    }

    if (sample.watts !== null) {
      const stillRunning = sample.watts >= PUMP_RUNNING_WATTS;
      if (stillRunning && !running) {
        run = { startMs: sample.timeMs, startKnown: previous !== null, stopMs: null,
                cutInPsi: settled?.psi ?? null, tripPsi: null, settledPsi: null, deliveredGallons: null,
                wattsSum: 0, wattsCount: 0, lastMs: sample.timeMs, maxGapMs: 0 };
        runs.push(run);
      }
      if (run && run.stopMs === null) {
        run.maxGapMs = Math.max(run.maxGapMs, sample.timeMs - run.lastMs);
        run.lastMs = sample.timeMs;
        if (stillRunning) {
          run.wattsSum += sample.watts; run.wattsCount += 1;
          if (sample.psi !== null) run.tripPsi = sample.psi;
          // Load is only meaningful while the motor runs; idle it reads well-head gear.
          if (Number.isFinite(sample.loadRatio) && index >= 0 && index < count) { buckets[index].loadSum += sample.loadRatio; buckets[index].loadCount += 1; }
        }
        else run.stopMs = sample.timeMs;
      }
      if (stillRunning && !running) {
        startsTotal += 1;
        if (index >= 0 && index < count) buckets[index].starts += 1;
      }
      running = stillRunning;
      // A cycle opens anchored on the last SETTLED level, never on the reading
      // beside it: by the time the pump is drawing current the sensor is already
      // showing discharge pressure.
      if (stillRunning && !cycle) {
        cycle = { startMs: sample.timeMs, anchorGallons: settled?.gallons ?? null,
                  anchorMs: settled?.timeMs ?? sample.timeMs,
                  // Nothing is dynamic before the pump draws current, so the
                  // last settled reading IS the switch's cut-in pressure. It is
                  // measured, never assumed: the switch is adjustable, it drifts
                  // as the contacts and spring age, and that drift across a year
                  // is worth seeing rather than being designed out.
                  cutInPsi: settled?.psi ?? null,
                  tripPsi: null, delivered: 0, stoppedAtMs: null };
      }
      if (stillRunning && cycle && sample.psi !== null) cycle.tripPsi = sample.psi;
    }

    if (cycle && cycle.stoppedAtMs !== null &&
        sample.timeMs - cycle.stoppedAtMs >= PUMP_SETTLING_MS &&
        sample.gallons !== null && !running) {
      // Settled at both ends, so the dynamic offset is in both anchors and
      // cancels. What the pump delivered and the tank did not keep, the house
      // drew -- including whatever it drew while the tank was refilling.
      if (cycle.anchorGallons !== null) {
        const used = cycle.delivered - (sample.gallons - cycle.anchorGallons);
        if (used > 0) {
          spread(buckets, startMs, bucketMs, cycle.anchorMs, sample.timeMs, used, "used");
        }
      }
      // Three pressures per cycle, all observed: where the switch closed, where
      // it opened, and where the tank came to rest once discharge pressure bled
      // off. The gap between the last two is the transient itself.
      switches.push({ cutInPsi: cycle.cutInPsi, tripPsi: cycle.tripPsi, settledPsi: sample.psi });
      const finished = runs.find(item => item.startMs === cycle.startMs);
      if (finished) { finished.settledPsi = sample.psi; finished.deliveredGallons = cycle.delivered; }
      cycle = null;
      settled = sample;
    } else if (!cycle && sample.gallons !== null &&
               sample.watts !== null && sample.watts < PUMP_RUNNING_WATTS) {
      settled = sample;
    }

    previous = sample;
  }

  // Carry the last known level forward into buckets that had no record, but only
  // as far as reporting can vouch for it.
  let carried = null;
  let carriedAtMs = null;
  const ordered = samples.filter(sample => sample.gallons !== null);
  let cursor = 0;
  for (const bucket of buckets) {
    const edge = bucket.startMs + bucketMs;
    while (cursor < ordered.length && ordered[cursor].timeMs < edge) {
      carried = ordered[cursor].gallons;
      carriedAtMs = ordered[cursor].timeMs;
      cursor += 1;
    }
    if (bucket.gallons === null && carried !== null && edge - carriedAtMs <= LEVEL_CARRY_LIMIT_MS) {
      bucket.gallons = carried;
    }
  }

  const round = (value, places) => Number(value.toFixed(places));
  return {
    buckets: buckets.map(bucket => ({
      startMs: bucket.startMs,
      gallons: bucket.gallons === null ? null : round(bucket.gallons, 2),
      used: round(bucket.used, 3),
      starts: round(bucket.starts, 0),
      runSeconds: round(bucket.runSeconds, 1),
      energyKWh: round(bucket.energyWh / 1000, 4),
      loadRatio: bucket.loadCount ? round(bucket.loadSum / bucket.loadCount, 1) : null,
      loadCount: bucket.loadCount
    })),
    totals: {
      usedGallons: round(buckets.reduce((sum, bucket) => sum + bucket.used, 0), 1),
      starts: startsTotal,
      runSeconds: round(buckets.reduce((sum, bucket) => sum + bucket.runSeconds, 0), 0),
      energyKWh: round(buckets.reduce((sum, bucket) => sum + bucket.energyWh, 0) / 1000, 2),
      latestGallons: ordered.length ? round(ordered.at(-1).gallons, 1) : null,
      latestAtMs: ordered.length ? ordered.at(-1).timeMs : null
    },
    runs: runs.slice(-10).map(item => ({
      startMs: item.startMs,
      stopMs: item.stopMs,
      // Running at the window's start or still running now: that end is not known.
      startKnown: item.startKnown,
      running: item.stopMs === null,
      seconds: item.stopMs === null || !item.startKnown ? null : round((item.stopMs - item.startMs) / 1000, 0),
      cutInPsi: !Number.isFinite(item.cutInPsi) ? null : round(item.cutInPsi, 1),
      tripPsi: !Number.isFinite(item.tripPsi) ? null : round(item.tripPsi, 1),
      settledPsi: !Number.isFinite(item.settledPsi) ? null : round(item.settledPsi, 1),
      averageWatts: item.wattsCount ? round(item.wattsSum / item.wattsCount, 0) : null,
      deliveredGallons: !Number.isFinite(item.deliveredGallons) ? null : round(item.deliveredGallons, 1),
      // A silence inside the run longer than a minute means records are missing
      // there, so its times and figures are shown as incomplete.
      complete: item.maxGapMs <= 60000
    })),
    // The pressure switch as this window actually found it, rather than the
    // nominal 40/60 nobody's switch is really set to.
    pressureSwitch: switchSummary(switches)
  };
}

module.exports = {
  LEVEL_CARRY_LIMIT_MS, MAX_SERIES_ROWS, PRECHARGE_BELOW_CUT_IN_PSI, PUMP_RUNNING_WATTS,
  REFERENCE_DELIVERY, WINDOWS,
  DELIVERY_LOOKBACK_MS, FILL_HIGH_PSI, FILL_LOW_PSI,
  buildSeries, deliveryFromFills, pumpCycles, pumpDeliveryGpm, quietStretches, recordField, recordTimeMs,
  samplesFromRecords, switchSummary, tankModelFromDraft, tankWaterGallons
};
