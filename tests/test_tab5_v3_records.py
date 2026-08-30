"""Host-only tests for disconnected Event V3 durable records and controls."""

import ast
import math
import pathlib
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
PUBLIC = {
    "resolve_v3_package", "v3_accept_device_records", "new_v3_kernel", "v3_kernel_step",
    "new_v3_record_stream", "v3_build_event_records",
    "new_v3_session_projection", "v3_apply_event_records_projection",
    "v3_current_event_projection", "v3_interpret_control",
}


def load_logic():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and (node.name.startswith("_v3_") or node.name in PUBLIC):
            nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if "RUNTIME_DIRECT_BINDINGS" in names:
                nodes.append(node)
    namespace = {
        "math": math,
        "time": types.SimpleNamespace(ticks_diff=lambda left, right: left - right),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"), namespace)
    return namespace


def condition(clauses):
    return {"mode": "all", "clauses": clauses,
            "observationCount": 1, "minimumSeconds": 0}


def phase():
    return {"assignments": [], "guardedGroups": []}


def event(event_id, event_class, trigger, closing):
    return {
        "id": event_id, "systemName": "Event" + event_id,
        "displayName": "Event " + event_id, "severity": "Info",
        "enabled": True, "eventClass": event_class,
        "opening": {"trigger": trigger}, "closing": closing,
        "onOpen": phase(), "onClose": phase(),
    }


def package():
    available = {"field": "ShellyEMAvailable", "operator": "eq", "value": True}
    return {
        "schemaVersion": 3, "kind": "well-pump-event-runtime-v3",
        "releaseId": "20260830000000-event-v3-v1", "packageVersion": 1,
        "adoption": {"runtimeSchemaVersion": 3, "legacyPackagePolicy": "reject"},
        "devices": [{
            "id": "shellyem", "address": "192.0.2.10", "driver": "shelly-gen1-em",
            "enabled": True, "fields": [
                {"systemName": "SupplyVoltage", "object": "emeter/0.voltage",
                 "type": "number", "unit": "V", "access": "read"},
                {"systemName": "ShellyEMAvailable", "object": "$availability",
                 "type": "boolean", "unit": None, "access": "read"},
            ],
        }],
        "calculatedFields": [],
        "events": [
            event("E007", "transient", {
                "type": "condition", "condition": condition([
                    {"field": "SupplyVoltage", "operator": "gt", "value": 265}, available])},
                {"policy": "condition", "condition": condition([
                    {"field": "SupplyVoltage", "operator": "lt", "value": 260}, available])}),
            event("H017", "transient", {
                "type": "internal", "occurrence": "bootSession",
                "qualification": {"observationCount": 1, "minimumSeconds": 0}},
                {"policy": "immediate"}),
            event("M001", "monitor", {
                "type": "manual", "request": "operatorMonitor",
                "qualification": {"observationCount": 1, "minimumSeconds": 0}},
                {"policy": "clearEvents"}),
            event("H001", "monitor", {
                "type": "internal", "occurrence": "sourceLost",
                "qualification": {"observationCount": 1, "minimumSeconds": 0}},
                {"policy": "clearEvents"}),
        ],
    }


RULES = {"version": 1, "contentHash": "a" * 64}
ACTOR = {"type": "user", "id": "operator-7"}
COMMAND_ID = "20260830000000-command-boot_A7f93k2Q-0000000009"


class V3RecordTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_logic()

    def stream(self):
        return self.logic["new_v3_record_stream"](
            package(), "well-main", "tab5-well-main", "boot_A7f93k2Q", RULES)

    def build(self, stream, transitions, observed="2026-08-30T00:00:07Z", **extra):
        outcome = {"transitions": transitions, "snapshot": {"SupplyVoltage": 270,
                   "ShellyEMAvailable": True}, "mode": extra.get("mode", "Normal")}
        return self.logic["v3_build_event_records"](
            stream, outcome, observed, extra.get("actor", ACTOR), extra.get("command_id"))

    def test_open_close_recurrence_identity_and_immutable_snapshot(self):
        outcome = {"transitions": [{"type": "open", "reason": "opening_qualified",
                                     "eventId": "E007", "eventInstanceId": "v3-instance-1"}],
                   "snapshot": {"SupplyVoltage": 270, "ShellyEMAvailable": True},
                   "mode": "Normal"}
        stream, opened = self.logic["v3_build_event_records"](
            self.stream(), outcome, "2026-08-30T00:00:07Z", ACTOR)
        record = opened["records"][0]
        self.assertEqual(record["eventId"], "20260830000007-E007-boot_A7f93k2Q-0000000000")
        self.assertEqual(record["recordId"], "20260830000007-event-open-boot_A7f93k2Q-0000000000")
        self.assertEqual(record["consequence"], "log-only")
        self.assertEqual(set(record), {
            "schemaVersion", "runtimeSchemaVersion", "recordType", "recordId", "eventId",
            "eventInstanceId", "siteId", "deviceId", "sessionId", "sequence", "observedAt",
            "ruleId", "severity", "latched", "eventClass", "consequence", "transitionReason",
            "mode", "rulesRelease", "condition", "actor"})
        outcome["snapshot"]["SupplyVoltage"] = 1
        self.assertEqual(record["condition"]["SupplyVoltage"], 270)

        stream, closed = self.build(stream, [{"type": "close", "reason": "closing_qualified",
                                               "eventId": "E007", "eventInstanceId": "v3-instance-1"}],
                                    "2026-08-30T00:00:37Z")
        self.assertEqual(closed["records"][0]["eventId"], record["eventId"])
        self.assertEqual(closed["records"][0]["sequence"], 1)
        stream, reopened = self.build(stream, [{"type": "open", "reason": "opening_qualified",
                                                 "eventId": "E007", "eventInstanceId": "v3-instance-2"}],
                                      "2026-08-30T00:00:38Z")
        self.assertNotEqual(reopened["records"][0]["eventId"], record["eventId"])
        self.assertEqual(reopened["records"][0]["eventInstanceId"], "v3-instance-2")

    def test_builder_accepts_only_calendar_valid_utc_record_times(self):
        self.assertEqual(self.logic["_v3_record_compact_time"]("2024-02-29T23:59:59Z"),
                         "20240229235959")
        for observed_at in (
            "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z",
            "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z",
            "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z",
        ):
            with self.assertRaises(ValueError):
                self.logic["_v3_record_compact_time"](observed_at)

    def test_multiple_ordered_transitions_and_missing_close_identity(self):
        stream, result = self.build(self.stream(), [
            {"type": "open", "reason": "opening_qualified", "eventId": "H017", "eventInstanceId": "v3-instance-1"},
            {"type": "close", "reason": "immediate_policy", "eventId": "H017", "eventInstanceId": "v3-instance-1"},
        ])
        self.assertEqual([record["recordType"] for record in result["records"]],
                         ["event-open", "event-close"])
        self.assertEqual([record["sequence"] for record in result["records"]], [0, 1])
        self.assertEqual(result["records"][0]["eventId"], result["records"][1]["eventId"])
        next_stream, missing = self.build(stream, [{"type": "close", "reason": "clear_events",
                                                     "eventId": "M001", "eventInstanceId": "v3-instance-9"}])
        self.assertEqual(missing["records"], [])
        self.assertEqual(missing["rejected"][0]["reason"], "missing_open_identity")
        self.assertEqual(next_stream["nextSequence"], 2)

    def test_projection_replaces_old_session_without_restart_close(self):
        stream, opened = self.build(self.stream(), [{"type": "open", "reason": "opening_qualified",
                                                      "eventId": "E007", "eventInstanceId": "v3-instance-1"}])
        projection = self.logic["new_v3_session_projection"]("boot_A7f93k2Q")
        projection = self.logic["v3_apply_event_records_projection"](
            projection, opened["records"], "Normal")
        self.assertEqual(self.logic["v3_current_event_projection"](projection)["openEventIds"],
                         [opened["records"][0]["eventId"]])
        replacement = self.logic["new_v3_session_projection"]("boot_B7f93k2Q")
        self.assertEqual(self.logic["v3_current_event_projection"](replacement), {
            "sessionId": "boot_B7f93k2Q", "mode": "Normal", "openEventIds": []})
        self.assertEqual(stream["openInstances"], {"v3-instance-1": {
            "eventId": opened["records"][0]["eventId"], "ruleId": "E007"}})

    def test_controls_are_pure_and_normal_only_closes_operator_monitor(self):
        monitor = self.logic["v3_interpret_control"]("Monitor", ACTOR, COMMAND_ID)
        self.assertEqual(monitor["kernelCommands"], {"manualRequests": ["operatorMonitor"]})
        self.assertEqual(monitor["context"], {"actor": ACTOR, "commandId": COMMAND_ID})
        self.assertEqual(self.logic["v3_interpret_control"]("Restart Tab5", ACTOR)["maintenanceSelections"],
                         [{"target": "tab5", "action": "restart"}])
        self.assertEqual(self.logic["v3_interpret_control"]("Restart Shelly", ACTOR)["maintenanceSelections"],
                         [{"target": "shelly1", "action": "restart"}])

        kernel = self.logic["new_v3_kernel"](package())
        source = {"shellyem": {"SupplyVoltage": 250, "ShellyEMAvailable": True}}
        kernel, first = self.logic["v3_kernel_step"](kernel, source, 1000, monitor["kernelCommands"])
        self.assertEqual(first["mode"], "Monitor")
        kernel, second = self.logic["v3_kernel_step"](kernel, source, 2000,
            {"internalOccurrences": ["sourceLost"]})
        self.assertEqual(second["mode"], "Monitor")
        normal = self.logic["v3_interpret_control"]("Normal", ACTOR)
        kernel, third = self.logic["v3_kernel_step"](kernel, source, 3000, normal["kernelCommands"])
        self.assertEqual(third["mode"], "Monitor")
        self.assertTrue(kernel["board"]["H001"]["active"])
        self.assertFalse(kernel["board"]["M001"]["active"])

    def test_control_context_is_included_without_mutable_aliasing(self):
        context = self.logic["v3_interpret_control"]("Clear Events", ACTOR, COMMAND_ID)["context"]
        stream, result = self.build(self.stream(), [{"type": "open", "reason": "opening_qualified",
                                                      "eventId": "E007", "eventInstanceId": "v3-instance-1"}],
                                    actor=context["actor"], command_id=context["commandId"])
        context["actor"]["id"] = "changed"
        self.assertEqual(result["records"][0]["actor"], ACTOR)
        self.assertEqual(result["records"][0]["commandId"], COMMAND_ID)

    def test_record_builder_and_controls_have_no_transport_or_reset_calls(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        names = {"v3_build_event_records", "v3_interpret_control", "v3_apply_event_records_projection"}
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name in names:
                called = {call.func.attr for call in ast.walk(node) if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)}
                direct = {call.func.id for call in ast.walk(node) if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)}
                self.assertFalse(called & {"post", "put", "reset", "submit_durable_record"})
                self.assertFalse(direct & {"reset", "submit_durable_record"})
        for name in ("new_v3_record_stream", "v3_build_event_records",
                     "v3_apply_event_records_projection", "v3_interpret_control"):
            self.assertEqual(source.count("def " + name + "("), 1)
        for name in ("new_v3_record_stream", "v3_build_event_records",
                     "v3_apply_event_records_projection"):
            self.assertEqual(source.count(name + "("), 1)


if __name__ == "__main__":
    unittest.main()
