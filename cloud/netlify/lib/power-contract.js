"use strict";

class ContractError extends Error {
  constructor(code, field) {
    super(code);
    this.name = "ContractError";
    this.code = code;
    this.field = field;
  }
}

function requireFiniteNumber(payload, field, minimum, maximum) {
  const value = payload[field];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ContractError("invalid_number", field);
  }

  if (value < minimum || value > maximum) {
    throw new ContractError("out_of_range", field);
  }

  return value;
}

function requireObject(payload, field) {
  const value = payload[field];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError("invalid_object", field);
  }

  return value;
}

function validateObservation(payload, observedAtMs) {
  if (payload.observation === undefined) {
    return undefined;
  }

  const observation = requireObject(payload, "observation");

  if (observation.schemaVersion !== 1) {
    throw new ContractError("unsupported_schema", "observation.schemaVersion");
  }

  if (!Number.isInteger(observation.sequence) || observation.sequence < 0) {
    throw new ContractError("invalid_number", "observation.sequence");
  }

  if (!Number.isInteger(observation.observedTicksMs) || observation.observedTicksMs < 0) {
    throw new ContractError("invalid_number", "observation.observedTicksMs");
  }

  const observationTimeMs = Date.parse(observation.observedAt);
  if (typeof observation.observedAt !== "string" || !Number.isFinite(observationTimeMs)) {
    throw new ContractError("invalid_timestamp", "observation.observedAt");
  }

  if (observationTimeMs !== observedAtMs) {
    throw new ContractError("inconsistent_value", "observation.observedAt");
  }

  if (observation.source !== "tab5") {
    throw new ContractError("invalid_value", "observation.source");
  }

  const values = requireObject(observation, "values");
  requireObject(observation, "status");

  for (const field of ["power", "reactive", "voltage", "is_valid", "total", "total_returned"]) {
    if (values[field] !== payload[field]) {
      throw new ContractError("inconsistent_value", `observation.values.${field}`);
    }
  }

  if (payload.pf !== undefined && values.pf !== payload.pf) {
    throw new ContractError("inconsistent_value", "observation.values.pf");
  }

  // Keep the original JSON object. Its required envelope and core values are
  // checked above; all optional present and future fields remain untouched.
  return observation;
}

function validatePowerTelemetry(payload, expectedDeviceId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ContractError("invalid_payload", "body");
  }

  if (payload.schemaVersion !== 1) {
    throw new ContractError("unsupported_schema", "schemaVersion");
  }

  if (payload.deviceId !== expectedDeviceId) {
    throw new ContractError("device_not_allowed", "deviceId");
  }

  const observedAtMs = Date.parse(payload.observedAt);

  if (typeof payload.observedAt !== "string" || !Number.isFinite(observedAtMs)) {
    throw new ContractError("invalid_timestamp", "observedAt");
  }

  if (typeof payload.is_valid !== "boolean") {
    throw new ContractError("invalid_boolean", "is_valid");
  }

  const normalized = {
    powerW: requireFiniteNumber(payload, "power", -100000, 100000),
    reactiveW: requireFiniteNumber(payload, "reactive", -100000, 100000),
    voltageV: requireFiniteNumber(payload, "voltage", 0, 500),
    isValid: payload.is_valid,
    totalWh: requireFiniteNumber(payload, "total", 0, Number.MAX_SAFE_INTEGER),
    totalReturnedWh: requireFiniteNumber(payload, "total_returned", 0, Number.MAX_SAFE_INTEGER)
  };

  if (payload.pf !== undefined) {
    normalized.powerFactor = requireFiniteNumber(payload, "pf", -1, 1);
  }

  const allowedReasons = new Set(["state-change", "heartbeat", "monitoring", "manual-test"]);
  const publishReason = payload.publishReason || "heartbeat";

  if (!allowedReasons.has(publishReason)) {
    throw new ContractError("invalid_value", "publishReason");
  }

  const observation = validateObservation(payload, observedAtMs);

  return {
    schemaVersion: 1,
    deviceId: payload.deviceId,
    observedAt: new Date(observedAtMs),
    publishReason,
    values: normalized,
    observation
  };
}

function classifyPumpRunning(powerW, previousRunning, startThresholdW, stopThresholdW) {
  if (previousRunning === true) {
    return powerW > stopThresholdW;
  }

  return powerW >= startThresholdW;
}

module.exports = {
  ContractError,
  classifyPumpRunning,
  validatePowerTelemetry
};
