"""Cutover, authoring and Monitor-timeline regressions for the Tab5IsLocked unit.

Covers the compatibility interlocks the coordinated cutover depends on, the
authoring restrictions on the inhibition target, three-valued evidence, and the
combined System Monitor / transient-inhibit timeline.
"""

import ast
import copy
import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).parents[1]
PILOT_PATH = ROOT / "tab5" / "pilot.py"
REVISED_PATH = ROOT / "tests" / "fixtures" / "rules-runtime-package-v3-checkpoint1.json"
LEGACY_PATH = ROOT / "tests" / "fixtures" / "rules-runtime-package-v3-legacy-control.json"

FUNCTIONS = {
    "_finite_number", "_v3_closed", "_v3_number", "_v3_integer", "_v3_name", "_v3_id",
    "_v3_scalar", "_v3_logging", "_v3_typed_value", "_v3_enum_values",
    "_v3_write_parameters", "_v3_field", "_v3_output", "_v3_system_field",
    "_v3_clause", "_v3_condition", "_v3_phase", "_v3_dependencies_acyclic",
    "_rules_v3_package_valid", "_rules_v3_runtime_supported", "resolve_rules_v3_package",
    "rules_v3_condition_value", "_rules_v3_clause_value",
    "_new_rules_v3_event_state", "new_rules_v3_kernel", "_copy_rules_v3_kernel",
    "_rules_v3_qualified", "_rules_v3_open_value", "_rules_v3_phase_assignments",
    "_rules_v3_add_owner", "_rules_v3_remove_owner", "_rules_v3_has_owner",
    "rules_v3_effective_mode", "_rules_v3_action", "_rules_v3_append_action",
    "advance_rules_v3_kernel", "restart_rules_v3_kernel",
    "rules_v3_collapse_actions", "operator_monitor_event_id",
    "operator_monitor_occurrence_field", "user_monitor_instance",
}
CONSTANTS = {
    "RULES_V3_SCHEMA_VERSION", "RULES_V3_PACKAGE_KIND", "RUNTIME_DIRECT_BINDINGS",
    "RULES_V3_INHIBITION_OBJECT", "RULES_V3_WRITE_SHAPES", "RULES_V3_SUPPORTED_WRITES",
    "RULES_V3_UNKNOWN",
}


def load_kernel():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = {t.id for t in node.targets if isinstance(t, ast.Name)}
            if names & CONSTANTS:
                nodes.append(node)
    namespace = {"ujson": json}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"),
         namespace)
    return namespace


