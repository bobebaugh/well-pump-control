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

  return {
    schemaVersion: 1,
    deviceId: payload.deviceId,
    observedAt: new Date(observedAtMs),
    values: normalized
  };
}

module.exports = {
  ContractError,
  validatePowerTelemetry
};
