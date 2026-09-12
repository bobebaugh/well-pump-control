"use strict";

const sectionLabels = {
  devices: ["DEVICES", "Configured devices"],
  calculatedFields: ["CALCULATED FIELDS", "Formulas and Boyle law"],
  systemFields: ["SYSTEM FIELDS", "Runtime-owned state and occurrences"],
  events: ["EVENTS", "Event definitions"]
};
const state = {
  formDirty: false, busy: false, draft: null, revisions: {}, current: null, capabilities: null,
  section: "devices", selected: { devices: 0, calculatedFields: 0, systemFields: 0, events: 0 },
  dirty: new Set(), runtimePackage: null, releases: []
};

const editor = document.querySelector("#engine-editor");
const list = document.querySelector("#engine-list");
const statusBox = document.querySelector("#engine-status");
const deliverButton = document.querySelector("#engine-deliver");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function setStatus(text, kind = "") { statusBox.className = `editor-status ${kind}`; statusBox.textContent = text; }
function pilotKey() { return sessionStorage.getItem("pilotMonitorKey"); }
async function api(method, payload, query = "") {
  let key = pilotKey();
  if (!key) key = window.prompt("Enter the pilot key");
  if (!key) throw new Error("cancelled");
  const separator = query ? "&" : "?";
  const response = await fetch(`/.netlify/functions/rules-engine${query}${separator}version=3`, {
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
  return fields.concat(state.draft.calculatedFields.flatMap(calculation => calculation.kind === "expression" ? [calculation.output] : (calculation.outputs || [])), state.draft.systemFields || []);
}
function directFields() { return state.draft.devices.flatMap(device => device.fields || []); }
function calculatedFields() { return state.draft.calculatedFields.flatMap(calculation => calculation.kind === "expression" ? [calculation.output] : (calculation.outputs || [])); }
function fieldByName(name) { return allFields().find(field => field.systemName === name); }
function writableFields() { return state.draft.devices.flatMap(device => device.fields || []).filter(field => field.access === "readWrite").concat((state.draft.systemFields || []).filter(field => field.assignmentTarget === true)); }
function optionHtml(field, selected) {
  return `<option value="${escapeHtml(field.systemName)}"${field.systemName === selected ? " selected" : ""}>${escapeHtml(field.systemName)} · ${escapeHtml(field.type)}${field.unit ? ` · ${escapeHtml(field.unit)}` : ""}</option>`;
}
function fieldOptions(selected) {
  return `<optgroup label="Direct Observations">${directFields().map(field => optionHtml(field, selected)).join("")}</optgroup><optgroup label="Calculated Values">${calculatedFields().map(field => optionHtml(field, selected)).join("")}</optgroup><optgroup label="System Fields">${(state.draft.systemFields || []).map(field => optionHtml(field, selected)).join("")}</optgroup>`;
}
function logModeOptions(selected) {
  return ["none", "delta", "change", "always"].map(value => `<option${value === selected ? " selected" : ""}>${value}</option>`).join("");
}
function updateCounts() {
  document.querySelector("#devices-count").textContent = `${state.draft.devices.length} configured`;
  document.querySelector("#calculations-count").textContent = `${state.draft.calculatedFields.length} configured`;
  document.querySelector("#system-fields-count").textContent = `${state.draft.systemFields.length} configured`;
  document.querySelector("#events-count").textContent = `${state.draft.events.length} configured`;
}
function deliveryText(current) {
  if (!current) return "No immutable package is published. Import a backup or edit the draft.";
  return `SHA-256 ${current.contentHash} · ${current.deliveryEnabled ? "Delivery requested; check Tab5 report below" : "Published; delivery not recorded"}`;
}
const deliveryErrors = {
  invalid_delivery_request: "Delivery request is invalid: the release id is missing or malformed.",
  pointer_read_failed: "Could not read the current V3 pointer. The database security rules are most likely not deployed (firebase deploy --only database).",
  delivery_not_current: "This release is no longer the current published version. Reload before delivering.",
  delivery_release_mismatch: "Delivery refused: the stored release disagrees with the published pointer.",
  rules_v3_republish_required: "This package has older V3 publication state. Publish it again before delivery.",
  pointer_changed: "Delivery did not complete because another writer changed the RTDB pointer. Reload and try again.",
  pointer_write_failed: "RTDB pointer write was rejected. The database security rules are most likely not deployed (firebase deploy --only database).",
  publisher_auth_failed: "Delivery could not authenticate the V3 publisher token.",
  configuration_missing: "Delivery is unavailable because Firebase environment configuration is missing.",
  runtime_pointer_required: "Delivery was refused because the package is not a V3 runtime pointer."
};
function deliveryErrorText(error) {
  const code = error.body?.code || error.message;
  return deliveryErrors[code] || `Delivery failed: ${code}`;
}
function markDirty() {
  state.formDirty = true;
  state.dirty.add(state.section);
  state.runtimePackage = null;
  document.querySelector("#engine-download").disabled = true;
  document.querySelector("#engine-save").disabled = false;
  document.querySelector("#engine-publish").disabled = false;
  deliverButton.disabled = true;
  document.querySelector("#validation-state").textContent = "Draft changed";
  document.querySelector("#validation-state").className = "warning-text";
}

function releaseDate(value) {
  return Number.isFinite(value) ? new Date(value).toLocaleString() : "Date unavailable";
}
function renderReleaseHistory() {
  const select = document.querySelector('#release-select');
  const releases = state.releases.slice(0,10);
  select.innerHTML = releases.length ? releases.map(r=>`<option value="${escapeHtml(r.releaseId)}">Version ${r.packageVersion} · ${escapeHtml(releaseDate(r.publishedAtMs))}</option>`).join('') : '<option value="">No published versions</option>';
  select.disabled = !releases.length;
  document.querySelector('#load-published').disabled = !releases.length;
}
async function openLoad() {
  document.querySelector('#load-error').textContent='';
  const loaded = await api('GET');
  state.releases = loaded.releases || [];
  renderReleaseHistory();
  document.querySelector('#load-dialog').showModal();
}
function acceptWorkingRules(draft, source, saved = false) {
  state.draft = clone(draft);
  state.draft.revisions = clone(state.revisions);
  state.dirty = new Set(saved ? [] : Object.keys(sectionLabels));
  state.formDirty = false; state.runtimePackage = null;
  state.selected = {devices:0,calculatedFields:0,systemFields:0,events:0};
  document.querySelector('#engine-tabs').hidden = false;
  document.querySelector('#engine-workspace').hidden = false;
  document.querySelector('#validation-panel').hidden = true;
  document.querySelector('#validation-state').textContent = 'Not checked';
  document.querySelector('#runtime-size').textContent = 'No runtime package generated.';
  document.querySelector('#working-source').textContent = source;
  document.querySelector('#load-dialog').close();
  updateCounts(); renderEditor(); syncButtons();
  setStatus(`${source} loaded into the editor.${saved ? '' : ' Not saved. Save Draft to keep it, or Load → Last saved to discard it.'}`, 'ok');
}
async function loadWorking(source, file) {
  if (state.dirty.size && !window.confirm('Discard unsaved editor changes?')) return;
  // Retain the revision baseline of an existing editing session, so loading a
  // file cannot silently authorize overwriting another session's newer save.
  const loaded = await api('GET');
  if (!state.draft || source === 'saved') state.revisions = loaded.draft.revisions;
  state.current = loaded.current; state.capabilities = loaded.capabilities;
  state.releases = loaded.releases || [];
  let draft, label;
  if (source === 'saved') {draft = loaded.draft; label = 'Last saved draft';}
  else if (source === 'seed') {draft = (await api('GET',undefined,'?seedTemplate=1')).draft; label = 'Seed';}
  else if (source === 'published') {
    const id = document.querySelector('#release-select').value;
    if (!id) return;
    const {release} = await api('GET',undefined,`?releaseId=${encodeURIComponent(id)}`);
    draft = release.authoringPackage; label = `Published version ${release.packageVersion}`;
  } else {
    if (!file) return;
    if (file.size > 500000) throw new Error('Backup exceeds the 500,000 byte limit.');
    const result = await api('POST',{action:'previewImport',backup:JSON.parse(await file.text())});
    draft = result.draft; label = `Backup ${file.name}`;
  }
  if (source === 'seed' || source === 'published') {
    // Check editable structure without requiring unfinished rules to compile.
    await api('POST',{action:'previewImport',backup:{kind:'well-pump-rules-authoring-backup',backupVersion:1,authoringPackage:draft}});
  }
  acceptWorkingRules(draft,label,source === 'saved');
  if (state.current) showPublished(state.current);
  else {document.querySelector('#engine-release').textContent='No published package';document.querySelector('#engine-hash').textContent='';}
}

function captureDevice() {
  const device = state.draft.devices[state.selected.devices];
  if (!device || !document.querySelector("#device-id")) return;
  device.id = document.querySelector("#device-id").value.trim();
  device.label = document.querySelector("#device-label").value.trim();
  device.driver = document.querySelector("#device-driver").value.trim();
  device.address = document.querySelector("#device-address").value.trim();
  device.enabled = document.querySelector("#device-enabled").checked;
  device.fields = [...editor.querySelectorAll(".device-field-row")].map((row, index) => {
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
    if (type === "enum" && device.fields[index]?.enumValues) field.enumValues = clone(device.fields[index].enumValues);
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
  const readCommands = {'shelly-gen1-em':'GET /emeter/0', 'shelly-gen4-switch':'Shelly.GetStatus; Shelly.GetComponents with dynamic_only=true and config/status included', 'tab5-runtime':'Local acquisition (no Shelly command)'};
  const driverOptions = Object.entries(state.capabilities.drivers).map(([id, label]) => `<option value="${escapeHtml(id)}"${id === device.driver ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  const rows = device.fields.map((field, index) => `
    <div class="device-field-row" data-index="${index}">
      <div class="device-field-primary">
        <label class="field-system"><span>System name</span><input data-key="systemName" value="${escapeHtml(field.systemName)}"></label>
        <label class="field-label"><span>Label</span><input data-key="label" value="${escapeHtml(field.label)}"></label>
        <label class="field-object"><span>Object</span><input data-key="object" value="${escapeHtml(field.object)}"></label>
        <label class="field-type"><span>Type</span><select data-key="type"><option${field.type === "number" ? " selected" : ""}>number</option><option${field.type === "integer" ? " selected" : ""}>integer</option><option${field.type === "boolean" ? " selected" : ""}>boolean</option><option${field.type === "enum" ? " selected" : ""}>enum</option></select></label>
        <label class="field-unit"><span>Unit</span><input data-key="unit" value="${escapeHtml(field.unit || "")}"></label>
        <label class="field-log"><span>Log</span><select data-key="logMode">${logModeOptions(field.logging?.mode)}</select></label>
        <label class="field-threshold"><span>Change threshold</span><input data-key="threshold" type="number" step="any" value="${escapeHtml(field.logging?.threshold ?? "")}"${field.logging?.mode !== "delta" ? " disabled" : ""}></label>
        <label class="field-access"><span>Access</span><select data-key="access"><option value="read"${field.access === "read" ? " selected" : ""}>read</option><option value="readWrite"${field.access === "readWrite" ? " selected" : ""}>read/write</option></select></label>
        <button class="row-delete field-delete" type="button" data-remove-field="${index}" aria-label="Remove field">×</button>
      </div>
      <details class="field-action-mapping"${field.access === "readWrite" ? " open" : ""}>
        <summary>Device action mapping — supported relay ON / OFF</summary><button type="button" class="secondary-button" data-relay-mapping="${index}">Use supported relay mapping</button>
        <div>
          <label><span>Write method</span><input data-key="writeMethod" value="${escapeHtml(field.write?.method || "")}" placeholder="Switch.Set" readonly></label>
          <label><span>Write arguments</span><input data-key="writeParameters" value="${escapeHtml(typeof field.write?.parameters === "string" ? field.write.parameters : JSON.stringify(field.write?.parameters || {}))}" placeholder='{"id":0,"valueParameter":"on"}' readonly></label>
          <label><span>Released value (mechanical control)</span><input data-key="normalValue" value="${escapeHtml(field.write?.normalValue ?? "")}" placeholder="true" readonly></label>
        </div>
      </details>
    </div>`).join("");
  editor.innerHTML = `
    <div class="engine-editor-heading"><div><p class="kicker">DEVICE DEFINITION</p><h2>${escapeHtml(device.label)}</h2></div><div class="inline-switches"><label class="switch-label"><input id="device-enabled" type="checkbox"${device.enabled ? " checked" : ""}> Enabled</label><button class="secondary-button compact-button danger-button" id="remove-item" type="button">Remove</button></div></div>
    <div class="form-grid compact-form">
      <label>Device ID<input id="device-id" value="${escapeHtml(device.id)}"></label>
      <label>Display name<input id="device-label" value="${escapeHtml(device.label)}"></label>
      <label>Driver<select id="device-driver">${driverOptions}</select></label>
      <label>IP address / location<input id="device-address" value="${escapeHtml(device.address)}"></label>
    </div>
    <p class="form-help">Current acquisition: ${escapeHtml(readCommands[device.driver] || "Choose a supported driver")}</p>
    <div class="subsection-heading"><div><p class="kicker">NAMED FIELDS</p><h2>Telemetry and actions</h2></div><button class="secondary-button compact-button" id="add-device-field" type="button">Add field</button></div>
    <div class="device-fields-grid">${rows}</div>
    <p class="form-help">Rules reference system names. The only supported write is Switch.Set on relay 0: false sends {id:0,on:false}; true sends {id:0,on:true}, subject to ownership and valid lock evidence. Normal value true releases Tab5 inhibition; it does not create pump demand. Device addresses are descriptive here; installed Tab5 configuration owns polling endpoints.</p>`;
}

function captureCalculation() {
  const calculation = state.draft.calculatedFields[state.selected.calculatedFields];
  if (!calculation || !document.querySelector("#calculation-id")) return;
  const displayedKind = calculation.kind;
  calculation.id = document.querySelector("#calculation-id").value.trim();
  calculation.label = document.querySelector("#calculation-label").value.trim();
  if (displayedKind === "expression") {
    calculation.expression = document.querySelector("#calculation-expression").value.trim();
    calculation.output = captureOutputRow(editor.querySelector(".calculation-output-row"), calculation.output);
  } else {
    calculation.functionId = document.querySelector("#calculation-function").value;
    calculation.inputs = {};
    editor.querySelectorAll("[data-calculation-input]").forEach(input => { calculation.inputs[input.dataset.calculationInput] = input.value; });
    calculation.parameters = {};
    editor.querySelectorAll("[data-calculation-parameter]").forEach(input => {
      const raw = input.value.trim(); const numeric = Number(raw);
      calculation.parameters[input.dataset.calculationParameter] = raw !== "" && Number.isFinite(numeric) ? numeric : raw;
    });
    calculation.outputs = [...editor.querySelectorAll(".calculation-output-row")].map((row, index) => captureOutputRow(row, calculation.outputs[index]));
  }
  calculation.kind = document.querySelector("#calculation-kind").value;
}

function captureOutputRow(row, existing = {}) {
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

function normalizeCalculationKind(calculation, kind) {
  calculation.kind = kind;
  if (kind === "expression") {
    calculation.expression ||= "PumpWatts";
    calculation.output ||= { systemName: uniqueName("CalculatedValue",allFields().map(f=>f.systemName)), label: "Calculated value", type: "number", unit: null, logging: { mode: "delta", threshold: 1 } };
    return;
  }
  normalizeCalculationFunction(calculation, calculation.functionId && state.capabilities.functions[calculation.functionId] ? calculation.functionId : Object.keys(state.capabilities.functions)[0]);
}

function outputRowsHtml(outputs, typeReadonly) {
  return outputs.map((output, index) => `<div class="calculation-output-row data-grid-row" data-index="${index}">
    <input data-key="systemName" value="${escapeHtml(output.systemName)}"><input data-key="label" value="${escapeHtml(output.label)}">
    ${typeReadonly ? `<input data-key="type" value="${escapeHtml(output.type)}" readonly>` : `<select data-key="type"><option value="number"${output.type === "number" ? " selected" : ""}>number</option><option value="integer"${output.type === "integer" ? " selected" : ""}>integer</option></select>`}
    <input data-key="unit" value="${escapeHtml(output.unit || "")}">
    <select data-key="logMode">${logModeOptions(output.logging?.mode)}</select><input data-key="threshold" type="number" step="any" value="${escapeHtml(output.logging?.threshold ?? "")}">
  </div>`).join("");
}

function renderCalculation() {
  const calculation = state.draft.calculatedFields[state.selected.calculatedFields];
  if (!calculation) { editor.innerHTML = "<p class='empty-editor'>Add a calculated field to begin.</p>"; return; }
  const spec = calculation.kind === "function" ? state.capabilities.functions[calculation.functionId] : null;
  const functionOptions = Object.entries(state.capabilities.functions).map(([id, definition]) => `<option value="${escapeHtml(id)}"${id === calculation.functionId ? " selected" : ""}>${escapeHtml(definition.label)}</option>`).join("");
  const inputRows = Object.keys(spec?.inputs || {}).map(name => `<label>${escapeHtml(name)}<select data-calculation-input="${escapeHtml(name)}">${fieldOptions(calculation.inputs?.[name])}</select></label>`).join("");
  const parameterRows = Object.keys(spec?.parameters || {}).map(name => `<label>${escapeHtml(name)}<input data-calculation-parameter="${escapeHtml(name)}" value="${escapeHtml(calculation.parameters?.[name] ?? "")}"></label>`).join("");
  const expressionEditor = `<section class="expression-card"><p class="kicker">ARITHMETIC EXPRESSION</p><textarea id="calculation-expression" rows="4" spellcheck="false">${escapeHtml(calculation.expression || "")}</textarea><p class="form-help">Use named numeric fields, constants, +, −, ×, ÷, and parentheses. The web compiler validates dependencies for the immutable package.</p></section>`;
  const functionEditor = `<div class="form-grid compact-form"><label class="wide">Programmed function<select id="calculation-function">${functionOptions}</select></label></div><div class="calculation-config-grid"><section><p class="kicker">INPUT FIELDS</p><div class="stacked-form">${inputRows || "<p class='form-help'>No inputs.</p>"}</div></section><section><p class="kicker">FUNCTION PARAMETERS</p><div class="stacked-form">${parameterRows || "<p class='form-help'>No parameters.</p>"}</div></section></div>`;
  const outputs = calculation.kind === "expression" ? outputRowsHtml([calculation.output], false) : outputRowsHtml(calculation.outputs, true);
  editor.innerHTML = `
    <div class="engine-editor-heading"><div><p class="kicker">CALCULATED FIELD DEFINITION</p><h2>${escapeHtml(calculation.label)}</h2></div><button class="secondary-button compact-button danger-button" id="remove-item" type="button">Remove</button></div>
    <div class="form-grid compact-form"><label>Calculation ID<input id="calculation-id" value="${escapeHtml(calculation.id)}"></label><label>Display name<input id="calculation-label" value="${escapeHtml(calculation.label)}"></label><label>Calculation kind<select id="calculation-kind"><option value="expression"${calculation.kind === "expression" ? " selected" : ""}>Formula</option><option value="function"${calculation.kind === "function" ? " selected" : ""}>Programmed function</option></select></label></div>
    ${calculation.kind === "expression" ? expressionEditor : functionEditor}
    <div class="subsection-heading"><div><p class="kicker">OUTPUTS</p><h2>Named calculated fields</h2></div></div>
    <div class="data-grid calculation-output-grid"><div class="data-grid-head"><span>System name</span><span>Label</span><span>Type</span><span>Unit</span><span>Log</span><span>Range</span></div>${outputs}</div>
    <p class="form-help">Direct observations and calculated outputs may independently request one complete durable snapshot through their logging policy.</p>`;
}

function parseClauseValue(raw, field, operator) {
  if (operator === "occurs") return null;
  if (operator === "between" || operator === "outside") return raw.split(",").map(value => Number(value.trim()));
  if (field?.type === "number" || field?.type === "integer") return Number(raw);
  if (field?.type === "boolean") return raw.toLowerCase() === "true";
  return raw;
}
function operatorOptions(fieldName, selected) {
  const field = fieldByName(fieldName); const operators = state.capabilities.operators[field?.type] || [];
  return operators.map(operator => `<option value="${operator}"${operator === selected ? " selected" : ""}>${operator}</option>`).join("");
}
function valueText(clause) { return Array.isArray(clause.value) ? clause.value.join(", ") : clause.value === null ? "" : String(clause.value); }
function summaryHtml(summary) {
  const operations = selected => Object.entries(state.capabilities.summaryOperations).map(([id, label]) => `<option value="${id}"${id === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  const rows = summary.aggregates.map((aggregate, index) => `<div class="summary-row data-grid-row" data-index="${index}">
    <select data-key="source">${fieldOptions(aggregate.source)}</select><select data-key="operation">${operations(aggregate.operation)}</select>
    <input data-key="systemName" value="${escapeHtml(aggregate.output.systemName)}"><input data-key="label" value="${escapeHtml(aggregate.output.label)}">
    <input data-key="unit" value="${escapeHtml(aggregate.output.unit || "")}"><input data-key="scale" type="number" step="any" value="${escapeHtml(aggregate.scale)}">
    <button class="row-delete" type="button" data-remove-summary="${index}">×</button>
  </div>`).join("");
  const duration = summary.durationOutput || { systemName: "EventDurationSeconds", label: "Event duration" };
  return `<div class="summary-duration"><label class="switch-label"><input id="summary-duration-enabled" type="checkbox"${summary.durationOutput ? " checked" : ""}> Store event duration</label><input id="summary-duration-name" value="${escapeHtml(duration.systemName)}" placeholder="Output system name"><input id="summary-duration-label" value="${escapeHtml(duration.label)}" placeholder="Output label"></div>
    <div class="data-grid summary-grid"><div class="data-grid-head"><span>Source</span><span>Operation</span><span>Output name</span><span>Label</span><span>Unit</span><span>Scale</span><span></span></div>${rows}</div>`;
}

function itemLabel(item) { return item.label || item.displayName || item.systemName || item.id || "Unnamed"; }
function renderList() {
  const items = state.draft[state.section]; const selected = state.selected[state.section];
  list.innerHTML = items.map((item, index) => `<button type="button" class="engine-list-item${index === selected ? " selected" : ""}" data-select="${index}"><strong>${escapeHtml(itemLabel(item))}</strong><small>${escapeHtml(item.systemName || item.driver || item.functionId || item.id)}</small>${item.enabled === false ? "<i>OFF</i>" : ""}</button>`).join("");
}
async function loadDraft() { return loadWorking('saved'); }
async function saveAll() {
  captureCurrent();
  if (!state.dirty.size) return [];
  const result = await api('POST',{action:'import',backup:workingBackup(),baseRevisions:state.revisions});
  state.revisions = result.draft.revisions;
  state.draft.revisions = clone(state.revisions);
  state.dirty.clear();
  document.querySelector('#engine-save').disabled = true;
  document.querySelector('#working-source').textContent = 'Saved draft';
  return Object.keys(sectionLabels);
}
function workingBackup() {
  return {kind:'well-pump-rules-authoring-backup',backupVersion:1,authoringPackage:authoringDraft()};
}

function showFindings(result, navigable = true) {
  const panel = document.querySelector("#validation-panel"), box = document.querySelector("#validation-findings"); panel.hidden = false;
  const findings = [...(result.errors || []).map(x=>({...x,level:'error'})),...(result.warnings||[]).map(x=>({...x,level:'warning'}))];
  box.innerHTML = findings.length ? findings.map(item=>{
    const match = /^(devices|calculatedFields|systemFields|events)\[(\d+)\]/.exec(item.path);
    const definition = match && state.draft?.[match[1]]?.[Number(match[2])];
    const title = definition && navigable ? `${definition.id || definition.systemName} — ${itemLabel(definition)}` : item.path;
    let message = /invalid_(?:system_name|event_name)/.test(item.code) ? 'Use 2–64 characters: start with a letter, then letters, digits or underscores. Spaces are not allowed; use the display name for readable text.' : item.message;
    if(navigable && /duplicate/.test(item.code)) {
      const key=item.path.split('.').at(-1), value=item.path.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],state.draft);
      const matches=[];
      const walk=(v,p)=>{if(!v || typeof v!=='object') return; for(const [k,x] of Object.entries(v)) {const next=Array.isArray(v)?`${p}[${k}]`:(p?`${p}.${k}`:k);if(k===key && x===value && next!==item.path) matches.push(next);if(typeof x==='object') walk(x,next);}};
      walk(key==='id' && match ? {[match[1]]:state.draft[match[1]]}:state.draft,'');
      if(matches.length) message += ` Also defined at: ${matches.join(', ')}.`;
    }
    return `<div class="validation-finding ${item.level}">${navigable ? `<button class="secondary-button finding-link" data-finding-path="${escapeHtml(item.path)}">${escapeHtml(title || 'Configuration')}</button>` : `<strong>${escapeHtml(title)}</strong>`}<span>${escapeHtml(message)}</span><small>${escapeHtml(item.path)}</small><code>${escapeHtml(item.code)}</code></div>`;
  }).join('') : '<div class="validation-success">Online validation passed for the current Tab5 supported subset. Live device availability is checked during operation.</div>';
}
function reportError(error, operation) {
  if (error.saveFailure) { setStatus(error.message, 'error'); return; }
  if(error.body?.errors?.length) { showFindings(error.body); setStatus(`${operation} blocked. Select a finding to fix it.`, 'error'); }
  else setStatus(`${operation} failed: ${error.body?.message || error.body?.code || error.message}. Your browser edits are retained.`, 'error');
}
async function validatePackage() {
  setStatus("Validating the working rules without saving…");
  try {
    captureCurrent(); const result = await api("POST", { action: "validate", backup: workingBackup() });
    state.runtimePackage = result.runtimePackage;
    document.querySelector("#validation-state").textContent = "Passed"; document.querySelector("#validation-state").className = "ok-text";
    document.querySelector("#runtime-size").textContent = `${result.runtimeBytes.toLocaleString()} byte V3 runtime package · checked for Tab5 compatibility`;
    document.querySelector("#engine-download").disabled = false; document.querySelector("#engine-publish").disabled = false;
    showFindings(result); setStatus("Validation passed. The draft can become the next immutable package version.", "ok");
  } catch (error) {
    state.runtimePackage = null; document.querySelector('#engine-download').disabled = true;
    document.querySelector('#validation-state').textContent = error.saveFailure ? 'Save failed' : 'Failed';
    reportError(error,'Validation');
  }
}

function authoringDraft() {
  return {schemaVersion:3,...Object.fromEntries(Object.keys(sectionLabels).map(k=>[k,state.draft[k]]))};
}
function canonicalJson(value) {
  const ordered = v => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])) : v;
  return JSON.stringify(ordered(value));
}
function showPublished(current, result = {}) {
  state.current = current;
  document.querySelector('#engine-release').textContent = `${current.releaseId} · version ${current.packageVersion}`;
  document.querySelector('#engine-hash').textContent = deliveryText(current);
  if(result.runtimePackage) state.runtimePackage = result.runtimePackage;
  deliverButton.disabled = false;
}
async function publishPackage() {
  if(!state.draft) return;
  if(!window.confirm('Save, validate, publish and request delivery? Tab5 adopts only on restart.')) return;
  let publishing = false, baseVersion;
  try {
    setStatus('Checking Tab5 compatibility…');
    captureCurrent();
    const validation = await api('POST',{action:'validate',backup:workingBackup()});
    showFindings(validation); state.runtimePackage = validation.runtimePackage;
    if(validation.warnings?.length && !window.confirm('Validation has warnings shown below. Continue with publication and delivery?')) return;
    await saveAll();
    // Each deliberate publication creates a version; delivery retries do not.
    const loaded = await api('GET');
    if(canonicalJson(loaded.draft.revisions)!==canonicalJson(state.revisions)) throw new Error('Draft changed in another session. Export your edits before reloading.');
    state.current = loaded.current;
    baseVersion = state.current?.packageVersion || 0; publishing = true;
    const result = await api('POST',{action:'publish',basePackageVersion:baseVersion,baseRevisions:state.revisions});
    publishing = false; showPublished(result.current,result);
    state.releases = [{...result.current,schemaVersion:3},...state.releases];
    await deliverPackage(false);
  } catch(error) {
    if(publishing) {
      // Do not retry an uncertain publication: first recover its committed identity.
      try {
        const loaded = await api('GET');
        if(loaded.current?.packageVersion === baseVersion + 1) {
          const existing = await api('GET',undefined,`?releaseId=${encodeURIComponent(loaded.current.releaseId)}`);
          if(canonicalJson(existing.release.authoringPackage)===canonicalJson(authoringDraft())) {
            showPublished(loaded.current); setStatus('Publication confirmed after an interrupted response. Use Retry delivery for this version.', 'warning'); return;
          }
        }
      } catch (_) { /* Show uncertain outcome; never create a second version here. */ }
      setStatus('Publication outcome could not be confirmed. Load → Last saved and inspect the latest published version before deciding whether to publish again.', 'error');
    } else reportError(error,'Publish and Deliver');
  }
}
async function deliverPackage(confirm = true) {
  const releaseId = state.current?.releaseId;
  if(!releaseId) return;
  if(confirm && !window.confirm(`Request delivery of ${releaseId}? The running package changes only on Tab5 restart.`)) return;
  try {
    setStatus(`Requesting delivery of ${releaseId}…`);
    const result = await api('POST',{action:'deliver',releaseId});
    showPublished(result.current || state.current);
    setStatus(`Delivery requested for ${releaseId}. Awaiting Tab5 staging confirmation; restart adoption remains separate.`, 'ok');
    await refreshDeviceStatus();
  } catch(error) {
    if(error.body?.errors) showFindings(error.body);
    setStatus(`Version ${state.current.packageVersion} remains published. Delivery was not confirmed. ${deliveryErrorText(error)} Retry delivery uses this same version.`, 'error');
  }
}
function downloadRuntime() {
  if (!state.runtimePackage) return;
  const blob = new Blob([`${JSON.stringify(state.runtimePackage, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${state.runtimePackage.releaseId || "rules-engine-runtime-preview"}.json`; link.click(); URL.revokeObjectURL(link.href);
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

// Checkpoint 1 V3 editor layer. The device and calculation editors above are
// retained; these definitions replace only V2 event capture/rendering.
function occurrenceFields(source) { return (state.draft.systemFields || []).filter(field => field.source === source); }
function typedValue(target, raw) { return parseClauseValue(raw, fieldByName(target), "eq"); }
function defaultV3Clause() {
  const field = directFields().find(item => item.type === "number" || item.type === "integer") || directFields()[0] || allFields()[0];
  if (!field) return { field: "", operator: "eq", value: "" };
  const operator = (state.capabilities.operators[field.type] || ["eq"])[0];
  return { field: field.systemName, operator, value: operator === "occurs" ? null : field.type === "boolean" ? true : field.type === "number" || field.type === "integer" ? 0 : "" };
}
function v3ConditionHtml(prefix, condition, qualified = true) {
  const rows = (condition?.clauses || []).map((clause, index) => `<div class="condition-row v3-${prefix}-clause"><select data-key="field">${fieldOptions(clause.field)}</select><select data-key="operator">${operatorOptions(clause.field, clause.operator)}</select><input data-key="value" value="${escapeHtml(valueText(clause))}"><button type="button" class="row-delete" data-v3-remove-clause="${prefix}:${index}">×</button></div>`).join("");
  const qualification = qualified ? `<label>Observations<input id="v3-${prefix}-count" type="number" min="1" value="${condition?.observationCount ?? 1}"></label><label>Minimum seconds<input id="v3-${prefix}-seconds" type="number" min="0" value="${condition?.minimumSeconds ?? 0}"></label>` : "";
  return `<div class="condition-controls"><label>Combine<select id="v3-${prefix}-mode"><option value="all"${condition?.mode === "all" ? " selected" : ""}>ALL</option><option value="any"${condition?.mode === "any" ? " selected" : ""}>ANY</option></select></label>${qualification}</div><div>${rows}</div><button type="button" class="secondary-button compact-button" data-v3-add-clause="${prefix}">Add condition</button>`;
}
function captureV3Condition(prefix) {
  const condition = { mode: document.querySelector(`#v3-${prefix}-mode`).value, clauses: [...editor.querySelectorAll(`.v3-${prefix}-clause`)].map(row => { const field = row.querySelector("[data-key=field]").value; const operator = row.querySelector("[data-key=operator]").value; return { field, operator, value: parseClauseValue(row.querySelector("[data-key=value]").value, fieldByName(field), operator) }; }) };
  const count = document.querySelector(`#v3-${prefix}-count`);
  if (count) {
    condition.observationCount = Number(count.value);
    condition.minimumSeconds = Number(document.querySelector(`#v3-${prefix}-seconds`).value);
  }
  return condition;
}
function assignmentHtml(assignment, phase, index, group = null) {
  return `<div class="event-action-row condition-row"><select data-key="target">${writableFields().map(field => optionHtml(field, assignment.target)).join("")}</select><input data-key="value" value="${escapeHtml(String(assignment.value))}"><select data-key="ownership"><option value="transition"${assignment.ownership === "transition" ? " selected" : ""}>transition</option><option value="whileOpen"${assignment.ownership === "whileOpen" ? " selected" : ""}>while open</option></select><button type="button" class="row-delete" data-v3-remove-assignment="${phase}:${group ?? "plain"}:${index}">×</button></div>`;
}
function phaseHtml(name, phase) {
  const plain = (phase.assignments || []).map((item, index) => assignmentHtml(item, name, index)).join("");
  const groups = (phase.guardedGroups || []).map((group, groupIndex) => `<details class="field-action-mapping"><summary>Guarded group ${groupIndex + 1}</summary>${v3ConditionHtml(`guard-${name}-${groupIndex}`, group.guard, false)}<div>${group.assignments.map((item, index) => assignmentHtml(item, name, index, groupIndex)).join("")}</div><button type="button" class="secondary-button compact-button" data-v3-add-assignment="${name}:${groupIndex}">Add guarded assignment</button><button type="button" class="secondary-button compact-button danger-button" data-v3-remove-group="${name}:${groupIndex}">Remove group</button></details>`).join("");
  return `<section><div class="subsection-heading"><div><p class="kicker">${escapeHtml(name.toUpperCase())}</p><h2>Assignments and guards</h2></div><button type="button" class="secondary-button compact-button" data-v3-add-assignment="${name}:plain">Add assignment</button><button type="button" class="secondary-button compact-button" data-v3-add-group="${name}">Add guarded group</button></div>${plain || "<p class='form-help'>No unconditional assignment.</p>"}${groups}</section>`;
}
function capturePhase(name) {
  const plain = [...editor.querySelectorAll(`[data-v3-remove-assignment^="${name}:plain:"]`)].map(button => { const row = button.closest(".event-action-row"); const target = row.querySelector("[data-key=target]").value; return { target, value: typedValue(target, row.querySelector("[data-key=value]").value), ownership: row.querySelector("[data-key=ownership]").value }; });
  const groups = [...editor.querySelectorAll(`[data-v3-remove-group^="${name}:"]`)].map(button => { const groupIndex = button.dataset.v3RemoveGroup.split(":")[1]; const holder = button.closest("details"); const assignments = [...holder.querySelectorAll(`[data-v3-remove-assignment^="${name}:${groupIndex}:"]`)].map(action => { const row = action.closest(".event-action-row"); const target = row.querySelector("[data-key=target]").value; return { target, value: typedValue(target, row.querySelector("[data-key=value]").value), ownership: row.querySelector("[data-key=ownership]").value }; }); const capturedGuard = captureV3Condition(`guard-${name}-${groupIndex}`); return { guard: { mode: capturedGuard.mode, clauses: capturedGuard.clauses }, assignments }; });
  return { assignments: plain, guardedGroups: groups };
}
function renderSystemField() {
  const field = state.draft.systemFields[state.selected.systemFields]; if (!field) { editor.innerHTML = "<p class='empty-editor'>Add a system field to begin.</p>"; return; }
  const session = field.source === "session";
  const operatingMode = session && field.runtimeRole === "operatingMode";
  const enumValues = field.type === "enum" ? `<label>Enum choices<input id="sf-enum" value="${escapeHtml((field.enumValues || []).join(", "))}"${operatingMode ? " readonly" : ""}></label>` : "";
  const loggingControl = `<label>Logging<select id="sf-log">${logModeOptions(field.logging?.mode)}</select></label>${field.logging?.mode === "delta" ? `<label>Delta threshold<input id="sf-log-threshold" type="number" min="0" step="any" value="${escapeHtml(String(field.logging.threshold ?? ""))}"></label>` : ""}`;
  const workingInitial = field.type === "boolean"
    ? `<label>Startup value<select id="sf-initial"><option value="false"${field.initialValue === false ? " selected" : ""}>false</option><option value="true"${field.initialValue === true ? " selected" : ""}>true</option></select></label>`
    : `<label>Startup value<input id="sf-initial" value="${escapeHtml(String(field.initialValue ?? ""))}"></label>`;
  const sessionControls = operatingMode
    ? `<div class="form-grid compact-form"><label>Role<input value="operatingMode" readonly></label><label>Type<input value="enum" readonly></label>${enumValues}<label>Startup value<input id="sf-initial" value="Normal" readonly></label>${loggingControl}<label class="switch-label"><input id="sf-assignment" type="checkbox" checked disabled> Assignment target</label></div><p class="form-help">OperatingMode is the required Normal / Monitor state. It is not device telemetry.</p>`
    : `<div class="form-grid compact-form"><label>Role<input value="working" readonly></label><label>Type<select id="sf-type"><option value="number"${field.type === "number" ? " selected" : ""}>number</option><option value="integer"${field.type === "integer" ? " selected" : ""}>integer</option><option value="boolean"${field.type === "boolean" ? " selected" : ""}>Boolean</option><option value="enum"${field.type === "enum" ? " selected" : ""}>enum</option></select></label>${enumValues}${workingInitial}${loggingControl}<label class="switch-label"><input id="sf-assignment" type="checkbox"${field.assignmentTarget ? " checked" : ""}> Assignment target</label></div><p class="form-help">Working fields are session/RAM state, not device telemetry. They may be used in event conditions and become action targets only when enabled above.</p>`;
  editor.innerHTML = `<div class="engine-editor-heading"><div><p class="kicker">SYSTEM FIELD</p><h2>${escapeHtml(field.label)}</h2></div><button class="secondary-button compact-button danger-button" id="remove-item" type="button">Remove</button></div><div class="form-grid compact-form"><label>ID<input id="sf-id" value="${escapeHtml(field.id)}"></label><label>System name<input id="sf-name" value="${escapeHtml(field.systemName)}"></label><label>Label<input id="sf-label" value="${escapeHtml(field.label)}"></label><label>Source<select id="sf-source"><option value="session"${session ? " selected" : ""}>session working state</option><option value="manualOccurrence"${field.source === "manualOccurrence" ? " selected" : ""}>manual occurrence</option><option value="internalOccurrence"${field.source === "internalOccurrence" ? " selected" : ""}>internal occurrence</option></select></label></div>${session ? sessionControls : `<div class="form-grid compact-form"><label>Role<input value="occurrence" readonly></label><label>Occurrence key<input id="sf-occurrence" value="${escapeHtml(field.occurrenceKey || "")}"></label><label>Logging<select id="sf-log">${logModeOptions(field.logging?.mode)}</select></label><p class="form-help">Occurrence definitions name runtime signals; they are not persistent working values or device telemetry.</p></div>`}`;
}
function typedWorkingInitial(type, raw, enumValues = []) {
  if (type === "boolean") return raw === "true";
  if (type === "number" || type === "integer") return Number(raw);
  return raw.trim() || enumValues[0] || "";
}
function captureSystemField(displayedSource = state.draft.systemFields[state.selected.systemFields]?.source) {
  const index = state.selected.systemFields; const field = state.draft.systemFields[index]; if (!field || !document.querySelector("#sf-id")) return;
  const logMode = document.querySelector("#sf-log").value;
  const common = { id: document.querySelector("#sf-id").value.trim(), systemName: document.querySelector("#sf-name").value.trim(), label: document.querySelector("#sf-label").value.trim(), source: displayedSource, unit: field.unit ?? null, logging: logMode === "delta" ? { mode: logMode, threshold: Number(document.querySelector("#sf-log-threshold")?.value) } : { mode: logMode } };
  if (displayedSource !== "session") {
    state.draft.systemFields[index] = { ...common, runtimeRole: "occurrence", type: "signal", occurrenceKey: document.querySelector("#sf-occurrence").value.trim() };
    return;
  }
  if (field.runtimeRole === "operatingMode") {
    state.draft.systemFields[index] = { ...common, runtimeRole: "operatingMode", type: "enum", enumValues: ["Normal", "Monitor"], initialValue: "Normal", assignmentTarget: true };
    return;
  }
  const type = document.querySelector("#sf-type").value;
  const enumValues = type === "enum" ? document.querySelector("#sf-enum").value.split(",").map(value => value.trim()).filter(Boolean) : null;
  state.draft.systemFields[index] = { ...common, runtimeRole: "working", type, ...(enumValues ? { enumValues } : {}), initialValue: typedWorkingInitial(type, document.querySelector("#sf-initial").value, enumValues || []), assignmentTarget: document.querySelector("#sf-assignment").checked };
}
function normalizeSystemFieldSource(index, source) {
  const field = state.draft.systemFields[index];
  const common = { id: field.id, systemName: field.systemName, label: field.label, source, unit: null, logging: field.logging || { mode: "none" } };
  if (source === "session") {
    state.draft.systemFields[index] = field.runtimeRole === "operatingMode"
      ? { ...common, runtimeRole: "operatingMode", type: "enum", enumValues: ["Normal", "Monitor"], initialValue: "Normal", assignmentTarget: true }
      : { ...common, runtimeRole: "working", type: "boolean", initialValue: false, assignmentTarget: false };
    return;
  }
  state.draft.systemFields[index] = { ...common, runtimeRole: "occurrence", type: "signal", occurrenceKey: field.occurrenceKey || "newOccurrence" };
}
function workingFieldWithType(field, type) {
  const common = { id: field.id, systemName: field.systemName, label: field.label, source: "session", runtimeRole: "working", type, unit: null, logging: field.logging || { mode: "none" }, assignmentTarget: Boolean(field.assignmentTarget) };
  const initialValue = type === "boolean" ? false : type === "integer" || type === "number" ? 0 : "ChoiceA";
  return { ...common, ...(type === "enum" ? { enumValues: ["ChoiceA", "ChoiceB"] } : {}), initialValue };
}
function normalizeWorkingFieldType(index, type) {
  state.draft.systemFields[index] = workingFieldWithType(state.draft.systemFields[index], type);
}
function systemFieldWithLogging(field, mode) {
  const threshold = field.logging?.mode === "delta" && Number.isFinite(field.logging.threshold) && field.logging.threshold > 0 ? field.logging.threshold : 1;
  return { ...field, logging: mode === "delta" ? { mode, threshold } : { mode } };
}
function normalizeSystemFieldLogging(index, mode) {
  state.draft.systemFields[index] = systemFieldWithLogging(state.draft.systemFields[index], mode);
}
function renderEvent() {
  const event = state.draft.events[state.selected.events]; if (!event) { editor.innerHTML = "<p class='empty-editor'>Add an event to begin.</p>"; return; }
  const trigger = event.opening.trigger; const isCondition = trigger.type === "condition"; const openBody = isCondition ? v3ConditionHtml("open", trigger.condition) : `<div class="condition-controls"><label>Occurrence<select id="v3-occurrence">${occurrenceFields(trigger.type === "manual" ? "manualOccurrence" : "internalOccurrence").map(field => optionHtml(field, trigger.occurrenceField)).join("")}</select></label><label>Observations<input id="v3-open-count" type="number" min="1" value="${trigger.qualification.observationCount}"></label><label>Minimum seconds<input id="v3-open-seconds" type="number" min="0" value="${trigger.qualification.minimumSeconds}"></label></div>`; const close = event.closing.policy === "condition" ? v3ConditionHtml("close", event.closing.condition) : "<p class='form-help'>This policy has no closing condition.</p>";
  const web = event.web || { notifyOnOpen: false, notifyOnClose: false, openMessage: "", closeMessage: "" };
  editor.innerHTML = `<div class="engine-editor-heading"><div><p class="kicker">V3 EVENT DEFINITION</p><h2>${escapeHtml(event.displayName)}</h2></div><div class="inline-switches"><label class="switch-label"><input id="event-enabled" type="checkbox"${event.enabled ? " checked" : ""}> Enabled</label><button class="secondary-button compact-button danger-button" id="remove-item" type="button">Remove</button></div></div><div class="form-grid compact-form"><label>ID<input id="event-id" value="${escapeHtml(event.id)}"></label><label>System name<input id="event-system-name" value="${escapeHtml(event.systemName)}"></label><label>Display name<input id="event-display-name" value="${escapeHtml(event.displayName)}"></label><label>Severity<select id="event-severity"><option${event.severity === "Info" ? " selected" : ""}>Info</option><option${event.severity === "Yellow" ? " selected" : ""}>Yellow</option><option${event.severity === "Red" ? " selected" : ""}>Red</option></select></label><label>Class<select id="v3-class"><option value="transient"${event.eventClass === "transient" ? " selected" : ""}>transient</option><option value="latched"${event.eventClass === "latched" ? " selected" : ""}>latched</option><option value="monitor"${event.eventClass === "monitor" ? " selected" : ""}>Monitor</option></select></label></div><div class="event-condition-grid"><section><div class="subsection-heading"><div><p class="kicker">OPENING</p><h2>Trigger and qualification</h2></div></div><label>Trigger<select id="v3-trigger"><option value="condition"${isCondition ? " selected" : ""}>condition</option><option value="manual"${trigger.type === "manual" ? " selected" : ""}>manual occurrence</option><option value="internal"${trigger.type === "internal" ? " selected" : ""}>internal occurrence</option></select></label>${openBody}</section><section><div class="subsection-heading"><div><p class="kicker">CLOSING</p><h2>Policy</h2></div></div><label>Policy<select id="v3-close-policy"><option value="condition"${event.closing.policy === "condition" ? " selected" : ""}>condition</option><option value="clearEvents"${event.closing.policy === "clearEvents" ? " selected" : ""}>Clear Events</option><option value="immediate"${event.closing.policy === "immediate" ? " selected" : ""}>immediate</option></select></label>${close}</section></div><div class="event-lower-grid">${phaseHtml("onOpen", event.onOpen)}${phaseHtml("onClose", event.onClose)}</div><section class="event-summary-section"><div class="subsection-heading"><div><p class="kicker">SUMMARY</p><h2>Closing summary values — not supported by Tab5 yet</h2></div><button class="secondary-button compact-button" id="add-summary-row" type="button">Add summary value</button></div>${summaryHtml(event.summary)}</section><section><p class="kicker">AUTHORING NOTIFICATIONS</p><div class="inline-switches"><label class="switch-label"><input id="notify-open" type="checkbox"${web.notifyOnOpen ? " checked" : ""}> Notify on open</label><label class="switch-label"><input id="notify-close" type="checkbox"${web.notifyOnClose ? " checked" : ""}> Notify on close</label></div><label>Open message<textarea id="open-message">${escapeHtml(web.openMessage)}</textarea></label><label>Close message<textarea id="close-message">${escapeHtml(web.closeMessage)}</textarea></label><p class="form-help">Opening and closing conditions are independent. Occurrence and Clear Events inputs are not yet connected; notification settings are authoring only.</p></section>`;
}
function captureEvent(displayedTriggerType, displayedClosingPolicy) {
  const event = state.draft.events[state.selected.events];
  if (!event || !document.querySelector("#v3-class")) return;
  const triggerType = displayedTriggerType || event.opening.trigger.type;
  const closingPolicy = displayedClosingPolicy || event.closing.policy;
  event.id = document.querySelector("#event-id").value.trim();
  event.systemName = document.querySelector("#event-system-name").value.trim();
  event.displayName = document.querySelector("#event-display-name").value.trim();
  event.severity = document.querySelector("#event-severity").value;
  event.enabled = document.querySelector("#event-enabled").checked;
  event.eventClass = document.querySelector("#v3-class").value;
  event.opening = { trigger: triggerType === "condition" ? { type: triggerType, condition: captureV3Condition("open") } : { type: triggerType, occurrenceField: document.querySelector("#v3-occurrence").value, qualification: { observationCount: Number(document.querySelector("#v3-open-count").value), minimumSeconds: Number(document.querySelector("#v3-open-seconds").value) } } };
  event.closing = closingPolicy === "condition" ? { policy: closingPolicy, condition: captureV3Condition("close") } : { policy: closingPolicy };
  event.onOpen = capturePhase("onOpen");
  event.onClose = capturePhase("onClose");
  event.summary = { durationOutput: document.querySelector("#summary-duration-enabled").checked ? { systemName: document.querySelector("#summary-duration-name").value.trim(), label: document.querySelector("#summary-duration-label").value.trim(), type: event.summary.durationOutput?.type || "number", unit: "s", logging: clone(event.summary.durationOutput?.logging || { mode: "none" }) } : null, aggregates: [...editor.querySelectorAll(".summary-row")].map((row, index) => ({ source: row.querySelector("[data-key=source]").value, operation: row.querySelector("[data-key=operation]").value, scale: Number(row.querySelector("[data-key=scale]").value), output: { systemName: row.querySelector("[data-key=systemName]").value.trim(), label: row.querySelector("[data-key=label]").value.trim(), type: event.summary.aggregates[index]?.output.type || "number", unit: row.querySelector("[data-key=unit]").value.trim() || null, logging: clone(event.summary.aggregates[index]?.output.logging || { mode: "none" }) } })) };
  event.web = { notifyOnOpen: document.querySelector("#notify-open").checked, notifyOnClose: document.querySelector("#notify-close").checked, openMessage: document.querySelector("#open-message").value.trim(), closeMessage: document.querySelector("#close-message").value.trim() };
}
function setEventTrigger(event, type) {
  if (type === "condition") event.opening = { trigger: { type, condition: { mode: "all", clauses: [defaultV3Clause()], observationCount: 1, minimumSeconds: 0 } } };
  else {
    const source = type === "manual" ? "manualOccurrence" : "internalOccurrence";
    event.opening = { trigger: { type, occurrenceField: occurrenceFields(source)[0]?.systemName || "", qualification: { observationCount: 1, minimumSeconds: 0 } } };
  }
}
function setEventClosingPolicy(event, policy) {
  event.closing = policy === "condition" ? { policy, condition: { mode: "all", clauses: [defaultV3Clause()], observationCount: 1, minimumSeconds: 0 } } : { policy };
}
function captureCurrent() { if (!state.draft || !state.formDirty) return; state.formDirty = false; if (state.section === "devices") captureDevice(); else if (state.section === "calculatedFields") captureCalculation(); else if (state.section === "systemFields") captureSystemField(); else captureEvent(); }
function renderEditor() { const [kicker, title] = sectionLabels[state.section]; document.querySelector("#browser-kicker").textContent = kicker; document.querySelector("#browser-title").textContent = title; document.querySelectorAll(".engine-tile").forEach(button => button.classList.toggle("active", button.dataset.section === state.section)); renderList(); if (state.section === "devices") renderDevice(); else if (state.section === "calculatedFields") renderCalculation(); else if (state.section === "systemFields") renderSystemField(); else renderEvent(); }
function uniqueName(base, existing) { let name=base,n=2; while(existing.includes(name)) name=`${base}${n++}`; return name; }
function addItem() {
  captureCurrent();
  if (state.section === "devices") state.draft.devices.push({ id: `device-${state.draft.devices.length + 1}`, label: "New device", driver: "", address: "", enabled: false, fields: [] });
  else if (state.section === "calculatedFields") state.draft.calculatedFields.push({ id: `calculation-${state.draft.calculatedFields.length + 1}`, label: "New calculated value", kind: "expression", expression: "PumpWatts", output: { systemName: uniqueName("CalculatedValue",allFields().map(f=>f.systemName)), label: "Calculated value", type: "number", unit: null, logging: { mode: "delta", threshold: 1 } } });
  else if (state.section === "systemFields") state.draft.systemFields.push({ id: uniqueName("system-field",state.draft.systemFields.map(f=>f.id)), systemName: uniqueName("SystemField",allFields().map(f=>f.systemName)), label: "System field", source: "session", runtimeRole: "working", type: "boolean", unit: null, initialValue: false, logging: { mode: "none" }, assignmentTarget: false });
  else { const clause = defaultV3Clause(); state.draft.events.push({ id: uniqueName("E100", state.draft.events.map(e=>e.id)), systemName: uniqueName("NewEvent",state.draft.events.map(e=>e.systemName)), displayName: "New event", enabled: false, severity: "Info", eventClass: "transient", opening: { trigger: { type: "condition", condition: { mode: "all", clauses: [clause], observationCount: 1, minimumSeconds: 0 } } }, closing: { policy: "condition", condition: { mode: "all", clauses: [clone(clause)], observationCount: 1, minimumSeconds: 0 } }, onOpen: { assignments: [], guardedGroups: [] }, onClose: { assignments: [], guardedGroups: [] }, summary: { durationOutput: null, aggregates: [] }, web: { notifyOnOpen: false, notifyOnClose: false, openMessage: "", closeMessage: "" } }); }
  state.selected[state.section] = state.draft[state.section].length - 1; markDirty(); updateCounts(); renderEditor();
}


function syncButtons() {
  document.querySelector('#engine-validate').disabled = !state.draft;
  document.querySelector('#engine-publish').disabled = !state.draft;
  document.querySelector('#engine-backup').disabled = !state.draft;
  document.querySelector('#engine-save').disabled = !state.dirty.size;
  document.querySelector('#engine-download').disabled = !state.runtimePackage;
  deliverButton.disabled = !state.current;
}
async function runBusy(operation) {
  if(state.busy) return;
  state.busy = true;
  const main = document.querySelector('main'), dialog = document.querySelector('#load-dialog'); main.inert = true; dialog.inert = true;
  try { await operation(); } catch(error) {reportError(error,'Operation');if(document.querySelector('#load-dialog').open) document.querySelector('#load-error').textContent=statusBox.textContent;}
  finally {main.inert = false; dialog.inert = false; state.busy = false; syncButtons();}
}
function downloadBackup() {
  captureCurrent();
  const value = {kind:'well-pump-rules-authoring-backup',backupVersion:1,authoringPackage:authoringDraft()};
  const link = document.createElement('a'); link.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'}));
  link.download=`well-pump-rules-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; link.click(); URL.revokeObjectURL(link.href);
}
async function refreshDeviceStatus() {
  const box=document.querySelector('#device-package-state');
  box.textContent='Checking the last Tab5 report…';
  const checked = () => `Checked ${new Date().toLocaleTimeString()}. `;
  try {
    const result=await api('GET',undefined,'?deviceStatus=1'); const d=result.deviceStatus;
    if(!d) {box.textContent=checked()+'No Tab5 report exists at the expected database path. Staged and running identities are unknown.';return;}
    const ref=x=>x ? `v${x.packageVersion} · ${x.releaseId} · SHA ${x.contentHash.slice(0,12)}` : 'Unavailable';
    box.textContent=checked()+`Last reported ${new Date(d.reportedAtMs).toLocaleString()} (not a live connection check). Running: ${ref(d.running)}. Desired: ${ref(d.desired)}. Staged for restart: ${ref(d.staged)}.${d.rejected ? ` Rejected: ${d.rejected.reason}.` : ''}`;
  } catch(error) {
    const messages = {
      tab5_status_timeout:'The database read timed out.',
      tab5_status_invalid:'A report exists but does not match the expected Tab5 report format.',
      tab5_status_configuration:'The server is missing valid database configuration.',
      tab5_status_denied:'The database denied the server permission to read the report.',
      tab5_status_read_failed:'The server could not read the database report.'
    };
    box.textContent=checked()+(messages[error.body?.code] || 'The status request failed.')+' Staged and running identities are unknown.';
  }
}
function navigateFinding(path) {
  const match=/^(devices|calculatedFields|systemFields|events)\[(\d+)\](.*)$/.exec(path);
  if(!match || !state.draft?.[match[1]]?.[Number(match[2])]) return;
  captureCurrent(); state.section=match[1];state.selected[state.section]=Number(match[2]);renderEditor();
  const tail=match[3]; let target=null;
  const simple={devices:{id:'device-id',label:'device-label',driver:'device-driver',address:'device-address'},calculatedFields:{id:'calculation-id',expression:'calculation-expression',kind:'calculation-kind'},systemFields:{id:'sf-id',systemName:'sf-name',label:'sf-label',type:'sf-type',initialValue:'sf-initial',enumValues:'sf-enum',source:'sf-source'},events:{id:'event-id',systemName:'event-system-name',displayName:'event-display-name',eventClass:'v3-class'}};
  const key=tail.split('.')[1]; if(simple[state.section][key]) target=document.getElementById(simple[state.section][key]);
  const field=/\.fields\[(\d+)\]\.(\w+)/.exec(tail);
  if(field) target=editor.querySelector(`.device-field-row[data-index="${field[1]}"] [data-key="${field[2]}"]`);
  const parameter=/\.parameters\.(\w+)/.exec(tail);
  if(parameter) target=editor.querySelector(`[data-calculation-parameter="${parameter[1]}"]`);
  const output=/\.(output|outputs\[(\d+)\])\.(\w+)/.exec(tail);
  if(output) target=editor.querySelectorAll('.calculation-output-row')[Number(output[2]||0)]?.querySelector(`[data-key="${output[3]}"]`);
  if(tail.includes('.summary.durationOutput')) target=document.querySelector(tail.endsWith('systemName')?'#summary-duration-name':'#summary-duration-enabled');
  const aggregate=/\.summary\.aggregates\[(\d+)\]/.exec(tail);
  if(aggregate) target=editor.querySelectorAll('.summary-row')[Number(aggregate[1])]?.querySelector('input,select');
  if(tail.includes('.closing.policy')) target=document.querySelector('#v3-close-policy');
  const qualifier=/\.(observationCount|minimumSeconds)$/.exec(tail);
  const prefix=tail.includes('.closing')?'close':'open';
  if(qualifier) target=document.querySelector(`#v3-${prefix}-${qualifier[1]==='observationCount'?'count':'seconds'}`);
  const clause=/\.clauses\[(\d+)\]\.(field|operator|value)/.exec(tail);
  if(clause) target=editor.querySelectorAll(`.v3-${prefix}-clause`)[Number(clause[1])]?.querySelector(`[data-key="${clause[2]}"]`);
  const phaseMatch=/\.(onOpen|onClose)(?:\.guardedGroups\[(\d+)\])?\.assignments\[(\d+)\](?:\.(target|value|ownership))?/.exec(tail);
  if(phaseMatch) {
    const button=editor.querySelector(`[data-v3-remove-assignment="${phaseMatch[1]}:${phaseMatch[2]??'plain'}:${phaseMatch[3]}"]`);
    target=button?.closest('.event-action-row')?.querySelector(`[data-key="${phaseMatch[4]||'target'}"]`);
  }
  const guard=/\.(onOpen|onClose)\.guardedGroups\[(\d+)\]\.guard\.clauses\[(\d+)\]\.(field|operator|value)/.exec(tail);
  if(guard) target=editor.querySelectorAll(`.v3-guard-${guard[1]}-${guard[2]}-clause`)[Number(guard[3])]?.querySelector(`[data-key="${guard[4]}"]`);
  target ||= editor; for(let el=target;el && el!==editor;el=el.parentElement) if(el.tagName==='DETAILS') el.open=true;
  target.scrollIntoView({block:'center'});target.setAttribute('tabindex','-1');target.focus();
}
editor.addEventListener('click',e=>{
  const button=e.target.closest('[data-relay-mapping]'); if(!button) return;
  const device=state.draft.devices[state.selected.devices];
  if(device.driver!=='shelly-gen4-switch') return setStatus('Relay mapping is available only for Shelly Gen4 switch.','warning');
  captureCurrent(); const field=device.fields[Number(button.dataset.relayMapping)];
  Object.assign(field,{object:'RLY(0)',type:'boolean',unit:null,access:'readWrite',write:{method:'Switch.Set',parameters:{id:0,valueParameter:'on'},normalValue:true}});
  delete field.enumValues;markDirty();renderEditor();
});
document.querySelector('#validation-findings').addEventListener('click',e=>{const b=e.target.closest('[data-finding-path]');if(b) navigateFinding(b.dataset.findingPath);});
document.querySelector('#engine-backup').addEventListener('click',downloadBackup);
document.querySelector('#backup-file').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';if(file) runBusy(()=>loadWorking('backup',file));});
document.querySelector('#load-backup').addEventListener('click',()=>document.querySelector('#backup-file').click());
document.querySelector('#load-saved').addEventListener('click',()=>runBusy(()=>loadWorking('saved')));
document.querySelector('#load-seed').addEventListener('click',()=>runBusy(()=>loadWorking('seed')));
document.querySelector('#load-published').addEventListener('click',()=>runBusy(()=>loadWorking('published')));
document.querySelector('#load-cancel').addEventListener('click',()=>document.querySelector('#load-dialog').close());
document.querySelector('#refresh-device-state').addEventListener('click',()=>runBusy(refreshDeviceStatus));
window.addEventListener('beforeunload',e=>{if(state.dirty.size){e.preventDefault();e.returnValue='';}});
document.querySelector("#engine-load").addEventListener("click", () => runBusy(openLoad));
document.querySelector("#engine-save").addEventListener("click", () => runBusy(async () => { try { const sections = await saveAll(); setStatus(`Saved ${sections.join(", ")} draft section(s).`, "ok"); } catch (error) { reportError(error,"Save"); } }));
document.querySelector("#engine-validate").addEventListener("click", () => runBusy(validatePackage));
document.querySelector("#engine-publish").addEventListener("click", () => runBusy(publishPackage));
document.querySelector("#engine-deliver").addEventListener("click", () => runBusy(deliverPackage));
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
  if (event.target.id === "calculation-kind") {
    captureCalculation(); const calculation = state.draft.calculatedFields[state.selected.calculatedFields]; normalizeCalculationKind(calculation, event.target.value); renderEditor(); return;
  }
  if (event.target.id === "calculation-function") {
    captureCalculation(); const calculation = state.draft.calculatedFields[state.selected.calculatedFields]; normalizeCalculationFunction(calculation, event.target.value); renderEditor(); return;
  }
  if (event.target.dataset.key === "access" || event.target.dataset.key === "logMode") {
    if (state.section === "devices") { captureDevice(); renderEditor(); return; }
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
  const summaryRemove = event.target.closest("[data-remove-summary]");
  if (summaryRemove) { captureEvent(); state.draft.events[state.selected.events].summary.aggregates.splice(Number(summaryRemove.dataset.removeSummary), 1); markDirty(); renderEditor(); return; }
  if (event.target.id === "add-summary-row") { captureEvent(); const source = allFields().find(field => field.type === "number" || field.type === "integer"); if (!source) return setStatus("No numeric direct or calculated field is defined.", "warning"); state.draft.events[state.selected.events].summary.aggregates.push({ source: source.systemName, operation: "end", scale: 1, output: { systemName: "EventSummaryValue", label: "Event summary value", type: "number", unit: source.unit || null, logging: { mode: "none" } } }); markDirty(); renderEditor(); return; }
});

// V3-only structural controls.  These change authoring definitions locally;
// final lifecycle, ownership, and type enforcement remains in the server contract.
editor.addEventListener("change", event => {
  if (!state.draft) return;
  if (event.target.id === "sf-source") {
    captureSystemField(state.draft.systemFields[state.selected.systemFields].source);
    normalizeSystemFieldSource(state.selected.systemFields, event.target.value);
    markDirty(); renderEditor(); return;
  }
  if (event.target.id === "sf-type") {
    const type = event.target.value;
    // The select already has the requested value, but the surrounding form is
    // still the old type's shape. Capture that rendered shape before changing
    // the model so Boolean-to-enum does not seek a missing enum control.
    event.target.value = state.draft.systemFields[state.selected.systemFields].type;
    captureSystemField("session");
    event.target.value = type;
    normalizeWorkingFieldType(state.selected.systemFields, type);
    markDirty(); renderEditor(); return;
  }
  if (event.target.id === "sf-log") {
    const mode = event.target.value;
    // As with type, preserve the old rendered logging controls first. A
    // non-delta form has no threshold element to capture yet.
    event.target.value = state.draft.systemFields[state.selected.systemFields].logging?.mode || "none";
    captureSystemField(state.draft.systemFields[state.selected.systemFields].source);
    event.target.value = mode;
    normalizeSystemFieldLogging(state.selected.systemFields, mode);
    markDirty(); renderEditor(); return;
  }
  if (event.target.id === "v3-trigger") {
    const definition = state.draft.events[state.selected.events];
    captureEvent(definition.opening.trigger.type, definition.closing.policy);
    setEventTrigger(definition, event.target.value);
    markDirty(); renderEditor(); return;
  }
  if (event.target.id === "v3-close-policy") {
    const definition = state.draft.events[state.selected.events];
    captureEvent(definition.opening.trigger.type, definition.closing.policy);
    setEventClosingPolicy(definition, event.target.value);
    markDirty(); renderEditor();
  }
});
editor.addEventListener("click", event => {
  const addClause = event.target.closest("[data-v3-add-clause]");
  const removeClause = event.target.closest("[data-v3-remove-clause]");
  const addAssignment = event.target.closest("[data-v3-add-assignment]");
  const removeAssignment = event.target.closest("[data-v3-remove-assignment]");
  const addGroup = event.target.closest("[data-v3-add-group]");
  const removeGroup = event.target.closest("[data-v3-remove-group]");
  if (!addClause && !removeClause && !addAssignment && !removeAssignment && !addGroup && !removeGroup) return;
  captureEvent();
  const eventDefinition = state.draft.events[state.selected.events];
  const clauseList = prefix => {
    if (prefix === "open") return eventDefinition.opening.trigger.condition.clauses;
    if (prefix === "close") return eventDefinition.closing.condition.clauses;
    const [, phase, groupIndex] = prefix.match(/^guard-(onOpen|onClose)-(\d+)$/) || [];
    return eventDefinition[phase].guardedGroups[Number(groupIndex)].guard.clauses;
  };
  const defaultAssignment = () => {
    const target = writableFields()[0];
    return target ? { target: target.systemName, value: target.type === "boolean" ? false : target.type === "number" || target.type === "integer" ? 0 : target.initialValue || target.enumValues?.[0] || "", ownership: "transition" } : null;
  };
  if (addClause) clauseList(addClause.dataset.v3AddClause).push(defaultV3Clause());
  if (removeClause) { const [prefix, index] = removeClause.dataset.v3RemoveClause.split(":"); clauseList(prefix).splice(Number(index), 1); }
  if (addAssignment) {
    const [phase, group] = addAssignment.dataset.v3AddAssignment.split(":"); const assignment = defaultAssignment();
    if (assignment) (group === "plain" ? eventDefinition[phase].assignments : eventDefinition[phase].guardedGroups[Number(group)].assignments).push(assignment);
    else setStatus("No writable device or assignment-target system field is defined.", "warning");
  }
  if (removeAssignment) {
    const [phase, group, index] = removeAssignment.dataset.v3RemoveAssignment.split(":");
    (group === "plain" ? eventDefinition[phase].assignments : eventDefinition[phase].guardedGroups[Number(group)].assignments).splice(Number(index), 1);
  }
  if (addGroup) {
    const assignment = defaultAssignment();
    eventDefinition[addGroup.dataset.v3AddGroup].guardedGroups.push({ guard: { mode: "all", clauses: [defaultV3Clause()] }, assignments: assignment ? [assignment] : [] });
    if (!assignment) setStatus("Add an assignment target before validating this guarded group.", "warning");
  }
  if (removeGroup) { const [phase, index] = removeGroup.dataset.v3RemoveGroup.split(":"); eventDefinition[phase].guardedGroups.splice(Number(index), 1); }
  markDirty(); renderEditor();
});
