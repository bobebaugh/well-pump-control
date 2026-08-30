"""Host-only tests for the disconnected Event V3 pending-command adapter."""

import ast
import copy
import math
import pathlib
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
PUBLIC = {"v3_interpret_control", "v3_adapt_pending_command", "v3_select_pending_commands"}
COMMAND_TYPES = ("clear-events", "monitor", "normal", "restart-tab5", "restart-shelly1")


def load_logic():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and
             (node.name.startswith("_v3_") or node.name in PUBLIC)]
    namespace = {"math": math,
                 "time": types.SimpleNamespace(ticks_diff=lambda left, right: left - right)}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"), namespace)
    return namespace


WEB_FIXTURE = {
    "schemaVersion": 1,
    "runtimeSchemaVersion": 3,
    "commandId": "20260830000007-command-web_control-0000000007",
    "commandSequence": 7,
    "siteId": "well-main",
    "targetDeviceId": "tab5-well-main",
    "commandType": "clear-events",
    "requestedAt": "2026-08-30T00:00:07Z",
    "requestedBy": {"type": "user", "id": "pilot-web"},
    "status": "pending",
    "payload": {},
}


def command(sequence, command_type="clear-events", **changes):
    value = copy.deepcopy(WEB_FIXTURE)
    value["commandSequence"] = sequence
    value["commandId"] = "20260830000007-command-web_control-{:010d}".format(sequence)
    value["commandType"] = command_type
    value.update(changes)
    return value


class EmptyPayloadImpostor:
    def __eq__(self, other):
        return other == {}


class EmptyPayloadSubclass(dict):
    pass


