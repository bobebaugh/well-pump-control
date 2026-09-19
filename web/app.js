const healthRow = document.querySelector("#health-cloud");
const firestoreRow = document.querySelector("#health-firestore");
const tab5Row = document.querySelector("#health-tab5");
const shellyRow = document.querySelector("#health-shelly");
const shelly1Row = document.querySelector("#health-shelly1");
const checkTime = document.querySelector("#api-check-time");
const pumpState = document.querySelector("#pump-state");
const pressureValue = document.querySelector("#pressure-value");
const tankPressure = document.querySelector("#tank-pressure");
const tankGallons = document.querySelector("#tank-gallons");
const historyTitle = document.querySelector("#history-title");
const historyHero = document.querySelector("#history-hero");
const historyChart = document.querySelector("#history-chart");
const historyCaption = document.querySelector("#history-caption");
const statUsed = document.querySelector("#stat-used");
const statStarts = document.querySelector("#stat-starts");
const statRun = document.querySelector("#stat-run");
const historyViewButtons = [...document.querySelectorAll("#history-view button")];
const historyRangeButtons = [...document.querySelectorAll("#history-range button")];
const tankWater = document.querySelector("#tank-water");
const pressureTag = document.querySelector("#pressure-tag");
const pressureRow = document.querySelector("#health-pressure");
const powerValue = document.querySelector("#power-value");
const voltageValue = document.querySelector("#voltage-value");
const pfValue = document.querySelector("#pf-value");
const sw0Value = document.querySelector("#sw0-value");
const rly0Value = document.querySelector("#rly0-value");
const monitorButton = document.querySelector("#monitor-toggle");
const monitorStatus = document.querySelector("#monitor-status");
const eventStatus = document.querySelector("#event-browser-status");
const openEvents = document.querySelector("#open-events");
const closedEvents = document.querySelector("#closed-events");
const operatorUnlock = document.querySelector("#operator-unlock");
const operatorSummary = document.querySelector("#operator-summary");
const operatorEvidence = document.querySelector("#operator-evidence");
const restartConsequence = document.querySelector("#restart-consequence");
const operatorButtons = [...document.querySelectorAll(".control-button")];

const NORMAL_REFRESH_MS = 60000;
const LIVE_REFRESH_MS = 1000;
// Tab5 mirrors its whole observation to RTDB about every two seconds, so the
// live readings follow that rather than the 60s Firestore cadence. Polling
// faster than the device writes only burns requests for the same record.
const OBSERVATION_REFRESH_MS = 2000;
const HISTORY_REFRESH_MS = 300000;
// The tank cutaway shows WATER against the range this system actually uses.
//
// Two scales were wrong before. Pressure on a linear 0-70 scale drew a tank 71%
// full at 49.8 psi when it held 14.9 of 79.3 gallons, because a precharged
// tank's water content is a Boyle function of pressure, not a linear one. And
// no absolute full mark is meaningful: the tank is rated to 150 psi, nobody
// runs one there, and a normal band is anywhere from 30-50 to 40-60 depending
// on where the tank sits.
//
// So the cutaway runs empty at the observed cut-in and full at the observed
// cut-out -- the usable drawdown, which is the water actually available before
// the pump has to run. Both ends are measured from history, never assumed.
// Both filled in from the history endpoint; until it answers, the cutaway falls
// back to pressure against the observed band rather than inventing a model.
let tankModel = null;
let pressureSwitch = null;
let observationTimer;
let historyTimer;
let historyView = "gallons";
let historyWindow = "1d";
// Keyed by window: switching between chart views must not refetch, and the two
// windows are cached separately so flipping back is instant.
const historyData = {};
let telemetryTimer;
let monitoringUntil = 0;
let operatorBusy = false;
let operatorTimer;
let lastOperatorStatus = null;

// Water in a precharged tank: the air charge compresses, the water is what is
// left over. Same Boyle model the device and the rules engine use.
function tankWaterGallons(psi) {
  if (!tankModel || !Number.isFinite(psi)) return null;
  const { effectiveTankGallons: volume, prechargeGaugePsi: precharge,
          atmosphericPressurePsi: atmosphere } = tankModel;
  if (psi + atmosphere <= 0) return null;
  const water = volume - volume * (precharge + atmosphere) / (psi + atmosphere);
  return water >= 0 && water <= volume ? water : null;
}

