"use strict";

const FUNCTION_CATALOG = {
  boyle_tank: {
    label: "Boyle-law tank model",
    inputs: { pressure: ["number"] }, inputUnits: { pressure: "psi" },
    parameters: { effectiveTankGallons: "number", prechargeGaugePsi: "number", atmosphericPressurePsi: "number", regressionWindowSeconds: "number", minimumSamples: "number" },
    outputs: [
      { type: "number", unit: "gal" }, { type: "number", unit: "psi/min" },
      { type: "number", unit: "GPM" }, { type: "number", unit: "GPM" },
      { type: "enum", unit: null, enumValues: ["VALID", "INSUFFICIENT_HISTORY", "PRESSURE_INVALID", "SAMPLE_GAP", "TREND_UNRESOLVED", "TANK_MODEL_INVALID"] }
    ]
  }
};

const TYPE_OPERATORS = {
  number: ["lt", "lte", "gt", "gte", "between", "outside"],
  integer: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "outside", "changes"],
  boolean: ["eq", "neq", "changes_to"], enum: ["eq", "neq", "changes_from", "changes_to"], signal: ["occurs"]
};

const DEVICE_DRIVERS = {
  "shelly-gen1-em": "Shelly Gen1 EM HTTP",
  "shelly-gen4-switch": "Shelly Gen4 RPC switch/input/script",
  "tab5-runtime": "Tab5 local runtime"
};
const SUMMARY_OPERATIONS = { start: "Opening value", end: "Closing value", delta: "Closing minus opening", average: "Average while active", minimum: "Minimum while active", maximum: "Maximum while active" };
const noLog = { mode: "none" };
const deltaLog = threshold => ({ mode: "delta", threshold });
const changeLog = { mode: "change" };

