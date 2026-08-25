"use strict";

const ORDERED_RULE_IDS = [
  ...Array.from({ length: 16 }, (_, index) => `P${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 9 }, (_, index) => `E${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 13 }, (_, index) => `T${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 21 }, (_, index) => `H${String(index + 1).padStart(3, "0")}`)
];
const REQUIRED_RULE_FIELDS = [
  "id", "event", "enabled", "level", "response", "confirmSeconds",
  "clearSeconds", "conditions", "notify", "commissioningStatus"
];
const OPTIONAL_RULE_FIELDS = ["scheduleContext", "operatingContext", "recoveryResetPolicy"];
const RULE_FIELDS = new Set([...REQUIRED_RULE_FIELDS, ...OPTIONAL_RULE_FIELDS]);
const LEVELS = new Set([null, "Yellow", "Red"]);
const RESPONSES = new Set([
  "Observe", "Alert", "Trip—while active", "Trip—recovery policy", "Trip—latched/manual reset"
]);

class RulesContractError extends Error {
  constructor(code, field) {
    super(code);
    this.name = "RulesContractError";
    this.code = code;
    this.field = field;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireValue(ok, code, field) {
  if (!ok) throw new RulesContractError(code, field);
}

function validateRule(rule, index) {
  const field = `rules[${index}]`;
  requireValue(isPlainObject(rule), "invalid_rule", field);
  const keys = Object.keys(rule);
  requireValue(keys.every(key => RULE_FIELDS.has(key)), "unexpected_rule_field", field);
  requireValue(REQUIRED_RULE_FIELDS.every(key => Object.hasOwn(rule, key)), "missing_rule_field", field);
  requireValue(rule.id === ORDERED_RULE_IDS[index], "rules_out_of_order", `${field}.id`);
  requireValue(typeof rule.event === "string" && rule.event.length > 0, "invalid_event", `${field}.event`);
  requireValue(typeof rule.enabled === "boolean", "invalid_enabled", `${field}.enabled`);
  requireValue(LEVELS.has(rule.level), "invalid_level", `${field}.level`);
  requireValue(RESPONSES.has(rule.response), "invalid_response", `${field}.response`);
  requireValue(Number.isInteger(rule.confirmSeconds) && rule.confirmSeconds >= 1, "invalid_confirm_seconds", `${field}.confirmSeconds`);
  requireValue(Number.isInteger(rule.clearSeconds) && rule.clearSeconds >= 1, "invalid_clear_seconds", `${field}.clearSeconds`);
  requireValue(isPlainObject(rule.conditions) && Object.keys(rule.conditions).length > 0, "invalid_conditions", `${field}.conditions`);
  requireValue(typeof rule.notify === "boolean", "invalid_notify", `${field}.notify`);
  requireValue(typeof rule.commissioningStatus === "string" && rule.commissioningStatus.length > 0, "invalid_commissioning_status", `${field}.commissioningStatus`);
  for (const optional of OPTIONAL_RULE_FIELDS) {
    requireValue(rule[optional] === undefined || typeof rule[optional] === "string", "invalid_optional_field", `${field}.${optional}`);
  }
}

function validateRules(rules) {
  requireValue(Array.isArray(rules) && rules.length === ORDERED_RULE_IDS.length, "invalid_rule_count", "rules");
  rules.forEach(validateRule);
  return rules;
}

function validatePackage(value) {
  requireValue(isPlainObject(value), "invalid_package", "body");
  const packageFields = new Set(["schemaVersion", "kind", "releaseId", "rulesVersion", "rulesSchemaVersion", "sourceWorkbook", "rules"]);
  requireValue(Object.keys(value).every(key => packageFields.has(key)) && Object.keys(value).length === packageFields.size, "invalid_package_fields", "body");
  requireValue(value.schemaVersion === 1, "invalid_schema_version", "schemaVersion");
  requireValue(value.kind === "well-pump-rules-release", "invalid_kind", "kind");
  requireValue(/^[0-9]{14}-rules-v[0-9]+$/.test(value.releaseId), "invalid_release_id", "releaseId");
  requireValue(Number.isInteger(value.rulesVersion) && value.rulesVersion >= 1, "invalid_rules_version", "rulesVersion");
  requireValue(value.rulesSchemaVersion === 1, "invalid_rules_schema_version", "rulesSchemaVersion");
  requireValue(value.sourceWorkbook === "well_pump_operational_rules_1.xlsx", "invalid_source_workbook", "sourceWorkbook");
  validateRules(value.rules);
  return value;
}

module.exports = { ORDERED_RULE_IDS, RulesContractError, validatePackage, validateRules };