// Null where the tank model has not arrived yet, so the caller leaves the
// cutaway alone rather than drawing an empty tank beside a healthy pressure.
function tankFillPercent(psi) {
  const water = tankWaterGallons(psi);
  if (water === null) return null;
  const low = tankWaterGallons(pressureSwitch?.cutInPsi);
  const high = tankWaterGallons(pressureSwitch?.fullPsi);
  // Until a completed cycle has been seen, fall back to water as a fraction of
  // the tank -- honest, just always low-looking, since even at cut-out a
  // bladder tank is only about a third water.
  if (low === null || high === null || !(high > low)) {
    return (water / tankModel.effectiveTankGallons) * 100;
  }
  return ((water - low) / (high - low)) * 100;
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(date);
}

function setHealth(row, state, text) {
  row.querySelector(".health-dot").className = `health-dot ${state}`;
  row.querySelector("small").textContent = text;
}

function setBinaryValue(element, value) {
  element.textContent = typeof value === "boolean" ? (value ? "ON" : "OFF") : "—";
  element.className = `binary-value ${value === true ? "on" : value === false ? "off" : "unknown"}`;
}

async function fetchStatus(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Accept": "application/json", ...(options.headers || {}) },
    cache: "no-store",
    ...options
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.body = body;
    throw error;
  }

  return body;
}

function pilotKey(promptText = "Enter the pilot owner key") {
  let key = sessionStorage.getItem("pilotMonitorKey");
  if (!key) key = window.prompt(promptText);
  if (key) sessionStorage.setItem("pilotMonitorKey", key);
  return key;
}

function commandIdentity() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll("-", "_");
  return `web_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

function shellyLockText(value) {
  if (value === -1) return "full lockout";
  if (value === 0) return "normal (islocked = 0)";
  if (Number.isInteger(value) && value > 0) return `temporary lockout (${value}s remaining)`;
  return "unknown; never treated as zero";
}

function renderOperatorStatus(control) {
  lastOperatorStatus = control;
  const labels = {
    idle: "No current request",
    "not-delivered": "Not delivered",
    accepted: "Accepted; completion not yet confirmed",
    "confirmed-completed": "Confirmed completed",
    failed: "Failed",
    unknown: "Unknown; execution may have occurred"
  };
  const monitor = control.userMonitor === true
    ? "User Monitor ACTIVE until Tab5 restart"
    : control.userMonitor === false ? "User Monitor normal" : "User Monitor status unknown";
  const relay = control.relayRestoration === "unconfirmed"
    ? "Relay restoration UNCONFIRMED"
    : `Relay restoration ${control.relayRestoration || "not applicable"}`;
  operatorSummary.textContent = `${monitor} · ${relay}`;
  operatorSummary.classList.toggle("alert", control.userMonitor || control.relayRestoration === "unconfirmed");
  const command = control.command;
  const identity = command ? ` · #${command.commandSequence} ${command.commandType}` : "";
  operatorEvidence.textContent = `${labels[control.outcome] || control.outcome}: ${control.detailCode}${identity}. Shelly: ${shellyLockText(control.shellyLock)}; locntr ${Number.isInteger(control.shellyLockoutCount) ? control.shellyLockoutCount : "unknown"}.`;
  const staged = control.stagedRestartAdoption;
  restartConsequence.textContent = staged
    ? `Restart will adopt staged ${staged.releaseId || `package v${staged.packageVersion}`} (${staged.contentHashPrefix || "hash unavailable"}) if it remains valid.`
    : "Tab5 restart creates a fresh event board and session. No different staged package is currently evidenced.";
}

function setOperatorBusy(value) {
  operatorBusy = value;
  operatorButtons.forEach(button => { button.disabled = value; });
  operatorUnlock.disabled = value;
}

