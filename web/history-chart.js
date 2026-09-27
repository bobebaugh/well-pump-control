"use strict";

// The home-screen history chart.
//
// Geometry is kept in pure functions at the top so it can be tested without a
// DOM; everything below buildChart only turns those numbers into SVG.

const HistoryChart = (function () {
  const PAD = { top: 14, right: 14, bottom: 26, left: 48 };
  const HEIGHT = 320;
  const HOUR_MS = 3600000;
  const DAY_MS = 24 * HOUR_MS;

  // A 5-minute bucket is the right resolution for a level trace and far too fine
  // for a bar. Bars are regrouped so a day of starts reads as 24 hourly columns
  // and a week as 7 daily ones, which is the "starts per day" shape.
  const GROUPING = {
    gallons: { "1d": 1, "7d": 1, "30d": 1 },
    used: { "1d": 12, "7d": 6, "30d": 24 },
    starts: { "1d": 12, "7d": 24, "30d": 24 },
    energy: { "1d": 12, "7d": 24, "30d": 24 }
  };

  const VIEWS = {
    gallons: { key: "gallons", title: "Tank water", unit: "gal", mark: "line", decimals: 1 },
    used: { key: "used", title: "Water used", unit: "gal", mark: "bar", decimals: 1 },
    starts: { key: "starts", title: "Pump starts", unit: "starts", mark: "bar", decimals: 0 },
    energy: { key: "energyKWh", title: "Energy", unit: "kWh", mark: "bar", decimals: 2 },
    // The trend views plot runs and quiet stretches where they happened rather
    // than in buckets, on axes zoomed to the readings: a drift is the signal.
    fill: { title: "Fill time 48\u201358 psi", unit: "s", mark: "scatter", decimals: 1, minSpan: 6 },
    switch: { title: "Pressure switch", unit: "psi", mark: "scatter", decimals: 1, minSpan: 2 },
    leak: { title: "Leak-down", unit: "gal/h", mark: "scatter", decimals: 3, minSpan: 0.2, zero: true }
  };

  // The narrowest the zoom rail will close to, per window.
  const ZOOM_MIN_MS = { "1d": HOUR_MS, "7d": 6 * HOUR_MS, "30d": DAY_MS };

  function groupBuckets(buckets, factor, key) {
    if (factor <= 1) return buckets.map(bucket => ({ startMs: bucket.startMs, value: bucket[key] }));
    const grouped = [];
    for (let index = 0; index < buckets.length; index += factor) {
      const slice = buckets.slice(index, index + factor);
      // A level is a state: the group takes the last reading it actually has, and
      // stays null when the whole group was silent. A flow is a sum.
      const value = key === "gallons"
        ? (slice.filter(item => item.gallons !== null).at(-1)?.gallons ?? null)
        : slice.reduce((sum, item) => sum + (item[key] ?? 0), 0);
      grouped.push({ startMs: slice[0].startMs, value });
    }
    return grouped;
  }

  // Ticks land on 1, 2 or 5 times a power of ten so the axis reads in round
  // numbers rather than whatever the data maximum happened to be.
  function niceCeiling(value) {
    if (!(value > 0)) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const step = [1, 2, 2.5, 5, 10].find(item => value <= item * magnitude) || 10;
    return step * magnitude;
  }

  // Ticks are chosen as round STEPS, not by dividing the maximum into four.
  // Dividing 25 by four gives 6.25, 12.5, 18.75 down the axis, which is a scale
  // nobody reads in gallons.
  function niceStep(max, integer) {
    const rough = max / 5;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough) || 0));
    const candidates = (integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map(item => item * magnitude);
    const step = candidates.find(item => item >= rough) || candidates.at(-1);
    return integer ? Math.max(1, Math.round(step)) : step;
  }

  function axis(points, { integer = false, floor = false, minSpan = 4, zero = false } = {}) {
    if (floor) {
      // Zoomed to the readings, with a minimum span so a steady value does not
      // magnify noise into a trend. A rate that can be either sign keeps zero.
      const values = points.map(point => point.value).filter(Number.isFinite);
      if (values.length) {
        const low = Math.min(...values, ...(zero ? [0] : []));
        const high = Math.max(...values, ...(zero ? [0] : []));
        const step = niceStep(Math.max(high - low, minSpan), false);
        const min = Math.floor((low - step / 2) / step) * step;
        const top = Math.ceil((high + step / 2) / step) * step;
        const count = Math.round((top - min) / step);
        return { min, max: top, ticks: Array.from({ length: count + 1 }, (unused, index) => Number((min + step * index).toFixed(6))) };
      }
    }
    const max = Math.max(0, ...points.map(point => point.value ?? 0));
    if (max <= 0) return { min: 0, max: integer ? 4 : 1, ticks: integer ? [0, 1, 2, 3, 4] : [0, 0.25, 0.5, 0.75, 1] };
    const step = niceStep(max, integer);
    // Strictly above the maximum, always: a mark that touches the ceiling reads
    // as clipped, and the direct label on the peak has nowhere to sit.
    const divisions = Math.floor(max / step) + 1;
    const top = step * divisions;
    return { min: 0, max: top, ticks: Array.from({ length: divisions + 1 }, (unused, index) => Number((step * index).toFixed(6))) };
  }

  function plot(width) {
    return { x: PAD.left, y: PAD.top, width: Math.max(10, width - PAD.left - PAD.right), height: HEIGHT - PAD.top - PAD.bottom };
  }

  // Null is a gap, not a zero: where reporting went silent the trace breaks
  // instead of drawing a straight line through the missing time.
  function linePath(points, area, max, min = 0) {
    const step = area.width / Math.max(1, points.length - 1);
    const at = index => area.x + index * step;
    const level = value => area.y + area.height - ((value - min) / (max - min)) * area.height;
    const segments = [];
    let current = [];
    points.forEach((point, index) => {
      if (point.value === null || point.value === undefined) {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      current.push([at(index), level(point.value)]);
    });
    if (current.length) segments.push(current);
    return segments.map(segment => segment
      .map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" "));
  }

  function areaPath(segments, area) {
    return segments.map(path => {
      const points = path.match(/-?[\d.]+ -?[\d.]+/g) || [];
      if (points.length < 2) return "";
      const first = points[0].split(" ")[0];
      const last = points.at(-1).split(" ")[0];
      const base = (area.y + area.height).toFixed(1);
      return `${path} L${last} ${base} L${first} ${base} Z`;
    }).filter(Boolean);
  }

  // A 4px rounded cap on the data end, square against the baseline.
  function barPath(x, y, width, height, radius = 4) {
    const r = Math.max(0, Math.min(radius, width / 2, height));
    const bottom = y + height;
    return `M${x.toFixed(1)} ${bottom.toFixed(1)} L${x.toFixed(1)} ${(y + r).toFixed(1)}`
      + ` Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)}`
      + ` L${(x + width - r).toFixed(1)} ${y.toFixed(1)}`
      + ` Q${(x + width).toFixed(1)} ${y.toFixed(1)} ${(x + width).toFixed(1)} ${(y + r).toFixed(1)}`
      + ` L${(x + width).toFixed(1)} ${bottom.toFixed(1)} Z`;
  }

  function bars(points, area, max) {
    const slot = area.width / Math.max(1, points.length);
    // A 2px surface gap between neighbours, so adjacent columns stay separate marks.
    const width = Math.max(1, slot - 2);
    return points.map((point, index) => {
      const value = point.value || 0;
      const height = max > 0 ? (value / max) * area.height : 0;
      return { ...point, x: area.x + index * slot + 1, width, height, y: area.y + area.height - height, slot };
    });
  }


  // The zoom rail's two handles: each stays inside the window and at least the
  // minimum span from the other.
  function clampZoom(handle, timeMs, [fromMs, toMs], [startMs, endMs], minSpanMs) {
    const span = Math.min(minSpanMs, endMs - startMs);
    if (handle === "from") return [Math.max(startMs, Math.min(timeMs, toMs - span)), toMs];
    return [fromMs, Math.min(endMs, Math.max(timeMs, fromMs + span))];
  }

  function localDay(ms) {
    const date = new Date(ms);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  // One point per day: the fastest clean fill, the pump's own rate with the
  // least draw against it. A day with fills but none clean shows its fastest as
  // best available; a day with no runs has no point at all.
  function dailyBest(cycles, dayOf = localDay) {
    const days = new Map();
    for (const cycle of cycles || []) {
      if (!Number.isFinite(cycle.fillSeconds)) continue;
      const key = dayOf(cycle.startMs);
      const held = days.get(key);
      const clean = cycle.clean === true;
      if (!held || (clean && !held.clean) || (clean === held.clean && cycle.fillSeconds < held.value)) {
        days.set(key, { timeMs: cycle.startMs, value: cycle.fillSeconds, clean });
      }
    }
    return [...days.values()].sort((left, right) => left.timeMs - right.timeMs);
  }

  // One point per day: the longest quiet stretch ending that day, the one with
  // the least noise in its rate.
  function dailyLeak(quiet, dayOf = localDay) {
    const days = new Map();
    for (const stretch of quiet || []) {
      if (!Number.isFinite(stretch.gallonsPerHour)) continue;
      const key = dayOf(stretch.endMs);
      const hours = (stretch.endMs - stretch.startMs) / HOUR_MS;
      if (!days.has(key) || hours > days.get(key).hours) {
        days.set(key, { timeMs: stretch.endMs, value: stretch.gallonsPerHour, hours, startMs: stretch.startMs });
      }
    }
    return [...days.values()].sort((left, right) => left.timeMs - right.timeMs);
  }

  // Daily points joined only across a day or so: a day with no reading breaks
  // the line rather than bridging it.
  function joinDaily(points, maxGapMs = 36 * HOUR_MS) {
    const segments = [];
    let current = [];
    for (const point of points) {
      if (current.length && point.timeMs - current.at(-1).timeMs > maxGapMs) { segments.push(current); current = []; }
      current.push(point);
    }
    if (current.length) segments.push(current);
    return segments;
  }

  // Round local times for the axis: hours on a day, days on a week, every few
  // days on a month, whatever the zoom.
  const TICK_STEPS = [15 * 60000, 30 * 60000, HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS,
    DAY_MS, 2 * DAY_MS, 5 * DAY_MS, 7 * DAY_MS];
  function timeTicks(fromMs, toMs, most = 7) {
    const span = toMs - fromMs;
    if (!(span > 0)) return [];
    const step = TICK_STEPS.find(item => span / item <= most) || TICK_STEPS.at(-1);
    const midnight = new Date(fromMs); midnight.setHours(0, 0, 0, 0);
    const ticks = [];
    if (step < DAY_MS) {
      for (let at = midnight.getTime(); at <= toMs; at += step) if (at >= fromMs) ticks.push(at);
    } else {
      const days = Math.round(step / DAY_MS);
      for (const day = new Date(midnight); day.getTime() <= toMs; day.setDate(day.getDate() + days)) {
        if (day.getTime() >= fromMs) ticks.push(day.getTime());
      }
    }
    const format = new Intl.DateTimeFormat(undefined, step < HOUR_MS ? { hour: "numeric", minute: "2-digit" }
      : step < DAY_MS ? { hour: "numeric" }
      : span <= 8 * DAY_MS ? { weekday: "short" } : { month: "short", day: "numeric" });
    return ticks.map(ms => ({ ms, text: format.format(new Date(ms)) }));
  }

  return { DAY_MS, GROUPING, HEIGHT, HOUR_MS, PAD, VIEWS, ZOOM_MIN_MS, areaPath, axis, barPath, bars, clampZoom,
           dailyBest, dailyLeak, groupBuckets, joinDaily, linePath, localDay, niceCeiling, niceStep, plot, timeTicks };
})();

