"use strict";

const expectedIds = [
  ...Array.from({ length: 16 }, (_, i) => `P${String(i + 1).padStart(3, "0")}`),
  ...Array.from({ length: 9 }, (_, i) => `E${String(i + 1).padStart(3, "0")}`),
  ...Array.from({ length: 13 }, (_, i) => `T${String(i + 1).padStart(3, "0")}`),
  ...Array.from({ length: 21 }, (_, i) => `H${String(i + 1).padStart(3, "0")}`)
];
const responses = new Set(["Observe", "Alert", "Trip—while active", "Trip—recovery policy", "Trip—latched/manual reset"]);
const fields = {
  enabled: document.querySelector("#rule-enabled"), event: document.querySelector("#rule-event"),
  level: document.querySelector("#rule-level"), response: document.querySelector("#rule-response"),
  confirmSeconds: document.querySelector("#rule-confirm"), clearSeconds: document.querySelector("#rule-clear"),
  conditions: document.querySelector("#rule-conditions"), scheduleContext: document.querySelector("#rule-schedule"),
  operatingContext: document.querySelector("#rule-operating"), recoveryResetPolicy: document.querySelector("#rule-recovery"),
  commissioningStatus: document.querySelector("#rule-commissioning"), notify: document.querySelector("#rule-notify")
};
const statusBox = document.querySelector("#editor-status");
const workspace = document.querySelector("#rules-workspace");
const ruleList = document.querySelector("#rule-list");
const publishButton = document.querySelector("#publish-rules");
const downloadButton = document.querySelector("#download-draft");
let pointer = null;
let draft = [];
let baseline = [];
let selected = 0;
let changed = new Set();

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function setStatus(text, kind = "") { statusBox.className = `editor-status ${kind}`; statusBox.textContent = text; }
function key() { return sessionStorage.getItem("pilotMonitorKey"); }

