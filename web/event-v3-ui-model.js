(function eventV3UiModel(global) {
  "use strict";

  const MAX_OPEN_EVENTS = 64;
  const MAX_HISTORY = 50;
  const CONTROL_ACTIONS = Object.freeze({
    "clear-events": Object.freeze({ label: "Clear Events", restartTarget: null }),
    monitor: Object.freeze({ label: "Monitor", restartTarget: null }),
    normal: Object.freeze({ label: "Normal", restartTarget: null }),
    "restart-tab5": Object.freeze({ label: "Restart Tab5", restartTarget: "Tab5" }),
    "restart-shelly1": Object.freeze({ label: "Restart Shelly 1", restartTarget: "Shelly 1" })
  });

  function text(value, fallback = "—") {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  function eventTime(value) {
    const time = typeof value === "string" ? new Date(value) : null;
    return time && Number.isFinite(time.getTime()) ? time.toISOString().replace(".000Z", "Z") : "—";
  }

  function eventStatus(value) {
    return ["open", "closed", "interrupted"].includes(value) ? value : "unknown";
  }

  function eventView(value) {
    const event = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      eventId: text(event.eventId),
      eventInstanceId: text(event.eventInstanceId),
      ruleId: text(event.ruleId),
      eventClass: text(event.eventClass),
      severity: text(event.severity),
      consequence: text(event.consequence),
      status: eventStatus(event.effectiveStatus || event.status),
      openedAt: eventTime(event.openedAt),
      closedAt: eventTime(event.closedAt),
      reason: text(event.closeTransitionReason || event.openTransitionReason || event.transitionReason)
    };
  }

  function statusView(value) {
    const data = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const board = data.board && typeof data.board === "object" && !Array.isArray(data.board) ? data.board : {};
    const opens = Array.isArray(board.openEvents) ? board.openEvents.slice(0, MAX_OPEN_EVENTS).map(eventView) : [];
    const history = Array.isArray(data.history) ? data.history.slice(0, MAX_HISTORY).map(eventView) : [];
    return {
      sessionId: text(board.sessionId, "Not available"),
      mode: board.mode === "Monitor" || board.mode === "Normal" ? board.mode : "Unknown",
      boundaryObservedAt: eventTime(board.boundaryObservedAt),
      openEvents: opens,
      history
    };
  }

  function controlAction(commandType) {
    return CONTROL_ACTIONS[commandType] || null;
  }

  const api = Object.freeze({ MAX_HISTORY, MAX_OPEN_EVENTS, CONTROL_ACTIONS, controlAction, eventStatus, eventTime, eventView, statusView });
  global.EventV3UiModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis === "undefined" ? this : globalThis);
