"""Host-only tests for the disconnected Event V3 writable-field executor."""

import ast
import copy
import math
import pathlib
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
PUBLIC = {
    "resolve_v3_package", "new_v3_executor", "v3_enqueue_selected_assignments",
    "v3_executor_worker", "v3_executor_confirm_readback", "v3_kernel_step",
}


def load_v3_logic():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and (node.name.startswith("_v3_") or node.name in PUBLIC):
            nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if "RUNTIME_DIRECT_BINDINGS" in names:
                nodes.append(node)
    namespace = {"math": math,
                 "time": types.SimpleNamespace(ticks_diff=lambda left, right: left - right)}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"), namespace)
    return namespace


def package():
    return {
        "schemaVersion": 3, "kind": "well-pump-event-runtime-v3",
        "releaseId": "20260830000000-event-v3-v1", "packageVersion": 1,
        "adoption": {"runtimeSchemaVersion": 3, "legacyPackagePolicy": "reject"},
        "devices": [{
            "id": "shelly1", "address": "192.0.2.11", "driver": "shelly-gen4-switch", "enabled": True,
            "fields": [
                {"systemName": "PumpEnable", "object": "RLY(0)", "type": "boolean",
                 "unit": None, "access": "readWrite", "write": {
                     "method": "Switch.Set", "parameters": {"id": 0, "valueParameter": "on"},
                     "normalValue": True}},
                {"systemName": "LockSeconds", "object": "UDF(IsLocked)", "type": "integer",
                 "unit": "s", "access": "read"},
                {"systemName": "Shelly1Available", "object": "$availability", "type": "boolean",
                 "unit": None, "access": "read"},
            ],
        }],
        "calculatedFields": [], "events": [],
    }


def outcome(value=None, lock=0, complete=True, mode="Normal"):
    assignments = [] if value is None else [{"target": "PumpEnable", "value": value}]
    return {
        "assignments": assignments, "mode": mode,
        "acceptedDevices": ["shelly1"] if complete else [],
        "snapshot": ({"PumpEnable": True, "LockSeconds": lock,
                      "Shelly1Available": True} if complete else {}),
    }


