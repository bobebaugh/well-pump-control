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
// Two fields are deliberately unavailable here: ShellyEnergyWh and
// PressureADCCounts are both logging mode "none" in the live package, so no
// record has ever carried them. Energy totals are not computable until that
// changes.

// Idle at the well head is about 12 W of network gear; the pump runs at about
// 2800 W. Anything between those is unambiguous, so the pair below is a wide
// hysteresis band rather than a tuned threshold.
const PUMP_RUNNING_WATTS = 500;
const PUMP_STOPPED_WATTS = 200;

// Past this the tank level on screen would be a guess rather than a reading. The
// device publishes a durable record at least every 10 minutes, so a gap beyond
// twice that means reporting stopped, and the chart shows a gap instead of a
// flat line carried forward from before the silence.
const LEVEL_CARRY_LIMIT_MS = 20 * 60 * 1000;

const WINDOWS = {
  "1d": { spanMs: 24 * 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 },
  "7d": { spanMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 }
};

// A week of records: the 10-minute maximum interval alone is about 1000, and
// pressure deltas during normal cycling add several thousand more. This bounds
// one request; beyond it the reply says it was truncated rather than quietly
// charting part of the window.
const MAX_SERIES_ROWS = 12000;

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
  const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
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
  return { timeMs, gallons, watts: numberOrNull(recordField(record, "PumpWatts")) };
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

/**
 * Bucket a sorted sample series into the shape the charts draw.
 *
 * gallons  - tank level at the bucket's end, or null where reporting was silent
 * used     - water drawn from the tank, as the sum of falls in level
 * starts   - pump starts, counted on the rising crossing
 * runSeconds - time the pump was drawing running current
 */
function buildSeries(samples, { startMs, endMs, bucketMs }) {
  const count = Math.max(0, Math.ceil((endMs - startMs) / bucketMs));
  const buckets = Array.from({ length: count }, (unused, index) => ({
    startMs: startMs + index * bucketMs,
    gallons: null,
    used: 0,
    starts: 0,
    runSeconds: 0
  }));

  let previous = null;
  let running = false;
  let startsTotal = 0;

  for (const sample of samples) {
    const index = Math.floor((sample.timeMs - startMs) / bucketMs);

    if (sample.gallons !== null && index >= 0 && index < count) {
      // The level is a state, not a flow, so the bucket shows where the tank
      // stood at its end rather than an average across it.
      buckets[index].gallons = sample.gallons;
    }

    if (previous) {
      // Water used is the fall in tank level. This is drawdown only: whatever
      // the house pulls while the pump is refilling the tank is masked by the
      // rise and is not counted here.
      if (previous.gallons !== null && sample.gallons !== null) {
        const fall = previous.gallons - sample.gallons;
        if (fall > 0) spread(buckets, startMs, bucketMs, previous.timeMs, sample.timeMs, fall, "used");
      }
      // The interval carries the state it began in: a record is published within
      // 50 W of any change, so a span that opened at running current was running
      // for its duration.
      if (previous.watts !== null && previous.watts >= PUMP_RUNNING_WATTS) {
        spread(buckets, startMs, bucketMs, previous.timeMs, sample.timeMs,
               (sample.timeMs - previous.timeMs) / 1000, "runSeconds");
      }
    }

    if (sample.watts !== null) {
      if (!running && sample.watts >= PUMP_RUNNING_WATTS) {
        running = true;
        startsTotal += 1;
        if (index >= 0 && index < count) buckets[index].starts += 1;
      } else if (running && sample.watts <= PUMP_STOPPED_WATTS) {
        running = false;
      }
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
      runSeconds: round(bucket.runSeconds, 1)
    })),
    totals: {
      usedGallons: round(buckets.reduce((sum, bucket) => sum + bucket.used, 0), 1),
      starts: startsTotal,
      runSeconds: round(buckets.reduce((sum, bucket) => sum + bucket.runSeconds, 0), 0),
      latestGallons: ordered.length ? round(ordered.at(-1).gallons, 1) : null,
      latestAtMs: ordered.length ? ordered.at(-1).timeMs : null
    }
  };
}

module.exports = {
  LEVEL_CARRY_LIMIT_MS, MAX_SERIES_ROWS, PUMP_RUNNING_WATTS, PUMP_STOPPED_WATTS, WINDOWS,
  buildSeries, recordField, recordTimeMs, samplesFromRecords, tankModelFromDraft, tankWaterGallons
};
