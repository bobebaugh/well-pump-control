"use strict";

// Plain-language names for the reasons a durable record was written. The page
// and the CSV export both use this file, so the Reasons column and the CSV's
// reasonSummary always say the same thing. Everything is read from the stored
// reason itself (field, from, to, threshold, event key); nothing is inferred.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api; else root.RecordReasons = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  // Booleans with a well-known meaning: [name, word when true, word when false].
  const toggles = {
    CloudAvailable: ["Cloud", "back", "lost"],
    WiFiConnected: ["Wi-Fi", "back", "lost"],
    ShellyEMAvailable: ["Meter", "back", "lost"],
    Shelly1Available: ["Shelly 1", "back", "lost"],
    ContactorFlag: ["Contactor", "on", "off"],
    ClockValid: ["Clock", "valid", "invalid"],
    ADCValid: ["ADC", "valid", "invalid"]
  };
  // Measured fields: [short name, unit].
  const measures = {
    TankWaterGallons: ["Tank", "gal"],
    TankNetFlowGPM: ["Net flow", "GPM"],
    PumpWatts: ["Pump", "W"],
    PressurePSI: ["Pressure", "psi"],
    SupplyVoltage: ["Supply", "V"]
  };
  const rank = { "event-boundary": 0, change: 1, delta: 2, "session-start": 3, "maximum-interval": 4 };
  const text = value => value === undefined ? "?" : typeof value === "string" ? value : JSON.stringify(value);
  function signed(value) {
    const size = Math.abs(value); const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${value < 0 ? "−" : "+"}${size.toFixed(digits)}`;
  }
  function label(reason = {}) {
    if (reason.kind === "maximum-interval") return "Health";
    if (reason.kind === "session-start") return "Session start";
    if (reason.kind === "event-boundary") return `${reason.eventKey || "Event"} ${reason.transition === "open" ? "opened" : reason.transition === "close" ? "closed" : text(reason.transition)}`;
    if (reason.kind === "change") {
      const toggle = toggles[reason.field];
      if (toggle && typeof reason.to === "boolean") return `${toggle[0]} ${reason.to ? toggle[1] : toggle[2]}`;
      return `${reason.field} → ${text(reason.to)}`;
    }
    if (reason.kind === "delta") {
      const [name, unit] = measures[reason.field] || [reason.field, ""];
      return typeof reason.to === "number" && typeof reason.from === "number" ? `${name} ${signed(reason.to - reason.from)}${unit ? ` ${unit}` : ""}` : `${name} changed`;
    }
    return text(reason.kind);
  }
  function detail(reason = {}) {
    if (reason.kind === "maximum-interval") return `Ten-minute health record${Number.isFinite(reason.intervalMs) ? ` (maximum interval ${reason.intervalMs / 1000} s)` : ""}`;
    if (reason.kind === "session-start") return "First record after the Tab5 started";
    if (reason.kind === "event-boundary") return `Event ${reason.eventKey || "?"} ${reason.transition === "open" ? "opened" : reason.transition === "close" ? "closed" : text(reason.transition)}${reason.occurrenceId ? ` · occurrence ${reason.occurrenceId}` : ""}`;
    if (reason.kind === "change") return `${label(reason)}: ${reason.field} changed ${text(reason.from)} → ${text(reason.to)}`;
    if (reason.kind === "delta") return `${reason.field} ${text(reason.from)} → ${text(reason.to)}${typeof reason.to === "number" && typeof reason.from === "number" ? ` (Δ ${signed(reason.to - reason.from)}` : " ("}${reason.threshold !== undefined ? `, threshold ${text(reason.threshold)})` : ")"}`;
    return JSON.stringify(reason);
  }
  const ordered = reasons => [...(reasons || [])].sort((left, right) => (rank[left?.kind] ?? 5) - (rank[right?.kind] ?? 5));
  // One label for a narrow column: the most telling reason, plus a count of the rest.
  function short(reasons) { const list = ordered(reasons); return list.length ? `${label(list[0])}${list.length > 1 ? ` +${list.length - 1}` : ""}` : "Not recorded"; }
  function summary(reasons) { return ordered(reasons).map(label).join("; "); }
  // Fields named by the reasons: the cells worth highlighting in that row.
  function fields(reasons) { return new Set((reasons || []).map(reason => reason?.field).filter(field => typeof field === "string")); }
  const filters = [
    ["all", "All records"],
    ["hide-health", "Hide health records"],
    ["changes", "Changes & events only"],
    ["events", "Events only"]
  ];
  function matches(reasons, filter) {
    const kinds = (reasons || []).map(reason => reason?.kind);
    if (filter === "hide-health") return kinds.some(kind => kind !== "maximum-interval");
    if (filter === "changes") return kinds.some(kind => kind === "change" || kind === "event-boundary");
    if (filter === "events") return kinds.includes("event-boundary");
    return true;
  }
  return { detail, fields, filters, label, matches, ordered, short, summary };
});
