const endpoint = "/.netlify/functions/record-browser";
const optionalMetadata = [
  { name: "session-cycle", label: "Session / cycle", width: "170px" },
  { name: "release", label: "Release", width: "180px" },
  { name: "receipt-time", label: "Receipt time", width: "190px" }
];
// Presets name the fields they would like; each shows whichever of them the
// records on the page actually carry, so a field that stops being logged, or is
// renamed, simply drops out rather than breaking the view.
const presets = [
  { id: "standard", label: "Standard", columns: ["ContactorFlag", "PumpWatts", "PressurePSI", "TankWaterGallons", "TankNetFlowGPM"] },
  { id: "electrical", label: "Electrical", columns: ["PumpWatts", "SupplyVoltage", "PowerFactor", "LoadRatioPercent", "ShellyEMAvailable"] },
  { id: "protection", label: "Protection", columns: ["ContactorFlag", "PumpEnable", "IsLocked", "Shelly1Available", "OperatingMode"] },
  { id: "health", label: "Device health", columns: ["ClockValid", "WiFiConnected", "CloudAvailable", "BufferUsedPercent", "RecordsLost", "BatteryPercent"] }
];
const storageKey = "recordBrowserColumns.v2";
const filterKey = "recordBrowserReasonFilter.v1";
const reasons = globalThis.RecordReasons;
const MAX_EXPORT_DAYS = 32;
const qs = new URLSearchParams(location.search);
const linked = qs.get("session") ? { session: qs.get("session"), cycle: qs.get("cycle") || "0", event: qs.get("event") || "" } : null;
// What sets the rows: a quick range, a custom From/To, an event, or receipt time.
const quickRanges = { "8h": () => new Date(Date.now() - 8 * 3600000), today: () => { const value = new Date(); value.setHours(0, 0, 0, 0); return value; }, "24h": () => new Date(Date.now() - 86400000), "7d": () => new Date(Date.now() - 7 * 86400000) };
const quickButtons = { "8h": "#range-8h", today: "#range-today", "24h": "#range-day", "7d": "#range-week" };
const state = { source: linked ? "event" : "24h", rangeSource: "24h", link: linked, events: [], eventChoice: linked ? "link" : "", scan: null, reasonFilter: "all", expanded: new Set(), toFollowsNow: true, currentStart: null, currentDirection: "after", nextCursor: null, previousCursor: null, trail: [], columns: [], metadata: [], catalog: [], records: [], preset: "standard", trigger: null, triggerChecked: false, customizeOpen: false, mode: linked ? "session" : "observation" };
const statusLine = document.querySelector("#records-status");
const table = document.querySelector("#records-table");
const picker = document.querySelector("#column-picker");
const rangeFrom = document.querySelector("#range-from");
const rangeTo = document.querySelector("#range-to");
const exportShown = document.querySelector("#export-shown");
const eventSelect = document.querySelector("#event-select");
const newer = document.querySelector("#newer-records");
const older = document.querySelector("#older-records");
const historyState = { cursor: null, next: null, trail: [] };

