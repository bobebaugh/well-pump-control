"""Deterministic host replays for the inert Event V3 semantic kernel."""

import ast
import math
import pathlib
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
PUBLIC = {"resolve_v3_package", "v3_accept_device_records", "new_v3_kernel", "v3_kernel_step"}


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


def condition(clauses, count=1, seconds=0):
    return {"mode": "all", "clauses": clauses,
            "observationCount": count, "minimumSeconds": seconds}


def phase(assignments=None, groups=None):
    return {"assignments": assignments or [], "guardedGroups": groups or []}


def assignment(value=False, ownership="whileOpen", target="PumpEnable"):
    return {"target": target, "value": value, "ownership": ownership}


def event(event_id, name, event_class, opening, closing, on_open=None):
    return {
        "id": event_id, "systemName": name, "displayName": name,
        "severity": "Red", "enabled": True, "eventClass": event_class,
        "opening": opening, "closing": closing,
        "onOpen": phase(on_open), "onClose": phase(),
    }


def v3_package():
    high = event(
        "E007", "UtilityVoltageHigh", "transient",
        {"trigger": {"type": "condition", "condition": condition([
            {"field": "SupplyVoltage", "operator": "gt", "value": 265},
            {"field": "ShellyEMAvailable", "operator": "eq", "value": True},
        ], count=2)}},
        {"policy": "condition", "condition": condition([
            {"field": "SupplyVoltage", "operator": "lt", "value": 260},
            {"field": "ShellyEMAvailable", "operator": "eq", "value": True},
        ], count=30)}, [assignment()])
    power = event(
        "T001", "PumpPowerUnsafe", "transient",
        {"trigger": {"type": "condition", "condition": condition([
            {"field": "PumpWatts", "operator": "gt", "value": 2000},
        ])}},
        {"policy": "condition", "condition": condition([
            {"field": "PumpWatts", "operator": "lt", "value": 1000},
        ])}, [assignment()])
    latch = event(
        "E002", "PumpUnderload", "latched",
        {"trigger": {"type": "condition", "condition": condition([
            {"field": "PumpWatts", "operator": "lt", "value": 500},
        ])}}, {"policy": "clearEvents"}, [assignment()])
    source_monitor = event(
        "H001", "ElectricalSourceInvalid", "monitor",
        {"trigger": {"type": "internal", "occurrence": "shellyEmUnavailable",
                     "qualification": {"observationCount": 1, "minimumSeconds": 0}}},
        {"policy": "condition", "condition": condition([
            {"field": "ShellyEMAvailable", "operator": "eq", "value": True},
        ])})
    control_monitor = event(
        "H005", "ControlSourceInvalid", "monitor",
        {"trigger": {"type": "internal", "occurrence": "shelly1Unavailable",
                     "qualification": {"observationCount": 1, "minimumSeconds": 0}}},
        {"policy": "condition", "condition": condition([
            {"field": "Shelly1Available", "operator": "eq", "value": True},
        ])})
    operator_monitor = event(
        "M001", "OperatorMonitor", "monitor",
        {"trigger": {"type": "manual", "request": "operatorMonitor",
                     "qualification": {"observationCount": 1, "minimumSeconds": 0}}},
        {"policy": "clearEvents"})
    return {
        "schemaVersion": 3, "kind": "well-pump-event-runtime-v3",
        "releaseId": "20260830000000-event-v3-v1", "packageVersion": 1,
        "adoption": {"runtimeSchemaVersion": 3, "legacyPackagePolicy": "reject"},
        "devices": [
            {"id": "em", "address": "192.0.2.10", "driver": "shelly-gen1-em", "enabled": True, "fields": [
                {"systemName": "SupplyVoltage", "object": "emeter/0.voltage", "type": "number", "unit": "V", "access": "read"},
                {"systemName": "PumpWatts", "object": "emeter/0.power", "type": "number", "unit": "W", "access": "read"},
                {"systemName": "ShellyEMAvailable", "object": "$availability", "type": "boolean", "unit": None, "access": "read"},
            ]},
            {"id": "shelly1", "address": "192.0.2.11", "driver": "shelly-gen4-switch", "enabled": True, "fields": [
                {"systemName": "PumpEnable", "object": "RLY(0)", "type": "boolean", "unit": None, "access": "readWrite", "write": {"method": "Switch.Set", "parameters": {"id": 0, "valueParameter": "on"}, "normalValue": True}},
                {"systemName": "IsLocked", "object": "UDF(IsLocked)", "type": "integer", "unit": "s", "access": "read"},
                {"systemName": "Shelly1Available", "object": "$availability", "type": "boolean", "unit": None, "access": "read"},
            ]},
        ],
        "calculatedFields": [],
        "events": [high, power, latch, source_monitor, control_monitor, operator_monitor],
    }


