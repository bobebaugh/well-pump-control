"use strict";

// V3 deliberately starts with the installed V2 device, calculation, function,
// and logging definitions.  Event lifecycle changes must not silently drop a
// physical binding or a calculation from the package.
const { defaults: v2Defaults } = require("./rules-engine-defaults");

const noLog = { mode: "none" };
const changeLog = { mode: "change" };

function phase(assignments = [], guardedGroups = []) {
  return { assignments, guardedGroups };
}

function defaults() {
  const v2 = v2Defaults();
  return {
    schemaVersion: 3,
    devices: v2.devices,
    calculatedFields: v2.calculatedFields,
    systemFields: [
      {
        id: "system-operating-mode",
        systemName: "OperatingMode",
        label: "Operating mode",
        source: "session",
        runtimeRole: "operatingMode",
        type: "enum",
        unit: null,
        enumValues: ["Normal", "Monitor"],
        initialValue: "Normal",
        logging: changeLog,
        assignmentTarget: true
      },
      {
        id: "manual-operator-monitor",
        systemName: "OperatorMonitorRequest",
        label: "Operator Monitor request",
        source: "manualOccurrence",
        runtimeRole: "occurrence",
        type: "signal",
        unit: null,
        occurrenceKey: "operatorMonitor",
        logging: noLog
      },
      {
        id: "internal-shelly-em-unavailable",
        systemName: "ShellyEMUnavailable",
        label: "Shelly EM complete record unavailable",
        source: "internalOccurrence",
        runtimeRole: "occurrence",
        type: "signal",
        unit: null,
        occurrenceKey: "shellyEmUnavailable",
        logging: noLog
      }
    ],
    events: [
      {
        id: "E007",
        systemName: "UtilityVoltageHigh",
        displayName: "Utility voltage high",
        severity: "Red",
        enabled: true,
        eventClass: "transient",
        opening: { trigger: { type: "condition", condition: { mode: "all", clauses: [{ field: "SupplyVoltage", operator: "gt", value: 265 }, { field: "ShellyEMAvailable", operator: "eq", value: true }], observationCount: 2, minimumSeconds: 0 } } },
        closing: { policy: "condition", condition: { mode: "all", clauses: [{ field: "SupplyVoltage", operator: "lt", value: 265 }, { field: "ShellyEMAvailable", operator: "eq", value: true }], observationCount: 30, minimumSeconds: 0 } },
        onOpen: phase([{ target: "PumpEnable", value: false, ownership: "whileOpen" }]),
        onClose: phase(),
        summary: { durationOutput: null, aggregates: [] },
        web: { notifyOnOpen: false, notifyOnClose: false, openMessage: "", closeMessage: "" }
      },
      {
        id: "M001",
        systemName: "OperatorMonitor",
        displayName: "Operator Monitor",
        severity: "Info",
        enabled: true,
        eventClass: "monitor",
        opening: { trigger: { type: "manual", occurrenceField: "OperatorMonitorRequest", qualification: { observationCount: 1, minimumSeconds: 0 } } },
        closing: { policy: "clearEvents" },
        onOpen: phase([{ target: "OperatingMode", value: "Monitor", ownership: "whileOpen" }]),
        onClose: phase(),
        summary: { durationOutput: null, aggregates: [] },
        web: { notifyOnOpen: false, notifyOnClose: false, openMessage: "", closeMessage: "" }
      },
      {
        id: "H001",
        systemName: "ElectricalSourceInvalid",
        displayName: "Electrical source invalid",
        severity: "Red",
        enabled: true,
        eventClass: "monitor",
        opening: { trigger: { type: "internal", occurrenceField: "ShellyEMUnavailable", qualification: { observationCount: 1, minimumSeconds: 0 } } },
        closing: { policy: "condition", condition: { mode: "all", clauses: [{ field: "ShellyEMAvailable", operator: "eq", value: true }], observationCount: 1, minimumSeconds: 0 } },
        onOpen: phase([{ target: "OperatingMode", value: "Monitor", ownership: "whileOpen" }]),
        onClose: phase(),
        summary: { durationOutput: null, aggregates: [] },
        web: { notifyOnOpen: false, notifyOnClose: false, openMessage: "", closeMessage: "" }
      },
      {
        id: "E002",
        systemName: "PumpUnderload",
        displayName: "Pump running underload",
        severity: "Red",
        enabled: false,
        eventClass: "latched",
        opening: { trigger: { type: "condition", condition: { mode: "all", clauses: [{ field: "ContactorFlag", operator: "eq", value: true }, { field: "PumpEnable", operator: "eq", value: true }, { field: "PumpWatts", operator: "lt", value: 500 }, { field: "ShellyEMAvailable", operator: "eq", value: true }, { field: "Shelly1Available", operator: "eq", value: true }], observationCount: 4, minimumSeconds: 0 } } },
        closing: { policy: "clearEvents" },
        onOpen: phase([{ target: "PumpEnable", value: false, ownership: "whileOpen" }]),
        onClose: phase(),
        summary: { durationOutput: null, aggregates: [] },
        web: { notifyOnOpen: false, notifyOnClose: false, openMessage: "", closeMessage: "" }
      }
    ]
  };
}

module.exports = { defaults };