function localDateTime(value = new Date()) { const offset = value.getTimezoneOffset() * 60000; return new Date(value - offset).toISOString().slice(0, 16); }
function time(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "Unknown device time"; }
function clock(value) { return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date(value)); }
function dateHeading(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(value)) : "Unknown device time"; }
function duration(ms) { return ms < 120000 ? `${Math.round(ms / 1000)} s` : ms < 5400000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`; }
// Rounded for the narrow table only; the expanded row and the CSV keep every digit.
function brief(value) { return typeof value === "number" && !Number.isInteger(value) ? String(Number(value.toFixed(2))) : typeof value === "object" ? JSON.stringify(value) : String(value); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]); }
function cell(field = { state: "missing" }) { if (field.state === "available") return `<span title="${escapeHtml(typeof field.value === "object" ? JSON.stringify(field.value) : field.value)}">${escapeHtml(brief(field.value))}</span>`; if (field.state === "unavailable") return `<span class="unavailable-value">Unavailable · ${escapeHtml(field.reason)}</span>`; return `<span class="missing-value">Not in this record</span>`; }
function updateButtons() { if (state.mode === "session") { older.disabled = !state.previousCursor; newer.disabled = !state.nextCursor; older.textContent = "Earlier records"; newer.textContent = "Later records"; return; } older.textContent = "Older"; newer.textContent = "Newer"; newer.disabled = !state.trail.length; older.disabled = !state.nextCursor; }
// The selection is kept by name in this browser only and is the same on every
// screen. An event link adds that event's first trigger field for the visit;
// it is never saved, and leaving the event's session drops it.
function savedSelection() { try { const saved = JSON.parse(localStorage.getItem(storageKey) || "null"); return saved && Array.isArray(saved.columns) ? saved : null; } catch { return null; } }
function savedFilter() { try { const value = localStorage.getItem(filterKey); return reasons.filters.some(([id]) => id === value) ? value : "all"; } catch { return "all"; } }
function saveFilter() { try { localStorage.setItem(filterKey, state.reasonFilter); } catch {} }
function saveSelection() { try { localStorage.setItem(storageKey, JSON.stringify({ preset: state.preset, columns: state.columns, metadata: state.metadata })); } catch {} }
function presetFor(columns) { return presets.find(item => item.columns.join(",") === columns.join(","))?.id || "custom"; }
function present() { return new Set(state.catalog.map(item => item.name)); }
function selectedColumns() { return state.trigger && !state.columns.includes(state.trigger) ? [...state.columns, state.trigger] : state.columns; }
function shownColumns() { const names = present(); return selectedColumns().filter(name => names.has(name)); }
function renderColumns() {
  const names = present();
  const options = [...presets.map(item => [item.id, item.label]), ...(state.preset === "custom" ? [["custom", "Custom"]] : [])];
  const chipClass = name => `column-chip${names.has(name) ? "" : " absent"}${name === state.trigger && !state.columns.includes(name) ? " trigger" : ""}`;
  const chipTitle = name => name === state.trigger && !state.columns.includes(name) ? ' title="This event\'s trigger field, shown for this visit only"' : names.has(name) ? "" : ' title="Not in the records on this page"';
  const chips = selectedColumns().map(name => `<span class="${chipClass(name)}"${chipTitle(name)}>${escapeHtml(name)}<button type="button" data-remove="${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">×</button></span>`).join("") || `<span class="column-empty">No field columns selected.</span>`;
  const offered = [...state.catalog.map(item => item.name), ...selectedColumns().filter(name => !names.has(name))].sort((left, right) => left.localeCompare(right));
  const filterOptions = reasons.filters.map(([id, label]) => `<option value="${id}"${id === state.reasonFilter ? " selected" : ""}>${label}</option>`).join("");
  picker.innerHTML = `<div class="column-bar"><label>View<select data-kind="preset">${options.map(([id, label]) => `<option value="${id}"${id === state.preset ? " selected" : ""}>${label}</option>`).join("")}</select></label><label>Show<select data-kind="filter">${filterOptions}</select></label><div class="column-chips">${chips}</div></div>` +
    `<details class="column-more"${state.customizeOpen ? " open" : ""}><summary>Customize</summary><div class="column-options">${optionalMetadata.map(item => `<label><input type="checkbox" data-kind="metadata" value="${item.name}" ${state.metadata.includes(item.name) ? "checked" : ""}>${item.label}</label>`).join("")}</div>` +
    `<div class="column-options">${offered.map(name => `<label${names.has(name) ? "" : ' class="absent"'}><input type="checkbox" data-kind="data" value="${escapeHtml(name)}" ${selectedColumns().includes(name) ? "checked" : ""}>${escapeHtml(name)}</label>`).join("") || `<span class="column-empty">No fields in the records on this page.</span>`}</div></details>`;
}
function selectColumns(columns, preset = presetFor(columns)) { state.columns = [...columns]; state.preset = preset; saveSelection(); }
// Removing a column or changing metadata needs no new read: the page already
// holds everything still shown. Adding a field does, because the server sends
// only the requested fields.
picker.addEventListener("change", event => {
  const target = event.target; const kind = target.dataset?.kind;
  if (kind === "filter") { state.reasonFilter = reasons.filters.some(([id]) => id === target.value) ? target.value : "all"; saveFilter(); renderColumns(); if (state.mode === "observation") { state.trail = []; load(); } else render(state.records); }
  else if (kind === "preset") { const preset = presets.find(item => item.id === target.value); if (preset) selectColumns(preset.columns, preset.id); load(state.currentStart, state.currentDirection); }
  else if (kind === "metadata") { state.metadata = target.checked ? [...new Set([...state.metadata, target.value])] : state.metadata.filter(name => name !== target.value); saveSelection(); renderColumns(); render(state.records); }
  else if (kind === "data" && target.checked) { if (!state.columns.includes(target.value)) selectColumns([...state.columns, target.value]); load(state.currentStart, state.currentDirection); }
  else if (kind === "data") { dropColumn(target.value); renderColumns(); render(state.records); }
});
// Dropping the visit-only trigger field saves nothing; dropping a selected field saves.
function dropColumn(name) { if (name === state.trigger) state.trigger = null; if (state.columns.includes(name)) selectColumns(state.columns.filter(item => item !== name)); }
picker.addEventListener("click", event => { const name = event.target.dataset?.remove; if (name === undefined) return; dropColumn(name); renderColumns(); render(state.records); });
picker.addEventListener("toggle", event => { if (event.target.tagName === "DETAILS") state.customizeOpen = event.target.open; }, true);
// A change back to an earlier value: how long the field held the value it is
// leaving, measured between the two records' device times on this page.
function held(record, reason, records) {
  if (reason.kind !== "change" || !record.observationTime) return null;
  const at = Date.parse(record.observationTime);
  const earlier = records.filter(item => item.sessionId === record.sessionId && item.observationTime && Date.parse(item.observationTime) < at && item.triggerReasons.some(other => other.kind === "change" && other.field === reason.field && JSON.stringify(other.to) === JSON.stringify(reason.from)));
  const start = Math.max(...earlier.map(item => Date.parse(item.observationTime)));
  return Number.isFinite(start) ? at - start : null;
}
function reasonCell(record, records) {
  const first = reasons.ordered(record.triggerReasons)[0];
  const span = first ? held(record, first, records) : null;
  return `<span class="reason-label" title="${escapeHtml(reasons.summary(record.triggerReasons))}">${escapeHtml(reasons.short(record.triggerReasons))}${span === null ? "" : ` <small class="reason-held">after ${duration(span)}</small>`}</span>`;
}
function detailRow(record, records, columns) {
  const lines = reasons.ordered(record.triggerReasons).map(reason => { const span = held(record, reason, records); return `<li>${escapeHtml(reasons.detail(reason))}${span === null ? "" : escapeHtml(` · ${reason.field} was ${JSON.stringify(reason.from)} for ${duration(span)}`)}</li>`; }).join("") || "<li>No reason recorded.</li>";
  const values = columns.map(name => { const field = record.fields[name] || { state: "missing" }; return `<span><strong>${escapeHtml(name)}</strong> ${field.state === "available" ? escapeHtml(typeof field.value === "object" ? JSON.stringify(field.value) : field.value) : field.state === "unavailable" ? `Unavailable · ${escapeHtml(field.reason)}` : "Not in this record"}</span>`; }).join("");
  return `<div class="records-detail"><ul>${lines}</ul>${values ? `<div class="records-detail-values">${values}</div>` : ""}<small>${escapeHtml(time(record.observationTime))} · session ${escapeHtml(record.sessionId)} / cycle ${escapeHtml(record.cycleSequence ?? "—")}</small></div>`;
}
function render(records) {
  state.records = records;
  const columns = shownColumns();
  table.style.setProperty("--record-columns", String(Math.max(1, columns.length)));
  const selectedMetadata = optionalMetadata.filter(item => state.metadata.includes(item.name));
  table.style.setProperty("--record-grid-template", ["120px", ...selectedMetadata.map(item => item.width), "140px", `repeat(var(--record-columns, 6), minmax(90px, 1fr))`].join(" "));
  const headers = ["Observation time", ...selectedMetadata.map(item => item.label), "Reasons", ...columns];
  const metadataCells = record => selectedMetadata.map(item => item.name === "session-cycle" ? `<span>${escapeHtml(record.sessionId)} / ${escapeHtml(record.cycleSequence ?? "—")}</span>` : item.name === "release" ? `<span>${escapeHtml(record.rulesRelease?.releaseId || record.rulesRelease?.version || "Not recorded")}</span>` : `<span>${record.receiptTime ? time(record.receiptTime) : "Not stored"}</span>`).join("");
  const shown = records.filter(record => reasons.matches(record.triggerReasons, state.reasonFilter));
  const note = shown.length < records.length ? `<p class="records-note">Showing ${shown.length} of ${records.length} records on this page. Older and Newer move through all records.</p>` : "";
  let lastDate = null;
  const rows = shown.map(record => {
    const heading = dateHeading(record.observationTime);
    const divider = heading === lastDate ? "" : `<div class="records-date">${escapeHtml(heading)}</div>`; lastDate = heading;
    const marked = reasons.fields(record.triggerReasons); const open = state.expanded.has(record.recordId);
    return `${divider}<div class="records-row records-record${open ? " expanded" : ""}" data-record="${escapeHtml(record.recordId)}" tabindex="0" aria-expanded="${open}"> <span>${record.observationTime ? clock(record.observationTime) : "Unknown device time<br><small>Unsynchronized; use session/cycle navigation.</small>"}</span>${metadataCells(record)}${reasonCell(record, records)}${columns.map(name => `<span${marked.has(name) ? ' class="trigger-cell"' : ""}>${cell(record.fields[name])}</span>`).join("")}</div>${open ? detailRow(record, records, columns) : ""}`;
  }).join("");
  table.innerHTML = `<div class="records-row records-head">${headers.map(escapeHtml).map(value => `<strong>${value}</strong>`).join("")}</div>` + note + (shown.length ? rows : `<p class="event-empty">${records.length ? "No records on this page match the Show filter." : "No observation records match this position."}</p>`);
}
// Click or Enter on a row opens its full reasons and values below it.
function toggleRow(event) {
  const row = event.target?.closest?.("[data-record]"); if (!row) return;
  const id = row.dataset.record; if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
  render(state.records);
}
table.addEventListener("click", toggleRow);
table.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault?.(); toggleRow(event); } });
async function request(url) { const response = await fetch(url, { cache: "no-store" }); const body = await response.json().catch(() => ({})); if (!response.ok) { const error = new Error(body.code || "read_failed"); error.body = body; throw error; } return body; }
function scanNote(scan, count) {
  if (!scan || scan.filter === "all") return "";
  return scan.capped ? ` Read ${scan.scanned} records back to ${time(scan.searchedTo)} and found ${count} that match; Older keeps searching.` : "";
}
async function load(pageCursor = null, direction = "after") {
  statusLine.textContent = "Loading durable records…"; highlight();
  const link = state.link || {};
  const params = new URLSearchParams({ columns: state.columns.join(",") }); if (pageCursor) params.set("cursor", pageCursor);
  if (state.mode === "session") { params.set("view", "session"); params.set("session", link.session); params.set("cycle", link.cycle || "0"); params.set("direction", direction); if (link.event) params.set("event", link.event); }
  else if (state.mode === "receipt") params.set("view", "receipt");
  else { const chosen = range(); if (chosen.error) { statusLine.textContent = chosen.error; return; } params.set("start", chosen.start.toISOString()); if (!pageCursor) params.set("anchor", chosen.end.toISOString()); params.set("filter", state.reasonFilter); }
  try { const data = await request(`${endpoint}?${params}`); if (!state.triggerChecked && link.event && state.mode === "session") { state.triggerChecked = true; state.trigger = data.eventTriggerField || null; } state.catalog = data.catalog; if (state.mode === "session" && data.status === "empty" && pageCursor) { if (direction === "before") state.previousCursor = null; else state.nextCursor = null; statusLine.textContent = direction === "before" ? "No earlier session records exist; showing the last available records." : "No later session records exist; showing the last available records."; updateButtons(); return; } state.currentStart = pageCursor; state.currentDirection = direction; state.nextCursor = data.nextCursor; state.previousCursor = data.previousCursor; state.scan = data.scan || null; renderColumns(); render(data.records); statusLine.textContent = (data.status === "empty" ? (state.mode === "observation" ? "No matching records in this range." : "No records at this position.") : (data.source === "receipt-time-fallback" ? "Receipt-time fallback: this is cloud receipt time, not device observation time." : "Observation time is device-reported time. Receipt time is shown separately.")) + scanNote(data.scan, data.records.length); updateButtons(); } catch (error) { statusLine.textContent = error.body?.code === "configuration_missing" ? "Configuration is unavailable." : error.body?.code === "read_denied" ? "Record reading is denied by the current service configuration." : error.body?.code === "invalid_cursor" ? "This browsing position is invalid; choose Latest or a new range." : "Read failed. The page remains usable; try again."; }
}
function stamp(value) { return value.replace(/-/g, "").replace(":", "").replace("T", "_"); }
// From and To are local wall-clock times. To follows "now" until it is edited,
// so the newest records and an export always run to the moment they are asked for.
function setRange(from, to = new Date()) { rangeFrom.value = localDateTime(from); rangeTo.value = localDateTime(to); state.toFollowsNow = true; }
function range() {
  if (state.toFollowsNow) rangeTo.value = localDateTime();
  const start = new Date(rangeFrom.value); const end = new Date(rangeTo.value);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return { error: "Choose both a From and a To date and time." };
  // The To minute is included whole.
  end.setSeconds(59, 999);
  if (end <= start) return { error: "To must be later than From." };
  if (end - start > MAX_EXPORT_DAYS * 86400000) return { error: `Choose a range of ${MAX_EXPORT_DAYS} days or less.` };
  return { start, end };
}
// Exactly one choice is marked as the one setting the rows.
function mark(selector, on) { document.querySelector(selector)?.classList?.toggle("is-current", on); }
function highlight() {
  for (const [id, selector] of Object.entries(quickButtons)) mark(selector, state.source === id);
  mark("#range-custom", state.source === "custom"); mark("#range-custom-to", state.source === "custom");
  mark("#event-choice", state.source === "event"); mark("#receipt-records", state.source === "receipt");
}
function leaveSession(mode) { state.mode = mode; state.currentStart = null; state.trail = []; state.trigger = null; state.expanded.clear(); }
function applyRange(source) {
  if (quickRanges[source]) setRange(quickRanges[source]()); else if (state.toFollowsNow) rangeTo.value = localDateTime();
  state.source = source; state.rangeSource = source; state.eventChoice = "";
  leaveSession("observation"); load(); loadEvents();
}
function eventLabel(item) { const at = item.observedAt || item.firstReportedAt; return `${at ? time(at) : "Time unknown"} · ${item.displayName || item.eventDefinitionId} (${item.eventDefinitionId})`; }
function renderEvents(note = null) {
  const link = state.link || {};
  const linkedListed = state.events.some(item => item.sessionId === link.session && String(item.cycleSequence) === String(link.cycle) && item.eventDefinitionId === link.event);
  const extra = state.eventChoice === "link" && !linkedListed ? `<option value="link" selected>Linked event ${escapeHtml(link.event || "")} (session ${escapeHtml(link.session || "")})</option>` : "";
  const options = state.events.map((item, index) => { const chosen = state.source === "event" && item.sessionId === link.session && String(item.cycleSequence) === String(link.cycle) && item.eventDefinitionId === link.event; return `<option value="${index}"${chosen ? " selected" : ""}>${escapeHtml(eventLabel(item))}</option>`; }).join("");
  eventSelect.innerHTML = `<option value="">${escapeHtml(note || `Events in this range (${state.events.length})`)}</option>${extra}${options}`;
}
async function loadEvents() {
  const chosen = range(); if (chosen.error) return;
  try { const data = await request(`${endpoint}?${new URLSearchParams({ view: "events", start: chosen.start.toISOString(), end: chosen.end.toISOString() })}`); state.events = Array.isArray(data.events) ? data.events : []; renderEvents(); } catch { state.events = []; renderEvents("Event list unavailable"); }
}
function chooseEvent(value) {
  if (value === "" || value === "link" && !state.link) { applyRange(state.rangeSource); return; }
  if (value !== "link") { const item = state.events[Number(value)]; if (!item || item.cycleSequence === null) { statusLine.textContent = "That event has no device cycle to open at."; return; } state.link = { session: item.sessionId, cycle: String(item.cycleSequence), event: item.eventDefinitionId }; }
  state.eventChoice = value; state.source = "event"; state.triggerChecked = false;
  leaveSession("session"); renderEvents(); load();
}
// In event view the export covers the span of the rows on screen.
function exportWindow() {
  if (state.source !== "event") return range();
  const times = state.records.map(record => Date.parse(record.observationTime)).filter(Number.isFinite);
  if (!times.length) return { error: "No timed rows on screen to export." };
  return { start: new Date(Math.min(...times)), end: new Date(Math.max(...times) + 1) };
}
async function exportRange() {
  const chosen = exportWindow(); if (chosen.error) { statusLine.textContent = chosen.error; return; }
  const params = new URLSearchParams({ view: "export", start: chosen.start.toISOString(), end: chosen.end.toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (exportShown.checked) { params.set("columns", selectedColumns().join(",")); params.set("filter", state.reasonFilter); }
  statusLine.textContent = "Exporting…";
  try { const response = await fetch(`${endpoint}?${params}`, { cache: "no-store" }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.code || "export_failed"); } const text = await response.text(); const blob = new Blob([text], { type: "text/csv" }); const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `durable-observations-${stamp(localDateTime(chosen.start))}-to-${stamp(localDateTime(chosen.end))}.csv` }); link.click(); URL.revokeObjectURL(link.href); statusLine.textContent = `Export complete: ${response.headers.get("X-Export-Record-Count")} records.`; } catch (error) { statusLine.textContent = error.message === "export_too_large" ? "Export is too large to complete safely; narrow the range." : error.message === "invalid_range" ? `The range was refused; choose ${MAX_EXPORT_DAYS} days or less with To after From.` : "Export failed; no partial file was presented as complete."; }
}
async function history(pageCursor = null) { const panel = document.querySelector("#history-panel"); panel.hidden = false; try { const data = await request(`${endpoint}?view=history${pageCursor ? `&cursor=${encodeURIComponent(pageCursor)}` : ""}`); document.querySelector("#history-list").innerHTML = data.occurrences.map(item => { const open = item.open; const close = item.close; const opening = open.opening?.observedAt ? `Device opening ${time(open.opening.observedAt)}` : `Device opening time unknown; first reported ${open.firstReportedAt ? time(open.firstReportedAt) : "unknown"}`; return `<article class="event-card ${open.severity.toLowerCase()}"><strong>${escapeHtml(open.severity)} · ${escapeHtml(open.displayName)}</strong><span>${escapeHtml(opening)}</span><span>${close ? `Closed by ${escapeHtml(close.closeReason)}; cloud detection ${time(close.detectedAt || close.restartDetectedAt)}. Device close time unknown.` : "Closure not recorded."}</span><a href="/records.html?session=${encodeURIComponent(open.sessionId)}&cycle=${open.opening?.cycleSequence || 0}&event=${encodeURIComponent(open.eventDefinitionId)}">View nearby observations</a></article>`; }).join("") || "<p class='event-empty'>No V3 occurrences found.</p>"; historyState.cursor = pageCursor; historyState.next = data.nextCursor; document.querySelector("#history-older").disabled = !historyState.next; document.querySelector("#history-newer").disabled = !historyState.trail.length; } catch { document.querySelector("#history-list").textContent = "Event history is currently unavailable."; } }
setRange(quickRanges["24h"]()); exportShown.checked = false; document.querySelector("#timezone-label").textContent = `Displayed in ${Intl.DateTimeFormat().resolvedOptions().timeZone}; day boundaries adjust for daylight-saving time. The CSV carries local and UTC times.`;
// Latest re-runs the current choice up to now; from an event it returns to the range.
document.querySelector("#latest-records").addEventListener("click", () => { if (state.source === "receipt") { leaveSession("receipt"); load(); } else { if (state.source === "custom") state.toFollowsNow = true; applyRange(state.source === "event" ? state.rangeSource : state.source); } });
document.querySelector("#receipt-records").addEventListener("click", () => { state.source = "receipt"; leaveSession("receipt"); load(); });
older.addEventListener("click", () => { if (state.mode === "session") { if (state.previousCursor) load(state.previousCursor, "before"); } else if (state.nextCursor) { state.trail.push(state.currentStart); load(state.nextCursor); } }); newer.addEventListener("click", () => { if (state.mode === "session") { if (state.nextCursor) load(state.nextCursor, "after"); } else load(state.trail.pop() || null); }); document.querySelector("#export-range").addEventListener("click", exportRange);
// Editing From or To makes a custom range once the edit settles.
let editTimer = null;
function customEdit(isTo) { if (isTo) state.toFollowsNow = false; clearTimeout(editTimer); editTimer = setTimeout(() => applyRange("custom"), 700); }
rangeFrom.addEventListener("change", () => customEdit(false)); rangeTo.addEventListener("change", () => customEdit(true));
for (const [id, selector] of Object.entries(quickButtons)) document.querySelector(selector).addEventListener("click", () => applyRange(id));
eventSelect.addEventListener("change", () => chooseEvent(eventSelect.value));
document.querySelector("#history-older").addEventListener("click", () => { if (historyState.next) { historyState.trail.push(historyState.cursor); history(historyState.next); } }); document.querySelector("#history-newer").addEventListener("click", () => history(historyState.trail.pop() || null));
// A saved preset follows that preset as it is defined now; a custom selection
// is restored exactly, even when it is empty.
state.reasonFilter = savedFilter();
{ const saved = savedSelection(); const preset = presets.find(item => item.id === saved?.preset) || (saved ? null : presets[0]); state.columns = [...(preset ? preset.columns : saved.columns)]; state.preset = preset ? preset.id : presetFor(state.columns); state.metadata = Array.isArray(saved?.metadata) ? saved.metadata.filter(name => optionalMetadata.some(item => item.name === name)) : []; }
if (qs.get("history") === "1") history(); load(); loadEvents();