async function checkOperatorStatus({ promptForKey = false } = {}) {
  clearTimeout(operatorTimer);
  const key = sessionStorage.getItem("pilotMonitorKey") || (promptForKey ? pilotKey() : null);
  if (!key) return;
  // This is the heaviest poll in the page -- one call reads four RTDB children,
  // including the whole current observation -- and it was the only one that kept
  // running against a screen nobody was looking at. The visibilitychange handler
  // brings it straight back.
  if (document.hidden && !promptForKey) {
    operatorTimer = setTimeout(checkOperatorStatus, 5000);
    return;
  }
  try {
    const body = await fetchStatus("/.netlify/functions/operator-control", {
      headers: { "X-Pilot-Key": key }
    });
    operatorUnlock.textContent = "Refresh control status";
    renderOperatorStatus(body.control);
    operatorTimer = setTimeout(checkOperatorStatus, 5000);
  } catch (error) {
    if (error.body?.code === "unauthorized") {
      sessionStorage.removeItem("pilotMonitorKey");
      operatorSummary.textContent = "Owner key not accepted; controls remain locked.";
      operatorUnlock.textContent = "Unlock status";
    } else if (error.body?.code === "configuration_missing") {
      operatorSummary.textContent = "Control service configuration is unavailable; controls cannot be used.";
      operatorEvidence.textContent = "No command was issued or retried.";
      operatorUnlock.textContent = "Retry control status";
    } else if (error.body?.code === "control_denied") {
      operatorSummary.textContent = "Owner key accepted; the control service is not authorized to read the device path.";
      operatorEvidence.textContent = "No command was issued or retried. This is a device-path authorization state, not a key rejection.";
      operatorUnlock.textContent = "Retry control status";
    } else {
      operatorSummary.textContent = "Owner key accepted; current control status is unavailable.";
      operatorEvidence.textContent = "Control status unavailable; no command was retried.";
      operatorUnlock.textContent = "Retry control status";
      operatorTimer = setTimeout(checkOperatorStatus, 15000);
    }
  }
}

function confirmationText(action) {
  if (action === "enter-user-monitor") return "Enter User Monitor until Tab5 restarts? This deliberately releases and suppresses Tab5 inhibits, but does not override Shelly-local or mechanical protection.";
  if (action === "restart-tab5") {
    const staged = lastOperatorStatus?.stagedRestartAdoption;
    return `Restart the actual Tab5 now? This creates a fresh event board/session${staged ? ` and may adopt staged ${staged.releaseId}` : ""}. Do not retry if the result becomes unknown.`;
  }
  return "Restart Shelly 1 now? This does not create pump demand and is not proof that its lockout cleared. Do not retry if the result becomes unknown.";
}

async function issueOperatorAction(action) {
  if (operatorBusy || !window.confirm(confirmationText(action))) return;
  const key = pilotKey();
  if (!key) return;
  setOperatorBusy(true);
  operatorEvidence.textContent = "Submitting one short-lived request…";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const body = await fetchStatus("/.netlify/functions/operator-control", {
      method: "POST",
      headers: { "X-Pilot-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ action, clientRequestId: commandIdentity() }),
      signal: controller.signal
    });
    renderOperatorStatus(body.control);
  } catch (error) {
    if (error.body?.code === "unauthorized") {
      sessionStorage.removeItem("pilotMonitorKey");
      operatorEvidence.textContent = "Not delivered: the owner key was not accepted.";
    } else if (error.body?.status === "not-delivered" || error.body?.status === "error" && error.body?.code === "invalid_request") {
      operatorEvidence.textContent = `Not delivered: ${error.body.code}.`;
    } else {
      operatorEvidence.textContent = "Unknown: the request may have executed, but its acknowledgment was not received. It will not be retried automatically.";
    }
  } finally {
    clearTimeout(timeout);
    setOperatorBusy(false);
    checkOperatorStatus();
  }
}