class MutualPackageRejectionTests(unittest.TestCase):
    """The interlock the coordinated cutover and its rollback both rely on."""

    @classmethod
    def setUpClass(cls):
        cls.logic = load_kernel()
        cls.revised = json.loads(REVISED_PATH.read_text(encoding="utf-8"))
        cls.legacy = json.loads(LEGACY_PATH.read_text(encoding="utf-8"))

    def test_this_build_accepts_the_revised_package(self):
        resolved = self.logic["resolve_rules_v3_package"](copy.deepcopy(self.revised))
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved["inhibitionTarget"], "Tab5IsLocked")
        self.assertIsNone(resolved["pumpTarget"], "no relay write target survives")

    def test_this_build_rejects_the_legacy_relay_control_package(self):
        """New firmware must refuse a package that writes RLY0."""
        self.assertTrue(self.logic["_rules_v3_package_valid"](copy.deepcopy(self.legacy)),
                        "the legacy shape stays structurally valid")
        self.assertFalse(
            self.logic["_rules_v3_runtime_supported"](copy.deepcopy(self.legacy)),
            "structural validity is not runtime support")
        self.assertIsNone(
            self.logic["resolve_rules_v3_package"](copy.deepcopy(self.legacy)))

    def test_the_previous_build_rejects_the_revised_package(self):
        """Old firmware must refuse the revised package, so rollback is safe.

        The previous build's binding catalog has no UDF(Tab5IsLocked) entry at all,
        which is what makes its support gate reject the revised package.
        """
        previous = dict(self.logic["RUNTIME_DIRECT_BINDINGS"])
        previous["shelly-gen4-switch"] = {
            "SW(0)": ("boolean", None, "read"),
            "RLY(0)": ("boolean", None, "readWrite"),
            "UDF(IsLocked)": ("integer", "s", "read"),
            "$availability": ("boolean", None, "read"),
        }
        self.assertNotIn(self.logic["RULES_V3_INHIBITION_OBJECT"],
                         previous["shelly-gen4-switch"],
                         "the object the revised package writes did not exist then")
        restore = self.logic["RUNTIME_DIRECT_BINDINGS"]
        self.logic["RUNTIME_DIRECT_BINDINGS"] = previous
        try:
            # An unknown object fails the binding comparison before any write shape
            # is considered, which is the mechanism the rollback relies on. Only
            # that mechanism is asserted here: this build's own write gate is not
            # the previous build's, so it cannot stand in for one.
            self.assertFalse(self.logic["_rules_v3_runtime_supported"](
                copy.deepcopy(self.revised)))
        finally:
            self.logic["RUNTIME_DIRECT_BINDINGS"] = restore

    def test_a_relay_write_cannot_be_reintroduced_by_authoring(self):
        for shape in ({"method": "Switch.Set",
                       "parameters": {"id": 0, "valueParameter": "on"},
                       "normalValue": True},
                      {"method": "Boolean.Set",
                       "parameters": {"valueParameter": "value"},
                       "normalValue": False}):
            package = copy.deepcopy(self.revised)
            device = next(d for d in package["devices"]
                          if d["driver"] == "shelly-gen4-switch")
            relay = next(f for f in device["fields"] if f["object"] == "RLY(0)")
            relay["access"] = "readWrite"
            relay["write"] = shape
            self.assertFalse(self.logic["_rules_v3_runtime_supported"](package),
                             "RLY(0) is telemetry now, whatever method is named")

    def test_write_shapes_are_discriminated_by_method_and_stay_closed(self):
        check = self.logic["_v3_write_parameters"]
        self.assertTrue(check("Switch.Set", {"id": 0, "valueParameter": "on"}))
        self.assertTrue(check("Boolean.Set", {"valueParameter": "value"}))
        # An id is required where the method carries one and refused where it does not.
        self.assertFalse(check("Switch.Set", {"valueParameter": "on"}))
        self.assertFalse(check("Boolean.Set", {"id": 0, "valueParameter": "value"}))
        self.assertFalse(check("Boolean.Set", {"valueParameter": "value", "extra": 1}))
        self.assertFalse(check("Number.Set", {"valueParameter": "value"}))
        self.assertFalse(check("Switch.Set", {"id": 300, "valueParameter": "on"}))
        self.assertFalse(check("Switch.Set", {"id": True, "valueParameter": "on"}))

    def test_the_inhibition_flag_needs_its_exact_supported_write(self):
        for bad in ({"method": "Switch.Set",
                     "parameters": {"id": 0, "valueParameter": "on"},
                     "normalValue": False},
                    {"method": "Boolean.Set",
                     "parameters": {"valueParameter": "on"},
                     "normalValue": False},
                    {"method": "Boolean.Set",
                     "parameters": {"valueParameter": "value"},
                     "normalValue": True}):
            package = copy.deepcopy(self.revised)
            device = next(d for d in package["devices"]
                          if d["driver"] == "shelly-gen4-switch")
            flag = next(f for f in device["fields"]
                        if f["object"] == "UDF(Tab5IsLocked)")
            flag["write"] = bad
            self.assertFalse(self.logic["_rules_v3_runtime_supported"](package),
                             repr(bad))

    def test_an_alias_cannot_create_a_second_target_for_one_component(self):
        package = copy.deepcopy(self.revised)
        device = next(d for d in package["devices"]
                      if d["driver"] == "shelly-gen4-switch")
        flag = next(f for f in device["fields"] if f["object"] == "UDF(Tab5IsLocked)")
        alias = copy.deepcopy(flag)
        alias["systemName"] = "Tab5Inhibit"
        device["fields"].append(alias)
        self.assertIsNone(self.logic["resolve_rules_v3_package"](package),
                          "two writable aliases for one physical component")

    def test_the_target_is_resolved_by_binding_not_by_system_name(self):
        package = copy.deepcopy(self.revised)
        device = next(d for d in package["devices"]
                      if d["driver"] == "shelly-gen4-switch")
        flag = next(f for f in device["fields"] if f["object"] == "UDF(Tab5IsLocked)")
        flag["systemName"] = "RenamedByTheOwner"
        for event in package["events"]:
            for assignment in event["onOpen"]["assignments"]:
                if assignment["target"] == "Tab5IsLocked":
                    assignment["target"] = "RenamedByTheOwner"
        resolved = self.logic["resolve_rules_v3_package"](package)
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved["inhibitionTarget"], "RenamedByTheOwner")