async function api(method, payload) {
  let pilotKey = key();
  if (!pilotKey) pilotKey = window.prompt("Enter the pilot key");
  if (!pilotKey) throw new Error("cancelled");
  const response = await fetch("/.netlify/functions/rules-admin", {
    method, cache: "no-store",
    headers: { "Accept": "application/json", "Content-Type": "application/json", "X-Pilot-Key": pilotKey },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem("pilotMonitorKey");
    const error = new Error(body.code || `HTTP ${response.status}`); error.body = body; throw error;
  }
  sessionStorage.setItem("pilotMonitorKey", pilotKey);
  return body;
}

function validateRule(rule, index) {
  const errors = [];
  if (rule.id !== expectedIds[index]) errors.push(`${rule.id || `Row ${index + 1}`}: ID/order mismatch`);
  if (!rule.event || typeof rule.event !== "string") errors.push(`${rule.id}: event is required`);
  if (typeof rule.enabled !== "boolean") errors.push(`${rule.id}: enabled must be true or false`);
  if (![null, "Yellow", "Red"].includes(rule.level)) errors.push(`${rule.id}: invalid level`);
  if (!responses.has(rule.response)) errors.push(`${rule.id}: invalid response`);
  if (!Number.isInteger(rule.confirmSeconds) || rule.confirmSeconds < 1) errors.push(`${rule.id}: confirm seconds must be a positive whole number`);
  if (!Number.isInteger(rule.clearSeconds) || rule.clearSeconds < 1) errors.push(`${rule.id}: clear seconds must be a positive whole number`);
  if (!rule.conditions || typeof rule.conditions !== "object" || Array.isArray(rule.conditions) || !Object.keys(rule.conditions).length) errors.push(`${rule.id}: conditions must be a non-empty object`);
  if (!rule.commissioningStatus) errors.push(`${rule.id}: commissioning status is required`);
  return errors;
}

function validateDraft() {
  if (draft.length !== 59) return ["The draft must contain exactly 59 rules."];
  return draft.flatMap(validateRule);
}

function draftChanged(index) { return JSON.stringify(draft[index]) !== JSON.stringify(baseline[index]); }

function renderList() {
  const filter = document.querySelector("#rule-filter").value;
  ruleList.replaceChildren();
  draft.forEach((rule, index) => {
    const show = filter === "all" || rule.id.startsWith(filter) ||
      (filter === "enabled" && rule.enabled) || (filter === "changed" && changed.has(index));
    if (!show) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `rule-row${index === selected ? " selected" : ""}${changed.has(index) ? " changed" : ""}`;
    button.setAttribute("role", "option");
    const id = document.createElement("strong"); id.textContent = rule.id;
    const event = document.createElement("span"); event.textContent = rule.event;
    const state = document.createElement("i"); state.className = `rule-state ${rule.enabled ? "enabled" : ""}`; state.textContent = rule.enabled ? "ON" : "OFF";
    button.append(id, event, state);
    button.addEventListener("click", () => selectRule(index));
    ruleList.append(button);
  });
}

function loadForm() {
  const rule = draft[selected];
  document.querySelector("#rule-id").textContent = rule.id;
  for (const name of ["enabled", "notify"]) fields[name].checked = rule[name];
  fields.event.value = rule.event;
  fields.level.value = rule.level || "";
  fields.response.value = rule.response;
  fields.confirmSeconds.value = rule.confirmSeconds;
  fields.clearSeconds.value = rule.clearSeconds;
  fields.conditions.value = JSON.stringify(rule.conditions, null, 2);
  for (const name of ["scheduleContext", "operatingContext", "recoveryResetPolicy", "commissioningStatus"]) fields[name].value = rule[name] || "";
}

function formRule() {
  let conditions;
  try { conditions = JSON.parse(fields.conditions.value); } catch { throw new Error("Conditions must be valid JSON."); }
  const rule = {
    id: draft[selected].id, event: fields.event.value.trim(), enabled: fields.enabled.checked,
    level: fields.level.value || null, response: fields.response.value,
    confirmSeconds: Number(fields.confirmSeconds.value), clearSeconds: Number(fields.clearSeconds.value),
    conditions, notify: fields.notify.checked, commissioningStatus: fields.commissioningStatus.value.trim()
  };
  for (const name of ["scheduleContext", "operatingContext", "recoveryResetPolicy"]) {
    const value = fields[name].value.trim(); if (value) rule[name] = value;
  }
  const errors = validateRule(rule, selected);
  if (errors.length) throw new Error(errors.join(" "));
  return rule;
}

function applyForm() {
  draft[selected] = formRule();
  if (draftChanged(selected)) changed.add(selected); else changed.delete(selected);
  renderList();
  publishButton.disabled = changed.size === 0;
  downloadButton.disabled = false;
  setStatus(`${changed.size} changed rule${changed.size === 1 ? "" : "s"}; draft is valid.`, changed.size ? "warning" : "ok");
}

function selectRule(index) {
  try { applyForm(); } catch (error) { setStatus(error.message, "error"); return; }
  selected = index; renderList(); loadForm();
}

async function loadRules() {
  setStatus("Loading the published pointer and exact release…");
  try {
    const result = await api("GET");
    pointer = result.pointer; draft = clone(result.rulesPackage.rules); baseline = clone(draft);
    selected = 0; changed = new Set();
    document.querySelector("#release-name").textContent = `${pointer.releaseId} · version ${pointer.rulesVersion}`;
    document.querySelector("#release-hash").textContent = `SHA-256 ${pointer.contentHash}`;
    workspace.hidden = false; publishButton.disabled = true; downloadButton.disabled = false;
    renderList(); loadForm(); setStatus("All 59 published rules loaded and validated.", "ok");
  } catch (error) {
    if (error.message !== "cancelled") setStatus(`Could not load rules: ${error.body?.code || error.message}`, "error");
  }
}

function downloadDraft() {
  try { applyForm(); } catch (error) { setStatus(error.message, "error"); return; }
  const errors = validateDraft();
  if (errors.length) return setStatus(errors[0], "error");
  const packageDraft = { schemaVersion: 1, kind: "well-pump-rules-draft", basedOn: pointer, rules: draft };
  const blob = new Blob([`${JSON.stringify(packageDraft, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.download = `${pointer.releaseId}-draft.json`; link.click(); URL.revokeObjectURL(link.href);
}

async function publishRules() {
  try { applyForm(); } catch (error) { setStatus(error.message, "error"); return; }
  const errors = validateDraft();
  if (errors.length) return setStatus(errors[0], "error");
  if (!changed.size) return setStatus("Nothing has changed.", "warning");
  const confirmation = window.prompt(`This will publish ${changed.size} changed rule(s) for Tab5 adoption. Type PUBLISH to continue.`);
  if (confirmation !== "PUBLISH") return;
  publishButton.disabled = true; setStatus("Storing immutable release, then updating the live pointer…");
  try {
    const result = await api("POST", { baseContentHash: pointer.contentHash, rules: draft });
    pointer = result.pointer; baseline = clone(draft); changed.clear();
    document.querySelector("#release-name").textContent = `${pointer.releaseId} · version ${pointer.rulesVersion}`;
    document.querySelector("#release-hash").textContent = `SHA-256 ${pointer.contentHash}`;
    renderList(); setStatus(`Published ${pointer.releaseId}. Tab5 may now download and adopt it.`, "ok");
  } catch (error) {
    publishButton.disabled = false;
    setStatus(error.body?.code === "stale_draft" ? "The live pointer changed. Reload before publishing this draft." : `Publish failed: ${error.body?.code || error.message}`, "error");
  }
}

document.querySelector("#load-rules").addEventListener("click", loadRules);
document.querySelector("#download-draft").addEventListener("click", downloadDraft);
document.querySelector("#publish-rules").addEventListener("click", publishRules);
document.querySelector("#rule-filter").addEventListener("change", renderList);
document.querySelector("#rule-form").addEventListener("submit", event => { event.preventDefault(); try { applyForm(); } catch (error) { setStatus(error.message, "error"); } });
document.querySelector("#reset-rule").addEventListener("click", () => { draft[selected] = clone(baseline[selected]); changed.delete(selected); loadForm(); renderList(); publishButton.disabled = changed.size === 0; setStatus("Selected rule reset to the published value.", "ok"); });