function renderTelemetry(data) {
  const values = data.values || {};
  const shelly1 = data.shelly1 || {};
  const fresh = data.ageSeconds !== null && data.ageSeconds <= 150;
  const stateText = !fresh ? "Telemetry stale" : (data.pumpRunning ? "RUNNING" : "STOPPED");
  const stateClass = !fresh ? "stale" : (data.pumpRunning ? "running" : "stopped");

  pumpState.className = `pump-state ${stateClass}`;
  pumpState.querySelector("strong").textContent = stateText;
  powerValue.textContent = Number.isFinite(values.powerW) ? values.powerW.toFixed(0) : "—";
  voltageValue.textContent = Number.isFinite(values.voltageV) ? values.voltageV.toFixed(1) : "—";
  pfValue.textContent = Number.isFinite(values.powerFactor) ? values.powerFactor.toFixed(2) : "—";
  setBinaryValue(sw0Value, shelly1.sw0);
  setBinaryValue(rly0Value, shelly1.rly0);

  const ageText = data.ageSeconds === null ? "Timestamp unavailable" : `Last report ${data.ageSeconds}s ago`;
  setHealth(tab5Row, fresh ? "online" : "checking", ageText);
  setHealth(shellyRow, values.isValid === true ? "online" : "offline", values.isValid === true ? "Meter valid" : "Meter invalid");
  if (shelly1.available === true) {
    const mismatch = fresh && typeof shelly1.sw0 === "boolean" && shelly1.sw0 !== data.pumpRunning;
    const state = !fresh ? "checking" : (mismatch ? "offline" : "online");
    const detail = mismatch
      ? `SW0 ${shelly1.sw0 ? "ON" : "OFF"} does not match pump state · RLY0 ${shelly1.rly0 ? "ON" : "OFF"}`
      : `SW0 ${shelly1.sw0 ? "ON" : "OFF"} · RLY0 ${shelly1.rly0 ? "ON" : "OFF"}`;
    setHealth(shelly1Row, state, detail);
  } else if (shelly1.available === false) {
    setHealth(shelly1Row, "offline", "Not reachable from Tab5 · relay state unknown");
  } else {
    setHealth(shelly1Row, "unavailable", "Firmware has not reported Shelly 1 yet");
  }
}

function clearTelemetry() {
  pumpState.className = "pump-state unknown";
  pumpState.querySelector("strong").textContent = "Waiting for telemetry";
  powerValue.textContent = "—";
  voltageValue.textContent = "—";
  pfValue.textContent = "—";
  setBinaryValue(sw0Value, null);
  setBinaryValue(rly0Value, null);
  setHealth(shelly1Row, "unavailable", "Awaiting Tab5 telemetry");
}

function renderObservation(data) {
  const values = data.values || {};
  const shelly1 = data.shelly1 || {};
  // Two seconds of cadence plus a little slack. Past that the number on screen
  // is a memory, and saying so matters more than showing a stale digit.
  const fresh = data.ageSeconds !== null && data.ageSeconds <= 30;
  const psi = Number.isFinite(values.pressurePsi) ? values.pressurePsi : null;

  if (psi !== null && fresh) {
    const text = psi.toFixed(1);
    pressureValue.textContent = text;
    tankPressure.textContent = `${text} psi`;
    const water = tankWaterGallons(psi);
    tankGallons.textContent = water === null ? "—" : `${water.toFixed(1)} gal`;
    const fill = tankFillPercent(psi);
    if (fill === null) {
      tankWater.style.height = "";
      tankWater.classList.remove("live");
    } else {
      tankWater.style.height = `${Math.max(0, Math.min(100, fill)).toFixed(1)}%`;
      tankWater.classList.add("live");
    }
    pressureTag.textContent = `Live · ${data.ageSeconds}s ago`;
    pressureTag.className = "tag";
    setHealth(pressureRow, "online", `${text} psi · ADC ${values.adcRaw ?? "—"}`);
  } else {
    pressureValue.textContent = "—";
    tankPressure.textContent = "— psi";
    tankGallons.textContent = "—";
    tankWater.style.height = "";
    tankWater.classList.remove("live");
    const reason = data.pressureCommissioned === false
      ? "Sensor not commissioned"
      : psi === null ? "Pressure telemetry unavailable" : "Pressure telemetry stale";
    pressureTag.textContent = reason;
    pressureTag.className = "tag unavailable";
    setHealth(pressureRow, "unavailable", reason);
  }

  // The rest of the live readings come from the same record, so every number on
  // the row is the same instant rather than two reads stitched together.
  if (fresh) {
    if (Number.isFinite(values.powerW)) powerValue.textContent = values.powerW.toFixed(0);
    if (Number.isFinite(values.voltageV)) voltageValue.textContent = values.voltageV.toFixed(1);
    if (Number.isFinite(values.powerFactor)) pfValue.textContent = values.powerFactor.toFixed(2);
    if (typeof shelly1.sw0 === "boolean") setBinaryValue(sw0Value, shelly1.sw0);
    if (typeof shelly1.rly0 === "boolean") setBinaryValue(rly0Value, shelly1.rly0);
  }
}