def records(voltage=240, watts=1000, em_available=True, shelly_available=True,
            locked=0, pump=True):
    return {
        "em": {"SupplyVoltage": voltage, "PumpWatts": watts,
               "ShellyEMAvailable": em_available},
        "shelly1": {"PumpEnable": pump, "IsLocked": locked,
                    "Shelly1Available": shelly_available},
    }


class V3KernelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_v3_logic()

    def kernel(self, package=None):
        return self.logic["new_v3_kernel"](package or v3_package())

    def step(self, kernel, now_ms, source=None, commands=None):
        return self.logic["v3_kernel_step"](kernel, source or records(), now_ms, commands)

    def assigned(self, outcome, value, target="PumpEnable"):
        return any(item.get("target") == target and item.get("value") is value
                   for item in outcome["assignments"])

    def transition(self, outcome, event_id, transition_type, reason):
        matches = [item for item in outcome["transitions"]
                   if item["eventId"] == event_id and item["type"] == transition_type]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["reason"], reason)
        self.assertTrue(matches[0]["eventInstanceId"].startswith("v3-instance-"))
        return matches[0]

    def open_high(self, kernel, now=0):
        kernel, _ = self.step(kernel, now, records(voltage=270))
        return self.step(kernel, now + 1000, records(voltage=270))

    def test_01_high_voltage_confirms_then_requires_thirty_valid_recovery_samples(self):
        kernel, first = self.step(self.kernel(), 0, records(voltage=270))
        self.assertEqual(first["transitions"], [])
        kernel, opened = self.step(kernel, 1000, records(voltage=270))
        self.transition(opened, "E007", "open", "opening_qualified")
        self.assertTrue(self.assigned(opened, False))
        for sample in range(1, 30):
            kernel, outcome = self.step(kernel, 1000 + sample * 1000, records(voltage=250))
            self.assertNotIn("E007", [item["eventId"] for item in outcome["transitions"]])
        kernel, closed = self.step(kernel, 31000, records(voltage=250))
        self.transition(closed, "E007", "close", "closing_qualified")
        self.assertTrue(self.assigned(closed, True))

    def test_02_dropped_source_freezes_recovery_count_and_elapsed_time(self):
        kernel, _ = self.open_high(self.kernel())
        kernel, _ = self.step(kernel, 2000, records(voltage=250))
        before = dict(kernel["board"]["E007"])
        dropped = records(voltage=250)
        del dropped["em"]["SupplyVoltage"]
        kernel, outcome = self.step(kernel, 12000, dropped)
        after = kernel["board"]["E007"]
        self.assertEqual(after["closeCount"], before["closeCount"])
        self.assertEqual(after["closeElapsedMs"], before["closeElapsedMs"])
        self.assertIn("em", outcome["droppedDevices"])
        for sample in range(2, 30):
            kernel, outcome = self.step(kernel, 12000 + sample * 1000, records(voltage=250))
            self.assertEqual(outcome["transitions"], [])
        kernel, outcome = self.step(kernel, 42000, records(voltage=250))
        self.assertEqual(outcome["transitions"][0]["eventId"], "E007")

    def test_02b_dropped_evidence_cannot_satisfy_minimum_recovery_time(self):
        package = v3_package()
        closing = package["events"][0]["closing"]["condition"]
        closing["observationCount"] = 2
        closing["minimumSeconds"] = 10
        kernel, _ = self.open_high(self.kernel(package))
        kernel, _ = self.step(kernel, 2000, records(voltage=250))
        dropped = records(voltage=250)
        del dropped["em"]["SupplyVoltage"]
        kernel, gap = self.step(kernel, 12000, dropped)
        self.assertEqual(gap["transitions"], [])
        kernel, after_gap = self.step(kernel, 13000, records(voltage=250))
        self.assertEqual(after_gap["transitions"], [])
        self.assertEqual(kernel["board"]["E007"]["closeCount"], 2)
        self.assertEqual(kernel["board"]["E007"]["closeElapsedMs"], 0)
        kernel, closed = self.step(kernel, 23000, records(voltage=250))
        self.assertEqual(closed["transitions"][0]["eventId"], "E007")

    def test_03_two_transient_inhibits_overlap_without_early_release(self):
        kernel, _ = self.open_high(self.kernel())
        kernel, power_open = self.step(kernel, 2000, records(voltage=270, watts=2500))
        self.assertIn("T001", [item["eventId"] for item in power_open["transitions"]])
        for sample in range(1, 31):
            kernel, outcome = self.step(kernel, 2000 + sample * 1000, records(voltage=250, watts=2500))
        self.assertIn("E007", [item["eventId"] for item in outcome["transitions"]])
        self.assertTrue(kernel["board"]["T001"]["active"])
        self.assertTrue(self.assigned(outcome, False))

    def test_04_latch_remains_authoritative_until_clear_events(self):
        kernel, _ = self.open_high(self.kernel())
        kernel, latch_open = self.step(kernel, 2000, records(voltage=270, watts=400))
        self.assertIn("E002", [item["eventId"] for item in latch_open["transitions"]])
        for sample in range(1, 31):
            kernel, outcome = self.step(kernel, 2000 + sample * 1000, records(voltage=250, watts=400))
        self.assertTrue(kernel["board"]["E002"]["active"])
        self.assertTrue(self.assigned(outcome, False))
        kernel, cleared = self.step(kernel, 34000, records(voltage=250, watts=1000), {"clearEvents": True})
        self.assertIn("E002", [item["eventId"] for item in cleared["transitions"]])
        self.assertTrue(self.assigned(cleared, True))

    def test_05_two_monitor_causes_release_normal_only_after_final_owner(self):
        failed = records()
        failed["em"] = {"ShellyEMAvailable": False}
        failed["shelly1"] = {"Shelly1Available": False}
        kernel, first = self.step(self.kernel(), 0, failed, {
            "internalOccurrences": ["shellyEmUnavailable", "shelly1Unavailable"]})
        self.assertEqual(first["mode"], "Monitor")
        self.assertIn("em", first["droppedDevices"])
        self.assertIn("shelly1", first["droppedDevices"])
        self.assertNotIn("ShellyEMAvailable", first["snapshot"])
        self.assertNotIn("Shelly1Available", first["snapshot"])
        still_failed = records()
        still_failed["shelly1"] = {"Shelly1Available": False}
        kernel, one_clear = self.step(kernel, 1000, still_failed)
        self.assertEqual(one_clear["mode"], "Monitor")
        kernel, final_clear = self.step(kernel, 2000, records())
        self.assertEqual(final_clear["mode"], "Normal")

    def test_06_normal_request_closes_operator_monitor_only(self):
        failed = records()
        del failed["em"]["SupplyVoltage"]
        kernel, _ = self.step(self.kernel(), 0, failed, {
            "manualRequests": ["operatorMonitor"],
            "internalOccurrences": ["shellyEmUnavailable"]})
        self.assertEqual(kernel["mode"] if "mode" in kernel else None, None)
        failed = records()
        del failed["em"]["SupplyVoltage"]
        kernel, normal = self.step(kernel, 1000, failed, {"normal": True})
        closed = [item["eventId"] for item in normal["transitions"] if item["type"] == "close"]
        self.assertIn("M001", closed)
        self.assertTrue(kernel["board"]["H001"]["active"])
        self.assertEqual(normal["mode"], "Monitor")

    def test_07_events_continue_in_monitor_and_apply_inhibit_on_return(self):
        failed = records(watts=400)
        del failed["shelly1"]["PumpEnable"]
        kernel, monitor = self.step(self.kernel(), 0, failed, {
            "internalOccurrences": ["shelly1Unavailable"]})
        self.assertEqual(monitor["mode"], "Monitor")
        self.assertTrue(kernel["board"]["E002"]["active"])
        self.assertFalse(self.assigned(monitor, False))
        kernel, returned = self.step(kernel, 1000, records(watts=400))
        self.assertEqual(returned["mode"], "Normal")
        self.assertTrue(self.assigned(returned, False))

    def test_08_enable_requires_current_unlocked_shelly_and_survives_pending_release(self):
        kernel, opened = self.step(self.kernel(), 0, records(watts=400, locked=0))
        self.assertTrue(self.assigned(opened, False))
        kernel, timed = self.step(kernel, 1000, records(watts=1000, locked=5), {"clearEvents": True})
        self.assertFalse(self.assigned(timed, True))
        kernel, latched = self.step(kernel, 2000, records(watts=1000, locked=-1))
        self.assertFalse(self.assigned(latched, True))
        dropped = records(watts=1000, locked=0)
        del dropped["shelly1"]["PumpEnable"]
        kernel, unavailable = self.step(kernel, 3000, dropped)
        self.assertIn("shelly1", unavailable["droppedDevices"])
        self.assertFalse(self.assigned(unavailable, True))
        kernel, unlocked = self.step(kernel, 4000, records(watts=1000, locked=0))
        self.assertTrue(self.assigned(unlocked, True))

    def test_09_shelly_timed_reenable_is_disabled_again_while_owner_remains(self):
        kernel, _ = self.step(self.kernel(), 0, records(watts=400, pump=True))
        kernel, outcome = self.step(kernel, 1000, records(watts=400, pump=True))
        self.assertTrue(kernel["board"]["E002"]["active"])
        self.assertTrue(self.assigned(outcome, False))

    def test_10_restart_has_empty_board_no_blind_enable_and_reopens_from_evidence(self):
        kernel, _ = self.open_high(self.kernel())
        restarted = self.kernel()
        restarted, first = self.step(restarted, 0, records(voltage=270))
        self.assertEqual(first["transitions"], [])
        self.assertFalse(self.assigned(first, True))
        restarted, opened = self.step(restarted, 1000, records(voltage=270))
        self.assertEqual(opened["transitions"][0]["eventId"], "E007")

    def test_11_disabled_rule_does_not_reopen_after_restart(self):
        package = v3_package()
        package["events"][0]["enabled"] = False
        kernel, first = self.step(self.kernel(package), 0, records(voltage=270))
        kernel, second = self.step(kernel, 1000, records(voltage=270))
        self.assertEqual(first["transitions"], [])
        self.assertEqual(second["transitions"], [])
        self.assertFalse(kernel["board"]["E007"]["active"])

    def test_12_guard_groups_share_one_frozen_transition_snapshot(self):
        phase_value = phase(groups=[
            {"guard": condition([{"field": "SupplyVoltage", "operator": "gt", "value": 260}]),
             "assignments": [{"target": "PumpEnable", "value": False, "ownership": "transition"}]},
            {"guard": condition([{"field": "PumpEnable", "operator": "eq", "value": True}]),
             "assignments": [{"target": "Marker", "value": True, "ownership": "transition"}]},
        ])
        snapshot = {"SupplyVoltage": 270, "PumpEnable": True}
        selected = self.logic["_v3_phase_assignments"](phase_value, snapshot)
        self.assertEqual([item["target"] for item in selected], ["PumpEnable", "Marker"])
        self.assertTrue(snapshot["PumpEnable"])

    def test_monitor_suppresses_protected_transition_disable_but_keeps_transition(self):
        package = v3_package()
        package["events"][4]["onOpen"] = phase([
            assignment(False, ownership="transition")])
        failed = records()
        del failed["shelly1"]["PumpEnable"]
        kernel, outcome = self.step(self.kernel(package), 0, failed, {
            "internalOccurrences": ["shelly1Unavailable"]})
        self.assertEqual(outcome["mode"], "Monitor")
        self.transition(outcome, "H005", "open", "opening_qualified")
        self.assertFalse(self.assigned(outcome, False))
        self.assertTrue(kernel["board"]["H005"]["active"])

    def test_event_instance_ids_match_close_and_change_on_recurrence(self):
        package = v3_package()
        package["events"][0]["closing"]["condition"]["observationCount"] = 1
        kernel, _ = self.step(self.kernel(package), 0, records(voltage=270))
        kernel, opened = self.step(kernel, 1000, records(voltage=270))
        first_open = self.transition(opened, "E007", "open", "opening_qualified")
        self.assertIn(first_open["eventInstanceId"], kernel["owners"]["PumpEnable"])
        kernel, closed = self.step(kernel, 2000, records(voltage=250))
        first_close = self.transition(closed, "E007", "close", "closing_qualified")
        self.assertEqual(first_close["eventInstanceId"], first_open["eventInstanceId"])
        kernel, _ = self.step(kernel, 3000, records(voltage=270))
        kernel, reopened = self.step(kernel, 4000, records(voltage=270))
        second_open = self.transition(reopened, "E007", "open", "opening_qualified")
        self.assertNotEqual(second_open["eventInstanceId"], first_open["eventInstanceId"])

    def test_nonfinite_record_drops_device_without_qualification(self):
        for invalid in (float("nan"), float("inf"), float("-inf")):
            kernel, outcome = self.step(self.kernel(), 0, records(voltage=invalid))
            self.assertIn("em", outcome["droppedDevices"])
            self.assertEqual(kernel["board"]["E007"]["openCount"], 0)
            self.assertFalse(kernel["board"]["E007"]["active"])

    def test_binding_renamed_pump_target_has_identical_safe_reconciliation(self):
        package = v3_package()
        device_fields = package["devices"][1]["fields"]
        for field in device_fields:
            if field["object"] == "RLY(0)":
                field["systemName"] = "PumpPermit"
        for item in package["events"]:
            for group in (item["onOpen"], item["onClose"]):
                for action in group["assignments"]:
                    if action["target"] == "PumpEnable":
                        action["target"] = "PumpPermit"
        source = records(watts=400)
        source["shelly1"]["PumpPermit"] = source["shelly1"].pop("PumpEnable")
        kernel, opened = self.step(self.kernel(package), 0, source)
        self.assertTrue(self.assigned(opened, False, "PumpPermit"))
        source = records(watts=1000, locked=0)
        source["shelly1"]["PumpPermit"] = source["shelly1"].pop("PumpEnable")
        kernel, released = self.step(kernel, 1000, source, {"clearEvents": True})
        self.assertTrue(self.assigned(released, True, "PumpPermit"))

    def test_atomic_partial_record_rejection_and_kernel_has_no_executor_or_network_calls(self):
        resolved = self.logic["resolve_v3_package"](v3_package())
        partial = records()
        del partial["em"]["SupplyVoltage"]
        accepted = self.logic["v3_accept_device_records"](resolved, partial)
        self.assertIn("em", accepted["droppedDevices"])
        self.assertNotIn("SupplyVoltage", accepted["snapshot"])
        self.assertIn("shelly1", accepted["acceptedDevices"])
        tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
        v3_nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and
                    (node.name.startswith("_v3_") or node.name in PUBLIC)]
        calls = {node.func.id for function in v3_nodes for node in ast.walk(function)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertFalse(calls & {"issue_runtime_stop", "requests", "log"})

    def test_resolver_rejects_v2_identity_and_unknown_kernel_reference(self):
        with self.assertRaises(ValueError):
            self.logic["resolve_v3_package"]({"schemaVersion": 2})
        package = v3_package()
        package["events"][0]["opening"]["trigger"]["condition"]["clauses"][0]["field"] = "Missing"
        with self.assertRaises(ValueError):
            self.logic["resolve_v3_package"](package)

    def test_resolver_rejects_unit1_fixture_shape_without_same_device_lock_binding(self):
        package = v3_package()
        package["devices"][1]["fields"] = [
            field for field in package["devices"][1]["fields"]
            if field["object"] != "UDF(IsLocked)"
        ]
        with self.assertRaises(ValueError):
            self.logic["resolve_v3_package"](package)

    def test_resolver_rejects_incompatible_while_open_values(self):
        package = v3_package()
        package["events"][1]["onOpen"]["assignments"][0]["value"] = True
        with self.assertRaises(ValueError):
            self.logic["resolve_v3_package"](package)

    def test_resolver_rejects_transition_or_close_conflicts_with_held_target(self):
        package = v3_package()
        package["events"][4]["onOpen"] = phase([
            assignment(True, ownership="transition")])
        with self.assertRaises(ValueError):
            self.logic["resolve_v3_package"](package)
        package = v3_package()
        package["events"][4]["onClose"] = phase([
            assignment(False, ownership="transition")])
        with self.assertRaises(ValueError):
            self.logic["resolve_v3_package"](package)

    def test_resolver_accepts_normal_transition_when_no_held_target_exists(self):
        package = v3_package()
        for item in package["events"][:3]:
            item["onOpen"] = phase()
        package["events"][4]["onOpen"] = phase([
            assignment(True, ownership="transition")])
        self.logic["resolve_v3_package"](package)


if __name__ == "__main__":
    unittest.main()
