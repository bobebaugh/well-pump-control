"use strict";

const FUNCTION_CATALOG = {
  pump_state: {
    label: "Pump state from power",
    inputs: { power: ["number"] },
    inputUnits: { power: "W" },
    parameters: { runningAtWatts: "number", stoppedBelowWatts: "number" },
    outputs: [{ type: "enum", unit: null, enumValues: ["STOPPED", "RUNNING", "UNKNOWN"] }]
  },
  elapsed_state_seconds: {
    label: "Elapsed state time",
    inputs: { state: ["enum", "boolean"] },
    parameters: { activeValue: "scalar" },
    outputs: [{ type: "number", unit: "s" }]
  },
  pressure_linear: {
    label: "Calibrated pressure",
    inputs: { raw: ["number"] },
    inputUnits: { raw: "uV" },
    parameters: { slopePsiPerUnit: "number", interceptPsi: "number" },
    outputs: [{ type: "number", unit: "psi" }]
  },
  load_ratio: {
    label: "Load ratio",
    inputs: { power: ["number"] },
    inputUnits: { power: "W" },
    parameters: { baselineWatts: "number" },
    outputs: [{ type: "number", unit: "%" }]
  },
  rolling_transition_count: {
    label: "Transitions in a rolling window",
    inputs: { state: ["enum", "boolean"] },
    parameters: { fromValue: "scalar", toValue: "scalar", windowSeconds: "number" },
    outputs: [{ type: "integer", unit: "count" }]
  },
  least_squares_slope: {
    label: "Timestamped least-squares slope",
    inputs: { value: ["number"] },
    parameters: { windowSeconds: "number", minimumSamples: "number" },
    outputs: [{ type: "number", unit: "per_minute" }]
  },
  boyle_tank: {
    label: "Boyle-law tank model",
    inputs: { pressure: ["number"] },
    inputUnits: { pressure: "psi" },
    parameters: {
      effectiveTankGallons: "number", prechargeGaugePsi: "number",
      atmosphericPressurePsi: "number", regressionWindowSeconds: "number",
      minimumSamples: "number"
    },
    outputs: [
      { type: "number", unit: "gal" },
      { type: "number", unit: "psi/min" },
      { type: "number", unit: "GPM" },
      { type: "number", unit: "GPM" },
      { type: "enum", unit: null, enumValues: ["VALID", "INSUFFICIENT_HISTORY", "PRESSURE_INVALID", "SAMPLE_GAP", "TREND_UNRESOLVED", "TANK_MODEL_INVALID"] }
    ]
  },
  cycle_accumulator: {
    label: "Completed pump-cycle summary",
    inputs: { pumpState: ["enum"], power: ["number"], pressure: ["number"], tankFlow: ["number"] },
    inputUnits: { power: "W", pressure: "psi", tankFlow: "GPM" },
    parameters: {},
    outputs: [
      { type: "number", unit: "s" }, { type: "number", unit: "kWh" },
      { type: "number", unit: "gal" }, { type: "signal", unit: null }
    ]
  }
};

const TYPE_OPERATORS = {
  number: ["lt", "lte", "gt", "gte", "between", "outside"],
  integer: ["eq", "neq", "lt", "lte", "gt", "gte", "between", "outside", "changes"],
  boolean: ["eq", "neq", "changes_to"],
  enum: ["eq", "neq", "changes_from", "changes_to"],
  signal: ["occurs"]
};

const DEVICE_DRIVERS = {
  "shelly-gen1-em": "Shelly Gen1 EM HTTP",
  "shelly-gen4-switch": "Shelly Gen4 RPC switch/input/script",
  "tab5-runtime": "Tab5 local runtime"
};
const EVENT_FUNCTIONS = new Set(["StartCycleAccumulator", "CompleteCycleAccumulator"]);