function clearObservation() {
  pressureValue.textContent = "—";
  tankPressure.textContent = "— psi";
  tankGallons.textContent = "—";
  tankWater.style.height = "";
  tankWater.classList.remove("live");
  pressureTag.textContent = "Pressure telemetry unavailable";
  pressureTag.className = "tag unavailable";
  setHealth(pressureRow, "unavailable", "Awaiting Tab5 telemetry");
}

// History moves slowly and the endpoint caches, so this is nothing like the
// live cadence. It carries the tank model and the observed switch band, which
// are what let the cutaway show water rather than a pressure ratio.
function runTimeText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// The tiles are always the last 24 hours whatever the chart is showing, so they
// read off the day series rather than the selected window. Energy is absent by
// necessity: ShellyEnergyWh is logging mode "none", so no record carries it.
function renderDayStats() {
  const totals = historyData["1d"]?.totals;
  if (!totals) return;
  statUsed.textContent = `${totals.usedGallons ?? 0} gal`;
  statStarts.textContent = `${totals.starts ?? 0}`;
  statRun.textContent = runTimeText(totals.runSeconds);
}

function renderHistory() {
  const data = historyData[historyWindow];
  const spec = HistoryChart.VIEWS[historyView];
  historyTitle.textContent = spec.title;
  if (!data) {
    historyCaption.textContent = "Loading history\u2026";
    return;
  }
  const totals = data.totals || {};
  historyHero.textContent = historyView === "gallons"
    ? (totals.latestGallons === null ? "\u2014" : `${totals.latestGallons} gal`)
    : historyView === "used"
      ? `${totals.usedGallons ?? 0} gal`
      : `${totals.starts ?? 0}`;
  HistoryChart.mount(historyChart, data, historyView, historyWindow);
  historyCaption.textContent = HistoryChart.caption(data, historyView);
}

async function loadHistory(windowKey) {
  const data = await fetchStatus(
    `/.netlify/functions/observation-series?window=${encodeURIComponent(windowKey)}`);
  historyData[windowKey] = data;
  if (data.tankModel) tankModel = data.tankModel;
  if (data.pressureSwitch?.cycles > 0) pressureSwitch = data.pressureSwitch;
  return data;
}

async function checkHistory() {
  clearTimeout(historyTimer);
  if (document.hidden) {
    historyTimer = setTimeout(checkHistory, HISTORY_REFRESH_MS);
    return;
  }
  try {
    // The day window is always refreshed: the tank cutaway and the 24h tiles
    // both need it even when the chart is showing the week.
    await loadHistory("1d");
    if (historyWindow !== "1d") await loadHistory(historyWindow);
    renderDayStats();
    renderHistory();
  } catch (error) {
    // The cutaway degrades on its own; the pressure readout is unaffected.
    if (!historyData[historyWindow]) historyCaption.textContent = "History unavailable";
  }
  historyTimer = setTimeout(checkHistory, HISTORY_REFRESH_MS);
}

function selectHistory(buttons, attribute, value) {
  buttons.forEach(button => button.classList.toggle("on", button.dataset[attribute] === value));
}

historyViewButtons.forEach(button => button.addEventListener("click", () => {
  historyView = button.dataset.view;
  selectHistory(historyViewButtons, "view", historyView);
  renderHistory();
}));

