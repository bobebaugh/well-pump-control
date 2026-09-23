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
const state = { currentStart: null, currentDirection: "after", nextCursor: null, previousCursor: null, trail: [], columns: [], metadata: [], catalog: [], records: [], preset: "standard", trigger: null, triggerChecked: false, customizeOpen: false, mode: new URLSearchParams(location.search).get("session") ? "session" : "observation", anchor: null };
const qs = new URLSearchParams(location.search);
const statusLine = document.querySelector("#records-status");
const table = document.querySelector("#records-table");
const picker = document.querySelector("#column-picker");
const day = document.querySelector("#record-day");
const at = document.querySelector("#record-at");
const newer = document.querySelector("#newer-records");
const older = document.querySelector("#older-records");
const historyState = { cursor: null, next: null, trail: [] };

function localDay(value = new Date()) { const offset = value.getTimezoneOffset() * 60000; return new Date(value - offset).toISOString().slice(0, 10); }
function localDateTime(value = new Date()) { const offset = value.getTimezoneOffset() * 60000; return new Date(value - offset).toISOString().slice(0, 16); }
function time(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "Unknown device time"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]); }
function cell(field = { state: "missing" }) { if (field.state === "available") return escapeHtml(typeof field.value === "object" ? JSON.stringify(field.value) : field.value); if (field.state === "unavailable") return `<span class="unavailable-value">Unavailable · ${escapeHtml(field.reason)}</span>`; return `<span class="missing-value">Not in this record</span>`; }
function updateButtons() { if (state.mode === "session") { older.disabled = !state.previousCursor; newer.disabled = !state.nextCursor; older.textContent = "Earlier records"; newer.textContent = "Later records"; return; } older.textContent = "Older"; newer.textContent = "Newer"; newer.disabled = !state.trail.length; older.disabled = !state.nextCursor; }
// The selection is kept by name in this browser only and is the same on every
// screen. An event link adds that event's first trigger field for the visit;
// it is never saved, and leaving the event's session drops it.
function savedSelection() { try { const saved = JSON.parse(localStorage.getItem(storageKey) || "null"); return saved && Array.isArray(saved.columns) ? saved : null; } catch { return null; } }
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
  picker.innerHTML = `<div class="column-bar"><label>View<select data-kind="preset">${options.map(([id, label]) => `<option value="${id}"${id === state.preset ? " selected" : ""}>${label}</option>`).join("")}</select></label><div class="column-chips">${chips}</div></div>` +
    `<details class="column-more"${state.customizeOpen ? " open" : ""}><summary>Customize</summary><div class="column-options">${optionalMetadata.map(item => `<label><input type="checkbox" data-kind="metadata" value="${item.name}" ${state.metadata.includes(item.name) ? "checked" : ""}>${item.label}</label>`).join("")}</div>` +
    `<div class="column-options">${offered.map(name => `<label${names.has(name) ? "" : ' class="absent"'}><input type="checkbox" data-kind="data" value="${escapeHtml(name)}" ${selectedColumns().includes(name) ? "checked" : ""}>${escapeHtml(name)}</label>`).join("") || `<span class="column-empty">No fields in the records on this page.</span>`}</div></details>`;
}
function selectColumns(columns, preset = presetFor(columns)) { state.columns = [...columns]; state.preset = preset; saveSelection(); }
// Removing a column or changing metadata needs no new read: the page already
// holds everything still shown. Adding a field does, because the server sends
// only the requested fields.
picker.addEventListener("change", event => {
  const target = event.target; const kind = target.dataset?.kind;
  if (kind === "preset") { const preset = presets.find(item => item.id === target.value); if (preset) selectColumns(preset.columns, preset.id); load(state.currentStart, state.currentDirection); }
  else if (kind === "metadata") { state.metadata = target.checked ? [...new Set([...state.metadata, target.value])] : state.metadata.filter(name => name !== target.value); saveSelection(); renderColumns(); render(state.records); }
  else if (kind === "data" && target.checked) { if (!state.columns.includes(target.value)) selectColumns([...state.columns, target.value]); load(state.currentStart, state.currentDirection); }
  else if (kind === "data") { dropColumn(target.value); renderColumns(); render(state.records); }
});
// Dropping the visit-only trigger field saves nothing; dropping a selected field saves.
function dropColumn(name) { if (name === state.trigger) state.trigger = null; if (state.columns.includes(name)) selectColumns(state.columns.filter(item => item !== name)); }
picker.addEventListener("click", event => { const name = event.target.dataset?.remove; if (name === undefined) return; dropColumn(name); renderColumns(); render(state.records); });
picker.addEventListener("toggle", event => { if (event.target.tagName === "DETAILS") state.customizeOpen = event.target.open; }, true);
function render(records) {
  state.records = records;
  const columns = shownColumns();
  table.style.setProperty("--record-columns", String(Math.max(1, columns.length)));
  const selectedMetadata = optionalMetadata.filter(item => state.metadata.includes(item.name));
  table.style.setProperty("--record-grid-template", ["190px", ...selectedMetadata.map(item => item.width), "150px", `repeat(var(--record-columns, 6), minmax(140px, 1fr))`].join(" "));
  const headers = ["Observation time", ...selectedMetadata.map(item => item.label), "Reasons", ...columns];
  const metadataCells = record => selectedMetadata.map(item => item.name === "session-cycle" ? `<span>${escapeHtml(record.sessionId)} / ${escapeHtml(record.cycleSequence ?? "—")}</span>` : item.name === "release" ? `<span>${escapeHtml(record.rulesRelease?.releaseId || record.rulesRelease?.version || "Not recorded")}</span>` : `<span>${record.receiptTime ? time(record.receiptTime) : "Not stored"}</span>`).join("");
  table.innerHTML = `<div class="records-row records-head">${headers.map(escapeHtml).map(value => `<strong>${value}</strong>`).join("")}</div>` + (records.length ? records.map(record => `<div class="records-row"> <span>${time(record.observationTime)}${record.observationTime ? "" : "<br><small>Unsynchronized; use session/cycle navigation.</small>"}</span>${metadataCells(record)}<span>${escapeHtml(record.triggerReasons.map(reason => reason.kind).join(", "))}</span>${columns.map(name => `<span>${cell(record.fields[name])}</span>`).join("")}</div>`).join("") : `<p class="event-empty">No observation records match this position.</p>`);
}
async function request(url) { const response = await fetch(url, { cache: "no-store" }); const body = await response.json().catch(() => ({})); if (!response.ok) { const error = new Error(body.code || "read_failed"); error.body = body; throw error; } return body; }
async function load(pageCursor = null, direction = "after") {
  statusLine.textContent = "Loading durable records…";
  const params = new URLSearchParams({ columns: state.columns.join(",") }); if (pageCursor) params.set("cursor", pageCursor); if (qs.get("event")) params.set("event", qs.get("event")); if (!pageCursor && state.anchor && state.mode === "observation") params.set("anchor", state.anchor); if (state.mode === "session") { params.set("view", "session"); params.set("session", qs.get("session")); params.set("cycle", qs.get("cycle") || "0"); params.set("direction", direction); } else if (state.mode === "receipt") params.set("view", "receipt");
  try { const data = await request(`${endpoint}?${params}`); if (!state.triggerChecked && qs.get("event")) { state.triggerChecked = true; state.trigger = data.eventTriggerField || null; } state.catalog = data.catalog; if (state.mode === "session" && data.status === "empty" && pageCursor) { if (direction === "before") state.previousCursor = null; else state.nextCursor = null; statusLine.textContent = direction === "before" ? "No earlier session records exist; showing the last available records." : "No later session records exist; showing the last available records."; updateButtons(); return; } state.currentStart = pageCursor; state.currentDirection = direction; state.nextCursor = data.nextCursor; state.previousCursor = data.previousCursor; renderColumns(); render(data.records); statusLine.textContent = data.status === "empty" ? "No records at this position." : (data.source === "receipt-time-fallback" ? "Receipt-time fallback: this is cloud receipt time, not device observation time." : "Observation time is device-reported time. Receipt time is shown separately."); updateButtons(); } catch (error) { statusLine.textContent = error.body?.code === "configuration_missing" ? "Configuration is unavailable." : error.body?.code === "read_denied" ? "Record reading is denied by the current service configuration." : error.body?.code === "invalid_cursor" ? "This browsing position is invalid; choose Latest or a new date/time." : "Read failed. The page remains usable; try again."; }
}
async function exportDay() { const selected = new Date(`${day.value}T00:00:00`); const next = new Date(selected); next.setDate(next.getDate() + 1); statusLine.textContent = "Exporting the complete local day…"; try { const response = await fetch(`${endpoint}?view=export&start=${encodeURIComponent(selected.toISOString())}&end=${encodeURIComponent(next.toISOString())}`, { cache: "no-store" }); if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.code || "export_failed"); } const text = await response.text(); const blob = new Blob([text], { type: "text/csv" }); const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `durable-observations-${day.value}.csv` }); link.click(); URL.revokeObjectURL(link.href); statusLine.textContent = `Export complete: ${response.headers.get("X-Export-Record-Count")} records.`; } catch (error) { statusLine.textContent = error.message === "export_too_large" ? "Export is too large to complete safely; narrow the day or investigate ingestion volume." : "Export failed; no partial file was presented as complete."; } }
async function history(pageCursor = null) { const panel = document.querySelector("#history-panel"); panel.hidden = false; try { const data = await request(`${endpoint}?view=history${pageCursor ? `&cursor=${encodeURIComponent(pageCursor)}` : ""}`); document.querySelector("#history-list").innerHTML = data.occurrences.map(item => { const open = item.open; const close = item.close; const opening = open.opening?.observedAt ? `Device opening ${time(open.opening.observedAt)}` : `Device opening time unknown; first reported ${open.firstReportedAt ? time(open.firstReportedAt) : "unknown"}`; return `<article class="event-card ${open.severity.toLowerCase()}"><strong>${escapeHtml(open.severity)} · ${escapeHtml(open.displayName)}</strong><span>${escapeHtml(opening)}</span><span>${close ? `Closed by ${escapeHtml(close.closeReason)}; cloud detection ${time(close.detectedAt || close.restartDetectedAt)}. Device close time unknown.` : "Closure not recorded."}</span><a href="/records.html?session=${encodeURIComponent(open.sessionId)}&cycle=${open.opening?.cycleSequence || 0}&event=${encodeURIComponent(open.eventDefinitionId)}">View nearby observations</a></article>`; }).join("") || "<p class='event-empty'>No V3 occurrences found.</p>"; historyState.cursor = pageCursor; historyState.next = data.nextCursor; document.querySelector("#history-older").disabled = !historyState.next; document.querySelector("#history-newer").disabled = !historyState.trail.length; } catch { document.querySelector("#history-list").textContent = "Event history is currently unavailable."; } }
day.value = localDay(); at.value = localDateTime(); document.querySelector("#timezone-label").textContent = `Displayed in ${Intl.DateTimeFormat().resolvedOptions().timeZone}; day boundaries adjust for daylight-saving time.`;
function leaveSession(mode) { state.mode = mode; state.anchor = null; state.currentStart = null; state.trail = []; state.trigger = null; }
document.querySelector("#latest-records").addEventListener("click", () => { leaveSession("observation"); day.value = localDay(); at.value = localDateTime(); load(); }); document.querySelector("#receipt-records").addEventListener("click", () => { leaveSession("receipt"); load(); }); older.addEventListener("click", () => { if (state.mode === "session") { if (state.previousCursor) load(state.previousCursor, "before"); } else if (state.nextCursor) { state.trail.push(state.currentStart); load(state.nextCursor); } }); newer.addEventListener("click", () => { if (state.mode === "session") { if (state.nextCursor) load(state.nextCursor, "after"); } else load(state.trail.pop() || null); }); document.querySelector("#export-day").addEventListener("click", exportDay); at.addEventListener("change", () => { const selected = new Date(at.value); if (!Number.isFinite(selected.getTime())) return; leaveSession("observation"); state.anchor = selected.toISOString(); load(); });
document.querySelector("#history-older").addEventListener("click", () => { if (historyState.next) { historyState.trail.push(historyState.cursor); history(historyState.next); } }); document.querySelector("#history-newer").addEventListener("click", () => history(historyState.trail.pop() || null));
// A saved preset follows that preset as it is defined now; a custom selection
// is restored exactly, even when it is empty.
{ const saved = savedSelection(); const preset = presets.find(item => item.id === saved?.preset) || (saved ? null : presets[0]); state.columns = [...(preset ? preset.columns : saved.columns)]; state.preset = preset ? preset.id : presetFor(state.columns); state.metadata = Array.isArray(saved?.metadata) ? saved.metadata.filter(name => optionalMetadata.some(item => item.name === name)) : []; }
if (qs.get("history") === "1") history(); load();