const DEFAULT_DRAFT = {
  schemaVersion: 1,
  devices: [
    {
      id: "shelly-em-main", label: "Shelly EM", driver: "shelly-gen1-em",
      address: "192.168.50.141", enabled: true,
      fields: [
        { systemName: "PumpWatts", label: "Pump real power", object: "emeter/0.power", type: "number", unit: "W", access: "read", logging: { mode: "delta", threshold: 10 } },
        { systemName: "SupplyVoltage", label: "Supply voltage", object: "emeter/0.voltage", type: "number", unit: "V", access: "read", logging: { mode: "delta", threshold: 2 } },
        { systemName: "PowerFactor", label: "Power factor", object: "emeter/0.pf", type: "number", unit: null, access: "read", logging: { mode: "delta", threshold: 0.05 } },
        { systemName: "ShellyEMAvailable", label: "Shelly EM available", object: "$availability", type: "boolean", unit: null, access: "read", logging: { mode: "change" } }
      ]
    },
    {
      id: "shelly-1-main", label: "Shelly 1 Gen4", driver: "shelly-gen4-switch",
      address: "192.168.50.201", enabled: true,
      fields: [
        { systemName: "PumpEnable", label: "Pump enable", object: "SW(0)", type: "boolean", unit: null, access: "readWrite", logging: { mode: "change" }, write: { method: "Switch.Set", parameters: { id: 0, valueParameter: "on" }, normalValue: true } },
        { systemName: "ContactorFlag", label: "Contactor flag", object: "IN(0)", type: "boolean", unit: null, access: "read", logging: { mode: "change" } },
        { systemName: "IsLocked", label: "Shelly script lock remaining", object: "UDF(IsLocked)", type: "integer", unit: "s", access: "read", logging: { mode: "delta", threshold: 10 } },
        { systemName: "Shelly1Available", label: "Shelly 1 available", object: "$availability", type: "boolean", unit: null, access: "read", logging: { mode: "change" } }
      ]
    },
    {
      id: "tab5-main", label: "Tab5", driver: "tab5-runtime", address: "local", enabled: true,
      fields: [
        { systemName: "PressureADCMicrovolts", label: "Pressure ADC", object: "values.adc_microvolts", type: "number", unit: "uV", access: "read", logging: { mode: "delta", threshold: 25000 } },
        { systemName: "PressureSensorCommissioned", label: "Pressure sensor commissioned", object: "status.pressure_sensor_commissioned", type: "boolean", unit: null, access: "read", logging: { mode: "change" } },
        { systemName: "ADCValid", label: "ADC available", object: "status.adc_available", type: "boolean", unit: null, access: "read", logging: { mode: "change" } },
        { systemName: "ClockValid", label: "Clock synchronized", object: "status.clock_synced", type: "boolean", unit: null, access: "read", logging: { mode: "change" } },
        { systemName: "WiFiConnected", label: "Wi-Fi connected", object: "status.wifi_connected", type: "boolean", unit: null, access: "read", logging: { mode: "change" } },
        { systemName: "CloudAvailable", label: "Cloud delivery available", object: "status.cloud_available", type: "boolean", unit: null, access: "read", logging: { mode: "change" } },
        { systemName: "BatteryPercent", label: "Battery percent", object: "values.battery_percent", type: "number", unit: "%", access: "read", logging: { mode: "delta", threshold: 1 } },
        { systemName: "BufferUsedPercent", label: "RAM queue used", object: "status.buffer_used_pct", type: "number", unit: "%", access: "read", logging: { mode: "delta", threshold: 5 } },
        { systemName: "RecordsLost", label: "Records lost", object: "status.records_lost", type: "integer", unit: "count", access: "read", logging: { mode: "change" } }
      ]
    }
  ],
  calculatedFields: [
    { id: "calc-pump-state", label: "Pump state", functionId: "pump_state", inputs: { power: "PumpWatts" }, parameters: { runningAtWatts: 1000, stoppedBelowWatts: 5 }, outputs: [{ systemName: "PumpState", label: "Pump state", type: "enum", unit: null, enumValues: ["STOPPED", "RUNNING", "UNKNOWN"], logging: { mode: "change" } }] },
    { id: "calc-pump-runtime", label: "Pump runtime", functionId: "elapsed_state_seconds", inputs: { state: "PumpState" }, parameters: { activeValue: "RUNNING" }, outputs: [{ systemName: "PumpRuntimeSeconds", label: "Current pump runtime", type: "number", unit: "s", logging: { mode: "delta", threshold: 60 } }] },
    { id: "calc-pressure", label: "Calibrated pressure", functionId: "pressure_linear", inputs: { raw: "PressureADCMicrovolts" }, parameters: { slopePsiPerUnit: 0.00002218, interceptPsi: -9.57 }, outputs: [{ systemName: "PressurePSI", label: "Calibrated pressure", type: "number", unit: "psi", logging: { mode: "delta", threshold: 2 } }] },
    { id: "calc-load-ratio", label: "Pump load ratio", functionId: "load_ratio", inputs: { power: "PumpWatts" }, parameters: { baselineWatts: 2900 }, outputs: [{ systemName: "LoadRatioPercent", label: "Pump load ratio", type: "number", unit: "%", logging: { mode: "delta", threshold: 5 } }] },
    { id: "calc-start-count", label: "Pump starts in 60 seconds", functionId: "rolling_transition_count", inputs: { state: "PumpState" }, parameters: { fromValue: "STOPPED", toValue: "RUNNING", windowSeconds: 60 }, outputs: [{ systemName: "PumpStartsIn60Seconds", label: "Pump starts in 60 seconds", type: "integer", unit: "count", logging: { mode: "change" } }] },
    { id: "calc-tank", label: "Main tank Boyle-law model", functionId: "boyle_tank", inputs: { pressure: "PressurePSI" }, parameters: { effectiveTankGallons: 79.3, prechargeGaugePsi: 38, atmosphericPressurePsi: 13.07, regressionWindowSeconds: 10, minimumSamples: 8 }, outputs: [
      { systemName: "TankWaterGallons", label: "Estimated tank water", type: "number", unit: "gal", logging: { mode: "delta", threshold: 1 } },
      { systemName: "PressureSlopePSIPerMinute", label: "Pressure slope", type: "number", unit: "psi/min", logging: { mode: "delta", threshold: 0.5 } },
      { systemName: "TankNetFlowGPM", label: "Estimated tank net flow", type: "number", unit: "GPM", logging: { mode: "delta", threshold: 0.5 } },
      { systemName: "PumpOffDemandGPM", label: "Estimated pump-off demand", type: "number", unit: "GPM", logging: { mode: "delta", threshold: 0.5 } },
      { systemName: "TankFlowQuality", label: "Tank flow quality", type: "enum", unit: null, enumValues: ["VALID", "INSUFFICIENT_HISTORY", "PRESSURE_INVALID", "SAMPLE_GAP", "TREND_UNRESOLVED", "TANK_MODEL_INVALID"], logging: { mode: "change" } }
    ] },
    { id: "calc-cycle", label: "Pump cycle summary", functionId: "cycle_accumulator", inputs: { pumpState: "PumpState", power: "PumpWatts", pressure: "PressurePSI", tankFlow: "TankNetFlowGPM" }, parameters: {}, outputs: [
      { systemName: "LastCycleRuntimeSeconds", label: "Last cycle runtime", type: "number", unit: "s", logging: { mode: "delta", threshold: 1 } },
      { systemName: "LastCycleEnergyKWh", label: "Last cycle energy", type: "number", unit: "kWh", logging: { mode: "delta", threshold: 0.01 } },
      { systemName: "LastCycleGallons", label: "Last cycle estimated gallons", type: "number", unit: "gal", logging: { mode: "delta", threshold: 0.5 } },
      { systemName: "PumpCycleCompleted", label: "Pump cycle completed", type: "signal", unit: null, logging: { mode: "always" } }
    ] }
  ],
  events: [
    { id: "EV-PUMP-RUN", systemName: "PumpRunning", displayName: "Pump running", enabled: false, severity: "Info", open: { mode: "all", clauses: [{ field: "PumpState", operator: "eq", value: "RUNNING" }], observationCount: 1, minimumSeconds: 0 }, close: { mode: "all", clauses: [{ field: "PumpState", operator: "eq", value: "STOPPED" }], observationCount: 1, minimumSeconds: 0 }, latched: false, openFunctions: ["StartCycleAccumulator"], closeFunctions: ["CompleteCycleAccumulator"], actions: [], web: { notifyOnOpen: false, notifyOnClose: false, openMessage: "", closeMessage: "" } },
    { id: "EV-FAILED-START", systemName: "PumpFailedToStart", displayName: "Pump failed to start", enabled: false, severity: "Red", open: { mode: "all", clauses: [{ field: "ContactorFlag", operator: "eq", value: true }, { field: "PumpEnable", operator: "eq", value: true }, { field: "PumpState", operator: "eq", value: "STOPPED" }], observationCount: 5, minimumSeconds: 0 }, close: { mode: "any", clauses: [{ field: "PumpState", operator: "eq", value: "RUNNING" }, { field: "ContactorFlag", operator: "eq", value: false }], observationCount: 1, minimumSeconds: 0 }, latched: false, openFunctions: [], closeFunctions: [], actions: [], web: { notifyOnOpen: true, notifyOnClose: false, openMessage: "Well pump demand was present but the pump did not start.", closeMessage: "" } },
    { id: "EV-HIGH-VOLTAGE", systemName: "UtilityVoltageHigh", displayName: "Utility voltage high", enabled: false, severity: "Red", open: { mode: "all", clauses: [{ field: "SupplyVoltage", operator: "gte", value: 300 }, { field: "ShellyEMAvailable", operator: "eq", value: true }], observationCount: 3, minimumSeconds: 0 }, close: { mode: "all", clauses: [{ field: "SupplyVoltage", operator: "lt", value: 265 }, { field: "ShellyEMAvailable", operator: "eq", value: true }], observationCount: 30, minimumSeconds: 0 }, latched: false, openFunctions: [], closeFunctions: [], actions: [{ target: "PumpEnable", value: false }], web: { notifyOnOpen: true, notifyOnClose: true, openMessage: "Well pump disabled after repeated high-voltage observations.", closeMessage: "Well pump high-voltage event cleared after sustained good voltage." } },
    { id: "EV-LONG-RUNTIME", systemName: "LongPumpRuntime", displayName: "Long pump runtime", enabled: false, severity: "Red", open: { mode: "all", clauses: [{ field: "PumpRuntimeSeconds", operator: "gt", value: 360 }], observationCount: 1, minimumSeconds: 0 }, close: { mode: "all", clauses: [{ field: "PumpState", operator: "eq", value: "STOPPED" }], observationCount: 1, minimumSeconds: 0 }, latched: true, openFunctions: [], closeFunctions: [], actions: [{ target: "PumpEnable", value: false }], web: { notifyOnOpen: true, notifyOnClose: true, openMessage: "Well pump exceeded the configured runtime and was disabled.", closeMessage: "Long-runtime event cleared by the user." } },
    { id: "EV-RAPID-CYCLING", systemName: "RapidCyclingObserved", displayName: "Rapid cycling observed", enabled: false, severity: "Red", open: { mode: "all", clauses: [{ field: "PumpStartsIn60Seconds", operator: "gt", value: 4 }], observationCount: 1, minimumSeconds: 0 }, close: { mode: "all", clauses: [{ field: "PumpStartsIn60Seconds", operator: "lte", value: 4 }], observationCount: 60, minimumSeconds: 0 }, latched: false, openFunctions: [], closeFunctions: [], actions: [], web: { notifyOnOpen: true, notifyOnClose: false, openMessage: "Rapid cycling was observed. Shelly-local protection remains independent.", closeMessage: "" } },
    { id: "EV-CYCLE-OUTLIER", systemName: "CycleRuntimeOutlier", displayName: "Cycle runtime outlier", enabled: false, severity: "Yellow", open: { mode: "all", clauses: [{ field: "PumpCycleCompleted", operator: "occurs", value: null }, { field: "LastCycleRuntimeSeconds", operator: "outside", value: [60, 240] }], observationCount: 1, minimumSeconds: 0 }, close: { mode: "all", clauses: [{ field: "PumpCycleCompleted", operator: "occurs", value: null }], observationCount: 1, minimumSeconds: 0 }, latched: false, openFunctions: [], closeFunctions: [], actions: [], web: { notifyOnOpen: true, notifyOnClose: false, openMessage: "Completed pump-cycle runtime was outside the configured range.", closeMessage: "" } },
    { id: "EV-SHELLY-TIMED", systemName: "ShellyTimedLock", displayName: "Shelly timed lock", enabled: false, severity: "Red", open: { mode: "all", clauses: [{ field: "IsLocked", operator: "gt", value: 1 }], observationCount: 1, minimumSeconds: 0 }, close: { mode: "all", clauses: [{ field: "IsLocked", operator: "eq", value: 0 }], observationCount: 1, minimumSeconds: 0 }, latched: false, openFunctions: [], closeFunctions: [], actions: [], web: { notifyOnOpen: true, notifyOnClose: true, openMessage: "Well pump locked temporarily by Shelly-local protection.", closeMessage: "Shelly timed lock expired." } },
    { id: "EV-SHELLY-PERM", systemName: "ShellyPermanentLock", displayName: "Shelly permanent lock", enabled: false, severity: "Red", open: { mode: "all", clauses: [{ field: "IsLocked", operator: "lt", value: 0 }], observationCount: 1, minimumSeconds: 0 }, close: { mode: "all", clauses: [{ field: "IsLocked", operator: "eq", value: 0 }], observationCount: 1, minimumSeconds: 0 }, latched: false, openFunctions: [], closeFunctions: [], actions: [], web: { notifyOnOpen: true, notifyOnClose: true, openMessage: "Well pump locked by Shelly protection. Cycle well power to reset; remote override is unavailable.", closeMessage: "Shelly permanent lock cleared after well power restoration." } }
  ]
};

function defaults() { return structuredClone(DEFAULT_DRAFT); }

module.exports = { DEFAULT_DRAFT, DEVICE_DRIVERS, EVENT_FUNCTIONS, FUNCTION_CATALOG, TYPE_OPERATORS, defaults };