historyRangeButtons.forEach(button => button.addEventListener("click", async () => {
  historyWindow = button.dataset.window;
  selectHistory(historyRangeButtons, "window", historyWindow);
  if (historyData[historyWindow]) { renderHistory(); return; }
  historyCaption.textContent = "Loading history\u2026";
  try {
    await loadHistory(historyWindow);
  } catch (error) {
    historyCaption.textContent = "History unavailable";
    return;
  }
  renderHistory();
}));

// The SVG is drawn at measured pixel widths so strokes are not scaled, which
// means a resize needs a redraw rather than a stretch.
if (typeof ResizeObserver === "function") {
  let lastWidth = 0;
  new ResizeObserver(entries => {
    const width = Math.round(entries[0].contentRect.width);
    if (width && width !== lastWidth && historyData[historyWindow]) {
      lastWidth = width;
      renderHistory();
    }
  }).observe(historyChart);
}

async function checkObservation() {
  clearTimeout(observationTimer);
  // Stop polling a page nobody is looking at; resume on the visibility change.
  if (document.hidden) {
    observationTimer = setTimeout(checkObservation, OBSERVATION_REFRESH_MS);
    return;
  }
  try {
    renderObservation(await fetchStatus("/.netlify/functions/current-observation"));
  } catch (error) {
    if (error.body?.code === "telemetry_missing") clearObservation();
  }
  observationTimer = setTimeout(checkObservation, OBSERVATION_REFRESH_MS);
}

