"""Deterministic host replays for the pure, selection-only V3 kernel."""

import ast
import copy
import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).parents[1]
PILOT_PATH = ROOT / "tab5" / "pilot.py"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "rules-runtime-package-v3-checkpoint1.json"

FUNCTIONS = {
    "_v3_closed", "_v3_number", "_v3_integer", "_v3_name", "_v3_id",
    "_v3_scalar", "_v3_logging", "_v3_typed_value", "_v3_enum_values",
    "_v3_field", "_v3_output", "_v3_system_field", "_v3_clause",
    "_v3_condition", "_v3_phase", "_v3_dependencies_acyclic",
    "_rules_v3_package_valid", "resolve_rules_v3_package",
    "accept_rules_v3_device_record", "freeze_rules_v3_snapshot",
    "rules_v3_condition_value", "_new_rules_v3_event_state",
    "new_rules_v3_kernel", "_copy_rules_v3_kernel", "_rules_v3_qualified",
    "_rules_v3_open_value", "_rules_v3_phase_assignments",
    "_rules_v3_add_owner", "_rules_v3_remove_owner", "_rules_v3_has_owner",
    "rules_v3_effective_mode", "_rules_v3_action", "_rules_v3_append_action",
    "advance_rules_v3_kernel", "restart_rules_v3_kernel",
}
CONSTANTS = {"RULES_V3_SCHEMA_VERSION", "RULES_V3_PACKAGE_KIND"}


def load_kernel():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if names & CONSTANTS:
                nodes.append(node)
    namespace = {"ujson": json}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"), namespace)
    return namespace


def condition(field, operator, value, count=1):
    return {
        "mode": "all",
        "clauses": [{"field": field, "operator": operator, "value": value}],
        "observationCount": count,
        "minimumSeconds": 0,
    }


def inhibit(event_id, open_field, open_operator, open_value,
            close_field, close_operator, close_value, count=1,
            event_class="transient"):
    closing = ({"policy": "clearEvents"} if event_class == "latched" else {
        "policy": "condition",
        "condition": condition(close_field, close_operator, close_value),
    })
    return {
        "id": event_id,
        "systemName": event_id.replace("-", ""),
        "displayName": event_id,
        "severity": "Red",
        "enabled": True,
        "eventClass": event_class,
        "opening": {"trigger": {
            "type": "condition",
            "condition": condition(open_field, open_operator, open_value, count),
        }},
        "closing": closing,
        "onOpen": {"assignments": [{
            "target": "PumpEnable", "value": False, "ownership": "whileOpen",
        }], "guardedGroups": []},
        "onClose": {"assignments": [], "guardedGroups": []},
        "summary": {"durationOutput": None, "aggregates": []},
    }


