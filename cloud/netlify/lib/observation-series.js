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
// goes stale across a season.  A window carrying enough fills of its own
// derives its own curve and this is never consulted.  It is what gets used when
// the window cannot, because an educated guess from a real measured fill beats
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

// A fill rate is only evidence over a span long enough to outrun the 1 gallon
// logging threshold.
const DELIVERY_MIN_SPAN_MS = 4000;
const DELIVERY_BAND_PSI = 3;
const DELIVERY_MIN_PER_BAND = 3;
const DELIVERY_MIN_BANDS = 3;

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
  return { timeMs, gallons, psi: samplePsi(record, gallons, model),
           watts: numberOrNull(recordField(record, "PumpWatts")) };
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

/**
 * Derive this window's pump delivery curve from its own fills.
 *
 * Within a run the tank rises at (pump delivery - household draw), so across
 * many fills the FASTEST rise seen at a given pressure is the one where nobody
 * was drawing, and the upper envelope of observed rates is the pump curve at
 * this period's well level.  Deriving it per window means it follows the well
 * through the seasons with nothing stored to go stale.
 *
 * Returns the reference prior when the window has too few fills to fit -- never
 * nothing.  The basis says which, so the page can label the estimate.
 */
function deliveryCurve(samples) {
  const usable = sample => sample.gallons !== null && sample.psi !== null &&
    sample.watts !== null && sample.watts >= PUMP_RUNNING_WATTS;

  const bands = new Map();
  for (let index = 0; index < samples.length; index += 1) {
    const previous = samples[index];
    if (!usable(previous)) continue;
    // Pair with the first later sample that spans enough time to outrun the
    // logging threshold, rather than the next one: at the 1 Hz of a capture no
    // adjacent pair would ever qualify, and the whole window would fall back.
    let partner = index + 1;
    while (partner < samples.length &&
           samples[partner].timeMs - previous.timeMs < DELIVERY_MIN_SPAN_MS &&
           usable(samples[partner])) partner += 1;
    if (partner >= samples.length) break;
    const current = samples[partner];
    const spanMs = current.timeMs - previous.timeMs;
    if (spanMs < DELIVERY_MIN_SPAN_MS || !usable(current)) continue;
    const rate = (current.gallons - previous.gallons) / (spanMs / 60000);
    if (!(rate > 0)) continue;
    const band = Math.floor(((previous.psi + current.psi) / 2) / DELIVERY_BAND_PSI);
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band).push(rate);
  }

  // The second-highest rate rather than the highest: one noisy pair should not
  // set the envelope for a whole pressure band.
  const points = [];
  for (const [band, rates] of bands) {
    if (rates.length < DELIVERY_MIN_PER_BAND) continue;
    rates.sort((left, right) => right - left);
    points.push([(band + 0.5) * DELIVERY_BAND_PSI, rates[1]]);
  }
  if (points.length < DELIVERY_MIN_BANDS) {
    return { ...REFERENCE_DELIVERY, basis: "reference", bands: points.length };
  }
  const meanPsi = points.reduce((sum, [psi]) => sum + psi, 0) / points.length;
  const meanRate = points.reduce((sum, [, rate]) => sum + rate, 0) / points.length;
  const variance = points.reduce((sum, [psi]) => sum + (psi - meanPsi) ** 2, 0);
  if (!(variance > 0)) {
    return { ...REFERENCE_DELIVERY, basis: "reference", bands: points.length };
  }
  const slopePerPsi = points.reduce((sum, [psi, rate]) =>
    sum + (psi - meanPsi) * (rate - meanRate), 0) / variance;
  return { intercept: meanRate - slopePerPsi * meanPsi, slopePerPsi,
           basis: "window", bands: points.length };
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
    runSeconds: 0
  }));

  let previous = null;
  let running = false;
  let startsTotal = 0;
  // The last reading known to be settled, and the open cycle if the pump is
  // running or still settling. Nothing outside a cycle is dynamic.
  let settled = null;
  let cycle = null;

  for (const sample of samples) {
    const index = Math.floor((sample.timeMs - startMs) / bucketMs);
    if (sample.gallons !== null && index >= 0 && index < count) {
      buckets[index].gallons = sample.gallons;
    }

    const wasRunning = previous !== null && previous.watts !== null &&
      previous.watts >= PUMP_RUNNING_WATTS;

    if (previous) {
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
        startsTotal += 1;
        if (index >= 0 && index < count) buckets[index].starts += 1;
      }
      running = stillRunning;
      // A cycle opens anchored on the last SETTLED level, never on the reading
      // beside it: by the time the pump is drawing current the sensor is already
      // showing discharge pressure.
      if (stillRunning && !cycle) {
        cycle = { anchorGallons: settled?.gallons ?? null,
                  anchorMs: settled?.timeMs ?? sample.timeMs,
                  delivered: 0, stoppedAtMs: null };
      }
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
  LEVEL_CARRY_LIMIT_MS, MAX_SERIES_ROWS, PUMP_RUNNING_WATTS, REFERENCE_DELIVERY, WINDOWS,
  buildSeries, deliveryCurve, pumpDeliveryGpm, recordField, recordTimeMs, samplesFromRecords,
  tankModelFromDraft, tankWaterGallons
};