if (typeof module === "object" && module.exports) module.exports = HistoryChart;

// ---------------------------------------------------------------------------
// Rendering. Everything above is pure geometry and is what the tests exercise;
// everything below turns those numbers into SVG and needs a DOM.
// ---------------------------------------------------------------------------

Object.assign(HistoryChart, (function () {
  const { GROUPING, HEIGHT, PAD, VIEWS, areaPath, axis, barPath, bars, dailyBest, dailyLeak, groupBuckets,
          joinDaily, linePath, plot, timeTicks } = HistoryChart;

  function escape(value) {
    return String(value ?? "").replace(/[&<>"]/g, character =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  }

  function fullRange(data) {
    return [data.startMs, data.endMs];
  }

  // The bucketed views, cut to the zoomed range. Buckets are uniform, so the
  // renderer can keep placing them by index.
  function points(data, view, windowKey, range = fullRange(data)) {
    const grouped = groupBuckets(data.buckets || [], GROUPING[view][windowKey] || 1, VIEWS[view].key);
    const [fromMs, toMs] = range;
    if (!(Number.isFinite(fromMs) && Number.isFinite(toMs))) return grouped;
    const width = grouped.length > 1 ? grouped[1].startMs - grouped[0].startMs : 0;
    return grouped.filter(point => point.startMs + width > fromMs && point.startMs < toMs);
  }

  function timeLabels(windowKey, series) {
    if (!series.length) return [];
    const width = series.length > 1 ? series[1].startMs - series[0].startMs : 1;
    const ticks = timeTicks(series[0].startMs, series.at(-1).startMs + (width > 1 ? 0 : 1));
    return ticks.map(tick => ({ index: (tick.ms - series[0].startMs) / width, text: tick.text }));
  }

  function bucketSvg(data, view, windowKey, width, range) {
    const spec = VIEWS[view];
    const series = points(data, view, windowKey, range);
    const area = plot(width);
    const scale = axis(series, { integer: view === "starts" });
    const level = value => area.y + area.height - ((value - scale.min) / (scale.max - scale.min)) * area.height;
    const parts = [];

    for (const tick of scale.ticks) {
      const y = level(tick).toFixed(1);
      parts.push(`<line class="hc-grid" x1="${area.x}" y1="${y}" x2="${area.x + area.width}" y2="${y}"/>`);
      parts.push(`<text class="hc-axis" x="${area.x - 8}" y="${y}" dy="0.32em" text-anchor="end">${
        view === "starts" ? tick : Number(tick.toFixed(Math.max(1, spec.decimals)))}</text>`);
    }

    let maxIndex = -1;
    series.forEach((point, index) => {
      if (point.value !== null && (maxIndex < 0 || point.value > series[maxIndex].value)) maxIndex = index;
    });

    if (spec.mark === "line") {
      const segments = linePath(series, area, scale.max, scale.min);
      for (const path of areaPath(segments, area)) parts.push(`<path class="hc-area hc-${view}" d="${path}"/>`);
      for (const path of segments) parts.push(`<path class="hc-line hc-${view}" d="${path}"/>`);
    } else {
      for (const bar of bars(series, area, scale.max)) {
        if (!(bar.value > 0)) continue;
        parts.push(`<path class="hc-bar hc-${view}" d="${barPath(bar.x, bar.y, bar.width, bar.height)}"/>`);
      }
    }

    // One direct label, on the peak, rather than a number over every mark.
    if (maxIndex >= 0 && series[maxIndex].value > 0) {
      const step = spec.mark === "line"
        ? area.width / Math.max(1, series.length - 1)
        : area.width / Math.max(1, series.length);
      const x = area.x + maxIndex * step + (spec.mark === "line" ? 0 : (area.width / series.length) / 2);
      const y = level(series[maxIndex].value);
      const labelY = y - 9 >= PAD.top + 8 ? y - 9 : y + 14;
      parts.push(`<text class="hc-peak" x="${Math.min(area.x + area.width - 14, Math.max(area.x + 14, x)).toFixed(1)}" y="${
        labelY.toFixed(1)}" text-anchor="middle">${series[maxIndex].value.toFixed(spec.decimals)}</text>`);
    }

    const step = area.width / Math.max(1, spec.mark === "line" ? series.length - 1 : series.length);
    for (const label of timeLabels(windowKey, series)) {
      // A line's points sit ON the tick; a bar occupies the slot after it.
      const x = area.x + label.index * step + (spec.mark === "line" ? 0 : step / 2);
      if (x < area.x - 1 || x > area.x + area.width + 1) continue;
      parts.push(`<text class="hc-axis" x="${x.toFixed(1)}" y="${HEIGHT - 8}" text-anchor="middle">${escape(label.text)}</text>`);
    }

    const marks = series.map((point, index) => ({ ...point, x: area.x + index * step + (spec.mark === "line" ? 0 : step / 2) }));
    return { parts, marks, area, empty: series.every(point => !point.value) };
  }

  // What each trend view plots: lanes stacked in one chart, each on its own
  // zoomed axis, with dots per run (or per day) and an optional daily line.
  function lanesFor(data, view) {
    const cycles = data.cycles || [];
    if (view === "fill") {
      const best = dailyBest(cycles).filter(point => point.clean);
      return [{ key: "fill", label: "", dots: cycles.filter(cycle => Number.isFinite(cycle.fillSeconds))
        .map(cycle => ({ timeMs: cycle.startMs, value: cycle.fillSeconds, hollow: cycle.clean !== true, cycle })),
        line: best }];
    }
    if (view === "switch") {
      return [
        { key: "cutout", label: "Cut-out", dots: cycles.filter(cycle => Number.isFinite(cycle.cutOutPsi))
          .map(cycle => ({ timeMs: cycle.startMs, value: cycle.cutOutPsi, cycle })), line: [] },
        { key: "cutin", label: "Cut-in", dots: cycles.filter(cycle => Number.isFinite(cycle.cutInPsi))
          .map(cycle => ({ timeMs: cycle.startMs, value: cycle.cutInPsi, cycle })), line: [] }
      ];
    }
    const days = dailyLeak(data.quiet);
    return [{ key: "leak", label: "", dots: days.map(day => ({ ...day, stretch: day })), line: days }];
  }

  function scatterSvg(data, view, width, range) {
    const spec = VIEWS[view];
    const [fromMs, toMs] = range;
    const area = plot(width);
    const inRange = point => point.timeMs >= fromMs && point.timeMs <= toMs;
    const lanes = lanesFor(data, view).map(lane => ({ ...lane, dots: lane.dots.filter(inRange), line: lane.line.filter(inRange) }));
    const gap = 16;
    const laneHeight = (area.height - gap * (lanes.length - 1)) / lanes.length;
    const x = ms => area.x + ((ms - fromMs) / Math.max(1, toMs - fromMs)) * area.width;
    const parts = [];
    const marks = [];

    lanes.forEach((lane, laneIndex) => {
      const top = area.y + laneIndex * (laneHeight + gap);
      const scale = axis(lane.dots, { floor: true, minSpan: spec.minSpan, zero: spec.zero === true });
      const y = value => top + laneHeight - ((value - scale.min) / (scale.max - scale.min)) * laneHeight;
      const every = Math.max(1, Math.ceil(scale.ticks.length / (lanes.length > 1 ? 3 : 6)));
      scale.ticks.forEach((tick, index) => {
        if (index % every) return;
        const at = y(tick).toFixed(1);
        parts.push(`<line class="hc-grid" x1="${area.x}" y1="${at}" x2="${area.x + area.width}" y2="${at}"/>`);
        parts.push(`<text class="hc-axis" x="${area.x - 8}" y="${at}" dy="0.32em" text-anchor="end">${
          Number(tick.toFixed(spec.decimals))}</text>`);
      });
      if (lane.label) parts.push(`<text class="hc-lane" x="${area.x + 6}" y="${(top + 11).toFixed(1)}">${escape(lane.label)}</text>`);
      for (const segment of joinDaily(lane.line)) {
        if (segment.length < 2) continue;
        parts.push(`<path class="hc-line hc-${lane.key}" d="${segment.map((point, index) =>
          `${index ? "L" : "M"}${x(point.timeMs).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ")}"/>`);
      }
      for (const dot of lane.dots) {
        parts.push(`<circle class="hc-dot hc-${lane.key}${dot.hollow ? " hollow" : ""}" cx="${x(dot.timeMs).toFixed(1)}" cy="${
          y(dot.value).toFixed(1)}" r="3.5"/>`);
        marks.push({ ...dot, x: x(dot.timeMs), lane: lane.key });
      }
    });

    for (const tick of timeTicks(fromMs, toMs)) {
      parts.push(`<text class="hc-axis" x="${x(tick.ms).toFixed(1)}" y="${HEIGHT - 8}" text-anchor="middle">${escape(tick.text)}</text>`);
    }
    return { parts, marks: marks.sort((left, right) => left.x - right.x), area, empty: marks.length === 0 };
  }

  function svgFor(data, view, windowKey, width, range = fullRange(data)) {
    const spec = VIEWS[view];
    const drawn = spec.mark === "scatter" ? scatterSvg(data, view, width, range) : bucketSvg(data, view, windowKey, width, range);
    const { area } = drawn;
    drawn.parts.push(`<line class="hc-cross" x1="0" y1="${area.y}" x2="0" y2="${area.y + area.height}" style="display:none"/>`);
    drawn.parts.push(`<rect class="hc-hit" x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" fill="transparent"/>`);
    return { markup: `<svg viewBox="0 0 ${width} ${HEIGHT}" width="100%" height="${HEIGHT}" role="img" aria-label="${
      escape(spec.title)}">${drawn.parts.join("")}</svg>`, series: drawn.marks, area, empty: drawn.empty, spec };
  }

  return { lanesFor, points, svgFor, timeLabels, escape };
})());

Object.assign(HistoryChart, (function () {
  const { DAY_MS, PAD, VIEWS, clampZoom, escape, svgFor } = HistoryChart;

  function when(ms, withDay) {
    return new Intl.DateTimeFormat(undefined, withDay
      ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  }

  function tipText(point, spec, windowKey, view) {
    if (view === "fill") {
      const cycle = point.cycle;
      const state = cycle.clean === true ? "clean" : cycle.clean === false
        ? `draw after cut-out (${cycle.afterFallGallons ?? "?"} gal in 5 min)` : "settling";
      return `${when(point.timeMs, true)} · ${point.value.toFixed(1)} s · ${state}`;
    }
    if (view === "switch") {
      const cycle = point.cycle;
      return `${when(point.timeMs, true)} · cut-in ${cycle.cutInPsi ?? "—"} · cut-out ${cycle.cutOutPsi ?? "—"} psi`;
    }
    if (view === "leak") {
      return `${when(point.startMs, true)} – ${when(point.timeMs, false)} · ${point.value.toFixed(3)} gal/h over ${point.hours.toFixed(1)} h`;
    }
    const at = new Intl.DateTimeFormat(undefined, windowKey === "1d"
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", month: "short", day: "numeric", hour: "numeric" }).format(new Date(point.startMs));
    const value = point.value === null ? "no reading" : `${point.value.toFixed(spec.decimals)} ${spec.unit}`;
    return `${at} · ${value}`;
  }

  const EMPTY = {
    starts: "Pump starts appear as soon as the first cycle is logged.",
    energy: "Energy appears once records carry the meter's energy total.",
    fill: "No timed fill in this range. A fill is timed when a run passes 48–58 psi with records every few seconds.",
    switch: "No completed run in this range.",
    leak: "No quiet stretch of two hours or more in this range.",
    gallons: "Tank readings begin when the pressure sensor started reporting; earlier records cannot be back-filled.",
    used: "Tank readings begin when the pressure sensor started reporting; earlier records cannot be back-filled."
  };

  /** Draw the chart into a container and wire its hover layer. */
  function mount(container, data, view, windowKey, range) {
    const width = Math.max(320, container.clientWidth || 640);
    const { markup, series, area, empty, spec } = svgFor(data, view, windowKey, width, range || [data.startMs, data.endMs]);
    const note = empty ? `<div class="hc-empty"><strong>Nothing recorded yet</strong><span>${escape(EMPTY[view])}</span></div>` : "";
    container.innerHTML = `${markup}${note}<div class="hc-tip" hidden></div>`;

    const svg = container.querySelector("svg");
    const cross = container.querySelector(".hc-cross");
    const tip = container.querySelector(".hc-tip");
    const hit = container.querySelector(".hc-hit");
    if (!hit || !series.length) return;

    hit.addEventListener("pointermove", event => {
      const box = svg.getBoundingClientRect();
      const x = (event.clientX - box.left) * (width / box.width);
      let point = series[0];
      for (const candidate of series) if (Math.abs(candidate.x - x) < Math.abs(point.x - x)) point = candidate;
      if (!point || (spec.mark !== "scatter" && point.value === undefined)) return;
      cross.setAttribute("x1", point.x);
      cross.setAttribute("x2", point.x);
      cross.style.display = "";
      tip.textContent = tipText(point, spec, windowKey, view);
      tip.hidden = false;
      const left = (point.x / width) * box.width;
      tip.style.left = `${Math.max(4, Math.min(box.width - tip.offsetWidth - 4, left - tip.offsetWidth / 2))}px`;
    });

    const leave = () => { cross.style.display = "none"; tip.hidden = true; };
    hit.addEventListener("pointerleave", leave);
    hit.addEventListener("pointercancel", leave);
  }

  /**
   * The zoom rail under the chart: the whole window as a track, the shown range
   * as a bar between two handles. Drag a handle (or focus it and use the arrow
   * keys) to narrow or widen; double-click the rail to show the whole window.
   */
  function mountRail(container, { extent, range, minSpanMs, onChange }) {
    const width = Math.max(320, container.clientWidth || 640);
    const [startMs, endMs] = extent;
    const left = PAD.left; const right = width - PAD.right; const y = 15;
    const toX = ms => left + ((ms - startMs) / Math.max(1, endMs - startMs)) * (right - left);
    const toMs = x => startMs + ((x - left) / Math.max(1, right - left)) * (endMs - startMs);
    const withDay = endMs - startMs > DAY_MS;
    const label = ms => new Intl.DateTimeFormat(undefined, withDay
      ? { weekday: "short", month: "short", day: "numeric", hour: "numeric" } : { hour: "numeric", minute: "2-digit" })
      .format(new Date(ms));
    let current = [...range];
    let dragging = null;

    container.innerHTML = `<svg class="hc-rail" viewBox="0 0 ${width} 30" width="100%" height="30">`
      + `<line class="hc-rail-track" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/>`
      + `<line class="hc-rail-range" y1="${y}" y2="${y}"/>`
      + `<circle class="hc-rail-handle" data-handle="from" r="7" cy="${y}" tabindex="0" role="slider" aria-label="Start of the shown range"/>`
      + `<circle class="hc-rail-handle" data-handle="to" r="7" cy="${y}" tabindex="0" role="slider" aria-label="End of the shown range"/>`
      + `</svg><div class="hc-rail-labels"><span></span><span></span></div>`;
    const svg = container.querySelector("svg");
    const bar = container.querySelector(".hc-rail-range");
    const handles = [...container.querySelectorAll(".hc-rail-handle")];
    const [fromLabel, toLabel] = container.querySelectorAll(".hc-rail-labels span");

    function draw() {
      const [from, to] = current;
      bar.setAttribute("x1", toX(from).toFixed(1));
      bar.setAttribute("x2", toX(to).toFixed(1));
      handles[0].setAttribute("cx", toX(from).toFixed(1));
      handles[1].setAttribute("cx", toX(to).toFixed(1));
      handles[0].setAttribute("aria-valuetext", label(from));
      handles[1].setAttribute("aria-valuetext", label(to));
      fromLabel.textContent = label(from);
      toLabel.textContent = to >= endMs - 60000 ? "Now" : label(to);
    }
    function move(handle, ms) {
      current = clampZoom(handle, ms, current, extent, minSpanMs);
      draw();
      onChange(current);
    }

    handles.forEach(handle => {
      handle.addEventListener("pointerdown", event => {
        dragging = handle.dataset.handle;
        svg.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      handle.addEventListener("keydown", event => {
        const step = (endMs - startMs) / 48 * (event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1
          : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : 0);
        if (!step) return;
        event.preventDefault();
        const which = handle.dataset.handle;
        move(which, (which === "from" ? current[0] : current[1]) + step);
      });
    });
    svg.addEventListener("pointermove", event => {
      if (!dragging) return;
      const box = svg.getBoundingClientRect();
      move(dragging, toMs((event.clientX - box.left) * (width / box.width)));
    });
    const stop = () => { dragging = null; };
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
    svg.addEventListener("dblclick", () => { current = [startMs, endMs]; draw(); onChange(current); });
    draw();
  }

  /** The line under the chart: what the numbers rest on, in plain words. */
  function caption(data, view) {
    if (!data) return "";
    const totals = data.totals || {};
    const parts = [];
    if (view === "gallons") {
      const observed = data.pressureSwitch;
      parts.push(observed?.cycles
        ? `Usable range measured at ${observed.cutInPsi}–${observed.settledPsi} psi over ${observed.cycles} cycle${observed.cycles === 1 ? "" : "s"}`
        : "Usable range not yet observed");
    } else if (view === "used") {
      parts.push(`${totals.usedGallons ?? 0} gal estimated`);
      // Never presented as a meter reading: there is no flow meter on either leg.
      parts.push(data.delivery?.basis === "fills"
        ? `pump delivery from the fastest clean fills of the last 7 days (${data.delivery.fills})`
        : "pump delivery from the August qualification fill, too few clean fills in the last 7 days");
    } else if (view === "energy") {
      parts.push(`${totals.energyKWh ?? 0} kWh from the meter's running total`);
      parts.push("includes the idle draw of the well-head equipment");
    } else if (view === "fill") {
      parts.push("Seconds from 48 to 58 psi at the sensor while the pump runs");
      parts.push("line: each day's fastest clean fill; hollow: draw after cut-out, or still settling");
      parts.push("slower is less pump flow (well level, wear or steady draw); faster is the tank losing air");
    } else if (view === "switch") {
      parts.push("The switch's actual cut-in and cut-out as the sensor saw them, one dot per run");
      parts.push("a drift over weeks is the contacts or spring wearing");
    } else if (view === "leak") {
      parts.push("Tank level lost per hour over each day's longest quiet stretch (2 h or more, from an hour after the last run or draw)");
      parts.push("about zero is a tight system; a steady rise is a leak at the check valve, a fixture or a pipe");
    } else {
      parts.push(`${totals.starts ?? 0} start${totals.starts === 1 ? "" : "s"}`);
      if (totals.runSeconds) parts.push(`${Math.round(totals.runSeconds / 60)} min running`);
    }
    // Never a quiet partial chart: say when the read stopped short.
    if (data.truncated) parts.push("the window held more records than one read takes, so its oldest part is missing");
    return parts.join(" · ");
  }

  return { caption, mount, mountRail, tipText };
})());