class InhibitionAuthoringTests(unittest.TestCase):
    """Release is a consequence of ownership and mode, never an authored value."""

    @classmethod
    def setUpClass(cls):
        cls.logic = load_kernel()
        cls.revised = json.loads(REVISED_PATH.read_text(encoding="utf-8"))

    def package_with(self, phase, assignment, guarded=False):
        package = copy.deepcopy(self.revised)
        event = next(e for e in package["events"] if e["id"] == "E007")
        event["onOpen"] = {"assignments": [], "guardedGroups": []}
        event["onClose"] = {"assignments": [], "guardedGroups": []}
        if guarded:
            event[phase]["guardedGroups"] = [{
                "guard": {"mode": "all", "clauses": [
                    {"field": "ShellyEMAvailable", "operator": "eq", "value": True}]},
                "assignments": [assignment],
            }]
        else:
            event[phase]["assignments"] = [assignment]
        return package

    def test_the_only_legal_assignment_is_a_held_opening_request(self):
        legal = {"target": "Tab5IsLocked", "value": True, "ownership": "whileOpen"}
        self.assertTrue(self.logic["_rules_v3_package_valid"](
            self.package_with("onOpen", legal)))

    def test_illegal_assignment_forms_are_rejected(self):
        cases = [
            ("onOpen", {"target": "Tab5IsLocked", "value": True,
                        "ownership": "transition"}),
            ("onOpen", {"target": "Tab5IsLocked", "value": False,
                        "ownership": "whileOpen"}),
            ("onOpen", {"target": "Tab5IsLocked", "value": False,
                        "ownership": "transition"}),
            ("onClose", {"target": "Tab5IsLocked", "value": True,
                         "ownership": "transition"}),
            ("onClose", {"target": "Tab5IsLocked", "value": False,
                         "ownership": "transition"}),
        ]
        for phase, assignment in cases:
            for guarded in (False, True):
                package = self.package_with(phase, assignment, guarded=guarded)
                self.assertFalse(
                    self.logic["_rules_v3_package_valid"](package),
                    "{} {} guarded={}".format(phase, assignment, guarded))

    def test_a_guarded_group_may_still_hold_the_legal_form(self):
        legal = {"target": "Tab5IsLocked", "value": True, "ownership": "whileOpen"}
        self.assertTrue(self.logic["_rules_v3_package_valid"](
            self.package_with("onOpen", legal, guarded=True)))


class ThreeValuedEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_kernel()

    def value(self, mode, clauses, fields, previous=None):
        return self.logic["rules_v3_condition_value"](
            {"mode": mode, "clauses": clauses}, fields, previous)

    def test_a_definite_clause_decides_despite_unknown_siblings(self):
        volts = {"field": "SupplyVoltage", "operator": "lte", "value": 266}
        em_down = {"field": "ShellyEMAvailable", "operator": "eq", "value": False}
        em_up = {"field": "ShellyEMAvailable", "operator": "eq", "value": True}
        # any: one true decides even with no voltage evidence at all.
        self.assertIs(self.value("any", [volts, em_down],
                                 {"SupplyVoltage": None, "ShellyEMAvailable": False}), True)
        # all: one false decides the same way.
        self.assertIs(self.value("all", [volts, em_up],
                                 {"SupplyVoltage": None, "ShellyEMAvailable": False}), False)

    def test_an_unknown_clause_without_a_decider_stays_unavailable(self):
        volts = {"field": "SupplyVoltage", "operator": "lte", "value": 266}
        em_up = {"field": "ShellyEMAvailable", "operator": "eq", "value": True}
        self.assertIsNone(self.value("all", [volts, em_up],
                                     {"SupplyVoltage": None, "ShellyEMAvailable": True}))
        self.assertIsNone(self.value("any", [volts, em_up],
                                     {"SupplyVoltage": None, "ShellyEMAvailable": False}))

    def test_an_invalid_clause_is_never_rescued_by_a_definite_one(self):
        invalid = {"field": "PumpWatts", "operator": "gt", "value": 10}
        em_down = {"field": "ShellyEMAvailable", "operator": "eq", "value": False}
        em_up = {"field": "ShellyEMAvailable", "operator": "eq", "value": True}
        fields = {"PumpWatts": "not-a-number", "ShellyEMAvailable": False}
        # In either position, in either mode, and whichever way the sibling falls.
        for mode, other in (("any", em_down), ("all", em_up)):
            self.assertIsNone(self.value(mode, [invalid, other], fields))
            self.assertIsNone(self.value(mode, [other, invalid], fields))

    def test_unsupported_operators_and_shapes_still_reject_the_condition(self):
        fields = {"X": 1.0, "Y": True}
        self.assertIsNone(self.value("all", [{"field": "X", "operator": "??", "value": 1}],
                                     fields))
        self.assertIsNone(self.value("all", [{"field": "X", "operator": "between",
                                              "value": [1]}], fields))
        self.assertIsNone(self.value("all", ["not-a-clause"], fields))
        self.assertIsNone(self.value("weird", [{"field": "Y", "operator": "eq",
                                                "value": True}], fields))
        self.assertIsNone(self.value("all", [], fields))

    def test_changes_is_unknown_until_a_previous_value_exists(self):
        clause = {"field": "SupplyVoltage", "operator": "changes", "value": None}
        em_up = {"field": "ShellyEMAvailable", "operator": "eq", "value": True}
        present = {"SupplyVoltage": 244.0, "ShellyEMAvailable": True}
        self.assertIsNone(self.value("all", [clause], present, {}))
        # Unknown for the absence of history, not for the absence of a measurement.
        self.assertIs(self.value("all", [clause], present, {"SupplyVoltage": 240.0}), True)
        self.assertIs(self.value("all", [clause], present, {"SupplyVoltage": 244.0}), False)
        # And it still participates in three-valued aggregation.
        self.assertIs(self.value("all", [clause, em_up], present,
                                 {"SupplyVoltage": 244.0}), False)
        self.assertIsNone(self.value("all", [clause, em_up], present, {}))


