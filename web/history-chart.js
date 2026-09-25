"use strict";

// The home-screen history chart.
//
// Geometry is kept in pure functions at the top so it can be tested without a
// DOM; everything below buildChart only turns those numbers into SVG.

const HistoryChart = (function () {
  const PAD = { top: 14, right: 14, bottom: 26, left: 48 };
  const HEIGHT = 260;

  // A 5-minute bucket is the right resolution for a level trace and far too fine
  // for a bar. Bars are regrouped so a day of starts reads as 24 hourly columns
  // and a week as 7 daily ones, which is the "starts per day" shape.
  const GROUPING = {
    gallons: { "1d": 1, "7d": 1 },
    used: { "1d": 12, "7d": 6 },
    starts: { "1d": 12, "7d": 24 },
    energy: { "1d": 12, "7d": 24 },
    load: { "1d": 12, "7d": 24 }
  };

  const VIEWS = {
    gallons: { key: "gallons", title: "Tank water", unit: "gal", mark: "line", decimals: 1 },
    used: { key: "used", title: "Water used", unit: "gal", mark: "bar", decimals: 1 },
    starts: { key: "starts", title: "Pump starts", unit: "starts", mark: "bar", decimals: 0 },
    energy: { key: "energyKWh", title: "Energy", unit: "kWh", mark: "bar", decimals: 2 },
    // Load sits near 100% and matters only as a drift, so its axis is zoomed to
    // the readings, and each hour or day with a run is a dot rather than a bar.
    load: { key: "loadRatio", title: "Pump load", unit: "%", mark: "line", decimals: 1, floor: true, dots: true }
  };

  function groupBuckets(buckets, factor, key) {
    if (factor <= 1) return buckets.map(bucket => ({ startMs: bucket.startMs, value: bucket[key] }));
    const grouped = [];
    for (let index = 0; index < buckets.length; index += factor) {
      const slice = buckets.slice(index, index + factor);
      // A level is a state: the group takes the last reading it actually has, and
      // stays null when the whole group was silent. A flow is a sum.
      // Load is an average over the running readings, weighted by how many.
      const loaded = slice.filter(item => item.loadRatio !== null && item.loadRatio !== undefined && item.loadCount > 0);
      const value = key === "gallons"
        ? (slice.filter(item => item.gallons !== null).at(-1)?.gallons ?? null)
        : key === "loadRatio"
          ? (loaded.length ? loaded.reduce((sum, item) => sum + item.loadRatio * item.loadCount, 0) / loaded.reduce((sum, item) => sum + item.loadCount, 0) : null)
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

  function axis(points, { integer = false, floor = false } = {}) {
    if (floor) {
      // Zoomed to the readings, with at least four units of span so a steady
      // value does not magnify noise into a trend.
      const values = points.map(point => point.value).filter(Number.isFinite);
      if (values.length) {
        const low = Math.min(...values); const high = Math.max(...values);
        const step = niceStep(Math.max(high - low, 4), false);
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

  return { GROUPING, HEIGHT, PAD, VIEWS, areaPath, axis, barPath, bars, groupBuckets, linePath, niceCeiling, niceStep, plot };
})();

if (typeof module === "object" && module.exports) module.exports = HistoryChart;

// ---------------------------------------------------------------------------
// Rendering. Everything above is pure geometry and is what the tests exercise;
// everything below turns those numbers into SVG and needs a DOM.
// ---------------------------------------------------------------------------

Object.assign(HistoryChart, (function () {
  const { GROUPING, HEIGHT, PAD, VIEWS, areaPath, axis, barPath, bars, groupBuckets, linePath, plot } = HistoryChart;

  function points(data, view, windowKey) {
    return groupBuckets(data.buckets || [], GROUPING[view][windowKey] || 1, VIEWS[view].key);
  }

  function timeLabels(windowKey, points) {
    // Six labels on a day, one per day on a week: enough to place a mark in
    // time without crowding the axis.
    const every = windowKey === "1d" ? Math.ceil(points.length / 6) : Math.ceil(points.length / 7);
    const format = windowKey === "1d"
      ? new Intl.DateTimeFormat(undefined, { hour: "numeric" })
      : new Intl.DateTimeFormat(undefined, { weekday: "short" });
    return points.map((point, index) =>
      index % every === 0 ? { index, text: format.format(new Date(point.startMs)) } : null).filter(Boolean);
  }

  function escape(value) {
    return String(value ?? "").replace(/[&<>"]/g, character =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  }

  function svgFor(data, view, windowKey, width) {
    const spec = VIEWS[view];
    const series = points(data, view, windowKey);
    const area = plot(width);
    const scale = axis(series, { integer: view === "starts", floor: spec.floor === true });
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
      if (!spec.dots) {
        for (const path of areaPath(segments, area)) {
          parts.push(`<path class="hc-area hc-${view}" d="${path}"/>`);
        }
      }
      for (const path of segments) parts.push(`<path class="hc-line hc-${view}" d="${path}"/>`);
      if (spec.dots) {
        const step = area.width / Math.max(1, series.length - 1);
        series.forEach((point, index) => {
          if (Number.isFinite(point.value)) parts.push(`<circle class="hc-dot hc-${view}" cx="${(area.x + index * step).toFixed(1)}" cy="${level(point.value).toFixed(1)}" r="3.5"/>`);
        });
      }
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
      // Above the mark where there is room, inside it where there is not.
      const labelY = y - 9 >= PAD.top + 8 ? y - 9 : y + 14;
      parts.push(`<text class="hc-peak" x="${Math.min(area.x + area.width - 14, Math.max(area.x + 14, x)).toFixed(1)}" y="${
        labelY.toFixed(1)}" text-anchor="middle">${series[maxIndex].value.toFixed(spec.decimals)}</text>`);
    }

    for (const label of timeLabels(windowKey, series)) {
      const step = area.width / Math.max(1, spec.mark === "line" ? series.length - 1 : series.length);
      // A line's points sit ON the tick; a bar occupies the slot after it, so its
      // label belongs under the middle of the bar rather than its left edge.
      const x = area.x + label.index * step + (spec.mark === "line" ? 0 : step / 2);
      parts.push(`<text class="hc-axis" x="${x.toFixed(1)}" y="${
        HEIGHT - 8}" text-anchor="middle">${escape(label.text)}</text>`);
    }

    parts.push(`<line class="hc-cross" x1="0" y1="${area.y}" x2="0" y2="${area.y + area.height}" style="display:none"/>`);
    parts.push(`<rect class="hc-hit" x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" fill="transparent"/>`);

    const empty = series.every(point => !point.value);
    return { markup: `<svg viewBox="0 0 ${width} ${HEIGHT}" width="100%" height="${HEIGHT}" role="img" aria-label="${
      escape(spec.title)}">${parts.join("")}</svg>`, series, area, empty, spec };
  }

  return { points, svgFor, timeLabels, escape };
})());

Object.assign(HistoryChart, (function () {
  const { PAD, VIEWS, escape, svgFor } = HistoryChart;

  function tipText(point, spec, windowKey) {
    const when = new Intl.DateTimeFormat(undefined, windowKey === "1d"
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric" }).format(new Date(point.startMs));
    const value = point.value === null ? "no reading"
      : `${point.value.toFixed(spec.decimals)} ${spec.unit}`;
    return `${when} · ${value}`;
  }

  /** Draw the chart into a container and wire its hover layer. */
  function mount(container, data, view, windowKey) {
    const width = Math.max(320, container.clientWidth || 640);
    const { markup, series, area, empty, spec } = svgFor(data, view, windowKey, width);
    const note = empty
      ? `<div class="hc-empty"><strong>Nothing recorded yet</strong><span>${escape(
          view === "starts"
            ? "Pump starts appear as soon as the first cycle is logged."
            : view === "energy" ? "Energy appears once records carry the meter's energy total."
            : view === "load" ? "Pump load appears once a run is recorded in this window."
            : "Tank readings begin when the pressure sensor started reporting; earlier records cannot be back-filled.")
        }</span></div>`
      : "";
    container.innerHTML = `${markup}${note}<div class="hc-tip" hidden></div>`;

    const svg = container.querySelector("svg");
    const cross = container.querySelector(".hc-cross");
    const tip = container.querySelector(".hc-tip");
    const hit = container.querySelector(".hc-hit");
    if (!hit) return;

    const step = area.width / Math.max(1, spec.mark === "line" ? series.length - 1 : series.length);

    hit.addEventListener("pointermove", event => {
      const box = svg.getBoundingClientRect();
      const x = (event.clientX - box.left) * (width / box.width);
      const index = Math.max(0, Math.min(series.length - 1, Math.round((x - area.x) / step)));
      const point = series[index];
      if (!point) return;
      const at = area.x + index * step + (spec.mark === "line" ? 0 : step / 2);
      cross.setAttribute("x1", at);
      cross.setAttribute("x2", at);
      cross.style.display = "";
      tip.textContent = tipText(point, spec, windowKey);
      tip.hidden = false;
      // Keep the tip inside the panel rather than letting it run off the edge.
      const left = (at / width) * box.width;
      tip.style.left = `${Math.max(4, Math.min(box.width - tip.offsetWidth - 4, left - tip.offsetWidth / 2))}px`;
    });

    const leave = () => { cross.style.display = "none"; tip.hidden = true; };
    hit.addEventListener("pointerleave", leave);
    hit.addEventListener("pointercancel", leave);
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
      parts.push(data.delivery?.basis === "window"
        ? `pump delivery fitted from ${data.delivery.bands} pressure bands in this window`
        : "pump delivery from the qualification fill, too few cycles here to fit");
    } else if (view === "energy") {
      parts.push(`${totals.energyKWh ?? 0} kWh from the meter's running total`);
      parts.push("includes the idle draw of the well-head equipment");
    } else if (view === "load") {
      const runs = (data.runs || []).length;
      parts.push("Average LoadRatioPercent while the pump ran");
      parts.push(runs ? "a steady drift over weeks is the signal; one reading is not" : "no run in this window");
    } else {
      parts.push(`${totals.starts ?? 0} start${totals.starts === 1 ? "" : "s"}`);
      if (totals.runSeconds) parts.push(`${Math.round(totals.runSeconds / 60)} min running`);
    }
    return parts.join(" · ");
  }

  return { caption, mount, tipText };
})());
