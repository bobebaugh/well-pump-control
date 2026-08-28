"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ContractError,
  classifyPumpRunning,
  validatePowerTelemetry
} = require("./power-contract");

const valid = {
  schemaVersion: 1,
  deviceId: "shelly-em-well",
  observedAt: "2026-08-14T20:02:19.457Z",
  power: 2500,
  reactive: 10,
  pf: 0.98,
  voltage: 248,
  is_valid: true,
  total: 167704.8,
  total_returned: 0
};

test("normalizes Shelly EM fields and units", () => {
  const result = validatePowerTelemetry(valid, "shelly-em-well");
  assert.equal(result.values.powerW, 2500);
  assert.equal(result.values.voltageV, 248);
  assert.equal(result.values.totalWh, 167704.8);
  assert.equal(result.values.powerFactor, 0.98);
});

test("accepts a response without optional power factor", () => {
  const payload = { ...valid };
  delete payload.pf;
  const result = validatePowerTelemetry(payload, "shelly-em-well");
  assert.equal(result.values.powerFactor, undefined);
});

test("rejects a different device", () => {
  assert.throws(
    () => validatePowerTelemetry({ ...valid, deviceId: "other" }, "shelly-em-well"),
    error => error instanceof ContractError && error.code === "device_not_allowed"
  );
});

test("rejects invalid numeric and timestamp fields", () => {
  assert.throws(() => validatePowerTelemetry({ ...valid, power: "2500" }, "shelly-em-well"));
  assert.throws(() => validatePowerTelemetry({ ...valid, observedAt: "not-a-date" }, "shelly-em-well"));
});

test("uses hysteresis for pump state", () => {
  assert.equal(classifyPumpRunning(1500, false, 1000, 100), true);
  assert.equal(classifyPumpRunning(500, true, 1000, 100), true);
  assert.equal(classifyPumpRunning(50, true, 1000, 100), false);
  assert.equal(classifyPumpRunning(500, false, 1000, 100), false);
});
