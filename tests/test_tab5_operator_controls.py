"""Host-only outcomes for short-lived operator controls and restart RPCs."""

import ast
import json
import pathlib
import types
import unittest


ROOT = pathlib.Path(__file__).parents[1]
PILOT_PATH = ROOT / "tab5" / "pilot.py"
FIXTURE = ROOT / "tests" / "fixtures" / "rules-runtime-package-v3-checkpoint1.json"
FUNCTIONS = {
    "operator_command_execution_decision", "operator_result",
    "operator_monitor_occurrence_field", "shelly1_restart_request",
    "shelly_restart_confirmation", "_utc_tuple_epoch_ms", "utc_epoch_ms",
}
CONSTANTS = {
    "OPERATOR_COMMAND_LIFETIME_MS", "SITE_ID", "DEVICE_ID",
    "SHELLY_1_RESTART_URL", "SHELLY_TIMEOUT_S", "SHELLY_RESTART_CONFIRM_MS",
}


def load_logic():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if names & CONSTANTS:
                nodes.append(node)
    namespace = {
        "requests": types.SimpleNamespace(get=None),
        "time": types.SimpleNamespace(
            ticks_diff=lambda left, right: left - right,
            localtime=lambda: (2027, 1, 15, 8, 0, 0, 4, 15),
        ),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"), namespace)
    return namespace


def command(**changes):
    value = {
        "commandId": "op_1234567890abcdef", "commandSequence": 7,
        "targetSessionId": "boot_AAAAAAAA", "commandType": "restart-tab5",
        "requestedAtMs": 1_800_000_000_000,
        "expiresAtMs": 1_800_000_045_000,
    }
    value.update(changes)
    return value


class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self.body = {} if body is None else body
        self.closed = False

    def json(self):
        return self.body

    def close(self):
        self.closed = True


class OperatorControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_logic()

    def test_execution_boundary_accepts_only_fresh_current_session_once(self):
        decide = self.logic["operator_command_execution_decision"]
        fresh = command()
        self.assertEqual(decide(fresh, "boot_AAAAAAAA", 1_800_000_001_000, True),
                         ("accepted", "execution-boundary-accepted"))
        self.assertEqual(decide(fresh, "boot_BBBBBBBB", 1_800_000_001_000, True)[1],
                         "old-session")
        self.assertEqual(decide(fresh, "boot_AAAAAAAA", 1_800_000_046_000, True)[1],
                         "command-expired")
        self.assertEqual(decide(fresh, "boot_AAAAAAAA", 1_800_000_001_000, True,
                                7, fresh["commandId"])[1], "duplicate-command")
        newer = command(commandId="op_BBBBBBBBBBBBBBBB", commandSequence=8)
        self.assertEqual(decide(newer, "boot_AAAAAAAA", 1_800_000_001_000, True,
                                7, fresh["commandId"])[0], "accepted")
        self.assertEqual(decide(fresh, "boot_AAAAAAAA", 1_800_000_001_000, True,
                                8, newer["commandId"])[1],
                         "stale-command-sequence")
        older_different = command(
            commandId="op_CCCCCCCCCCCCCCCC", commandSequence=6)
        self.assertEqual(decide(
            older_different, "boot_AAAAAAAA", 1_800_000_001_000, True,
            8, newer["commandId"])[1], "stale-command-sequence")
        self.assertEqual(decide(fresh, "boot_AAAAAAAA", None, False)[1],
                         "clock-not-synchronized")

    def test_expiry_clock_uses_unix_utc_without_embedded_epoch_assumption(self):
        convert = self.logic["_utc_tuple_epoch_ms"]
        self.assertEqual(convert((1970, 1, 1, 0, 0, 0)), 0)
        self.assertEqual(convert((2000, 1, 1, 0, 0, 0)), 946684800000)
        self.assertEqual(convert((2027, 1, 15, 8, 0, 0)), 1800000000000)
        self.assertEqual(self.logic["utc_epoch_ms"](True), 1800000000000)
        self.assertIsNone(self.logic["utc_epoch_ms"](False))

    def test_result_does_not_fabricate_relay_restoration(self):
        result = self.logic["operator_result"](
            command(commandType="enter-user-monitor"), "boot_AAAAAAAA",
            "confirmed-completed", "monitor-active", "unconfirmed")
        self.assertEqual(result["outcome"], "confirmed-completed")
        self.assertEqual(result["relayRestoration"], "unconfirmed")
        self.assertEqual(result["reportingSessionId"], "boot_AAAAAAAA")

    def test_monitor_event_is_discovered_by_behavior_not_literal_id(self):
        package = json.loads(FIXTURE.read_text(encoding="utf-8"))
        resolved = {
            "operatingModeTarget": "OperatingMode",
            "events": package["events"],
        }
        self.assertEqual(self.logic["operator_monitor_occurrence_field"](resolved),
                         "OperatorMonitorRequest")

    def test_shelly_restart_ack_failure_and_ambiguous_timeout_are_distinct(self):
        accepted = FakeResponse()
        self.assertEqual(self.logic["shelly1_restart_request"](
            lambda *_args, **_kwargs: accepted),
            ("accepted", "shelly-restart-acknowledged"))
        self.assertTrue(accepted.closed)
        self.assertEqual(self.logic["shelly1_restart_request"](
            lambda *_args, **_kwargs: FakeResponse(500)),
            ("failed", "shelly-restart-http-error"))
        self.assertEqual(self.logic["shelly1_restart_request"](
            lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("timeout"))),
            ("unknown", "shelly-restart-outcome-unknown"))

    def test_shelly_restart_completion_requires_later_fresh_zero(self):
        confirm = self.logic["shelly_restart_confirmation"]
        pending = {"acceptedSequence": 10, "startedTicksMs": 1000}
        self.assertIsNone(confirm(pending, 10, 1500, True, 0))
        self.assertEqual(confirm(pending, 11, 2000, True, 0),
                         ("confirmed-completed", "fresh-islocked-zero"))
        for value in (-1, 35):
            self.assertEqual(confirm(pending, 11, 2000, True, value),
                             ("failed", "fresh-lockout-remains"))
        self.assertIsNone(confirm(pending, 11, 2000, False, None))
        self.assertEqual(confirm(pending, 11, 61000, False, None),
                         ("unknown", "fresh-lock-evidence-timeout"))

    def test_actual_tab5_restart_and_no_automatic_shelly_retry_are_wired(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        loop = source[source.index("while True:\n", source.index("Operational HMI initialized")):]
        self.assertIn("reset()", loop)
        self.assertEqual(loop.count("shelly1_restart_request()"), 1)
        self.assertNotIn("clear-event", loop)
        launcher = (PILOT_PATH.parent / "main.py").read_text(encoding="utf-8")
        self.assertIn("cloud.start()", launcher)
        self.assertIn("_thread.start_new_thread(_pilot_worker", launcher)
        self.assertIn("Release M6.38 launcher", launcher)
        self.assertIn("cloud.prepare_tab5_restart(selected_command)", loop)


if __name__ == "__main__":
    unittest.main()
