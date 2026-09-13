const healthRow = document.querySelector("#health-cloud");
const firestoreRow = document.querySelector("#health-firestore");
const tab5Row = document.querySelector("#health-tab5");
const shellyRow = document.querySelector("#health-shelly");
const shelly1Row = document.querySelector("#health-shelly1");
const checkTime = document.querySelector("#api-check-time");
const pumpState = document.querySelector("#pump-state");
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
let telemetryTimer;
let monitoringUntil = 0;
let operatorBusy = false;
let operatorTimer;
let lastOperatorStatus = null;

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

checkServices();
checkTelemetry();
checkEvents();
checkOperatorStatus();
setInterval(checkServices, 300000);
setInterval(checkEvents, 60000);
