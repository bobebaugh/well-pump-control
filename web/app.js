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
const eventV3Mode = document.querySelector("#event-v3-mode");
const eventV3Status = document.querySelector("#event-v3-status");
const eventV3Session = document.querySelector("#event-v3-session");
const eventV3Boundary = document.querySelector("#event-v3-boundary");
const eventV3OpenEvents = document.querySelector("#event-v3-open-events");
const eventV3History = document.querySelector("#event-v3-history");
const eventV3ControlStatus = document.querySelector("#event-v3-control-status");
const eventV3ControlButtons = [...document.querySelectorAll("[data-event-v3-command]")];
const eventV3Ui = globalThis.EventV3UiModel;

const NORMAL_REFRESH_MS = 60000;
const LIVE_REFRESH_MS = 1000;
let telemetryTimer;
let eventStatusTimer;
let monitoringUntil = 0;
let eventControlRequestInFlight = false;

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
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function eventDescription(event) {
  return `${event.eventClass} · ${event.severity} · ${event.consequence} · ${event.reason}`;
}

function eventRow(event) {
  const row = document.createElement("div");
  row.className = "event-row";
  row.setAttribute("role", "row");
  const time = event.closedAt === "—" ? `Opened ${event.openedAt}` : `Opened ${event.openedAt} · Closed ${event.closedAt}`;
  for (const value of [time, event.status, event.ruleId, eventDescription(event)]) {
    const cell = document.createElement("span");
    cell.setAttribute("role", "cell");
    cell.textContent = value;
    row.append(cell);
  }
  return row;
}

function renderEventV3Status(data) {
  const view = eventV3Ui.statusView(data);
  eventV3Mode.textContent = `Mode ${view.mode}`;
  eventV3Session.textContent = view.sessionId;
  eventV3Boundary.textContent = view.boundaryObservedAt;
  eventV3Status.textContent = `${view.openEvents.length} open Event V3 event${view.openEvents.length === 1 ? "" : "s"}.`;

  eventV3OpenEvents.replaceChildren();
  if (view.openEvents.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No open Event V3 events.";
    eventV3OpenEvents.append(empty);
  } else {
    for (const event of view.openEvents) {
      const item = document.createElement("li");
      item.textContent = `${event.ruleId} · ${event.eventClass} · ${event.severity} · ${event.consequence} · opened ${event.openedAt}`;
      eventV3OpenEvents.append(item);
    }
  }

  eventV3History.replaceChildren();
  if (view.history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "event-empty";
    empty.setAttribute("role", "row");
    const message = document.createElement("span");
    message.textContent = "No Event V3 history received.";
    empty.append(message);
    eventV3History.append(empty);
  } else {
    for (const event of view.history) eventV3History.append(eventRow(event));
  }
}

function renderEventV3Unavailable(message) {
  eventV3Mode.textContent = "Mode unavailable";
  eventV3Session.textContent = "Not available";
  eventV3Boundary.textContent = "—";
  eventV3Status.textContent = message;
  eventV3OpenEvents.replaceChildren();
  const emptyOpen = document.createElement("li");
  emptyOpen.textContent = message;
  eventV3OpenEvents.append(emptyOpen);
  eventV3History.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "event-empty";
  empty.setAttribute("role", "row");
  const text = document.createElement("span");
  text.textContent = message;
  empty.append(text);
  eventV3History.append(empty);
}

async function checkEventV3Status() {
  clearTimeout(eventStatusTimer);
  try {
    renderEventV3Status(await fetchStatus("/.netlify/functions/events-status"));
  } catch (error) {
    renderEventV3Unavailable(error.status === 404
      ? "Event V3 board not yet available."
      : "Event V3 status unavailable.");
  }
  eventStatusTimer = setTimeout(checkEventV3Status, NORMAL_REFRESH_MS);
}

function setEventV3ControlBusy(busy) {
  eventControlRequestInFlight = busy;
  for (const button of eventV3ControlButtons) button.disabled = busy;
}

async function queueEventV3Control(commandType) {
  const action = eventV3Ui.controlAction(commandType);
  if (!action || eventControlRequestInFlight) return;
  if (action.restartTarget && !window.confirm(`Queue ${action.label} for ${action.restartTarget}?`)) return;

  let key = sessionStorage.getItem("pilotControlKey");
  if (!key) key = window.prompt("Enter the Event V3 control key");
  if (!key) return;

  setEventV3ControlBusy(true);
  eventV3ControlStatus.textContent = "Queueing Event V3 control request…";
  try {
    const result = await fetchStatus("/.netlify/functions/control-request", {
      method: "POST",
      headers: { "X-Pilot-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ commandType })
    });
    const commandId = result.command && typeof result.command.commandId === "string" ? result.command.commandId : null;
    if (!commandId) throw new Error("missing command identity");
    sessionStorage.setItem("pilotControlKey", key);
    eventV3ControlStatus.textContent = `Queued · ${commandId}`;
  } catch (error) {
    if (error.status === 401 || error.body?.code === "unauthorized") {
      sessionStorage.removeItem("pilotControlKey");
      eventV3ControlStatus.textContent = "Event V3 control key was not accepted.";
    } else {
      eventV3ControlStatus.textContent = "Event V3 control request unavailable.";
    }
  } finally {
    setEventV3ControlBusy(false);
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
      : `SW0 ${shelly1.sw0 ? "ON" : "OFF"} · RLY0 ${shelly1.rly0 ? "ON" : "OFF"} · relay not wired`;
    setHealth(shelly1Row, state, detail);
  } else if (shelly1.available === false) {
    setHealth(shelly1Row, "offline", "Not reachable from Tab5 · RLY0 not wired");
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
  setHealth(shelly1Row, "unavailable", "Awaiting Tab5 telemetry · RLY0 not wired");
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
for (const button of eventV3ControlButtons) {
  button.addEventListener("click", () => queueEventV3Control(button.dataset.eventV3Command));
}

checkServices();
checkTelemetry();
checkEventV3Status();
setInterval(checkServices, 300000);
