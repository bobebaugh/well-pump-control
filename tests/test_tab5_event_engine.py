"""Host-only tests for the no-control M6.22 event lifecycle kernel."""

import ast
import pathlib
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
FUNCTIONS = {
    "new_rule_event_state",
    "_event_rule_latched",
    "_valid_event_rule_timing",
    "advance_rule_event",
}


def load_event_logic():
    source = PILOT_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)
    nodes = [node for node in tree.body
             if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
    namespace = {
        "time": types.SimpleNamespace(
            ticks_diff=lambda left, right: left - right,
        ),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]),
                 str(PILOT_PATH), "exec"), namespace)
    return namespace


def rule(response="Alert", confirm=2, clear=3, enabled=True):
    return {
        "id": "TEST001",
        "enabled": enabled,
        "response": response,
        "confirmSeconds": confirm,
        "clearSeconds": clear,
    }


class EventLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_event_logic()

    def fresh(self):
        return self.logic["new_rule_event_state"]("TEST001")

    def advance(self, policy, state, condition, now_ms):
        return self.logic["advance_rule_event"](
            policy, state, condition, now_ms)

    def test_continuous_confirmation_opens_once(self):
        policy = rule(confirm=2)
        state, transition = self.advance(policy, self.fresh(), True, 1000)
        self.assertEqual(state["phase"], "confirming")
        self.assertIsNone(transition)
        state, transition = self.advance(policy, state, True, 2999)
        self.assertIsNone(transition)
        state, transition = self.advance(policy, state, True, 3000)
        self.assertEqual(transition,
                         {"type": "open", "reason": "condition_confirmed"})
        self.assertTrue(state["active"])
        state, transition = self.advance(policy, state, True, 4000)
        self.assertIsNone(transition)

    def test_one_bad_or_unavailable_reading_does_not_open(self):
        policy = rule(confirm=2)
        state, _ = self.advance(policy, self.fresh(), True, 1000)
        state, transition = self.advance(policy, state, None, 2500)
        self.assertEqual(state["phase"], "inactive")
        self.assertIsNone(transition)
        state, _ = self.advance(policy, state, True, 3000)
        state, transition = self.advance(policy, state, True, 4999)
        self.assertIsNone(transition)

    def test_nonlatched_event_closes_only_after_continuous_clear(self):
        policy = rule(confirm=1, clear=3)
        state, _ = self.advance(policy, self.fresh(), True, 0)
        state, transition = self.advance(policy, state, True, 1000)
        self.assertEqual(transition["type"], "open")
        state, _ = self.advance(policy, state, False, 2000)
        self.assertEqual(state["phase"], "clearing")
        self.assertTrue(state["active"])
        state, transition = self.advance(policy, state, False, 4999)
        self.assertIsNone(transition)
        state, transition = self.advance(policy, state, False, 5000)
        self.assertEqual(transition,
                         {"type": "close", "reason": "condition_cleared"})
        self.assertFalse(state["active"])

    def test_recurrence_cancels_pending_clear(self):
        policy = rule(confirm=1, clear=3)
        state, _ = self.advance(policy, self.fresh(), True, 0)
        state, _ = self.advance(policy, state, True, 1000)
        state, _ = self.advance(policy, state, False, 2000)
        state, transition = self.advance(policy, state, True, 3000)
        self.assertEqual(state["phase"], "active")
        self.assertIsNone(transition)

    def test_latched_event_does_not_auto_close(self):
        policy = rule(response="Trip—latched/manual reset", confirm=1,
                      clear=1)
        state, _ = self.advance(policy, self.fresh(), True, 0)
        state, transition = self.advance(policy, state, True, 1000)
        self.assertEqual(transition["type"], "open")
        state, transition = self.advance(policy, state, False, 2000)
        self.assertEqual(state["phase"], "latched")
        self.assertTrue(state["active"])
        self.assertIsNone(transition)

    def test_unavailable_evidence_never_closes_an_active_event(self):
        policy = rule(confirm=1, clear=1)
        state, _ = self.advance(policy, self.fresh(), True, 0)
        state, _ = self.advance(policy, state, True, 1000)
        state, _ = self.advance(policy, state, False, 1500)
        state, transition = self.advance(policy, state, None, 3000)
        self.assertEqual(state["phase"], "active")
        self.assertTrue(state["active"])
        self.assertIsNone(transition)

    def test_disabling_rule_closes_any_open_event_as_rules_updated(self):
        policy = rule(confirm=1)
        state, _ = self.advance(policy, self.fresh(), True, 0)
        state, _ = self.advance(policy, state, True, 1000)
        disabled = dict(policy, enabled=False)
        state, transition = self.advance(disabled, state, True, 2000)
        self.assertEqual(transition,
                         {"type": "close", "reason": "rules_updated"})
        self.assertEqual(state["phase"], "inactive")

    def test_nonboolean_condition_values_are_rejected(self):
        with self.assertRaises(ValueError):
            self.advance(rule(), self.fresh(), 1, 1000)

    def test_kernel_has_no_transport_or_control_calls(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        node = next(item for item in tree.body
                    if isinstance(item, ast.FunctionDef) and
                    item.name == "advance_rule_event")
        calls = [item.func for item in ast.walk(node)
                 if isinstance(item, ast.Call)]
        names = {call.id for call in calls if isinstance(call, ast.Name)}
        attributes = {call.attr for call in calls
                      if isinstance(call, ast.Attribute)}
        self.assertFalse(names & {"open", "socket"})
        self.assertFalse(attributes & {
            "submit_durable_record", "submit_observation", "request",
            "relay", "set_relay",
        })


if __name__ == "__main__":
    unittest.main()
