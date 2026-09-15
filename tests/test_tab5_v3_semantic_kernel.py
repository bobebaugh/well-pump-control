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
    "_finite_number", "_v3_closed", "_v3_number", "_v3_integer", "_v3_name", "_v3_id",
    "_v3_scalar", "_v3_logging", "_v3_typed_value", "_v3_enum_values",
    "_v3_field", "_v3_output", "_v3_system_field", "_v3_clause",
    "_v3_write_parameters", "_rules_v3_clause_value",
    "_v3_condition", "_v3_phase", "_v3_dependencies_acyclic",
    "_rules_v3_package_valid", "_rules_v3_runtime_supported", "resolve_rules_v3_package",
    "accept_rules_v3_device_record", "freeze_rules_v3_snapshot",
    "rules_v3_condition_value", "_new_rules_v3_event_state",
    "new_rules_v3_kernel", "_copy_rules_v3_kernel", "_rules_v3_qualified",
    "_rules_v3_open_value", "_rules_v3_phase_assignments",
    "_rules_v3_add_owner", "_rules_v3_remove_owner", "_rules_v3_has_owner",
    "rules_v3_effective_mode", "_rules_v3_action", "_rules_v3_append_action",
    "advance_rules_v3_kernel", "restart_rules_v3_kernel",
    "rules_v3_acquisition_availability",
}
CONSTANTS = {"RULES_V3_SCHEMA_VERSION", "RULES_V3_PACKAGE_KIND",
             "RULES_V3_INHIBITION_OBJECT", "RULES_V3_WRITE_SHAPES",
             "RULES_V3_SUPPORTED_WRITES", "RULES_V3_UNKNOWN",
             "RUNTIME_DIRECT_BINDINGS"}


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
            "target": "Tab5IsLocked", "value": True, "ownership": "whileOpen",
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
            "Tab5IsLocked": False,
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

    def closing_count(self, resolved, event_id):
        """Read the authored qualification instead of restating it in the test."""
        event = next(item for item in resolved["events"] if item["id"] == event_id)
        return event["closing"]["condition"]["observationCount"]

    def test_01_transient_high_voltage_confirms_and_requires_authored_recovery(self):
        resolved = self.resolved(as_text=True)
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, actions, records = self.step(
            resolved, state, 0, self.fields(SupplyVoltage=270.0))
        self.assertEqual(records, [])
        state, actions, records = self.step(
            resolved, state, 1000, self.fields(SupplyVoltage=270.0))
        self.assertEqual([item["type"] for item in records], ["open"])
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [True])
        needed = self.closing_count(resolved, "E007")
        for index in range(needed - 1):
            state, actions, records = self.step(
                resolved, state, 2000 + index * 1000,
                self.fields(SupplyVoltage=240.0, Tab5IsLocked=True))
            self.assertEqual(records, [], "closed before the authored count")
        state, actions, records = self.step(
            resolved, state, 2000 + needed * 1000,
            self.fields(SupplyVoltage=240.0, Tab5IsLocked=True))
        self.assertEqual([item["type"] for item in records], ["close"])
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [False])

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
            resolved, state, 2000, self.fields(SupplyVoltage=240.0, Tab5IsLocked=True))
        self.assertEqual(state["events"]["E007"]["closeCount"], 1)
        dropped = self.fields(Tab5IsLocked=True)
        dropped.pop("SupplyVoltage")
        state, _, records = self.step(resolved, state, 3000, dropped)
        self.assertEqual(records, [])
        self.assertEqual(state["events"]["E007"]["closeCount"], 1)
        for index in range(self.closing_count(resolved, "E007") - 1):
            state, _, records = self.step(
                resolved, state, 4000 + index * 1000,
                self.fields(SupplyVoltage=240.0, Tab5IsLocked=True))
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
        self.assertEqual(len(state["owners"]["Tab5IsLocked"]["instances"]), 2)
        state, actions, records = self.step(
            resolved, state, 1000,
            self.fields(SupplyVoltage=240.0, PumpWatts=100.0, Tab5IsLocked=True))
        self.assertEqual([item["eventId"] for item in records], ["VOLTAGE"])
        self.assertEqual(len(state["owners"]["Tab5IsLocked"]["instances"]), 1)
        self.assertNotIn(False, self.action_values(actions, "Tab5IsLocked"))
        state, actions, records = self.step(
            resolved, state, 2000,
            self.fields(SupplyVoltage=240.0, PumpWatts=600.0, Tab5IsLocked=True))
        self.assertNotIn("Tab5IsLocked", state["owners"])
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [False])

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
            self.fields(SupplyVoltage=240.0, PumpWatts=600.0, Tab5IsLocked=True))
        self.assertEqual([item["eventId"] for item in records], ["TRANSIENT"])
        self.assertTrue(state["events"]["LATCH"]["active"])
        self.assertNotIn(False, self.action_values(actions, "Tab5IsLocked"))
        state, actions, records = self.step(
            resolved, state, 2000,
            self.fields(Tab5IsLocked=True), clear_event_ids=["LATCH"])
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [False])

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

    def test_07_non_monitor_events_are_not_evaluated_in_monitor(self):
        """In Monitor a non-monitor event is not evaluated at all.

        Its qualification neither advances nor resets, so a condition that arises
        during Monitor cannot open one, and the state it had on entry survives.
        """
        operator = copy.deepcopy(self.fixture["events"][1])
        voltage = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                          "SupplyVoltage", "lt", 265)
        resolved = self.resolved([operator, voltage])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, _, _ = self.step(
            resolved, state, 0, occurrences={"OperatorMonitorRequest": True})
        self.assertEqual(self.logic["rules_v3_effective_mode"](resolved, state), "Monitor")
        for step_ms in (1000, 2000, 3000):
            state, actions, records = self.step(
                resolved, state, step_ms, self.fields(SupplyVoltage=270.0))
            self.assertEqual(records, [], "a suspended event must not open")
            self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [])
        self.assertFalse(state["events"]["VOLTAGE"]["active"])
        self.assertEqual(state["events"]["VOLTAGE"]["openCount"], 0,
                         "qualification is frozen, not advanced")
        # Leaving Monitor resumes evaluation on the following cycle.
        state, actions, records = self.step(
            resolved, state, 4000, self.fields(SupplyVoltage=270.0),
            clear_event_ids=["M001"])
        self.assertEqual(self.logic["rules_v3_effective_mode"](resolved, state), "Normal")
        self.assertEqual([item["eventId"] for item in records], ["M001"],
                         "the exit cycle still evaluates monitor events only")
        state, actions, records = self.step(
            resolved, state, 5000, self.fields(SupplyVoltage=270.0))
        self.assertEqual([item["eventId"] for item in records], ["VOLTAGE"])
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [True])

    def test_retained_event_is_not_closed_or_erased_by_monitor_suspension(self):
        """An event open on entry keeps its instance and owner through Monitor.

        Suppression releases the physical inhibition; it never fabricates a close
        and never discards the ownership that will be reasserted on exit.
        """
        operator = copy.deepcopy(self.fixture["events"][1])
        voltage = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                          "SupplyVoltage", "lt", 265)
        resolved = self.resolved([operator, voltage])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, actions, _ = self.step(
            resolved, state, 0, self.fields(SupplyVoltage=270.0))
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [True])
        instance = state["events"]["VOLTAGE"]["instanceId"]
        state, actions, records = self.step(
            resolved, state, 1000, self.fields(SupplyVoltage=270.0, Tab5IsLocked=True),
            occurrences={"OperatorMonitorRequest": True})
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [False])
        # The opening condition clears while suspended: still no close is recorded.
        for step_ms in (2000, 3000, 4000):
            state, actions, records = self.step(
                resolved, state, step_ms, self.fields(SupplyVoltage=240.0))
            self.assertEqual(records, [], "suspension must not fabricate a close")
            self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [])
        self.assertTrue(state["events"]["VOLTAGE"]["active"])
        self.assertEqual(state["events"]["VOLTAGE"]["instanceId"], instance)
        self.assertIn("Tab5IsLocked", state["owners"])
        self.assertEqual(self.logic["rules_v3_effective_mode"](resolved, state),
                         "Monitor")

    def test_08_releasing_the_flag_does_not_depend_on_shelly_lock_evidence(self):
        """Tab5 releases only its own intent; the Shelly lock is not Tab5's to read.

        Under the previous design Tab5 re-closed RLY0 itself, so it refused without
        fresh `IsLocked == 0`. Tab5 no longer writes the relay: withdrawing its flag
        states only that Tab5 is done inhibiting. A nonzero or unavailable Shelly
        lock still holds RLY0 open, which the Shelly script enforces and
        tests/shelly1-anti-chatter.test.js covers.
        """
        event = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                        "SupplyVoltage", "lt", 265)
        resolved = self.resolved([event])
        for lock_value in (15, -1, 0, None):
            with self.subTest(lock_value=lock_value):
                state = self.logic["new_rules_v3_kernel"](resolved)
                state, _, _ = self.step(
                    resolved, state, 0, self.fields(SupplyVoltage=270.0))
                closing = self.fields(
                    SupplyVoltage=240.0, Tab5IsLocked=True, IsLocked=lock_value)
                state, actions, records = self.step(resolved, state, 1000, closing)
                self.assertEqual([item["type"] for item in records], ["close"])
                self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [False])
                self.assertNotIn("Tab5IsLocked", state["owners"])

    def test_monitor_releases_existing_inhibit_without_closing_its_event(self):
        operator = copy.deepcopy(self.fixture["events"][1])
        voltage = inhibit("VOLTAGE", "SupplyVoltage", "gt", 265,
                          "SupplyVoltage", "lt", 265)
        resolved = self.resolved([operator, voltage])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, actions, _ = self.step(
            resolved, state, 0,
            self.fields(SupplyVoltage=270.0, PumpEnable=True, IsLocked=0))
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [True])
        state, actions, records = self.step(
            resolved, state, 1000,
            self.fields(SupplyVoltage=270.0, Tab5IsLocked=True, IsLocked=0),
            occurrences={"OperatorMonitorRequest": True})
        self.assertTrue(state["events"]["VOLTAGE"]["active"])
        self.assertNotIn(("VOLTAGE", "close"),
                         [(item["eventId"], item["type"]) for item in records])
        self.assertEqual(self.logic["rules_v3_effective_mode"](resolved, state),
                         "Monitor")
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [False])

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
        self.assertEqual(self.action_values(actions, "Tab5IsLocked"), [True])

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

    def test_missing_telemetry_never_releases_existing_latched_inhibit(self):
        event = inhibit("LATCH", "PumpWatts", "lt", 500,
                        "PumpWatts", "gte", 500, event_class="latched")
        resolved = self.resolved([event])
        state = self.logic["new_rules_v3_kernel"](resolved)
        state, _, records = self.step(
            resolved, state, 0, self.fields(PumpWatts=100.0, PumpEnable=True))
        self.assertEqual([item["type"] for item in records], ["open"])
        missing = self.fields(Tab5IsLocked=True)
        missing.pop("PumpWatts")
        state, actions, records = self.step(resolved, state, 1000, missing)
        self.assertTrue(state["events"]["LATCH"]["active"])
        self.assertEqual(records, [])
        self.assertNotIn(False, self.action_values(actions, "Tab5IsLocked"))

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

    def test_kernel_stays_pure_while_the_executor_does_the_acting(self):
        """The kernel selects and never performs I/O; a separate executor acts.

        The engine is now deliberately connected to the device loop, so the
        earlier "not connected" assertion has been inverted. What still must
        hold is the separation: selection logic stays free of device calls.
        """
        source = PILOT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        names = set(FUNCTIONS) - {"_rules_v3_runtime_supported"}
        nodes = [node for node in tree.body
                 if isinstance(node, ast.FunctionDef) and node.name in names]
        kernel_source = "\n".join(ast.get_source_segment(source, node) for node in nodes)
        for forbidden in ("requests.", "cloud.", "Switch.Set", "issue_runtime_stop",
                          "SHELLY_1_STOP_URL", "socket."):
            self.assertNotIn(forbidden, kernel_source)
        # The engine is wired in, and issuing is a separate call from selecting.
        loop_source = source[source.index("while True:"):]
        self.assertIn("run_rules_v3_cycle", loop_source)
        self.assertIn("dispatch_rules_v3_actions", loop_source)
        self.assertNotIn("issue_rules_v3_action", kernel_source)

    def test_conflicting_actions_collapse_to_the_non_normal_value(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        nodes = [node for node in tree.body
                 if isinstance(node, ast.FunctionDef)
                 and node.name == "rules_v3_collapse_actions"]
        namespace = {}
        exec(compile(ast.Module(body=nodes, type_ignores=[]),
                     str(PILOT_PATH), "exec"), namespace)
        collapse = namespace["rules_v3_collapse_actions"]
        resolved = {"writableTargets": {"PumpEnable": {"normalValue": True}}}
        keep, dropped = collapse(resolved, [
            {"target": "PumpEnable", "value": True, "reason": "owner-release"},
            {"target": "PumpEnable", "value": False, "reason": "active-ownership"},
        ])
        self.assertEqual([(a["target"], a["value"]) for a in keep],
                         [("PumpEnable", False)])
        self.assertEqual([(a["target"], a["value"]) for a in dropped],
                         [("PumpEnable", True)])



class AcquisitionReadinessGateTests(unittest.TestCase):
    """Reboot sequence: CPU B holds network traffic while CPU A is already cycling.

    With the polls skipped, the observation reported the Shelly devices as
    unavailable rather than not-yet-attempted, and V3 evaluated that immediately
    against a fresh kernel. Availability events could open on every reboot and
    close again once polling began - newly generated events, not restored ones.

    The gate is narrow on purpose. Cycles before the first PERMITTED acquisition
    present availability as unknown, so qualification neither advances nor
    resets. Every protective event still begins evaluating on the first real
    acquisition, so lock reassertion stays as timely as it was.
    """

    @classmethod
    def setUpClass(cls):
        cls.kernel = load_kernel()
        package = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        cls.resolved = cls.kernel["resolve_rules_v3_package"](package)
        assert cls.resolved is not None
        cls.names = []
        for device in cls.resolved["devices"].values():
            if device.get("enabled") is not True:
                continue
            for field in device.get("fields", []):
                if field.get("object") == "$availability":
                    cls.names.append(field["systemName"])

    def availability(self, accepted, begun):
        return self.kernel["rules_v3_acquisition_availability"](
            self.resolved, accepted, begun)

    def test_before_the_first_attempt_availability_is_absent_not_false(self):
        self.assertTrue(self.names, "the fixture must declare $availability fields")
        values = self.availability({}, False)
        for name in self.names:
            self.assertNotIn(name, values,
                             "absent reads as unknown; False would be a claim")

    def test_after_the_first_attempt_a_missing_device_is_definitely_false(self):
        values = self.availability({}, True)
        for name in self.names:
            self.assertIs(values.get(name), False)

    def test_real_evidence_outranks_the_gate(self):
        # A device that answered is available whatever the startup flag says.
        device_id = next(iter(self.resolved["devices"]))
        values = self.availability({device_id: {}}, False)
        for field in self.resolved["devices"][device_id].get("fields", []):
            if field.get("object") == "$availability":
                self.assertIs(values.get(field["systemName"]), True)

    def test_the_default_preserves_the_pre_gate_behaviour(self):
        # An observation carrying no startup evidence must behave as before.
        plain = self.kernel["rules_v3_acquisition_availability"](self.resolved, {})
        for name in self.names:
            self.assertIs(plain.get(name), False)

    def test_an_unknown_availability_clause_is_unknown_not_false(self):
        clause = {"field": self.names[0], "operator": "eq", "value": False}
        evaluate = self.kernel["_rules_v3_clause_value"]
        self.assertIs(evaluate(clause, self.availability({}, False), {}, {}),
                      self.kernel["RULES_V3_UNKNOWN"])
        self.assertIs(evaluate(clause, self.availability({}, True), {}, {}), True)

    def test_unknown_freezes_qualification_rather_than_advancing_or_resetting(self):
        # The point of the gate: a held-traffic cycle must neither open an event
        # nor clear progress an earlier cycle made toward opening one.
        advance = self.kernel["advance_rules_v3_kernel"]
        copy_kernel = self.kernel["_copy_rules_v3_kernel"]
        event = next(e for e in self.resolved["events"]
                     if e["enabled"] is True
                     and e["opening"]["trigger"]["type"] == "condition")
        fresh = self.kernel["new_rules_v3_kernel"](self.resolved)

        held, _actions, _records = advance(self.resolved, fresh, {}, 1000)
        self.assertEqual(held["events"][event["id"]]["openCount"], 0)
        self.assertIsNot(held["events"][event["id"]].get("active"), True)

        primed = copy_kernel(held, self.resolved)
        primed["events"][event["id"]]["openCount"] = 1
        primed["events"][event["id"]]["openSinceMs"] = 500
        after, _actions, _records = advance(self.resolved, primed, {}, 2000)
        state = after["events"][event["id"]]
        self.assertEqual(state["openCount"], 1, "unknown must not advance the count")
        self.assertEqual(state["openSinceMs"], 500, "nor reset the qualification clock")
        self.assertIsNot(state.get("active"), True, "and must never open the event")

    def test_a_definite_false_still_resets_so_the_gate_broke_nothing(self):
        advance = self.kernel["advance_rules_v3_kernel"]
        copy_kernel = self.kernel["_copy_rules_v3_kernel"]
        event = next(e for e in self.resolved["events"]
                     if e["enabled"] is True
                     and e["opening"]["trigger"]["type"] == "condition")
        clauses = event["opening"]["trigger"]["condition"]["clauses"]
        mode = event["opening"]["trigger"]["condition"]["mode"]
        if mode != "all":
            self.skipTest("needs an all-mode opening trigger to force one false")
        # Make the first clause definitely false while leaving the rest unknown;
        # for 'all' that is decisive, so the count must reset rather than freeze.
        clause = clauses[0]
        opposite = {"eq": "neq", "neq": "eq"}.get(clause["operator"])
        if opposite is None:
            fields = {clause["field"]: clause["value"]}
            if clause["operator"] in ("gt", "gte"):
                fields = {clause["field"]: clause["value"] - 1000}
            elif clause["operator"] in ("lt", "lte"):
                fields = {clause["field"]: clause["value"] + 1000}
            else:
                self.skipTest("clause operator not trivially falsifiable")
        else:
            fields = {clause["field"]: clause["value"]
                      if clause["operator"] == "neq" else "\x00not-it"}
        primed = copy_kernel(self.kernel["new_rules_v3_kernel"](self.resolved),
                             self.resolved)
        primed["events"][event["id"]]["openCount"] = 2
        primed["events"][event["id"]]["openSinceMs"] = 500
        after, _actions, _records = advance(self.resolved, primed, fields, 2000)
        self.assertEqual(after["events"][event["id"]]["openCount"], 0)
        self.assertIsNone(after["events"][event["id"]]["openSinceMs"])


if __name__ == "__main__":
    unittest.main()
