"use strict";

// Chart geometry. The renderer needs a DOM, but everything that decides where a
// mark lands is pure and is tested here.

const test = require("node:test");
const assert = require("node:assert/strict");
const chart = require("../web/history-chart");

const T0 = Date.parse("2026-09-16T00:00:00Z");
const bucketsOf = (count, build) =>
  Array.from({ length: count }, (unused, index) => ({ startMs: T0 + index * 300000, ...build(index) }));

test("axis ticks are round steps, not the maximum cut into four", () => {
  // Dividing 24 into four gives 6, 12, 18 -- but 25/4 gives 6.25, 12.5, 18.75.
  assert.deepEqual(chart.axis([{ value: 24 }]).ticks, [0, 5, 10, 15, 20, 25]);
  assert.deepEqual(chart.axis([{ value: 0.8 }]).ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(chart.axis([{ value: 3 }], { integer: true }).ticks, [0, 1, 2, 3, 4]);
});

test("the axis always clears the tallest mark, so nothing reads as clipped", () => {
  for (const value of [1, 3, 20, 25, 100]) {
    assert.ok(chart.axis([{ value }]).max > value, `${value} touches the ceiling`);
  }
});

test("an empty series still yields a drawable axis", () => {
  assert.equal(chart.axis([]).max, 1);
  assert.equal(chart.axis([{ value: null }], { integer: true }).max, 4);
});

test("a level takes the last reading in a group; a flow is summed", () => {
  const buckets = bucketsOf(4, index => ({ gallons: 10 + index, used: 1, starts: 1 }));
  assert.deepEqual(chart.groupBuckets(buckets, 4, "gallons").map(item => item.value), [13]);
  assert.deepEqual(chart.groupBuckets(buckets, 4, "used").map(item => item.value), [4]);
  assert.deepEqual(chart.groupBuckets(buckets, 4, "starts").map(item => item.value), [4]);
});

test("a group with no reading stays null rather than collapsing to zero", () => {
  const buckets = bucketsOf(2, () => ({ gallons: null, used: 0, starts: 0 }));
  assert.equal(chart.groupBuckets(buckets, 2, "gallons")[0].value, null);
});

test("bars regroup so a week of starts reads as seven daily columns", () => {
  const day = bucketsOf(288, () => ({ gallons: 1, used: 1, starts: 0 }));
  const week = bucketsOf(168, () => ({ gallons: 1, used: 1, starts: 0 }));
  assert.equal(chart.groupBuckets(day, chart.GROUPING.starts["1d"], "starts").length, 24);
  assert.equal(chart.groupBuckets(week, chart.GROUPING.starts["7d"], "starts").length, 7);
  assert.equal(chart.groupBuckets(day, chart.GROUPING.gallons["1d"], "gallons").length, 288);
});

test("a gap in the level breaks the line instead of drawing through it", () => {
  const area = chart.plot(400);
  const single = chart.linePath([{ value: 1 }, { value: 2 }, { value: 3 }], area, 4);
  const broken = chart.linePath([{ value: 1 }, { value: null }, { value: 3 }], area, 4);
  assert.equal(single.length, 1);
  assert.equal(broken.length, 2, "a null should split the trace into two segments");
});

test("an area closes to the baseline under its own segment", () => {
  const area = chart.plot(400);
  const [path] = chart.areaPath(chart.linePath([{ value: 1 }, { value: 2 }], area, 4), area);
  const base = (area.y + area.height).toFixed(1);
  assert.ok(path.endsWith("Z"));
  assert.ok(path.includes(` ${base} L`), "the closing edge should sit on the baseline");
});

test("bars leave a surface gap between neighbours and round only the data end", () => {
  const area = chart.plot(400);
  const [first, second] = chart.bars([{ value: 1 }, { value: 2 }], area, 4);
  assert.equal(Math.round(second.x - (first.x + first.width)), 2);
  // Square against the baseline, curved at the top.
  const path = chart.barPath(0, 10, 20, 40);
  assert.ok(path.startsWith("M0.0 50.0"));
  assert.equal((path.match(/Q/g) || []).length, 2);
});

test("a bar shorter than the corner radius stays inside its own footprint", () => {
  // A 2px bar with a 4px radius would otherwise round past its baseline and
  // hang below the axis.
  const top = 48, height = 2, bottom = top + height;
  const path = chart.barPath(0, top, 20, height);
  const ys = [...path.matchAll(/[ML Q]\s*[\d.]+\s+([\d.]+)/g)].map(match => Number(match[1]));
  assert.ok(ys.length >= 4);
  assert.ok(Math.max(...ys) <= bottom + 0.01, `hangs below the baseline: ${Math.max(...ys)} > ${bottom}`);
  assert.ok(Math.min(...ys) >= top - 0.01, `pokes above the bar: ${Math.min(...ys)} < ${top}`);
  // And a normal bar is unaffected.
  const normal = [...chart.barPath(0, 10, 20, 40).matchAll(/[ML Q]\s*[\d.]+\s+([\d.]+)/g)].map(m => Number(m[1]));
  assert.ok(Math.max(...normal) <= 50.01 && Math.min(...normal) >= 9.99);
});

test("the axis carries a handful of time labels, not one per bucket", () => {
  const day = Array.from({ length: 288 }, (unused, index) => ({ startMs: T0 + index * 300000 }));
  assert.ok(chart.timeLabels("1d", day).length <= 7);
  const week = Array.from({ length: 7 }, (unused, index) => ({ startMs: T0 + index * 86400000 }));
  assert.equal(chart.timeLabels("7d", week).length, 7);
});

test("the caption says what the water-used figure rests on, never implying a meter", () => {
  const base = { totals: { usedGallons: 41.2, starts: 9, runSeconds: 900 },
                 pressureSwitch: { cycles: 9, cutInPsi: 39.1, settledPsi: 60 } };
  const fitted = chart.caption({ ...base, delivery: { basis: "window", bands: 6 } }, "used");
  assert.match(fitted, /estimated/);
  assert.match(fitted, /fitted from 6 pressure bands/);
  const fallback = chart.caption({ ...base, delivery: { basis: "reference", bands: 1 } }, "used");
  assert.match(fallback, /qualification fill/);
});

test("the gallons caption reports the observed band, and says so when there is none", () => {
  const observed = chart.caption({ totals: {}, pressureSwitch: { cycles: 4, cutInPsi: 39.1, settledPsi: 60 } }, "gallons");
  assert.match(observed, /39\.1–60 psi over 4 cycles/);
  assert.match(chart.caption({ totals: {}, pressureSwitch: { cycles: 0 } }, "gallons"), /not yet observed/);
});

test("the rendered SVG reports emptiness so the page can explain it", () => {
  const nothing = chart.svgFor({ buckets: bucketsOf(288, () => ({ gallons: null, used: 0, starts: 0 })) },
                               "gallons", "1d", 640);
  assert.equal(nothing.empty, true);
  const something = chart.svgFor({ buckets: bucketsOf(288, index => ({ gallons: 10 + index % 5, used: 1, starts: 0 })) },
                                 "gallons", "1d", 640);
  assert.equal(something.empty, false);
  assert.match(something.markup, /<svg viewBox="0 0 640 260"/);
});

test("markup is escaped, since labels come from Intl and flow into HTML", () => {
  assert.equal(chart.escape('<b>&"'), "&lt;b&gt;&amp;&quot;");
});