class MonitorTimelineTests(unittest.TestCase):
    """The combined System Monitor and transient-inhibit sequence."""

    @classmethod
    def setUpClass(cls):
        cls.logic = load_kernel()
        cls.package = json.loads(REVISED_PATH.read_text(encoding="utf-8"))

    def setUp(self):
        self.resolved = self.logic["resolve_rules_v3_package"](
            copy.deepcopy(self.package))
        self.assertIsNotNone(self.resolved)

    def fields(self, voltage=240.0, em=True, flag=False, lock=0):
        return {"SupplyVoltage": voltage, "ShellyEMAvailable": em,
                "PumpWatts": 2800.0, "PumpEnable": True, "ContactorFlag": True,
                "Shelly1Available": True, "Tab5IsLocked": flag, "IsLocked": lock,
                "PowerFactor": 0.98, "ShellyEnergyWh": 10.0}

    def step(self, state, now_ms, fields, **kwargs):
        return self.logic["advance_rules_v3_kernel"](
            self.resolved, state, fields, now_ms, **kwargs)

    def flag_values(self, actions):
        return [a["value"] for a in actions if a["target"] == "Tab5IsLocked"]

    def test_combined_h001_e007_freeze_reassert_and_close(self):
        needed = next(e for e in self.resolved["events"]
                      if e["id"] == "E007")["closing"]["condition"]["observationCount"]
        state = self.logic["new_rules_v3_kernel"](self.resolved)
        now = 0

        # E007 qualifies and takes the inhibition.
        for _ in range(2):
            state, actions, records = self.step(state, now, self.fields(voltage=270.0))
            now += 1000
        self.assertTrue(state["events"]["E007"]["active"])
        self.assertEqual(self.flag_values(actions), [True])
        e007_instance = state["events"]["E007"]["instanceId"]

        # The electrical source drops out. H001 opens the same cycle and Monitor
        # releases the inhibition at this cycle's dispatch.
        state, actions, records = self.step(
            state, now, self.fields(em=False, voltage=270.0, flag=True))
        now += 1000
        self.assertIn("H001", [r["eventId"] for r in records])
        self.assertEqual(self.logic["rules_v3_effective_mode"](self.resolved, state),
                         "Monitor")
        self.assertEqual(self.flag_values(actions), [False], "Monitor releases")
        frozen_close_count = state["events"]["E007"]["closeCount"]

        # Suspension: E007 is not evaluated, so its clearing qualification freezes
        # instead of collecting its authored reads.
        for _ in range(needed + 5):
            state, actions, records = self.step(
                state, now, self.fields(em=False, voltage=240.0))
            now += 1000
            self.assertEqual(records, [])
            self.assertEqual(self.flag_values(actions), [])
        self.assertEqual(state["events"]["E007"]["closeCount"], frozen_close_count)
        self.assertTrue(state["events"]["E007"]["active"])
        self.assertEqual(state["events"]["E007"]["instanceId"], e007_instance)

        # Recovery: H001 closes and the retained ownership is reasserted in the
        # same exit cycle, before E007 resumes.
        state, actions, records = self.step(
            state, now, self.fields(em=True, voltage=240.0, flag=False))
        now += 1000
        self.assertEqual([r["eventId"] for r in records], ["H001"])
        self.assertEqual(self.logic["rules_v3_effective_mode"](self.resolved, state),
                         "Normal")
        self.assertEqual(self.flag_values(actions), [True], "retained ownership reasserts")
        self.assertTrue(state["events"]["E007"]["active"])

        # Only now does E007 collect its authored clearing reads.
        for index in range(needed - frozen_close_count - 1):
            state, actions, records = self.step(
                state, now, self.fields(voltage=240.0, flag=True))
            now += 1000
            self.assertEqual(records, [], "closed early at index {}".format(index))
        state, actions, records = self.step(
            state, now, self.fields(voltage=240.0, flag=True))
        self.assertEqual([(r["eventId"], r["type"]) for r in records],
                         [("E007", "close")])
        self.assertEqual(self.flag_values(actions), [False], "final owner released")

    def test_e007_closes_on_missing_em_when_h001_is_disabled(self):
        """The authored any-condition closing path, isolated from System Monitor.

        This is not the combined-package timeline; with H001 enabled, Monitor
        suspends E007 long before it collects these reads.
        """
        package = copy.deepcopy(self.package)
        for event in package["events"]:
            if event["id"] == "H001":
                event["enabled"] = False
        self.resolved = self.logic["resolve_rules_v3_package"](package)
        needed = next(e for e in self.resolved["events"]
                      if e["id"] == "E007")["closing"]["condition"]["observationCount"]
        state = self.logic["new_rules_v3_kernel"](self.resolved)
        now = 0
        for _ in range(2):
            state, actions, _ = self.step(state, now, self.fields(voltage=270.0))
            now += 1000
        self.assertTrue(state["events"]["E007"]["active"])
        # The source disappears: SupplyVoltage is unknown, but the availability
        # clause is definitely true, so the any-condition still decides.
        records = []
        for _ in range(needed):
            unavailable = self.fields(em=False, flag=True)
            unavailable.pop("SupplyVoltage")
            state, actions, records = self.step(state, now, unavailable)
            now += 1000
        self.assertEqual([(r["eventId"], r["type"]) for r in records],
                         [("E007", "close")])
        self.assertEqual(self.flag_values(actions), [False])

    def test_two_monitor_owners_and_system_recovery_cannot_exit_user_monitor(self):
        state = self.logic["new_rules_v3_kernel"](self.resolved)
        state, _, _ = self.step(state, 0, self.fields(em=False))
        state, _, _ = self.step(state, 1000, self.fields(em=False),
                                occurrences={"OperatorMonitorRequest": True})
        self.assertTrue(state["events"]["H001"]["active"])
        self.assertTrue(state["events"]["M001"]["active"])
        mode_target = self.resolved["operatingModeTarget"]
        self.assertEqual(len(state["owners"][mode_target]["instances"]), 2)
        state, _, records = self.step(state, 2000, self.fields(em=True))
        self.assertEqual([r["eventId"] for r in records], ["H001"])
        self.assertEqual(self.logic["rules_v3_effective_mode"](self.resolved, state),
                         "Monitor", "User Monitor survives System recovery")

    def test_monitor_release_survives_the_ordinary_action_collapse(self):
        """Collapse prefers a non-normal value; the flag's normal value is false."""
        collapse = self.logic["rules_v3_collapse_actions"]
        resolved = {"writableTargets": {"Tab5IsLocked": {"normalValue": False}}}
        selected, _ = collapse(resolved, [
            {"target": "Tab5IsLocked", "value": True, "reason": "event-transition"},
            {"target": "Tab5IsLocked", "value": False, "reason": "monitor-release"}])
        self.assertEqual([a["value"] for a in selected], [True],
                         "collapse alone would keep the inhibit")

        # The kernel therefore removes competing actions before appending the
        # reconciled value, so a release reaches dispatch intact.
        state = self.logic["new_rules_v3_kernel"](self.resolved)
        state, _, _ = self.step(state, 0, self.fields(voltage=270.0))
        state, actions, _ = self.step(state, 1000, self.fields(voltage=270.0))
        self.assertEqual(self.flag_values(actions), [True])
        state, actions, _ = self.step(
            state, 2000, self.fields(voltage=270.0, flag=True),
            occurrences={"OperatorMonitorRequest": True})
        self.assertEqual(self.flag_values(actions), [False],
                         "exactly one flag action, and it is the release")

    def test_a_fresh_runtime_reconciles_an_old_true_flag_to_false(self):
        """Restart keeps no owners, so a flag left set on the device is cleared."""
        state = self.logic["restart_rules_v3_kernel"](self.resolved)
        self.assertEqual(state["owners"], {})
        state, actions, records = self.step(state, 0, self.fields(flag=True))
        self.assertEqual(self.flag_values(actions), [False])
        self.assertEqual(records, [])

    def test_unavailable_evidence_produces_no_flag_action(self):
        """Reconciliation resumes when communication returns; it is never guessed."""
        state = self.logic["new_rules_v3_kernel"](self.resolved)
        state, _, _ = self.step(state, 0, self.fields(voltage=270.0))
        state, actions, _ = self.step(state, 1000, self.fields(voltage=270.0))
        self.assertEqual(self.flag_values(actions), [True])
        blind = self.fields(voltage=270.0)
        blind.pop("Tab5IsLocked")
        state, actions, _ = self.step(state, 2000, blind)
        self.assertEqual(self.flag_values(actions), [],
                         "no write without evidence of the current value")
        state, actions, _ = self.step(state, 3000, self.fields(voltage=270.0, flag=False))
        self.assertEqual(self.flag_values(actions), [True], "and it resumes")

    def test_unrelated_transition_assignments_keep_their_behavior(self):
        """Only the named target is reconciled."""
        package = copy.deepcopy(self.package)
        package["systemFields"].append({
            "id": "working-counter", "systemName": "WorkingFlag", "label": "Working flag",
            "source": "session", "runtimeRole": "working", "type": "boolean",
            "unit": None, "logging": {"mode": "none"}, "initialValue": False,
            "assignmentTarget": True,
        })
        event = next(e for e in package["events"] if e["id"] == "E007")
        event["onOpen"]["assignments"].append(
            {"target": "WorkingFlag", "value": True, "ownership": "transition"})
        self.resolved = self.logic["resolve_rules_v3_package"](package)
        self.assertIsNotNone(self.resolved)
        state = self.logic["new_rules_v3_kernel"](self.resolved)
        state, _, _ = self.step(state, 0, self.fields(voltage=270.0))
        state, actions, _ = self.step(state, 1000, self.fields(voltage=270.0))
        self.assertIn(("WorkingFlag", True),
                      [(a["target"], a["value"]) for a in actions],
                      "an unrelated transition assignment is not reconciled away")
        self.assertEqual(self.flag_values(actions), [True])


