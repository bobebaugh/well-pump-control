"use strict";

// Replay a real durable-observation CSV export through planRetention.
//
//   node tests/record-retention-replay.check.cjs <export.csv> [floorSeconds...]
//
// The unit tests pin behaviour against constructed records. This pins it
// against the collection as it actually is, which is the only thing that can
// answer the question that matters before anything is deleted: how many
// records survive, and does the surviving series still draw a chart.
//
// It deletes nothing and touches no network. It reads a CSV produced by the
// record browser's export route and reports what a run WOULD do. Exit status
// is 1 if any checked property fails, so it can gate a review.

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_POLICY, LEVEL_CARRY_LIMIT_MS, planRetention
} = require("../cloud/netlify/lib/record-retention");

const FIXED = new Set([
  "recordId", "schemaVersion", "sessionId", "cycleSequence",
  "observationTime", "receiptTime", "observationTimeStatus", "triggerReasons"
]);

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') { cell += character; continue; }
      if (text[index + 1] === '"') { cell += '"'; index += 1; continue; }
      quoted = false;
    } else if (character === '"') { quoted = true; }
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (character !== "\r") { cell += character; }
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// The export flattens each field into value/availability/reason columns. Rebuild
// the schemaVersion 2 record shape the planner and record-browser.fieldState
// expect, so the replay exercises the real code path rather than a stand-in.
function recordsFromCsv(text) {
  const rows = parseCsv(text).filter(row => row.length > 1);
  const head = rows[0];
  const at = name => head.indexOf(name);
  const names = [...new Set(head.filter(column => !column.includes(".") && !FIXED.has(column)))];

  return rows.slice(1).filter(row => row.length === head.length).map(row => {
    const fields = {};
    for (const name of names) {
      const availability = row[at(`${name}.availability`)];
      const raw = row[at(name)];
      if (availability === "available") {
        const numeric = Number(raw);
        fields[name] = {
          state: "available",
          value: raw === "true" ? true : raw === "false" ? false
            : (raw !== "" && Number.isFinite(numeric) ? numeric : raw)
        };
      } else if (availability === "unavailable") {
        fields[name] = { state: "unavailable", reason: row[at(`${name}.reason`)] };
      }
      // "missing" is absent from the record by definition, so nothing is set.
    }
    let triggerReasons = [];
    try { triggerReasons = JSON.parse(row[at("triggerReasons")] || "[]"); } catch { triggerReasons = []; }
    return {
      recordId: row[at("recordId")], schemaVersion: 2,
      sessionId: row[at("sessionId")], cycleSequence: Number(row[at("cycleSequence")]),
      recordType: "observation", time: { observedAt: row[at("observationTime")] },
      triggerReasons, fields
    };
  });
}

// Paging is where a resumable delete goes wrong silently, so the replay drives
// it the way the executor would and checks the property that actually protects
// the data: a paged run must never delete a record the whole-window plan keeps.
function replayPaged(records, floorMs, anchor, pageSize) {
  let carry = {};
  const deleted = [];
  const kept = [];
  for (let start = 0; start < records.length; start += pageSize) {
    const page = records.slice(start, start + pageSize);
    const finalPage = start + pageSize >= records.length;
    const plan = planRetention(page, {
      floorMs, anchor, finalPage, evaluateFraction: false,
      nextSessionId: finalPage ? undefined : records[start + pageSize].sessionId,
      ...carry
    });
    deleted.push(...plan.delete.map(item => item.record.recordId));
    kept.push(...plan.keep.map(item => item.record.recordId));
    carry = plan.continuation;
  }
  return { deleted, kept };
}

function main(argv) {
  const [file, ...floorArgs] = argv;
  if (!file) {
    console.error("usage: node tests/record-retention-replay.check.cjs <export.csv> [floorSeconds...]");
    return 2;
  }
  const records = recordsFromCsv(fs.readFileSync(file, "utf8"));
  if (!records.length) { console.error(`no records parsed from ${file}`); return 2; }

  const floors = (floorArgs.length ? floorArgs.map(Number) : [60, 120, 300, 600, 900])
    .filter(seconds => Number.isFinite(seconds) && seconds > 0)
    .map(seconds => seconds * 1000);

  console.log(`${path.basename(file)}: ${records.length} records`);
  const probe = planRetention(records, {});
  if (!probe.anchorTime) {
    console.log(`\nNO ANCHOR for ${probe.anchorField} in this export: a run would refuse (${probe.refusal}).`);
    return 0;
  }
  console.log(`anchor ${probe.anchorField} first available ${probe.anchorTime} (${probe.anchorRecordId})`);
  console.log(`carry limit ${LEVEL_CARRY_LIMIT_MS / 60000} min; default floor ${DEFAULT_POLICY.floorMs / 1000}s\n`);

  let failures = 0;
  console.log("floor      keep      of total   delete   pre-anchor   worst gap   headroom   verdict");
  for (const floorMs of floors) {
    const plan = planRetention(records, { floorMs });
    const headroom = (LEVEL_CARRY_LIMIT_MS - plan.maxGapMs) / 60000;
    const verdict = plan.safe ? "ok" : plan.refusal;
    if (!plan.safe && floorMs === DEFAULT_POLICY.floorMs) failures += 1;
    console.log([
      `${String(floorMs / 1000).padStart(4)}s`,
      String(plan.stats.keep).padStart(9),
      `${(100 * plan.stats.keep / plan.stats.total).toFixed(1)}%`.padStart(12),
      String(plan.stats.delete).padStart(9),
      String(plan.stats.preAnchor).padStart(12),
      `${(plan.maxGapMs / 60000).toFixed(1)} min`.padStart(12),
      `${headroom.toFixed(1)} min`.padStart(11),
      `  ${verdict}`
    ].join(""));
  }

  // The paged run must be a subset of the whole-window run, at every page size.
  const floorMs = DEFAULT_POLICY.floorMs;
  const whole = planRetention(records, { floorMs, evaluateFraction: false });
  const wholeDeleted = new Set(whole.delete.map(item => item.record.recordId));
  console.log("\npaged replay at the default floor (executor path):");
  for (const pageSize of [50, 500, 2000]) {
    const paged = replayPaged(records, floorMs, whole.keep[0]?.record, pageSize);
    const stray = paged.deleted.filter(id => !wholeDeleted.has(id));
    const complete = new Set([...paged.deleted, ...paged.kept]).size === records.length;
    const ok = stray.length === 0 && complete;
    if (!ok) failures += 1;
    console.log(`  page ${String(pageSize).padStart(5)}: delete ${String(paged.deleted.length).padStart(6)}` +
      ` (whole ${whole.stats.delete})  stray ${stray.length}  accounts-for-all ${complete}  ${ok ? "ok" : "FAIL"}`);
    if (stray.length) console.log(`    first stray: ${stray.slice(0, 3).join(", ")}`);
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  return failures ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { recordsFromCsv, replayPaged, _main: main };
