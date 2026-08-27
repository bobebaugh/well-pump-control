"use strict";

const sectionLabels = {
  devices: ["DEVICES", "Configured devices"],
  calculatedFields: ["CALCULATED FIELDS", "Programmed calculations"],
  events: ["EVENTS", "Event definitions"]
};
const state = {
  draft: null, revisions: {}, current: null, capabilities: null,
  section: "devices", selected: { devices: 0, calculatedFields: 0, events: 0 },
  dirty: new Set(), runtimePackage: null
};

const editor = document.querySelector("#engine-editor");
const list = document.querySelector("#engine-list");
const statusBox = document.querySelector("#engine-status");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function setStatus(text, kind = "") { statusBox.className = `editor-status ${kind}`; statusBox.textContent = text; }
function pilotKey() { return sessionStorage.getItem("pilotMonitorKey"); }
async function api(method, payload) {
  let key = pilotKey();
  if (!key) key = window.prompt("Enter the pilot key");
  if (!key) throw new Error("cancelled");
  const response = await fetch("/.netlify/functions/rules-engine", {
    method, cache: "no-store",
    headers: { "Accept": "application/json", "Content-Type": "application/json", "X-Pilot-Key": key },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem("pilotMonitorKey");
    const error = new Error(body.code || body.status || `HTTP ${response.status}`); error.body = body; throw error;
  }
  sessionStorage.setItem("pilotMonitorKey", key);
  return body;
}

function allFields() {
  if (!state.draft) return [];
  const fields = state.draft.devices.flatMap(device => device.fields || []);
  return fields.concat(state.draft.calculatedFields.flatMap(calculation => calculation.outputs || []));
}
function directFields() { return state.draft.devices.flatMap(device => device.fields || []); }
function calculatedFields() { return state.draft.calculatedFields.flatMap(calculation => calculation.outputs || []); }
function fieldByName(name) { return allFields().find(field => field.systemName === name); }
function writableFields() { return state.draft.devices.flatMap(device => device.fields || []).filter(field => field.access === "readWrite"); }
function optionHtml(field, selected) {
  return `<option value="${escapeHtml(field.systemName)}"${field.systemName === selected ? " selected" : ""}>${escapeHtml(field.systemName)} · ${escapeHtml(field.type)}${field.unit ? ` · ${escapeHtml(field.unit)}` : ""}</option>`;
}
function fieldOptions(selected) {
  return `<optgroup label="Direct Observations">${directFields().map(field => optionHtml(field, selected)).join("")}</optgroup><optgroup label="Calculated Values">${calculatedFields().map(field => optionHtml(field, selected)).join("")}</optgroup>`;
}
function logModeOptions(selected) {
  return ["none", "delta", "change", "always"].map(value => `<option${value === selected ? " selected" : ""}>${value}</option>`).join("");
}
function updateCounts() {
  document.querySelector("#devices-count").textContent = `${state.draft.devices.length} configured`;
  document.querySelector("#calculations-count").textContent = `${state.draft.calculatedFields.length} configured`;
  document.querySelector("#events-count").textContent = `${state.draft.events.length} configured`;
}
function markDirty() {
  state.dirty.add(state.section);
  document.querySelector("#engine-save").disabled = false;
  document.querySelector("#engine-publish").disabled = true;
  document.querySelector("#validation-state").textContent = "Draft changed";
  document.querySelector("#validation-state").className = "warning-text";
}

function captureDevice() {
  const device = state.draft.devices[state.selected.devices];
  if (!device || !document.querySelector("#device-id")) return;
  device.id = document.querySelector("#device-id").value.trim();
  device.label = document.querySelector("#device-label").value.trim();
  device.driver = document.querySelector("#device-driver").value.trim();
  device.address = document.querySelector("#device-address").value.trim();
  device.enabled = document.querySelector("#device-enabled").checked;
  device.fields = [...editor.querySelectorAll(".device-field-row")].map(row => {
    const type = row.querySelector("[data-key=type]").value;
    const mode = row.querySelector("[data-key=logMode]").value;
    const field = {
      systemName: row.querySelector("[data-key=systemName]").value.trim(),
      label: row.querySelector("[data-key=label]").value.trim(),
      object: row.querySelector("[data-key=object]").value.trim(), type,
      unit: row.querySelector("[data-key=unit]").value.trim() || null,
      access: row.querySelector("[data-key=access]").value,
      logging: { mode }
    };
    const threshold = Number(row.querySelector("[data-key=threshold]").value);
    if (mode === "delta") field.logging.threshold = threshold;
    if (field.access === "readWrite") {
      const parametersText = row.querySelector("[data-key=writeParameters]").value.trim();
      let parameters;
      try { parameters = JSON.parse(parametersText); } catch { parameters = parametersText; }
      field.write = {
        method: row.querySelector("[data-key=writeMethod]").value.trim(),
        parameters,
        normalValue: parseClauseValue(row.querySelector("[data-key=normalValue]").value, field, "eq")
      };
    }
    return field;
  });
}

function renderDevice() {
  const device = state.draft.devices[state.selected.devices];
  if (!device) { editor.innerHTML = "<p class='empty-editor'>Add a device to begin.</p>"; return; }
  const driverOptions = Object.entries(state.capabilities.drivers).map(([id, label]) => `<option value="${escapeHtml(id)}"${id === device.driver ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  const rows = device.fields.map((field, index) => `
    <div class="device-field-row data-grid-row" data-index="${index}">
      <input data-key="systemName" value="${escapeHtml(field.systemName)}" aria-label="System name">
      <input data-key="label" value="${escapeHtml(field.label)}" aria-label="Label">
      <input data-key="object" value="${escapeHtml(field.object)}" aria-label="Device object">
      <select data-key="type"><option${field.type === "number" ? " selected" : ""}>number</option><option${field.type === "integer" ? " selected" : ""}>integer</option><option${field.type === "boolean" ? " selected" : ""}>boolean</option><option${field.type === "enum" ? " selected" : ""}>enum</option></select>
      <input data-key="unit" value="${escapeHtml(field.unit || "")}" aria-label="Unit">
      <select data-key="access"><option value="read"${field.access === "read" ? " selected" : ""}>read</option><option value="readWrite"${field.access === "readWrite" ? " selected" : ""}>read/write</option></select>
      <input data-key="writeMethod" value="${escapeHtml(field.write?.method || "")}" aria-label="Write method" placeholder="method">
      <input data-key="writeParameters" value="${escapeHtml(typeof field.write?.parameters === "string" ? field.write.parameters : JSON.stringify(field.write?.parameters || {}))}" aria-label="Write parameters" placeholder='{"valueParameter":"on"}'>
      <input data-key="normalValue" value="${escapeHtml(field.write?.normalValue ?? "")}" aria-label="Normal value" placeholder="normal">
      <select data-key="logMode">${logModeOptions(field.logging?.mode)}</select>
      <input data-key="threshold" type="number" step="any" value="${escapeHtml(field.logging?.threshold ?? "")}" aria-label="Logging threshold">
      <button class="row-delete" type="button" data-remove-field="${index}" aria-label="Remove field">×</button>
    </div>`).join("");
  editor.innerHTML = `
    <div class="engine-editor-heading"><div><p class="kicker">DEVICE DEFINITION</p><h2>${escapeHtml(device.label)}</h2></div><div class="inline-switches"><label class="switch-label"><input id="device-enabled" type="checkbox"${device.enabled ? " checked" : ""}> Enabled</label><button class="secondary-button compact-button danger-button" id="remove-item" type="button">Remove</button></div></div>
    <div class="form-grid compact-form">
      <label>Device ID<input id="device-id" value="${escapeHtml(device.id)}"></label>
      <label>Display name<input id="device-label" value="${escapeHtml(device.label)}"></label>
      <label>Driver<select id="device-driver">${driverOptions}</select></label>
      <label>IP address / location<input id="device-address" value="${escapeHtml(device.address)}"></label>
    </div>
    <div class="subsection-heading"><div><p class="kicker">NAMED FIELDS</p><h2>Telemetry and actions</h2></div><button class="secondary-button compact-button" id="add-device-field" type="button">Add field</button></div>
    <div class="data-grid device-fields-grid">
      <div class="data-grid-head"><span>System name</span><span>Label</span><span>Object</span><span>Type</span><span>Unit</span><span>Access</span><span>Write method</span><span>Write args</span><span>Normal</span><span>Log</span><span>Range</span><span></span></div>
      ${rows}
    </div>
    <p class="form-help">External calculations and events reference the system name. Device objects and API methods remain inside this definition.</p>`;
}

function captureCalculation() {
  const calculation = state.draft.calculatedFields[state.selected.calculatedFields];
  if (!calculation || !document.querySelector("#calculation-id")) return;
  calculation.id = document.querySelector("#calculation-id").value.trim();
  calculation.label = document.querySelector("#calculation-label").value.trim();
  calculation.functionId = document.querySelector("#calculation-function").value;
  calculation.inputs = {};
  editor.querySelectorAll("[data-calculation-input]").forEach(input => { calculation.inputs[input.dataset.calculationInput] = input.value; });
  calculation.parameters = {};
  editor.querySelectorAll("[data-calculation-parameter]").forEach(input => {
    const raw = input.value.trim(); const numeric = Number(raw);
    calculation.parameters[input.dataset.calculationParameter] = raw !== "" && Number.isFinite(numeric) ? numeric : raw;
  });
  calculation.outputs = [...editor.querySelectorAll(".calculation-output-row")].map((row, index) => {
    const existing = calculation.outputs[index] || {};
    const mode = row.querySelector("[data-key=logMode]").value;
    const output = {
      systemName: row.querySelector("[data-key=systemName]").value.trim(),
      label: row.querySelector("[data-key=label]").value.trim(),
      type: row.querySelector("[data-key=type]").value,
      unit: row.querySelector("[data-key=unit]").value.trim() || null,
      logging: { mode }
    };
    if (existing.enumValues) output.enumValues = existing.enumValues;
    if (mode === "delta") output.logging.threshold = Number(row.querySelector("[data-key=threshold]").value);
    return output;
  });
}

function normalizeCalculationFunction(calculation, functionId) {
  const spec = state.capabilities.functions[functionId];
  calculation.functionId = functionId;
  calculation.inputs ||= {};
  calculation.parameters ||= {};
  for (const key of Object.keys(spec.inputs)) calculation.inputs[key] ||= allFields()[0]?.systemName || "";
  for (const key of Object.keys(spec.parameters)) if (calculation.parameters[key] === undefined) calculation.parameters[key] = spec.parameters[key] === "number" ? 0 : "";
  calculation.outputs = spec.outputs.map((definition, index) => {
    const previous = calculation.outputs?.[index] || {};
    return { systemName: previous.systemName || `CalculatedField${index + 1}`, label: previous.label || `Calculated field ${index + 1}`, type: definition.type, unit: definition.unit, ...(definition.enumValues ? { enumValues: definition.enumValues } : {}), logging: previous.logging || { mode: definition.type === "number" || definition.type === "integer" ? "delta" : "change", ...(definition.type === "number" || definition.type === "integer" ? { threshold: 1 } : {}) } };
  });
}

function renderCalculation() {
  const calculation = state.draft.calculatedFields[state.selected.calculatedFields];
  if (!calculation) { editor.innerHTML = "<p class='empty-editor'>Add a calculated field to begin.</p>"; return; }
  const spec = state.capabilities.functions[calculation.functionId];
  const functionOptions = Object.entries(state.capabilities.functions).map(([id, definition]) => `<option value="${escapeHtml(id)}"${id === calculation.functionId ? " selected" : ""}>${escapeHtml(definition.label)}</option>`).join("");
  const inputRows = Object.keys(spec?.inputs || {}).map(name => `<label>${escapeHtml(name)}<select data-calculation-input="${escapeHtml(name)}">${fieldOptions(calculation.inputs?.[name])}</select></label>`).join("");
  const parameterRows = Object.keys(spec?.parameters || {}).map(name => `<label>${escapeHtml(name)}<input data-calculation-parameter="${escapeHtml(name)}" value="${escapeHtml(calculation.parameters?.[name] ?? "")}"></label>`).join("");
  const outputs = calculation.outputs.map((output, index) => `<div class="calculation-output-row data-grid-row" data-index="${index}">
    <input data-key="systemName" value="${escapeHtml(output.systemName)}"><input data-key="label" value="${escapeHtml(output.label)}">
    <input data-key="type" value="${escapeHtml(output.type)}" readonly><input data-key="unit" value="${escapeHtml(output.unit || "")}">
    <select data-key="logMode">${logModeOptions(output.logging?.mode)}</select><input data-key="threshold" type="number" step="any" value="${escapeHtml(output.logging?.threshold ?? "")}">
  </div>`).join("");
  editor.innerHTML = `
    <div class="engine-editor-heading"><div><p class="kicker">CALCULATED FIELD DEFINITION</p><h2>${escapeHtml(calculation.label)}</h2></div><button class="secondary-button compact-button danger-button" id="remove-item" type="button">Remove</button></div>
    <div class="form-grid compact-form"><label>Calculation ID<input id="calculation-id" value="${escapeHtml(calculation.id)}"></label><label>Display name<input id="calculation-label" value="${escapeHtml(calculation.label)}"></label><label class="wide">Programmed function<select id="calculation-function">${functionOptions}</select></label></div>
    <div class="calculation-config-grid"><section><p class="kicker">INPUT FIELDS</p><div class="stacked-form">${inputRows || "<p class='form-help'>No inputs.</p>"}</div></section><section><p class="kicker">FUNCTION PARAMETERS</p><div class="stacked-form">${parameterRows || "<p class='form-help'>No parameters.</p>"}</div></section></div>
    <div class="subsection-heading"><div><p class="kicker">OUTPUTS</p><h2>Named calculated fields</h2></div></div>
    <div class="data-grid calculation-output-grid"><div class="data-grid-head"><span>System name</span><span>Label</span><span>Type</span><span>Unit</span><span>Log</span><span>Range</span></div>${outputs}</div>
    <p class="form-help">The function implementation is programmed in Tab5. This definition supplies only supported inputs, parameters, output names, and logging ranges.</p>`;
}

function parseClauseValue(raw, field, operator) {
  if (operator === "occurs") return null;
  if (operator === "between" || operator === "outside") return raw.split(",").map(value => Number(value.trim()));
  if (field?.type === "number" || field?.type === "integer") return Number(raw);
  if (field?.type === "boolean") return raw.toLowerCase() === "true";
  return raw;
}
function captureCondition(prefix) {
  return {
    mode: document.querySelector(`#${prefix}-mode`).value,
    observationCount: Number(document.querySelector(`#${prefix}-count`).value),
    minimumSeconds: Number(document.querySelector(`#${prefix}-seconds`).value),
    clauses: [...editor.querySelectorAll(`.${prefix}-clause-row`)].map(row => {
      const fieldName = row.querySelector("[data-key=field]").value;
      const operator = row.querySelector("[data-key=operator]").value;
      return { field: fieldName, operator, value: parseClauseValue(row.querySelector("[data-key=value]").value, fieldByName(fieldName), operator) };
    })
  };
}
function captureEvent() {
  const event = state.draft.events[state.selected.events];
  if (!event || !document.querySelector("#event-id")) return;
  event.id = document.querySelector("#event-id").value.trim();
  event.systemName = document.querySelector("#event-system-name").value.trim();
  event.displayName = document.querySelector("#event-display-name").value.trim();
  event.severity = document.querySelector("#event-severity").value;
  event.enabled = document.querySelector("#event-enabled").checked;
  event.latched = document.querySelector("#event-latched").checked;
  event.open = captureCondition("open"); event.close = captureCondition("close");
  event.openFunctions = document.querySelector("#event-open-functions").value ? [document.querySelector("#event-open-functions").value] : [];
  event.closeFunctions = document.querySelector("#event-close-functions").value ? [document.querySelector("#event-close-functions").value] : [];
  event.actions = [...editor.querySelectorAll(".event-action-row")].map(row => {
    const target = row.querySelector("[data-key=target]").value;
    return { target, value: parseClauseValue(row.querySelector("[data-key=value]").value, fieldByName(target), "eq") };
  });
  event.web = {
    notifyOnOpen: document.querySelector("#notify-open").checked,
    notifyOnClose: document.querySelector("#notify-close").checked,
    openMessage: document.querySelector("#open-message").value.trim(),
    closeMessage: document.querySelector("#close-message").value.trim()
  };
}

function operatorOptions(fieldName, selected) {
  const field = fieldByName(fieldName); const operators = state.capabilities.operators[field?.type] || [];
  return operators.map(operator => `<option value="${operator}"${operator === selected ? " selected" : ""}>${operator}</option>`).join("");
}
function valueText(clause) { return Array.isArray(clause.value) ? clause.value.join(", ") : clause.value === null ? "" : String(clause.value); }
function conditionHtml(prefix, condition) {
  const rows = condition.clauses.map((clause, index) => `<div class="${prefix}-clause-row condition-row" data-index="${index}"><select data-key="field">${fieldOptions(clause.field)}</select><select data-key="operator">${operatorOptions(clause.field, clause.operator)}</select><input data-key="value" value="${escapeHtml(valueText(clause))}" placeholder="value or low, high"><button class="row-delete" type="button" data-remove-clause="${prefix}:${index}">×</button></div>`).join("");
  return `<div class="condition-controls"><label>Combine<select id="${prefix}-mode"><option value="all"${condition.mode === "all" ? " selected" : ""}>ALL — AND</option><option value="any"${condition.mode === "any" ? " selected" : ""}>ANY — OR</option></select></label><label>Observations<input id="${prefix}-count" type="number" min="1" step="1" value="${condition.observationCount}"></label><label>Minimum seconds<input id="${prefix}-seconds" type="number" min="0" step="any" value="${condition.minimumSeconds}"></label></div><div class="condition-list">${rows}</div><button class="secondary-button compact-button add-clause" type="button" data-add-clause="${prefix}">Add condition</button>`;
}
function renderEvent() {
  const event = state.draft.events[state.selected.events];
  if (!event) { editor.innerHTML = "<p class='empty-editor'>Add an event to begin.</p>"; return; }
  const actions = event.actions.map((action, index) => `<div class="event-action-row condition-row" data-index="${index}"><select data-key="target">${writableFields().map(field => `<option value="${escapeHtml(field.systemName)}"${field.systemName === action.target ? " selected" : ""}>${escapeHtml(field.systemName)} · ${escapeHtml(field.write?.method || "unmapped")}</option>`).join("")}</select><span class="action-equals">=</span><input data-key="value" value="${escapeHtml(String(action.value))}"><button class="row-delete" type="button" data-remove-action="${index}">×</button></div>`).join("");
  const eventFunctionOptions = selected => `<option value="">None</option>${state.capabilities.eventFunctions.map(name => `<option value="${escapeHtml(name)}"${name === selected ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
  editor.innerHTML = `
    <div class="engine-editor-heading"><div><p class="kicker">EVENT DEFINITION</p><h2>${escapeHtml(event.displayName)}</h2></div><div class="inline-switches"><label class="switch-label"><input id="event-enabled" type="checkbox"${event.enabled ? " checked" : ""}> Enabled</label><label class="switch-label"><input id="event-latched" type="checkbox"${event.latched ? " checked" : ""}> Latched</label><button class="secondary-button compact-button danger-button" id="remove-item" type="button">Remove</button></div></div>
    <div class="form-grid compact-form"><label>Event ID<input id="event-id" value="${escapeHtml(event.id)}"></label><label>System name<input id="event-system-name" value="${escapeHtml(event.systemName)}"></label><label>Display name<input id="event-display-name" value="${escapeHtml(event.displayName)}"></label><label>Severity<select id="event-severity"><option${event.severity === "Info" ? " selected" : ""}>Info</option><option${event.severity === "Yellow" ? " selected" : ""}>Yellow</option><option${event.severity === "Red" ? " selected" : ""}>Red</option></select></label></div>
    <div class="event-condition-grid"><section><div class="subsection-heading"><div><p class="kicker">EVENT OPEN</p><h2>Opening qualification</h2></div></div>${conditionHtml("open", event.open)}</section><section><div class="subsection-heading"><div><p class="kicker">EVENT CLOSE</p><h2>Closing qualification</h2></div></div>${conditionHtml("close", event.close)}</section></div>
    <div class="event-lower-grid"><section><div class="subsection-heading"><div><p class="kicker">TAB5 PROCESSING</p><h2>Functions and active consequences</h2></div><button class="secondary-button compact-button" id="add-event-action" type="button">Add action</button></div><div class="stacked-form"><label>Function on open<select id="event-open-functions">${eventFunctionOptions(event.openFunctions?.[0])}</select></label><label>Function on close<select id="event-close-functions">${eventFunctionOptions(event.closeFunctions?.[0])}</select></label></div><div class="event-actions">${actions || "<p class='form-help'>No device action; event is logging only.</p>"}</div><p class="form-help">An action applies while the event is active. When no active event requires it, the writable field returns to its device-defined normal value. A latched event stays active until a user requests clear and its closing condition qualifies. System Override suppresses Tab5 actions but never event evaluation or logging.</p></section>
      <section><div class="subsection-heading"><div><p class="kicker">WEB PROCESSING</p><h2>Notifications</h2></div></div><div class="inline-switches notification-switches"><label class="switch-label"><input id="notify-open" type="checkbox"${event.web?.notifyOnOpen ? " checked" : ""}> Notify on open</label><label class="switch-label"><input id="notify-close" type="checkbox"${event.web?.notifyOnClose ? " checked" : ""}> Notify on close</label></div><div class="stacked-form"><label>Open message<textarea id="open-message" rows="3">${escapeHtml(event.web?.openMessage || "")}</textarea></label><label>Close message<textarea id="close-message" rows="3">${escapeHtml(event.web?.closeMessage || "")}</textarea></label></div></section></div>`;
}

function captureCurrent() {
  if (!state.draft) return;
  if (state.section === "devices") captureDevice();
  if (state.section === "calculatedFields") captureCalculation();
  if (state.section === "events") captureEvent();
}
function itemLabel(item) { return item.label || item.displayName || item.systemName || item.id || "Unnamed"; }
function renderList() {
  const items = state.draft[state.section]; const selected = state.selected[state.section];
  list.innerHTML = items.map((item, index) => `<button type="button" class="engine-list-item${index === selected ? " selected" : ""}" data-select="${index}"><strong>${escapeHtml(itemLabel(item))}</strong><small>${escapeHtml(item.systemName || item.driver || item.functionId || item.id)}</small>${item.enabled === false ? "<i>OFF</i>" : ""}</button>`).join("");
}
function renderEditor() {
  const [kicker, title] = sectionLabels[state.section];
  document.querySelector("#browser-kicker").textContent = kicker; document.querySelector("#browser-title").textContent = title;
  document.querySelectorAll(".engine-tile").forEach(button => button.classList.toggle("active", button.dataset.section === state.section));
  renderList();
  if (state.section === "devices") renderDevice();
  if (state.section === "calculatedFields") renderCalculation();
  if (state.section === "events") renderEvent();
}

async function loadDraft() {
  setStatus("Loading the Rules Engine draft…");
  try {
    const result = await api("GET");
    state.draft = result.draft; state.revisions = result.draft.revisions; state.current = result.current; state.capabilities = result.capabilities; state.dirty.clear(); state.runtimePackage = null;
    document.querySelector("#engine-release").textContent = result.current ? `${result.current.releaseId} · version ${result.current.packageVersion}` : "No published parameter package";
    document.querySelector("#engine-hash").textContent = result.current ? `SHA-256 ${result.current.contentHash} · delivery disabled` : "Defaults loaded into the Firestore draft; delivery disabled.";
    document.querySelector("#engine-tabs").hidden = false; document.querySelector("#engine-workspace").hidden = false;
    ["engine-save", "engine-validate", "engine-publish"].forEach(id => document.querySelector(`#${id}`).disabled = false);
    updateCounts(); renderEditor(); setStatus("Draft loaded. All default events are OFF.", "ok");
  } catch (error) { if (error.message !== "cancelled") setStatus(`Could not load Rules Engine: ${error.body?.code || error.message}`, "error"); }
}

async function saveAll() {
  captureCurrent();
  const sections = state.dirty.size ? [...state.dirty] : [state.section];
  for (const section of sections) {
    const result = await api("PUT", { section, baseRevision: state.revisions[section], items: state.draft[section] });
    state.revisions[section] = result.revision; state.dirty.delete(section);
  }
  document.querySelector("#engine-save").disabled = true;
  return sections;
}

function showFindings(result) {
  const panel = document.querySelector("#validation-panel"); const box = document.querySelector("#validation-findings"); panel.hidden = false;
  const findings = [...(result.errors || []).map(item => ({ ...item, level: "error" })), ...(result.warnings || []).map(item => ({ ...item, level: "warning" }))];
  box.innerHTML = findings.length ? findings.map(item => `<div class="validation-finding ${item.level}"><strong>${escapeHtml(item.path)}</strong><span>${escapeHtml(item.message)}</span><code>${escapeHtml(item.code)}</code></div>`).join("") : "<div class='validation-success'><strong>All relationships resolved.</strong><span>The runtime package uses only supported fields, functions, operators, and writable actions.</span></div>";
}
async function validatePackage() {
  setStatus("Saving the draft and validating all relationships…");
  try {
    await saveAll(); const result = await api("POST", { action: "validate" });
    state.runtimePackage = result.runtimePackage;
    document.querySelector("#validation-state").textContent = "Passed"; document.querySelector("#validation-state").className = "ok-text";
    document.querySelector("#runtime-size").textContent = `${result.runtimeBytes.toLocaleString()} byte MicroPython runtime package · RTDB delivery disabled`;
    document.querySelector("#engine-download").disabled = false; document.querySelector("#engine-publish").disabled = false;
    showFindings(result); setStatus("Validation passed. The draft can become the next immutable package version.", "ok");
  } catch (error) {
    const result = error.body || {};
    if (!result.errors?.length) result.errors = [{ path: "draft", code: result.code || error.message, message: "The draft could not be saved or validated. Reload if another editor changed it." }];
    document.querySelector("#validation-state").textContent = "Failed"; document.querySelector("#validation-state").className = "error-text";
    showFindings(result); setStatus(`Validation failed with ${(result.errors || []).length} blocking finding(s).`, "error");
  }
}
async function publishPackage() {
  if (!state.runtimePackage) return validatePackage();
  const confirmation = window.prompt("Publish the validated draft as the next immutable parameter version? Type PUBLISH to continue.");
  if (confirmation !== "PUBLISH") return;
  setStatus("Publishing the authoring model and compiled runtime package…");
  try {
    const result = await api("POST", { action: "publish", basePackageVersion: state.current?.packageVersion || 0 });
    state.current = result.current; state.runtimePackage = result.runtimePackage;
    document.querySelector("#engine-release").textContent = `${result.current.releaseId} · version ${result.current.packageVersion}`;
    document.querySelector("#engine-hash").textContent = `SHA-256 ${result.current.contentHash} · delivery disabled`;
    document.querySelector("#runtime-size").textContent = `${result.runtimeBytes.toLocaleString()} byte MicroPython runtime package · RTDB delivery disabled`;
    showFindings(result); setStatus("Immutable package published to Firestore. Nothing was sent to RTDB or Tab5.", "ok");
  } catch (error) { setStatus(`Publish failed: ${error.body?.code || error.message}`, "error"); }
}
function downloadRuntime() {
  if (!state.runtimePackage) return;
  const blob = new Blob([`${JSON.stringify(state.runtimePackage, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${state.current?.releaseId || "rules-engine-runtime-preview"}.json`; link.click(); URL.revokeObjectURL(link.href);
}

function addItem() {
  captureCurrent();
  if (state.section === "devices") state.draft.devices.push({ id: `device-${state.draft.devices.length + 1}`, label: "New device", driver: "", address: "", enabled: false, fields: [{ systemName: "NewTelemetry", label: "New telemetry", object: "", type: "number", unit: null, access: "read", logging: { mode: "none" } }] });
  if (state.section === "calculatedFields") {
    const calculation = { id: `calculation-${state.draft.calculatedFields.length + 1}`, label: "New calculation", functionId: "load_ratio", inputs: {}, parameters: {}, outputs: [] };
    normalizeCalculationFunction(calculation, calculation.functionId); state.draft.calculatedFields.push(calculation);
  }
  if (state.section === "events") state.draft.events.push({ id: `EV-${state.draft.events.length + 1}`, systemName: `NewEvent${state.draft.events.length + 1}`, displayName: "New event", enabled: false, severity: "Info", open: { mode: "all", clauses: [{ field: allFields()[0]?.systemName || "", operator: "gt", value: 0 }], observationCount: 1, minimumSeconds: 0 }, close: { mode: "all", clauses: [{ field: allFields()[0]?.systemName || "", operator: "lte", value: 0 }], observationCount: 1, minimumSeconds: 0 }, latched: false, openFunctions: [], closeFunctions: [], actions: [], web: { notifyOnOpen: false, notifyOnClose: false, openMessage: "", closeMessage: "" } });
  state.selected[state.section] = state.draft[state.section].length - 1; markDirty(); updateCounts(); renderEditor();
}

function removeItem() {
  const items = state.draft[state.section];
  const index = state.selected[state.section];
  if (!items[index]) return;
  const label = itemLabel(items[index]);
  if (!window.confirm(`Remove ${label} from this draft? Validation will report any dependent references.`)) return;
  items.splice(index, 1);
  state.selected[state.section] = Math.max(0, Math.min(index, items.length - 1));
  markDirty(); updateCounts(); renderEditor();
}

document.querySelector("#engine-load").addEventListener("click", loadDraft);
document.querySelector("#engine-save").addEventListener("click", async () => { try { const sections = await saveAll(); setStatus(`Saved ${sections.join(", ")} draft section(s).`, "ok"); } catch (error) { setStatus(`Save failed: ${error.body?.code || error.message}`, "error"); } });
document.querySelector("#engine-validate").addEventListener("click", validatePackage);
document.querySelector("#engine-publish").addEventListener("click", publishPackage);
document.querySelector("#engine-download").addEventListener("click", downloadRuntime);
document.querySelector("#add-item").addEventListener("click", addItem);
document.querySelector("#engine-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-section]"); if (!button || button.dataset.section === state.section) return;
  captureCurrent(); state.section = button.dataset.section; renderEditor();
});
list.addEventListener("click", event => {
  const button = event.target.closest("[data-select]"); if (!button) return;
  captureCurrent(); state.selected[state.section] = Number(button.dataset.select); renderEditor();
});
editor.addEventListener("input", markDirty);
editor.addEventListener("change", event => {
  markDirty();
  if (event.target.id === "calculation-function") {
    captureCalculation(); const calculation = state.draft.calculatedFields[state.selected.calculatedFields]; normalizeCalculationFunction(calculation, event.target.value); renderEditor();
  }
  if (event.target.dataset.key === "field") {
    const row = event.target.closest(".condition-row"); const operator = row.querySelector("[data-key=operator]"); operator.innerHTML = operatorOptions(event.target.value, null);
  }
});
editor.addEventListener("click", event => {
  if (event.target.id === "remove-item") { removeItem(); return; }
  const fieldRemove = event.target.closest("[data-remove-field]");
  if (fieldRemove) { captureDevice(); state.draft.devices[state.selected.devices].fields.splice(Number(fieldRemove.dataset.removeField), 1); markDirty(); renderEditor(); return; }
  if (event.target.id === "add-device-field") { captureDevice(); state.draft.devices[state.selected.devices].fields.push({ systemName: "NewTelemetry", label: "New telemetry", object: "", type: "number", unit: null, access: "read", logging: { mode: "none" } }); markDirty(); renderEditor(); return; }
  const clauseRemove = event.target.closest("[data-remove-clause]");
  if (clauseRemove) { captureEvent(); const [side, index] = clauseRemove.dataset.removeClause.split(":"); state.draft.events[state.selected.events][side].clauses.splice(Number(index), 1); markDirty(); renderEditor(); return; }
  const clauseAdd = event.target.closest("[data-add-clause]");
  if (clauseAdd) { captureEvent(); const side = clauseAdd.dataset.addClause; const field = allFields()[0]; if (!field) { setStatus("Define at least one direct or calculated field first.", "warning"); return; } state.draft.events[state.selected.events][side].clauses.push({ field: field.systemName, operator: state.capabilities.operators[field.type][0], value: field.type === "boolean" ? true : 0 }); markDirty(); renderEditor(); return; }
  const actionRemove = event.target.closest("[data-remove-action]");
  if (actionRemove) { captureEvent(); state.draft.events[state.selected.events].actions.splice(Number(actionRemove.dataset.removeAction), 1); markDirty(); renderEditor(); return; }
  if (event.target.id === "add-event-action") { captureEvent(); const target = writableFields()[0]; if (!target) return setStatus("No writable device field is defined.", "warning"); state.draft.events[state.selected.events].actions.push({ target: target.systemName, value: target.type === "boolean" ? false : 0 }); markDirty(); renderEditor(); }
});