class V3ExecutorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_v3_logic()

    def executor(self, max_attempts=2):
        return self.logic["new_v3_executor"](package(), max_attempts)

    def enqueue(self, executor, selection):
        return self.logic["v3_enqueue_selected_assignments"](executor, selection)

    def worker(self, executor, transport, evidence, mode="Normal"):
        return self.logic["v3_executor_worker"](
            executor, transport, evidence["acceptedDevices"], evidence["snapshot"], mode)

    def test_typed_binding_queues_false_and_true_and_rejects_wrong_type(self):
        executor, false_selected = self.enqueue(self.executor(), outcome(False, complete=False))
        self.assertEqual(false_selected["rejected"], [])
        self.assertEqual(executor["queue"][0]["driver"], "shelly-gen4-switch")
        self.assertEqual(executor["queue"][0]["method"], "Switch.Set")
        self.assertEqual(executor["queue"][0]["address"], "192.0.2.11")
        self.assertEqual(executor["queue"][0]["parameters"], {"id": 0, "on": False})
        executor, true_selected = self.enqueue(self.executor(), outcome(True, lock=0))
        self.assertEqual(true_selected["rejected"], [])
        self.assertTrue(executor["queue"][0]["parameters"]["on"])
        executor, invalid = self.enqueue(self.executor(), {
            "assignments": [{"target": "PumpEnable", "value": "true"}], "mode": "Normal",
            "acceptedDevices": [], "snapshot": {}})
        self.assertEqual(invalid["rejected"][0]["reason"], "assignment_type_or_target")

    def test_resolver_requires_complete_supported_shelly_adapter_binding(self):
        missing_address = package()
        del missing_address["devices"][0]["address"]
        with self.assertRaises(ValueError):
            self.logic["resolve_v3_package"](missing_address)
        wrong_method = package()
        wrong_method["devices"][0]["fields"][0]["write"]["method"] = "Relay.Set"
        with self.assertRaises(ValueError):
            self.logic["resolve_v3_package"](wrong_method)
        wrong_parameters = package()
        wrong_parameters["devices"][0]["fields"][0]["write"]["parameters"] = {
            "id": 1, "valueParameter": "on"}
        with self.assertRaises(ValueError):
            self.logic["resolve_v3_package"](wrong_parameters)

    def test_enable_gate_rejects_positive_negative_and_dropped_shelly(self):
        for lock in (1, -1):
            executor, selected = self.enqueue(self.executor(), outcome(True, lock=lock))
            self.assertEqual(executor["queue"], [])
            self.assertEqual(selected["rejected"][0]["reason"], "protected_enable_locked")
            self.assertIn("PumpEnable", executor["desired"])
        executor, selected = self.enqueue(self.executor(), outcome(True, complete=False))
        self.assertEqual(executor["queue"], [])
        self.assertEqual(selected["rejected"][0]["reason"], "protected_enable_requires_current_record")

    def test_enqueue_has_no_transport_and_confirmation_requires_later_readback(self):
        calls = []
        executor, selected = self.enqueue(self.executor(), outcome(False, complete=False))
        self.assertEqual(calls, [])
        self.assertEqual(len(selected["selected"]), 1)
        evidence = outcome(False, complete=True)
        executor, issued = self.worker(executor, lambda command: calls.append(command) or {"accepted": True}, evidence)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(issued["issued"]), 1)
        self.assertEqual(issued["confirmed"], [])
        self.assertTrue(executor["desired"]["PumpEnable"]["awaitingConfirmation"])
        executor, confirmation = self.logic["v3_executor_confirm_readback"](
            executor, evidence["acceptedDevices"], {"PumpEnable": False, "LockSeconds": 0,
                                                       "Shelly1Available": True})
        self.assertEqual(confirmation["confirmed"][0]["target"], "PumpEnable")
        self.assertNotIn("PumpEnable", executor["desired"])

    def test_locked_true_readback_cannot_confirm_a_protected_enable(self):
        executor, _ = self.enqueue(self.executor(), outcome(True, lock=0))
        executor, issued = self.worker(executor, lambda command: {"accepted": True}, outcome(None, lock=0))
        self.assertEqual(len(issued["issued"]), 1)
        executor, confirmation = self.logic["v3_executor_confirm_readback"](
            executor, ["shelly1"], {"PumpEnable": True, "LockSeconds": 5,
                                      "Shelly1Available": True})
        self.assertEqual(confirmation["confirmed"], [])
        self.assertIn("PumpEnable", executor["desired"])
        self.assertTrue(any(item["reason"] == "protected_enable_locked"
                            for item in confirmation["rejected"]))

    def test_rpc_confirmed_flag_is_not_physical_readback_confirmation(self):
        executor, _ = self.enqueue(self.executor(), outcome(False, complete=False))
        evidence = outcome(False)
        executor, result = self.worker(executor, lambda command: {"confirmed": True}, evidence)
        self.assertEqual(result["confirmed"], [])
        self.assertEqual(len(executor["queue"]), 1)

    def test_true_release_survives_retry_and_temporary_worker_gate_rejection(self):
        executor, _ = self.enqueue(self.executor(), outcome(True, lock=0))
        dropped = outcome(None, complete=False)
        calls = []
        executor, rejected = self.worker(executor, lambda command: calls.append(command), dropped)
        self.assertEqual(calls, [])
        self.assertEqual(rejected["rejected"][0]["reason"], "protected_enable_requires_current_record")
        self.assertIn("PumpEnable", executor["desired"])
        executor, _ = self.enqueue(executor, outcome(None, lock=0))
        executor, locked = self.worker(executor, lambda command: calls.append(command), outcome(None, lock=5))
        self.assertEqual(locked["rejected"][0]["reason"], "protected_enable_locked")
        self.assertEqual(calls, [])
        self.assertIn("PumpEnable", executor["desired"])
        executor, _ = self.enqueue(executor, outcome(None, lock=0))
        executor, first_failure = self.worker(executor, lambda command: False, outcome(None, lock=0))
        self.assertEqual(first_failure["issued"][0]["state"], "issued")
        executor, second_failure = self.worker(executor, lambda command: False, outcome(None, lock=0))
        self.assertEqual(second_failure["rejected"][0]["reason"], "transport_unconfirmed_pending")
        self.assertIn("PumpEnable", executor["desired"])
        self.assertEqual(len(executor["queue"]), 1)

    def test_retry_attempt_count_survives_intervening_enqueue_cycles(self):
        executor, _ = self.enqueue(self.executor(), outcome(False, complete=False))
        executor, first = self.worker(executor, lambda command: False, outcome(None, complete=False))
        self.assertEqual(first["issued"][0]["state"], "issued")
        self.assertEqual(executor["queue"][0]["attempts"], 1)
        executor, _ = self.enqueue(executor, outcome(False, complete=False))
        self.assertEqual(executor["queue"][0]["attempts"], 1)
        executor, final = self.worker(executor, lambda command: False, outcome(None, complete=False))
        self.assertEqual(final["rejected"][0]["reason"], "transport_unconfirmed")
        self.assertEqual(executor["queue"], [])

    def test_transition_assignments_preserve_declared_order_in_a_bounded_queue(self):
        selection = outcome(None, lock=0)
        selection["assignments"] = [
            {"target": "PumpEnable", "value": True, "ownership": "transition"},
            {"target": "PumpEnable", "value": False, "ownership": "transition"},
        ]
        executor, queued = self.enqueue(self.executor(), selection)
        self.assertEqual(queued["rejected"], [])
        self.assertEqual([command["value"] for command in executor["transitionQueue"]], [True, False])
        issued = []
        executor, _ = self.worker(executor, lambda command: issued.append(command) or {"accepted": True}, outcome(None, lock=0))
        executor, waiting = self.worker(executor, lambda command: issued.append(command), outcome(None, lock=0))
        self.assertEqual(waiting["issued"], [])
        self.assertEqual([command["value"] for command in issued], [True])
        executor, confirmed = self.logic["v3_executor_confirm_readback"](
            executor, ["shelly1"], {"PumpEnable": True, "LockSeconds": 0,
                                      "Shelly1Available": True})
        self.assertEqual(confirmed["confirmed"][0]["value"], True)
        executor, _ = self.worker(executor, lambda command: issued.append(command) or {"accepted": True}, outcome(None, lock=0))
        self.assertEqual([command["value"] for command in issued], [True, False])

    def test_effective_false_supersedes_pending_transition_enable(self):
        transition = outcome(None, lock=0)
        transition["assignments"] = [{"target": "PumpEnable", "value": True,
                                      "ownership": "transition"}]
        executor, _ = self.enqueue(self.executor(), transition)
        self.assertEqual([command["value"] for command in executor["transitionQueue"]], [True])
        executor, replacement = self.enqueue(executor, outcome(False, complete=False))
        self.assertEqual(executor["transitionQueue"], [])
        self.assertTrue(any(item["reason"] == "superseded" for item in replacement["rejected"]))
        calls = []
        executor, worker = self.worker(executor, lambda command: calls.append(command), outcome(None, complete=False))
        self.assertEqual(worker["issued"][0]["value"], False)
        self.assertEqual([command["value"] for command in calls], [False])

    def test_blocked_transition_keeps_global_order_across_two_targets(self):
        dual = package()
        second = copy.deepcopy(dual["devices"][0])
        second["id"] = "shelly2"
        second["address"] = "192.0.2.12"
        second["fields"][0]["systemName"] = "PumpEnableB"
        second["fields"][1]["systemName"] = "LockSecondsB"
        second["fields"][2]["systemName"] = "Shelly2Available"
        dual["devices"].append(second)
        selection = {
            "assignments": [
                {"target": "PumpEnable", "value": True, "ownership": "transition"},
                {"target": "PumpEnable", "value": False, "ownership": "transition"},
                {"target": "PumpEnableB", "value": False, "ownership": "transition"},
            ], "mode": "Normal", "acceptedDevices": ["shelly1", "shelly2"],
            "snapshot": {"PumpEnable": True, "LockSeconds": 0, "Shelly1Available": True,
                         "PumpEnableB": True, "LockSecondsB": 0, "Shelly2Available": True},
        }
        executor, _ = self.enqueue(self.logic["new_v3_executor"](dual), selection)
        calls = []
        executor, _ = self.worker(executor, lambda command: calls.append(command) or {"accepted": True}, selection)
        executor, blocked = self.worker(executor, lambda command: calls.append(command), selection)
        self.assertEqual(blocked["issued"], [])
        self.assertEqual([command["target"] for command in calls], ["PumpEnable"])
        self.assertEqual([command["target"] for command in executor["transitionQueue"]],
                         ["PumpEnable", "PumpEnableB"])

    def test_latest_normal_inhibit_supersedes_queued_release_and_monitor_blocks_false_at_worker(self):
        executor, _ = self.enqueue(self.executor(), outcome(True, lock=0))
        executor, _ = self.enqueue(executor, outcome(False, complete=False, mode="Normal"))
        self.assertEqual(len(executor["queue"]), 1)
        self.assertFalse(executor["queue"][0]["value"])
        issued = []
        executor, worker_outcome = self.worker(executor, lambda command: issued.append(command) or {"accepted": True},
                                               outcome(False, complete=False))
        self.assertEqual(worker_outcome["issued"][0]["value"], False)
        self.assertEqual(len(issued), 1)
        executor, _ = self.enqueue(self.executor(), outcome(False, complete=False, mode="Normal"))
        executor, monitor_rejected = self.worker(executor, lambda command: issued.append(command),
                                                 outcome(None, complete=False), mode="Monitor")
        self.assertEqual(monitor_rejected["rejected"][0]["reason"], "monitor_suppressed")
        self.assertEqual(len(issued), 1)

    def test_kernel_and_enqueue_do_not_invoke_transport(self):
        tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        for name in ("v3_kernel_step", "v3_enqueue_selected_assignments"):
            calls = {node.func.id for node in ast.walk(functions[name])
                     if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
            self.assertNotIn("transport", calls)


if __name__ == "__main__":
    unittest.main()