const DEFAULT_DRAFT = {
  schemaVersion: 2,
  devices: [
    {
      id: "shelly-em-main", label: "Shelly EM", driver: "shelly-gen1-em", address: "192.168.50.141", enabled: true,
      fields: [
        { systemName: "PumpWatts", label: "Pump real power", object: "emeter/0.power", type: "number", unit: "W", access: "read", logging: deltaLog(10) },
        { systemName: "SupplyVoltage", label: "Supply voltage", object: "emeter/0.voltage", type: "number", unit: "V", access: "read", logging: deltaLog(2) },
        { systemName: "PowerFactor", label: "Power factor", object: "emeter/0.pf", type: "number", unit: null, access: "read", logging: deltaLog(0.05) },
        { systemName: "ShellyEnergyWh", label: "Shelly cumulative energy", object: "emeter/0.total", type: "number", unit: "Wh", access: "read", logging: noLog },
        { systemName: "ShellyEMAvailable", label: "Shelly EM available", object: "$availability", type: "boolean", unit: null, access: "read", logging: changeLog }
      ]
    },
    {
      id: "shelly-1-main", label: "Shelly 1 Gen4", driver: "shelly-gen4-switch", address: "192.168.50.201", enabled: true,
      fields: [
        { systemName: "PumpEnable", label: "Pump enable", object: "SW(0)", type: "boolean", unit: null, access: "readWrite", logging: changeLog, write: { method: "Switch.Set", parameters: { id: 0, valueParameter: "on" }, normalValue: true } },
        { systemName: "ContactorFlag", label: "Contactor flag", object: "IN(0)", type: "boolean", unit: null, access: "read", logging: changeLog },
        { systemName: "IsLocked", label: "Shelly script lock remaining", object: "UDF(IsLocked)", type: "integer", unit: "s", access: "read", logging: deltaLog(10) },
        { systemName: "Shelly1Available", label: "Shelly 1 available", object: "$availability", type: "boolean", unit: null, access: "read", logging: changeLog }
      ]
    },
    {
      id: "tab5-main", label: "Tab5", driver: "tab5-runtime", address: "local", enabled: true,
      fields: [
        { systemName: "PressureADCCounts", label: "Pressure ADC count", object: "values.adc_raw", type: "integer", unit: "count", access: "read", logging: noLog },
        { systemName: "PressureSensorCommissioned", label: "Pressure sensor commissioned", object: "status.pressure_sensor_commissioned", type: "boolean", unit: null, access: "read", logging: changeLog },
        { systemName: "ADCValid", label: "ADC available", object: "status.adc_available", type: "boolean", unit: null, access: "read", logging: changeLog },
        { systemName: "ClockValid", label: "Clock synchronized", object: "status.clock_synced", type: "boolean", unit: null, access: "read", logging: changeLog },
        { systemName: "WiFiConnected", label: "Wi-Fi connected", object: "status.wifi_connected", type: "boolean", unit: null, access: "read", logging: changeLog },
        { systemName: "CloudAvailable", label: "Cloud delivery available", object: "status.cloud_available", type: "boolean", unit: null, access: "read", logging: changeLog },
        { systemName: "BatteryPercent", label: "Battery percent", object: "values.battery_percent", type: "number", unit: "%", access: "read", logging: deltaLog(1) },
        { systemName: "BufferUsedPercent", label: "RAM queue used", object: "status.buffer_used_pct", type: "number", unit: "%", access: "read", logging: deltaLog(5) },
        { systemName: "RecordsLost", label: "Records lost", object: "status.records_lost", type: "integer", unit: "count", access: "read", logging: changeLog }
      ]
    }
  ],
  calculatedFields: [
    { id: "calc-pressure", label: "Calibrated pressure", kind: "expression", expression: "(PressureADCCounts - 3812.27) / 209.97", output: { systemName: "PressurePSI", label: "Calibrated pressure", type: "number", unit: "psi", logging: deltaLog(2) } },
    { id: "calc-load-ratio", label: "Pump load ratio", kind: "expression", expression: "(PumpWatts / 2900) * 100", output: { systemName: "LoadRatioPercent", label: "Pump load ratio", type: "number", unit: "%", logging: deltaLog(5) } },
    {
      id: "calc-tank", label: "Main tank Boyle-law model", kind: "function", functionId: "boyle_tank", inputs: { pressure: "PressurePSI" },
      parameters: { effectiveTankGallons: 79.3, prechargeGaugePsi: 38, atmosphericPressurePsi: 13.07, regressionWindowSeconds: 10, minimumSamples: 8 },
      outputs: [
        { systemName: "TankWaterGallons", label: "Estimated tank water", type: "number", unit: "gal", logging: deltaLog(1) },
        { systemName: "PressureSlopePSIPerMinute", label: "Pressure slope", type: "number", unit: "psi/min", logging: deltaLog(0.5) },
        { systemName: "TankNetFlowGPM", label: "Estimated tank net flow", type: "number", unit: "GPM", logging: deltaLog(0.5) },
        { systemName: "PumpOffDemandGPM", label: "Estimated pump-off demand", type: "number", unit: "GPM", logging: deltaLog(0.5) },
        { systemName: "TankFlowQuality", label: "Tank flow quality", type: "enum", unit: null, enumValues: FUNCTION_CATALOG.boyle_tank.outputs[4].enumValues, logging: changeLog }
      ]
    }
  ],
  events: [
    {
      id: "EV-PUMP-RUN", systemName: "PumpRunning", displayName: "Pump running", enabled: false, severity: "Info", latched: false,
      open: { mode: "all", clauses: [{ field: "PumpWatts", operator: "gte", value: 1000 }], observationCount: 1, minimumSeconds: 0 }, close: { basis: "openingFalse", observationCount: 2, minimumSeconds: 2 },
      summary: { durationOutput: { systemName: "LastCycleRuntimeSeconds", label: "Last cycle runtime", type: "number", unit: "s", logging: noLog }, aggregates: [
        { source: "PumpWatts", operation: "average", scale: 1, output: { systemName: "LastCycleAverageWatts", label: "Last cycle average watts", type: "number", unit: "W", logging: noLog } },
        { source: "ShellyEnergyWh", operation: "delta", scale: 0.001, output: { systemName: "LastCycleEnergyKWh", label: "Last cycle energy", type: "number", unit: "kWh", logging: noLog } },
        { source: "PressurePSI", operation: "start", scale: 1, output: { systemName: "LastCycleStartPSI", label: "Last cycle starting pressure", type: "number", unit: "psi", logging: noLog } },
        { source: "PressurePSI", operation: "end", scale: 1, output: { systemName: "LastCycleEndPSI", label: "Last cycle ending pressure", type: "number", unit: "psi", logging: noLog } }
      ] }, actions: [], web: { notifyOnOpen: false, notifyOnClose: false, openMessage: "", closeMessage: "" }
    },
    {
      id: "EV-FAILED-START", systemName: "PumpFailedToStart", displayName: "Pump failed to start", enabled: false, severity: "Red", latched: false,
      open: { mode: "all", clauses: [{ field: "ContactorFlag", operator: "eq", value: true }, { field: "PumpEnable", operator: "eq", value: true }, { field: "PumpWatts", operator: "lt", value: 1000 }], observationCount: 5, minimumSeconds: 5 }, close: { basis: "openingFalse", observationCount: 1, minimumSeconds: 0 },
      summary: { durationOutput: null, aggregates: [] }, actions: [], web: { notifyOnOpen: true, notifyOnClose: false, openMessage: "Well pump demand was present but the pump did not start.", closeMessage: "" }
    },
    {
      id: "EV-HIGH-VOLTAGE", systemName: "UtilityVoltageHigh", displayName: "Utility voltage high", enabled: false, severity: "Red", latched: false,
      open: { mode: "all", clauses: [{ field: "SupplyVoltage", operator: "gte", value: 300 }, { field: "ShellyEMAvailable", operator: "eq", value: true }], observationCount: 3, minimumSeconds: 0 }, close: { basis: "custom", mode: "all", clauses: [{ field: "SupplyVoltage", operator: "lt", value: 265 }, { field: "ShellyEMAvailable", operator: "eq", value: true }], observationCount: 30, minimumSeconds: 0 },
      summary: { durationOutput: null, aggregates: [] }, actions: [{ target: "PumpEnable", value: false }], web: { notifyOnOpen: true, notifyOnClose: true, openMessage: "Well pump disabled after repeated high-voltage observations.", closeMessage: "Well pump high-voltage event cleared after sustained good voltage." }
    },
    {
      id: "EV-LONG-RUNTIME", systemName: "LongPumpRuntime", displayName: "Long pump runtime", enabled: false, severity: "Red", latched: true,
      open: { mode: "all", clauses: [{ field: "PumpWatts", operator: "gte", value: 1000 }], observationCount: 1, minimumSeconds: 360 }, close: { basis: "openingFalse", observationCount: 1, minimumSeconds: 0 },
      summary: { durationOutput: null, aggregates: [] }, actions: [{ target: "PumpEnable", value: false }], web: { notifyOnOpen: true, notifyOnClose: true, openMessage: "Well pump exceeded the configured runtime and was disabled.", closeMessage: "Long-runtime event cleared by the user after pump demand ended." }
    },
    {
      id: "EV-SHELLY-TIMED", systemName: "ShellyTimedLock", displayName: "Shelly timed lock", enabled: false, severity: "Red", latched: false,
      open: { mode: "all", clauses: [{ field: "IsLocked", operator: "gt", value: 1 }], observationCount: 1, minimumSeconds: 0 }, close: { basis: "custom", mode: "all", clauses: [{ field: "IsLocked", operator: "eq", value: 0 }], observationCount: 1, minimumSeconds: 0 },
      summary: { durationOutput: null, aggregates: [] }, actions: [], web: { notifyOnOpen: true, notifyOnClose: true, openMessage: "Well pump locked temporarily by Shelly-local protection.", closeMessage: "Shelly timed lock expired." }
    },
    {
      id: "EV-SHELLY-PERM", systemName: "ShellyPermanentLock", displayName: "Shelly permanent lock", enabled: false, severity: "Red", latched: false,
      open: { mode: "all", clauses: [{ field: "IsLocked", operator: "lt", value: 0 }], observationCount: 1, minimumSeconds: 0 }, close: { basis: "custom", mode: "all", clauses: [{ field: "IsLocked", operator: "eq", value: 0 }], observationCount: 1, minimumSeconds: 0 },
      summary: { durationOutput: null, aggregates: [] }, actions: [], web: { notifyOnOpen: true, notifyOnClose: true, openMessage: "Well pump locked by Shelly protection. Cycle well power to reset; remote override is unavailable.", closeMessage: "Shelly permanent lock cleared after well power restoration." }
    }
  ]
};

function defaults() { return structuredClone(DEFAULT_DRAFT); }
module.exports = { DEFAULT_DRAFT, DEVICE_DRIVERS, FUNCTION_CATALOG, SUMMARY_OPERATIONS, TYPE_OPERATORS, defaults };
