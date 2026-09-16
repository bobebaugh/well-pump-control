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
    starts: { "1d": 12, "7d": 24 }
  };

  const VIEWS = {
    gallons: { key: "gallons", title: "Tank water", unit: "gal", mark: "line", decimals: 1 },
    used: { key: "used", title: "Water used", unit: "gal", mark: "bar", decimals: 1 },
    starts: { key: "starts", title: "Pump starts", unit: "starts", mark: "bar", decimals: 0 }
  };

  function groupBuckets(buckets, factor, key) {
    if (factor <= 1) return buckets.map(bucket => ({ startMs: bucket.startMs, value: bucket[key] }));
    const grouped = [];
    for (let index = 0; index < buckets.length; index += factor) {
      const slice = buckets.slice(index, index + factor);
      // A level is a state: the group takes the last reading it actually has, and
      // stays null when the whole group was silent. A flow is a sum.
      const value = key === "gallons"
        ? (slice.filter(item => item.gallons !== null).at(-1)?.gallons ?? null)
        : slice.reduce((sum, item) => sum + item[key], 0);
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

  function axis(points, { integer = false } = {}) {
    const max = Math.max(0, ...points.map(point => point.value ?? 0));
    if (max <= 0) return { max: integer ? 4 : 1, ticks: integer ? [0, 1, 2, 3, 4] : [0, 0.25, 0.5, 0.75, 1] };
    let top = niceCeiling(max);
    if (integer) top = Math.max(4, Math.ceil(top));
    const divisions = integer && top <= 4 ? top : 4;
    return { max: top, ticks: Array.from({ length: divisions + 1 }, (unused, index) => (top / divisions) * index) };
  }

  function plot(width) {
    return { x: PAD.left, y: PAD.top, width: Math.max(10, width - PAD.left - PAD.right), height: HEIGHT - PAD.top - PAD.bottom };
  }

  // Null is a gap, not a zero: where reporting went silent the trace breaks
  // instead of drawing a straight line through the missing time.
  function linePath(points, area, max) {
    const step = area.width / Math.max(1, points.length - 1);
    const at = index => area.x + index * step;
    const level = value => area.y + area.height - (value / max) * area.height;
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

  return { GROUPING, HEIGHT, PAD, VIEWS, areaPath, axis, barPath, bars, groupBuckets, linePath, niceCeiling, plot };
})();

if (typeof module === "object" && module.exports) module.exports = HistoryChart;