function eventTime(value) { return value ? formatTime(new Date(value)) : "Unknown time"; }
function eventLink(event) { const cycle = event?.opening?.cycleSequence || 0; return `/records.html?session=${encodeURIComponent(event.sessionId || "")}&cycle=${cycle}&event=${encodeURIComponent(event.eventDefinitionId || "")}`; }
function escapeEventHtml(value) { return String(value ?? "").replace(/[&<>\"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]); }
function eventCard(event, close = null) { const severity = String(event.severity || "Info").toLowerCase(); const opening = event?.opening?.observedAt ? `Device opening ${escapeEventHtml(eventTime(event.opening.observedAt))}` : `Device opening time unknown${event?.firstReportedAt ? `; first reported ${escapeEventHtml(eventTime(event.firstReportedAt))}` : ""}`; const closure = close ? `<span>Closed by ${escapeEventHtml(close.closeReason)}; cloud detection ${escapeEventHtml(eventTime(close.detectedAt || close.restartDetectedAt))}. Device close time unknown.</span>` : "<span>Open in the last successful board</span>"; return `<article class="event-card ${severity}"><strong>${escapeEventHtml(event.severity || "Info")} · ${escapeEventHtml(event.displayName || event.eventDefinitionId)}</strong><span>${opening}</span>${closure}<a href="${eventLink(event)}">View nearby observations</a></article>`; }
async function checkEvents() {
  try {
    const data = await fetchStatus("/.netlify/functions/record-browser?view=home");
    const board = data.board;
    const open = Object.values(board?.openEvents || {});
    openEvents.innerHTML = open.length ? open.map(entry => eventCard({ ...entry, ...entry.slot, opening: entry.slot?.opening })).join("") : "<p class='event-empty'>No open events reported by the latest successful board.</p>";
    closedEvents.innerHTML = data.recentClosed?.length ? data.recentClosed.map(item => eventCard(item.open, item.close)).join("") : "<p class='event-empty'>No recent closed occurrences.</p>";
    const ageSeconds = board?.lastReportAt ? Math.max(0, Math.round((Date.now() - Date.parse(board.lastReportAt)) / 1000)) : null;
    eventStatus.textContent = board ? (ageSeconds > 120 ? `Event board is stale (${ageSeconds}s since the last successful board); open events are retained.` : `Last successful board ${formatTime(new Date(board.lastReportAt))}.`) : "No successful event board is stored yet.";
    localStorage.setItem("pilotLastEventBoard", JSON.stringify({ board, at: Date.now() }));
  } catch (error) {
    const prior = JSON.parse(localStorage.getItem("pilotLastEventBoard") || "null");
    if (prior?.board) { openEvents.innerHTML = Object.values(prior.board.openEvents || {}).map(entry => eventCard({ ...entry, ...entry.slot, opening: entry.slot?.opening })).join(""); eventStatus.textContent = `Event board read failed; showing last known board from ${formatTime(new Date(prior.at))}.`; }
    else eventStatus.textContent = error.body?.code === "configuration_missing" ? "Event browser configuration is unavailable." : error.body?.code === "read_denied" ? "Event board read is denied by the current service configuration." : "Event board read failed.";
  }
}

function updateMonitorControls() {
  const remainingMs = monitoringUntil - Date.now();
  const active = remainingMs > 0;

  if (!active) {
    monitoringUntil = 0;
    monitorButton.textContent = "Start 15-minute live view";
    monitorButton.classList.remove("active");
    monitorStatus.textContent = "Standard 60-second refresh";
    return;
  }

  monitorButton.textContent = "Stop live view";
  monitorButton.classList.add("active");
  monitorStatus.textContent = `Live · ${Math.ceil(remainingMs / 60000)} min remaining`;
}

async function checkTelemetry() {
  clearTimeout(telemetryTimer);

  try {
    const data = await fetchStatus("/.netlify/functions/current-power");
    renderTelemetry(data);
  } catch (error) {
    if (error.body?.code === "telemetry_missing") {
      clearTelemetry();
    } else {
      setHealth(tab5Row, "offline", "Telemetry unavailable");
    }
  }

  updateMonitorControls();
  telemetryTimer = setTimeout(checkTelemetry, monitoringUntil > Date.now() ? LIVE_REFRESH_MS : NORMAL_REFRESH_MS);
}

async function setMonitoring(action) {
  let key = sessionStorage.getItem("pilotMonitorKey");

  if (!key) {
    key = window.prompt("Enter the pilot monitoring key");
  }

  if (!key) {
    return;
  }

  try {
    const result = await fetchStatus("/.netlify/functions/monitor-session", {
      method: "POST",
      headers: { "X-Pilot-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });

    sessionStorage.setItem("pilotMonitorKey", key);
    monitoringUntil = result.monitoring.until ? Date.parse(result.monitoring.until) : 0;
    updateMonitorControls();
    checkTelemetry();
  } catch (error) {
    if (error.body?.code === "unauthorized") {
      sessionStorage.removeItem("pilotMonitorKey");
      window.alert("The pilot monitoring key was not accepted.");
    } else {
      window.alert("The monitoring session could not be changed.");
    }
  }
}

async function checkServices() {
  const checkedAt = new Date();
  const [apiResult, firestoreResult] = await Promise.allSettled([
    fetchStatus("/.netlify/functions/health"),
    fetchStatus("/.netlify/functions/firebase-status")
  ]);

  setHealth(healthRow,
    apiResult.status === "fulfilled" && apiResult.value.status === "ok" ? "online" : "offline",
    apiResult.status === "fulfilled" ? "Online" : "Unavailable");

  if (firestoreResult.status === "fulfilled" && firestoreResult.value.status === "ok") {
    setHealth(firestoreRow, "online", "Connected");
  } else {
    const code = firestoreResult.reason?.body?.code;
    setHealth(firestoreRow, code === "configuration_missing" ? "checking" : "offline",
      code === "configuration_missing" ? "Credentials not configured" : "Unavailable");
  }

  checkTime.textContent = `Services checked ${formatTime(checkedAt)}`;
}

monitorButton.addEventListener("click", () => {
  setMonitoring(monitoringUntil > Date.now() ? "stop" : "start");
});
operatorUnlock.addEventListener("click", () => checkOperatorStatus({ promptForKey: true }));
operatorButtons.forEach(button => button.addEventListener("click", () => issueOperatorAction(button.id)));

// Come back immediately when the tab is shown again rather than waiting out the
// interval, so the first thing seen on return is current and not two seconds of
// whatever was on screen when it was hidden.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    checkObservation();
    checkHistory();
    checkOperatorStatus();
  }
});

checkServices();
checkTelemetry();
checkObservation();
checkHistory();
checkEvents();
checkOperatorStatus();
setInterval(checkServices, 300000);
setInterval(checkEvents, 60000);
