"""Executable host tests for M6.35 durable selection and board construction."""

import ast
import json
import pathlib
import unittest

PILOT = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
FUNCTIONS = {
    "_runtime_number", "_valid_rules_hash", "runtime_logging_policies",
    "durable_field_states", "durable_trigger_reasons", "event_boundary_reasons",
    "admitted_durable_baselines", "build_durable_observation_v2",
    "_event_opening_kind", "build_current_event_board", "event_board_signature",
}
CONSTANTS = {"SITE_ID", "DEVICE_ID"}


def load_logic():
    tree = ast.parse(PILOT.read_text(encoding="utf-8"))
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if names & CONSTANTS:
                nodes.append(node)
    namespace = {"ujson": json}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT), "exec"), namespace)
    return namespace


class RulesDurableBoardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_logic()

    def package(self):
        return {
            "devices": [{"enabled": True, "fields": [
                {"systemName": "PumpEnable", "type": "boolean", "logging": {"mode": "change"}},
                {"systemName": "SupplyVoltage", "type": "number", "logging": {"mode": "delta", "threshold": 1.0}},
                {"systemName": "PressureRaw", "type": "integer", "logging": {"mode": "none"}},
            ]}],
            "calculations": [{"output": {"systemName": "FlowGpm", "type": "number", "logging": {"mode": "always"}}}],
            "systemFields": [{"systemName": "OperatingMode", "type": "enum", "logging": {"mode": "change"}}],
        }

    def test_three_field_categories_and_none_include_policy(self):
        policies = self.logic["runtime_logging_policies"](self.package())
        self.assertEqual(policies["PumpEnable"]["fieldKind"], "Device")
        self.assertEqual(policies["FlowGpm"]["fieldKind"], "Calculated")
        self.assertEqual(policies["OperatingMode"]["fieldKind"], "System")
        fields = self.logic["durable_field_states"]({
            "PumpEnable": False, "SupplyVoltage": 250.0, "PressureRaw": 19000,
            "FlowGpm": 5.2, "OperatingMode": "Normal",
        }, policies)
        self.assertNotIn("PressureRaw", fields)
        self.assertEqual(set(fields), {"PumpEnable", "SupplyVoltage", "FlowGpm", "OperatingMode"})
        self.assertEqual(self.logic["durable_trigger_reasons"](fields, {
            "PumpEnable": False, "SupplyVoltage": 250.0, "FlowGpm": 4.0,
            "OperatingMode": "Normal",
        }, policies), [])

    def test_disabled_device_keeps_logging_selected_field_unavailable(self):
        package = self.package()
        package["devices"][0]["enabled"] = False
        policies = self.logic["runtime_logging_policies"](package)
        self.assertIn("PumpEnable", policies)
        fields = self.logic["durable_field_states"]({}, policies)
        self.assertEqual(fields["PumpEnable"], {
            "state": "unavailable", "reason": "source-unavailable"})

    def test_threshold_equality_cumulative_delta_change_and_gaps(self):
        policies = self.logic["runtime_logging_policies"](self.package())
        baseline = {"PumpEnable": False, "SupplyVoltage": 250.0, "OperatingMode": "Normal"}
        below = self.logic["durable_field_states"]({
            "PumpEnable": False, "SupplyVoltage": 250.9, "FlowGpm": 5.0,
            "OperatingMode": "Normal"}, policies)
        self.assertEqual(self.logic["durable_trigger_reasons"](below, baseline, policies), [])
        at_threshold = self.logic["durable_field_states"]({
            "PumpEnable": True, "SupplyVoltage": 251.0, "FlowGpm": 5.0,
            "OperatingMode": "Monitor"}, policies)
        kinds = [reason["kind"] for reason in self.logic["durable_trigger_reasons"](
            at_threshold, baseline, policies)]
        self.assertEqual(kinds, ["change", "delta", "change"])
        gap = self.logic["durable_field_states"]({
            "PumpEnable": False, "FlowGpm": 5.0, "OperatingMode": "Normal"}, policies)
        self.assertEqual(gap["SupplyVoltage"], {"state": "unavailable", "reason": "source-unavailable"})
        admitted = self.logic["admitted_durable_baselines"](gap, baseline)
        self.assertEqual(admitted["SupplyVoltage"], 250.0)
        recovery = self.logic["durable_field_states"]({
            "PumpEnable": False, "SupplyVoltage": 250.3, "FlowGpm": 5.0,
            "OperatingMode": "Normal"}, policies)
        self.assertEqual(self.logic["durable_trigger_reasons"](recovery, admitted, policies), [])

    def test_event_reasons_coalesce_in_one_v2_pre_dispatch_record(self):
        policies = self.logic["runtime_logging_policies"](self.package())
        fields = self.logic["durable_field_states"]({
            "PumpEnable": True, "SupplyVoltage": 266.0, "FlowGpm": 5.8,
            "OperatingMode": "Monitor"}, policies)
        reasons = self.logic["durable_trigger_reasons"](fields, {
            "PumpEnable": False, "SupplyVoltage": 250.0, "OperatingMode": "Normal"}, policies)
        reasons += self.logic["event_boundary_reasons"]([
            {"type": "open", "eventId": "E007", "eventInstanceId": "r:E007:1"},
            {"type": "close", "eventId": "S010", "eventInstanceId": "r:S010:1"},
        ])
        reasons.append({"kind": "maximum-interval", "intervalMs": 600000})
        observation = {"sequence": 44, "observedTicksMs": 44000, "observedAt": "2026-09-12T20:00:44Z"}
        reference = {"releaseId": "20260912001035-event-v3-v15", "packageVersion": 15, "contentHash": "a" * 64}
        record = self.logic["build_durable_observation_v2"](
            observation, "boot_AAAAAAAAAAAA", reference, reasons, fields)
        self.assertEqual(record["schemaVersion"], 2)
        self.assertEqual(record["recordId"], "obs_boot_AAAAAAAAAAAA_0000000044")
        self.assertEqual(record["snapshotPhase"], "observed-pre-dispatch")
        self.assertEqual(record["fields"]["PumpEnable"]["value"], True)
        self.assertEqual(len(record["triggerReasons"]), len(reasons))

    def test_board_is_sparse_from_committed_state_with_stable_opening(self):
        event = {"id": "E007", "displayName": "Utility voltage high", "severity": "Red", "eventClass": "transient", "opening": {"trigger": {"type": "condition"}}}
        opening = {"kind": "condition-qualified", "cycleSequence": 20, "uptimeMs": 20000, "observedAt": "2026-09-12T16:00:20Z"}
        runtime = {
            "resolved": {"events": [event]},
            "kernel": {"events": {"E007": {"active": True, "instanceId": "r15:E007:1", "opening": opening}}},
            "reference": {"releaseId": "20260912001035-event-v3-v15", "packageVersion": 15, "contentHash": "a" * 64},
        }
        board = self.logic["build_current_event_board"](
            runtime, "boot_AAAAAAAAAAAA", 1, 44, 44000, "2026-09-12T20:00:44Z")
        self.assertTrue(board["complete"])
        self.assertEqual(board["openEvents"]["E007"]["opening"], opening)
        first_signature = self.logic["event_board_signature"](board)
        board["boardSequence"] = 2
        board["producedUptimeMs"] = 74000
        self.assertEqual(self.logic["event_board_signature"](board), first_signature)
        runtime["kernel"]["events"]["E007"]["active"] = False
        empty = self.logic["build_current_event_board"](
            runtime, "boot_AAAAAAAAAAAA", 3, 45, 45000)
        self.assertEqual(empty["openEvents"], {})

    def test_representative_record_and_64_slot_board_fit_transport_caps(self):
        policies = self.logic["runtime_logging_policies"](self.package())
        fields = self.logic["durable_field_states"]({
            "PumpEnable": False, "SupplyVoltage": 250.0,
            "FlowGpm": 5.2, "OperatingMode": "Normal"}, policies)
        reference = {"releaseId": "20260912001035-event-v3-v15", "packageVersion": 15, "contentHash": "a" * 64}
        record = self.logic["build_durable_observation_v2"](
            {"sequence": 44, "observedTicksMs": 44000}, "boot_AAAAAAAAAAAA",
            reference, [{"kind": "session-start"}], fields, 44000)
        self.assertLess(len(json.dumps(record, separators=(",", ":")).encode()), 393216)
        definitions = []
        states = {}
        for index in range(64):
            event_id = "E{:03d}".format(index)
            definitions.append({"id": event_id, "displayName": "D" * 160,
                                "severity": "Red", "eventClass": "latched",
                                "opening": {"trigger": {"type": "condition"}}})
            states[event_id] = {"active": True,
                                "instanceId": "{}:{}:1".format(reference["releaseId"], event_id),
                                "opening": {"kind": "condition-qualified",
                                            "cycleSequence": 44, "uptimeMs": 44000}}
        runtime = {"resolved": {"events": definitions},
                   "kernel": {"events": states}, "reference": reference}
        board = self.logic["build_current_event_board"](
            runtime, "boot_AAAAAAAAAAAA", 1, 44, 44000)
        self.assertLess(len(json.dumps(board, separators=(",", ":")).encode()), 65536)


if __name__ == "__main__":
    unittest.main()