class V3CommandAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_logic()

    def test_exact_web_fixture_maps_all_five_controls_with_context(self):
        expected = {
            "clear-events": {"clearEvents": True},
            "monitor": {"manualRequests": ["operatorMonitor"]},
            "normal": {"normal": True},
            "restart-tab5": {},
            "restart-shelly1": {},
        }
        for index, command_type in enumerate(COMMAND_TYPES, 1):
            source = command(index, command_type)
            selected = self.logic["v3_adapt_pending_command"](source)
            self.assertEqual(selected["commandType"], command_type)
            self.assertEqual(selected["kernelCommands"], expected[command_type])
            self.assertEqual(selected["context"], {
                "actor": {"type": "user", "id": "pilot-web"},
                "commandId": source["commandId"],
            })
        self.assertEqual(
            self.logic["v3_adapt_pending_command"](command(4, "restart-tab5"))["maintenanceSelections"],
            [{"target": "tab5", "action": "restart"}])
        self.assertEqual(
            self.logic["v3_adapt_pending_command"](command(5, "restart-shelly1"))["maintenanceSelections"],
            [{"target": "shelly1", "action": "restart"}])

    def test_adapter_preserves_context_without_mutating_the_web_envelope(self):
        source = command(7, "monitor", requestedAt="2026-08-30T00:00:07.125+00:00")
        original = copy.deepcopy(source)
        selected = self.logic["v3_adapt_pending_command"](source)
        selected["context"]["actor"]["id"] = "changed"
        selected["kernelCommands"]["manualRequests"].append("changed")
        self.assertEqual(source, original)
        self.assertEqual(selected["commandId"], original["commandId"])
        self.assertEqual(self.logic["v3_adapt_pending_command"](source)["context"]["actor"],
                         {"type": "user", "id": "pilot-web"})

    def test_adapter_rejects_legacy_mixed_extra_and_malformed_envelopes(self):
        invalid = [
            command(1, "close-event", payload={"eventId": "old"}),
            command(1, "monitor", runtimeSchemaVersion=2),
            command(1, "monitor", payload={"unexpected": True}),
            command(1, "monitor", extra="field"),
            command(1, "monitor", requestedAt="2026-02-29T00:00:00Z"),
            command(0, "monitor"),
            command(1, "monitor", requestedBy={"type": "user", "id": "other"}),
            command(1, "monitor", commandId="20260830000007-command-other_issuer-0000000001"),
            command(2, "monitor", commandId="20260830000007-command-web_control-0000000003"),
            command(1, "monitor", payload=EmptyPayloadImpostor()),
            command(1, "monitor", payload=EmptyPayloadSubclass()),
        ]
        for source in invalid:
            with self.assertRaises(ValueError):
                self.logic["v3_adapt_pending_command"](source)

    def test_batch_sorts_gaps_and_reports_stale_retries_without_reselecting(self):
        result = self.logic["v3_select_pending_commands"](1, [
            command(5, "monitor"), command(3, "normal"), command(1, "clear-events"),
        ])
        self.assertEqual([item["commandSequence"] for item in result["selections"]], [3, 5])
        self.assertEqual(result["candidateHighWater"], 5)
        self.assertIsNone(result["failStopSequence"])
        self.assertEqual(result["rejections"], [{
            "reason": "stale_sequence", "commandSequence": 1,
            "commandId": "20260830000007-command-web_control-0000000001"}])

    def test_batch_rejects_duplicate_sequence_and_durable_identity_conflicts(self):
        duplicate_sequence = self.logic["v3_select_pending_commands"](1, [
            command(3, "monitor"), command(3, "normal"), command(4, "clear-events"),
        ])
        self.assertEqual(duplicate_sequence["selections"], [])
        self.assertEqual(duplicate_sequence["candidateHighWater"], 1)
        self.assertEqual(duplicate_sequence["failStopSequence"], 3)
        self.assertEqual([item["reason"] for item in duplicate_sequence["rejections"]], [
            "duplicate_sequence_conflict", "duplicate_sequence_conflict", "blocked_by_fail_stop"])

        repeated_id = command(4, "normal", commandId=command(3)["commandId"])
        duplicate_id = self.logic["v3_select_pending_commands"](1, [command(3, "monitor"), repeated_id])
        self.assertEqual(duplicate_id["selections"], [])
        self.assertEqual(duplicate_id["candidateHighWater"], 1)
        self.assertEqual(duplicate_id["failStopSequence"], 3)
        self.assertEqual([item["reason"] for item in duplicate_id["rejections"]], [
            "duplicate_command_id_conflict", "duplicate_command_id_conflict"])

    def test_invalid_newer_command_is_fail_stop_and_cannot_skip_high_water(self):
        poisoned = command(3, "monitor", payload={"bad": True})
        result = self.logic["v3_select_pending_commands"](1, [
            command(4, "normal"), poisoned, command(2, "clear-events"),
        ])
        self.assertEqual([item["commandSequence"] for item in result["selections"]], [2])
        self.assertEqual(result["candidateHighWater"], 2)
        self.assertEqual(result["failStopSequence"], 3)
        self.assertEqual([item["reason"] for item in result["rejections"]], [
            "invalid_command_envelope", "blocked_by_fail_stop"])

    def test_unorderable_sequences_fail_stop_before_any_selection_or_high_water(self):
        for invalid_sequence in (False, "7", 0, 10000000000):
            poisoned = command(1, "monitor")
            poisoned["commandSequence"] = invalid_sequence
            result = self.logic["v3_select_pending_commands"](0, [command(2, "normal"), poisoned])
            self.assertEqual(result["selections"], [])
            self.assertEqual(result["candidateHighWater"], 0)
            self.assertIsNone(result["failStopSequence"])
            self.assertEqual([item["reason"] for item in result["rejections"]], [
                "invalid_command_sequence", "blocked_by_unorderable_sequence"])

    def test_adapter_is_disconnected_from_legacy_runtime_and_maintenance_execution(self):
        tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
        adapter_names = {"v3_adapt_pending_command", "v3_select_pending_commands"}
        forbidden = {"reset", "v3_kernel_step", "v3_executor_worker", "submit_durable_record"}
        for node in tree.body:
            if isinstance(node, ast.FunctionDef) and node.name in adapter_names:
                called = {call.func.id for call in ast.walk(node) if isinstance(call, ast.Call) and
                          isinstance(call.func, ast.Name)}
                attributes = {call.func.attr for call in ast.walk(node) if isinstance(call, ast.Call) and
                              isinstance(call.func, ast.Attribute)}
                self.assertFalse(called & forbidden)
                self.assertFalse(attributes & {"post", "put", "reset"})
            if isinstance(node, ast.FunctionDef) and node.name == "evaluate_runtime_events":
                called = {call.func.id for call in ast.walk(node) if isinstance(call, ast.Call) and
                          isinstance(call.func, ast.Name)}
                self.assertFalse(called & adapter_names)
        source = PILOT_PATH.read_text(encoding="utf-8")
        for name in adapter_names:
            self.assertEqual(source.count("def " + name + "("), 1)


if __name__ == "__main__":
    unittest.main()