class V3SemanticKernelReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_kernel()
        cls.fixture_text = FIXTURE_PATH.read_text(encoding="utf-8")
        cls.fixture = json.loads(cls.fixture_text)

    def resolved(self, events=None, package=None, as_text=False):
        package = copy.deepcopy(self.fixture if package is None else package)
        if events is not None:
            package["events"] = events
        source = json.dumps(package, separators=(",", ":")) if as_text else package
        resolved = self.logic["resolve_rules_v3_package"](source)
        self.assertIsNotNone(resolved)
        return resolved

    def fields(self, **changes):
        values = {
            "SupplyVoltage": 240.0,
            "ShellyEMAvailable": True,
            "PumpWatts": 2800.0,
            "PumpEnable": True,
            "IsLocked": 0,
        }
        values.update(changes)
        return values

    def step(self, resolved, state, now_ms, fields=None, **kwargs):
        return self.logic["advance_rules_v3_kernel"](
            resolved, state, self.fields() if fields is None else fields, now_ms, **kwargs)

    @staticmethod
    def action_values(actions, target):
        return [item["value"] for item in actions if item["target"] == target]

    def test_01_transient_high_voltage_confirms_and_requires_30_recovery_observations(self):
        resolved = self.resolved(as_text=True)
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, actions, records = self.step(
            resolved, state, 0, self.fields(SupplyVoltage=270.0))
        self.assertEqual(records, [])
        state, actions, records = self.step(
            resolved, state, 1000, self.fields(SupplyVoltage=270.0))
        self.assertEqual([item["type"] for item in records], ["open"])
        self.assertEqual(self.action_values(actions, "PumpEnable"), [False])
        for index in range(29):
            state, actions, records = self.step(
                resolved, state, 2000 + index * 1000,
                self.fields(SupplyVoltage=240.0, PumpEnable=False))
            self.assertEqual(records, [])
        state, actions, records = self.step(
            resolved, state, 31000,
            self.fields(SupplyVoltage=240.0, PumpEnable=False))
        self.assertEqual([item["type"] for item in records], ["close"])
        self.assertEqual(self.action_values(actions, "PumpEnable"), [True])

    def test_02_dropped_atomic_source_record_freezes_recovery(self):
        resolved = self.resolved()
        complete = {
            "emeter/0.power": 2800.0, "emeter/0.voltage": 240.0,
            "emeter/0.pf": 0.95, "emeter/0.total": 123.0,
            "$availability": True,
        }
        accepted = self.logic["accept_rules_v3_device_record"](
            resolved, "shelly-em-main", complete)
        self.assertEqual(accepted["SupplyVoltage"], 240.0)
        incomplete = dict(complete)
        incomplete.pop("emeter/0.voltage")
        self.assertIsNone(self.logic["accept_rules_v3_device_record"](
            resolved, "shelly-em-main", incomplete))
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, _, _ = self.step(resolved, state, 0, self.fields(SupplyVoltage=270.0))
        state, _, _ = self.step(resolved, state, 1000, self.fields(SupplyVoltage=270.0))
        state, _, _ = self.step(
            resolved, state, 2000, self.fields(SupplyVoltage=240.0, PumpEnable=False))
        self.assertEqual(state["events"]["E007"]["closeCount"], 1)
        dropped = self.fields(PumpEnable=False)
        dropped.pop("SupplyVoltage")
        state, _, records = self.step(resolved, state, 3000, dropped)
        self.assertEqual(records, [])
        self.assertEqual(state["events"]["E007"]["closeCount"], 1)
        for index in range(29):
            state, _, records = self.step(
                resolved, state, 4000 + index * 1000,
                self.fields(SupplyVoltage=240.0, PumpEnable=False))
        self.assertEqual([item["type"] for item in records], ["close"])

    def test_03_overlapping_transient_owners_release_only_after_final_close(self):
        voltage = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                          "SupplyVoltage", "lt", 265)
        load = inhibit("LOAD", "PumpWatts", "lt", 500,
                       "PumpWatts", "gte", 500)
        resolved = self.resolved([voltage, load])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, actions, records = self.step(
            resolved, state, 0,
            self.fields(SupplyVoltage=270.0, PumpWatts=100.0))
        self.assertEqual(len(records), 2)
        self.assertEqual(len(state["owners"]["PumpEnable"]["instances"]), 2)
        state, actions, records = self.step(
            resolved, state, 1000,
            self.fields(SupplyVoltage=240.0, PumpWatts=100.0, PumpEnable=False))
        self.assertEqual([item["eventId"] for item in records], ["VOLTAGE"])
        self.assertEqual(len(state["owners"]["PumpEnable"]["instances"]), 1)
        self.assertNotIn(True, self.action_values(actions, "PumpEnable"))
        state, actions, records = self.step(
            resolved, state, 2000,
            self.fields(SupplyVoltage=240.0, PumpWatts=600.0, PumpEnable=False))
        self.assertNotIn("PumpEnable", state["owners"])
        self.assertEqual(self.action_values(actions, "PumpEnable"), [True])

    def test_04_transient_close_cannot_release_overlapping_latch(self):
        transient = inhibit("TRANSIENT", "SupplyVoltage", "gt", 265,
                            "SupplyVoltage", "lt", 265)
        latched = inhibit("LATCH", "PumpWatts", "lt", 500,
                          "PumpWatts", "gte", 500, event_class="latched")
        resolved = self.resolved([transient, latched])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, _, _ = self.step(
            resolved, state, 0, self.fields(SupplyVoltage=270.0, PumpWatts=100.0))
        state, actions, records = self.step(
            resolved, state, 1000,
            self.fields(SupplyVoltage=240.0, PumpWatts=600.0, PumpEnable=False))
        self.assertEqual([item["eventId"] for item in records], ["TRANSIENT"])
        self.assertTrue(state["events"]["LATCH"]["active"])
        self.assertNotIn(True, self.action_values(actions, "PumpEnable"))
        state, actions, records = self.step(
            resolved, state, 2000,
            self.fields(PumpEnable=False), clear_event_ids=["LATCH"])
        self.assertEqual(self.action_values(actions, "PumpEnable"), [True])

    def test_05_two_monitor_causes_return_normal_only_after_final_owner(self):
        operator = copy.deepcopy(self.fixture["events"][1])
        health = copy.deepcopy(self.fixture["events"][2])
        resolved = self.resolved([operator, health])
        state = self.logic["new_rules_v3_kernel"](resolved)
        occurrences = {"OperatorMonitorRequest": True, "ShellyEMUnavailable": True}
        state, actions, _ = self.step(
            resolved, state, 0, self.fields(ShellyEMAvailable=False),
            occurrences=occurrences)
        self.assertEqual(self.logic["rules_v3_effective_mode"](resolved, state), "Monitor")
        self.assertEqual(self.action_values(actions, "OperatingMode"), ["Monitor"])
        state, actions, _ = self.step(
            resolved, state, 1000, self.fields(ShellyEMAvailable=False),
            clear_event_ids=["M001"])
        self.assertEqual(self.logic["rules_v3_effective_mode"](resolved, state), "Monitor")
        self.assertEqual(self.action_values(actions, "OperatingMode"), [])
        state, actions, _ = self.step(
            resolved, state, 2000, self.fields(ShellyEMAvailable=True))
        self.assertEqual(self.logic["rules_v3_effective_mode"](resolved, state), "Normal")
        self.assertEqual(self.action_values(actions, "OperatingMode"), ["Normal"])

    def test_06_operator_normal_request_does_not_close_required_source_monitor(self):
        operator = copy.deepcopy(self.fixture["events"][1])
        health = copy.deepcopy(self.fixture["events"][2])
        resolved = self.resolved([operator, health])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, _, _ = self.step(
            resolved, state, 0, self.fields(ShellyEMAvailable=False),
            occurrences={"OperatorMonitorRequest": True, "ShellyEMUnavailable": True})
        state, _, records = self.step(
            resolved, state, 1000, self.fields(ShellyEMAvailable=False),
            clear_event_ids=["M001"])
        self.assertEqual([(item["eventId"], item["type"]) for item in records],
                         [("M001", "close")])
        self.assertTrue(state["events"]["H001"]["active"])
        self.assertEqual(self.logic["rules_v3_effective_mode"](resolved, state), "Monitor")

    def test_07_events_track_in_monitor_and_active_inhibit_applies_on_normal(self):
        operator = copy.deepcopy(self.fixture["events"][1])
        voltage = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                          "SupplyVoltage", "lt", 265)
        resolved = self.resolved([operator, voltage])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, _, _ = self.step(
            resolved, state, 0, occurrences={"OperatorMonitorRequest": True})
        state, actions, records = self.step(
            resolved, state, 1000, self.fields(SupplyVoltage=270.0, PumpEnable=True))
        self.assertEqual([item["eventId"] for item in records], ["VOLTAGE"])
        self.assertEqual(self.action_values(actions, "PumpEnable"), [])
        state, actions, records = self.step(
            resolved, state, 2000, self.fields(SupplyVoltage=270.0, PumpEnable=True),
            clear_event_ids=["M001"])
        self.assertEqual(self.logic["rules_v3_effective_mode"](resolved, state), "Normal")
        self.assertEqual(self.action_values(actions, "PumpEnable"), [False])

    def test_08_islocked_tri_state_gates_enable_selection(self):
        event = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                        "SupplyVoltage", "lt", 265)
        resolved = self.resolved([event])
        for lock_value, expected in ((15, []), (-1, []), (0, [True]), (None, [])):
            with self.subTest(lock_value=lock_value):
                state = self.logic["new_rules_v3_kernel"](resolved)
                state, _, _ = self.step(
                    resolved, state, 0,
                    self.fields(SupplyVoltage=270.0, PumpEnable=True))
                closing = self.fields(
                    SupplyVoltage=240.0, PumpEnable=False, IsLocked=lock_value)
                state, actions, records = self.step(resolved, state, 1000, closing)
                self.assertEqual([item["type"] for item in records], ["close"])
                self.assertEqual(self.action_values(actions, "PumpEnable"), expected)

    def test_09_shelly_timed_reenable_is_reasserted_off_with_active_owner(self):
        event = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                        "SupplyVoltage", "lt", 265)
        resolved = self.resolved([event])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, _, _ = self.step(
            resolved, state, 0, self.fields(SupplyVoltage=270.0, PumpEnable=True))
        state, actions, records = self.step(
            resolved, state, 1000, self.fields(SupplyVoltage=270.0, PumpEnable=True))
        self.assertEqual(records, [])
        self.assertEqual(self.action_values(actions, "PumpEnable"), [False])

    def test_10_restart_clears_board_then_persistent_evidence_reopens(self):
        event = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                        "SupplyVoltage", "lt", 265, count=2)
        resolved = self.resolved([event])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, _, _ = self.step(resolved, state, 0, self.fields(SupplyVoltage=270.0))
        state, _, records = self.step(resolved, state, 1000, self.fields(SupplyVoltage=270.0))
        self.assertEqual([item["type"] for item in records], ["open"])
        state = self.logic["restart_rules_v3_kernel"](resolved)
        self.assertEqual(state["owners"], {})
        self.assertFalse(state["events"]["VOLTAGE"]["active"])
        state, _, records = self.step(resolved, state, 2000, self.fields(SupplyVoltage=270.0))
        self.assertEqual(records, [])
        state, _, records = self.step(resolved, state, 3000, self.fields(SupplyVoltage=270.0))
        self.assertEqual([item["type"] for item in records], ["open"])

    def test_11_disabled_rule_does_not_reopen_after_restart(self):
        event = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                        "SupplyVoltage", "lt", 265)
        event["enabled"] = False
        resolved = self.resolved([event])
        state = self.logic["restart_rules_v3_kernel"](resolved)
        state, actions, records = self.step(
            resolved, state, 0, self.fields(SupplyVoltage=270.0))
        self.assertEqual(records, [])
        self.assertEqual(actions, [])
        self.assertFalse(state["events"]["VOLTAGE"]["active"])

    def test_12_guarded_groups_use_one_frozen_transition_snapshot(self):
        package = copy.deepcopy(self.fixture)
        package["systemFields"].extend([
            {"id": "guard-state", "systemName": "GuardState", "label": "Guard",
             "source": "session", "runtimeRole": "working", "type": "boolean",
             "unit": None, "initialValue": False, "logging": {"mode": "change"},
             "assignmentTarget": True},
            {"id": "guard-result", "systemName": "GuardResult", "label": "Result",
             "source": "session", "runtimeRole": "working", "type": "boolean",
             "unit": None, "initialValue": False, "logging": {"mode": "change"},
             "assignmentTarget": True},
        ])
        event = inhibit("GUARDED", "SupplyVoltage", "gt", 265,
                        "SupplyVoltage", "lt", 265)
        event["onOpen"] = {
            "assignments": [{"target": "GuardState", "value": True,
                             "ownership": "transition"}],
            "guardedGroups": [{
                "guard": {"mode": "all", "clauses": [{
                    "field": "GuardState", "operator": "eq", "value": False}]},
                "assignments": [{"target": "GuardResult", "value": True,
                                 "ownership": "transition"}],
            }],
        }
        package["events"] = [event]
        resolved = self.resolved(package=package)
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, actions, records = self.step(
            resolved, state, 0, self.fields(SupplyVoltage=270.0))
        selected = {(item["target"], item["value"]) for item in actions}
        self.assertIn(("GuardState", True), selected)
        self.assertIn(("GuardResult", True), selected)
        self.assertEqual([item["type"] for item in records], ["open"])

    def test_kernel_is_selection_only_and_not_connected_to_device_loop(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        names = set(FUNCTIONS)
        nodes = [node for node in tree.body
                 if isinstance(node, ast.FunctionDef) and node.name in names]
        kernel_source = "\n".join(ast.get_source_segment(source, node) for node in nodes)
        for forbidden in ("requests.", "cloud.", "Switch.Set", "issue_runtime_stop",
                          "SHELLY_1_STOP_URL", "socket."):
            self.assertNotIn(forbidden, kernel_source)
        loop_source = source[source.index("while True:"):]
        self.assertNotIn("advance_rules_v3_kernel", loop_source)


if __name__ == "__main__":
    unittest.main()