class UserMonitorAttributionTests(unittest.TestCase):
    """A System Monitor must never complete a user-issued command."""

    @classmethod
    def setUpClass(cls):
        cls.logic = load_kernel()
        cls.package = json.loads(REVISED_PATH.read_text(encoding="utf-8"))

    def setUp(self):
        self.resolved = self.logic["resolve_rules_v3_package"](
            copy.deepcopy(self.package))

    def fields(self, em=True):
        return {"SupplyVoltage": 240.0, "ShellyEMAvailable": em, "PumpWatts": 2800.0,
                "PumpEnable": True, "ContactorFlag": True, "Shelly1Available": True,
                "Tab5IsLocked": False, "IsLocked": 0, "PowerFactor": 0.98,
                "ShellyEnergyWh": 10.0}

    def test_the_manual_monitor_event_is_identified_separately(self):
        self.assertEqual(self.logic["operator_monitor_event_id"](self.resolved), "M001")
        self.assertEqual(
            self.logic["operator_monitor_occurrence_field"](self.resolved),
            "OperatorMonitorRequest")
        self.assertIsNone(self.logic["operator_monitor_event_id"](None))

    def test_system_monitor_does_not_produce_a_user_monitor_instance(self):
        state = self.logic["new_rules_v3_kernel"](self.resolved)
        state, _, _ = self.logic["advance_rules_v3_kernel"](
            self.resolved, state, self.fields(em=False), 0)
        runtime = {"resolved": self.resolved, "kernel": state}
        self.assertEqual(self.logic["rules_v3_effective_mode"](self.resolved, state),
                         "Monitor", "mode alone is satisfied by H001")
        self.assertIsNone(self.logic["user_monitor_instance"](runtime, "M001"),
                          "but the user's event never opened")

    def test_a_user_request_yields_its_own_instance(self):
        state = self.logic["new_rules_v3_kernel"](self.resolved)
        state, _, _ = self.logic["advance_rules_v3_kernel"](
            self.resolved, state, self.fields(), 0,
            occurrences={"OperatorMonitorRequest": True})
        runtime = {"resolved": self.resolved, "kernel": state}
        instance = self.logic["user_monitor_instance"](runtime, "M001")
        self.assertIsNotNone(instance)
        self.assertEqual(instance, state["events"]["M001"]["instanceId"])
        # It survives a System Monitor arriving afterwards, and stays the same.
        state, _, _ = self.logic["advance_rules_v3_kernel"](
            self.resolved, state, self.fields(em=False), 1000)
        runtime = {"resolved": self.resolved, "kernel": state}
        self.assertEqual(self.logic["user_monitor_instance"](runtime, "M001"), instance)

    def test_a_restart_ends_the_user_monitor_instance(self):
        state = self.logic["new_rules_v3_kernel"](self.resolved)
        state, _, _ = self.logic["advance_rules_v3_kernel"](
            self.resolved, state, self.fields(), 0,
            occurrences={"OperatorMonitorRequest": True})
        restarted = self.logic["restart_rules_v3_kernel"](self.resolved)
        self.assertIsNone(self.logic["user_monitor_instance"](
            {"resolved": self.resolved, "kernel": restarted}, "M001"))


if __name__ == "__main__":
    unittest.main()
