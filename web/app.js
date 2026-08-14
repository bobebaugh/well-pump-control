const healthRow = document.querySelector("#health-cloud");
const firestoreRow = document.querySelector("#health-firestore");
const tab5Row = document.querySelector("#health-tab5");
const shellyRow = document.querySelector("#health-shelly");
const checkTime = document.querySelector("#api-check-time");
const pumpState = document.querySelector("#pump-state");
const powerValue = document.querySelector("#power-value");
const voltageValue = document.querySelector("#voltage-value");
const pfValue = document.querySelector("#pf-value");
const monitorButton = document.querySelector("#monitor-toggle");
const monitorStatus = document.querySelector("#monitor-status");

const NORMAL_REFRESH_MS = 60000;
const LIVE_REFRESH_MS = 1000;
let telemetryTimer;
let monitoringUntil = 0;

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

function renderTelemetry(data) {
  const values = data.values || {};
  const fresh = data.ageSeconds !== null && data.ageSeconds <= 150;
  const stateText = !fresh ? "Telemetry stale" : (data.pumpRunning ? "RUNNING" : "STOPPED");
  const stateClass = !fresh ? "stale" : (data.pumpRunning ? "running" : "stopped");

  pumpState.className = `pump-state ${stateClass}`;
  pumpState.querySelector("strong").textContent = stateText;
  powerValue.textContent = Number.isFinite(values.powerW) ? values.powerW.toFixed(0) : "—";
  voltageValue.textContent = Number.isFinite(values.voltageV) ? values.voltageV.toFixed(1) : "—";
  pfValue.textContent = Number.isFinite(values.powerFactor) ? values.powerFactor.toFixed(2) : "—";

  const ageText = data.ageSeconds === null ? "Timestamp unavailable" : `Last report ${data.ageSeconds}s ago`;
  setHealth(tab5Row, fresh ? "online" : "checking", ageText);
  setHealth(shellyRow, values.isValid === true ? "online" : "offline", values.isValid === true ? "Meter valid" : "Meter invalid");
}

function clearTelemetry() {
  pumpState.className = "pump-state unknown";
  pumpState.querySelector("strong").textContent = "Waiting for telemetry";
  powerValue.textContent = "—";
  voltageValue.textContent = "—";
  pfValue.textContent = "—";
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

checkServices();
checkTelemetry();
setInterval(checkServices, 300000);
