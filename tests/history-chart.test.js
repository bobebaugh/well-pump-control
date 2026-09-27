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
  // One per local midnight in the week: six or seven depending on the zone.
  const labels = chart.timeLabels("7d", week).length;
  assert.ok(labels >= 6 && labels <= 7, `${labels} labels`);
});

test("the caption says what the water-used figure rests on, never implying a meter", () => {
  const base = { totals: { usedGallons: 41.2, starts: 9, runSeconds: 900 },
                 pressureSwitch: { cycles: 9, cutInPsi: 39.1, settledPsi: 60 } };
  const fitted = chart.caption({ ...base, delivery: { basis: "fills", fills: 16 } }, "used");
  assert.match(fitted, /estimated/);
  assert.match(fitted, /fastest clean fills of the last 7 days \(16\)/);
  const fallback = chart.caption({ ...base, delivery: { basis: "reference", fills: 1 } }, "used");
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
  assert.match(something.markup, /<svg viewBox="0 0 640 320"/);
});

test("markup is escaped, since labels come from Intl and flow into HTML", () => {
  assert.equal(chart.escape('<b>&"'), "&lt;b&gt;&amp;&quot;");
});

test("a trend axis zooms to its readings, keeping zero for a rate of either sign", () => {
  const scale = chart.axis([{ value: 100.5 }, { value: null }, { value: 102.4 }], { floor: true });
  assert.ok(scale.min > 90 && scale.min <= 100.5, `min ${scale.min}`);
  assert.ok(scale.max >= 102.4 && scale.max < 110, `max ${scale.max}`);
  assert.equal(chart.axis([{ value: 3 }]).min, 0, "bucket views still start at zero");
  const fill = chart.axis([{ value: 44.2 }, { value: 45.1 }], { floor: true, minSpan: 6 });
  assert.ok(fill.max - fill.min >= 6 && fill.max - fill.min <= 12, "a steady fill time is not magnified into a trend");
  const leak = chart.axis([{ value: 0.01 }, { value: 0.04 }], { floor: true, minSpan: 0.2, zero: true });
  assert.ok(leak.min <= 0 && leak.max >= 0.04 && leak.max <= 0.5);
});

// The zoom rail and the trend views.

const HOUR = 3600000;
const DAY = 24 * HOUR;

test("zoom handles stay inside the window and at least the minimum span apart", () => {
  const extent = [T0, T0 + DAY];
  assert.deepEqual(chart.clampZoom("from", T0 - HOUR, [T0, T0 + DAY], extent, HOUR), [T0, T0 + DAY]);
  assert.deepEqual(chart.clampZoom("from", T0 + DAY, [T0, T0 + 10 * HOUR], extent, HOUR), [T0 + 9 * HOUR, T0 + 10 * HOUR]);
  assert.deepEqual(chart.clampZoom("to", T0 + 2 * DAY, [T0, T0 + 10 * HOUR], extent, HOUR), [T0, T0 + DAY]);
  assert.deepEqual(chart.clampZoom("to", T0, [T0 + 5 * HOUR, T0 + 10 * HOUR], extent, HOUR), [T0 + 5 * HOUR, T0 + 6 * HOUR]);
});

test("a zoomed range cuts the bucket series to the buckets it covers", () => {
  const data = { startMs: T0, endMs: T0 + DAY, buckets: bucketsOf(288, index => ({ gallons: index, used: 1, starts: 0 })) };
  assert.equal(chart.points(data, "gallons", "1d").length, 288);
  const zoomed = chart.points(data, "gallons", "1d", [T0 + 6 * HOUR, T0 + 8 * HOUR]);
  assert.equal(zoomed.length, 24);
  assert.equal(zoomed[0].startMs, T0 + 6 * HOUR);
  // Hourly bars keep a bar that is only partly inside the range.
  assert.equal(chart.points(data, "used", "1d", [T0 + 6.5 * HOUR, T0 + 8 * HOUR]).length, 2);
});

test("the daily fill point is the fastest clean fill, and a day of drawn fills is best available", () => {
  const dayOf = ms => Math.floor(ms / DAY);
  const cycles = [
    { startMs: T0 + HOUR, fillSeconds: 46.0, clean: true },
    { startMs: T0 + 2 * HOUR, fillSeconds: 44.5, clean: true },
    { startMs: T0 + 3 * HOUR, fillSeconds: 41.0, clean: false },
    { startMs: T0 + DAY + HOUR, fillSeconds: 53.9, clean: false },
    { startMs: T0 + DAY + 2 * HOUR, fillSeconds: 50.0, clean: null },
    { startMs: T0 + 2 * DAY, fillSeconds: null, clean: false }
  ];
  const days = chart.dailyBest(cycles, dayOf);
  assert.deepEqual(days.map(day => [day.value, day.clean]), [[44.5, true], [50.0, false]]);
});

test("the daily leak-down point is the day's longest quiet stretch", () => {
  const dayOf = ms => Math.floor(ms / DAY);
  const days = chart.dailyLeak([
    { startMs: T0, endMs: T0 + 3 * HOUR, gallonsPerHour: 0.2 },
    { startMs: T0 + 4 * HOUR, endMs: T0 + 9 * HOUR, gallonsPerHour: 0.01 },
    { startMs: T0 + 3 * DAY, endMs: T0 + 3 * DAY + 2 * HOUR, gallonsPerHour: 0.05 }
  ], dayOf);
  assert.deepEqual(days.map(day => day.value), [0.01, 0.05]);
  assert.equal(days[0].hours, 5);
  // Two days apart: no line is drawn across the day with nothing measured.
  assert.equal(chart.joinDaily(days).length, 2);
});

test("time ticks are round and few, whatever the zoom", () => {
  for (const span of [2 * HOUR, DAY, 7 * DAY, 30 * DAY]) {
    const ticks = chart.timeTicks(T0 + 1234567, T0 + 1234567 + span);
    assert.ok(ticks.length >= 2 && ticks.length <= 8, `${ticks.length} ticks over ${span / HOUR} h`);
    for (const tick of ticks) assert.ok(tick.ms >= T0 + 1234567 && tick.ms <= T0 + 1234567 + span);
  }
});

test("the trend views draw runs where they happened, and say when there are none", () => {
  const data = { startMs: T0, endMs: T0 + DAY, buckets: [], quiet: [], cycles: [
    { startMs: T0 + HOUR, fillSeconds: 44.9, clean: true, cutInPsi: 39.2, cutOutPsi: 61.4 },
    { startMs: T0 + 5 * HOUR, fillSeconds: 53.9, clean: false, cutInPsi: 39.7, cutOutPsi: 61.2 }
  ] };
  const fill = chart.svgFor(data, "fill", "1d", 640);
  assert.equal(fill.empty, false);
  assert.equal(fill.series.length, 2);
  assert.equal((fill.markup.match(/hollow/g) || []).length, 1, "the drawn fill is hollow");
  const switches = chart.svgFor(data, "switch", "1d", 640);
  assert.equal(switches.series.length, 4, "a cut-in and a cut-out per run, in their own lanes");
  assert.match(switches.markup, /Cut-out/);
  assert.equal(chart.svgFor(data, "leak", "1d", 640).empty, true);
  const zoomed = chart.svgFor(data, "fill", "1d", 640, [T0 + 4 * HOUR, T0 + 6 * HOUR]);
  assert.equal(zoomed.series.length, 1);
});
