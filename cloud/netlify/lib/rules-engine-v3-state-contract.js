"use strict";

const schema = require("../../../contracts/rules-v3-state-v1.schema.json");
const { schemaErrors } = require("./rules-engine-v3-release-contract");

class RulesEngineV3StateError extends Error {
  constructor(code) { super(code); this.name = "RulesEngineV3StateError"; this.code = code; }
}

function verifiedRulesV3State(value) {
  if (schemaErrors(schema, value).length !== 0) throw new RulesEngineV3StateError("rules_v3_state_invalid");
  if (value.deliveryEnabled === true && (value.delivery.releaseId !== value.releaseId || value.delivery.packageVersion !== value.packageVersion || value.delivery.contentHash !== value.contentHash || value.delivery.executionEnabled !== false)) {
    throw new RulesEngineV3StateError("rules_v3_state_identity_mismatch");
  }
  return value;
}

module.exports = { RulesEngineV3StateError, verifiedRulesV3State };
