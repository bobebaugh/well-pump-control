"""Host-only startup and integrated-cycle tests; never import the live application."""

import ast
import copy
import hashlib
import json
import os
import pathlib
import tempfile
import types
import unittest


ROOT = pathlib.Path(__file__).parents[1]
PILOT_PATH = ROOT / "tab5" / "pilot.py"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "rules-runtime-package-v3-checkpoint1.json"


def load_logic(targets):
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    definitions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    assignments = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments[target.id] = node
    wanted = set(targets)
    selected_functions = set()
    selected_assignments = set()
    pending = list(targets)
    while pending:
        name = pending.pop()
        node = definitions.get(name)
        if node is not None and name not in selected_functions:
            selected_functions.add(name)
            dependencies = {item.id for item in ast.walk(node)
                            if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}
            pending.extend(dependencies - wanted)
            wanted.update(dependencies)
        assignment = assignments.get(name)
        if assignment is not None and name not in selected_assignments:
            selected_assignments.add(name)
            dependencies = {item.id for item in ast.walk(assignment)
                            if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}
            pending.extend(dependencies - wanted)
            wanted.update(dependencies)
    nodes = [node for node in tree.body
             if ((isinstance(node, ast.FunctionDef) and node.name in selected_functions) or
                 (isinstance(node, ast.Assign) and any(
                     isinstance(target, ast.Name) and target.id in selected_assignments
                     for target in node.targets)))]
    clock = types.SimpleNamespace(
        ticks_diff=lambda left, right: left - right,
        ticks_add=lambda value, delta: value + delta,
        localtime=lambda: (2026, 9, 11, 12, 0, 0, 0, 0),
    )
    namespace = {"time": clock, "ujson": json, "uhashlib": hashlib, "os": os}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"), namespace)
    return namespace


TARGETS = {
    "read_shelly", "read_shelly1", "normalize_shelly1_cycle",
    "start_rules_v3_runtime", "stage_rules_v3_release", "run_rules_v3_cycle",
    "rules_v3_state_report", "issue_rules_v3_action", "build_durable_observation",
}


class V3IntegratedApplicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_logic(TARGETS)
        cls.raw_a = FIXTURE_PATH.read_text(encoding="utf-8")

    def pointer(self, raw, release_id, version):
        return {
            "schemaVersion": 4, "kind": "well-pump-event-v3-runtime-pointer",
            "siteId": "well-main", "releaseId": release_id,
            "packageVersion": version, "runtimeSchemaVersion": 3,
            "contentHash": hashlib.sha256(raw.encode()).hexdigest(),
            "hashAlgorithm": "sha256", "byteLength": len(raw.encode()),
            "publishedAtMs": 1789128000000, "executionEnabled": True,
            "downloadPath": "/.netlify/functions/rules-engine-release?version=3&releaseId=" + release_id,
        }

    @staticmethod
    def shelly_status(output=False, state=True):
        return {"switch:0": {"output": output}, "input:0": {"state": state}}

    @staticmethod
    def components(locked=0, counter=0, include_counter=True):
        values = [{"key": "number:203", "config": {"name": "IsLocked"},
                   "status": {"value": locked}}]
        if include_counter:
            values.append({"key": "number:917", "config": {"name": "loCntr"},
                           "status": {"value": counter}})
        return {"components": values}

    @staticmethod
    def em(**changes):
        value = {"power": 2800.0, "reactive": 10.0, "pf": 0.98,
                 "voltage": 240.0, "is_valid": True,
                 "total": 1000.0, "total_returned": 0.0}
        value.update(changes)
        return value

    def observation(self, lock=0, voltage=240.0):
        return {
            "schemaVersion": 1, "sequence": 1, "observedTicksMs": 0,
            "observedAt": "2026-09-11T12:00:00Z", "source": "tab5",
            "values": {
                "power": 2800.0, "reactive": 10.0, "pf": 0.98,
                "voltage": voltage, "is_valid": True, "total": 1000.0,
                "total_returned": 0.0, "shelly1_rly0": False,
                "shelly1_sw0": True, "shelly1_lock": lock,
                "shelly1_lockout_count": 0, "adc_raw": 14307,
                "battery_percent": 78,
            },
            "status": {
                "shelly_available": True, "shelly1_available": True,
                "pressure_sensor_commissioned": True, "adc_available": True,
                "clock_synced": True, "wifi_connected": True,
                "cloud_available": True, "buffer_used_pct": 0.0,
                "records_lost": 0,
            },
        }

    def start(self, directory, raw=None):
        path = pathlib.Path(directory) / "rules-runtime-v3-staged.json"
        path.write_text(self.raw_a if raw is None else raw, encoding="utf-8")
        runtime, reason = self.logic["start_rules_v3_runtime"](str(path))
        self.assertIsNone(reason)
        self.assertIsNotNone(runtime)
        return runtime, path

    def test_two_rpc_shelly_cycle_discovers_names_and_recovers_after_timeout(self):
        for lock in (-1, 0, 37):
            replies = [self.shelly_status(), self.components(lock, 2)]
            urls = []
            sample = self.logic["read_shelly1"](
                lambda url: urls.append(url) or replies.pop(0))
            self.assertEqual(sample["is_locked"], lock)
            self.assertEqual(sample["lockout_count"], 2)
            self.assertIn("Shelly.GetStatus", urls[0])
            self.assertIn("Shelly.GetComponents", urls[1])
            self.assertIn("dynamic_only=true", urls[1])
        timed_out = [self.shelly_status(), None]
        self.assertIsNone(self.logic["read_shelly1"](lambda _url: timed_out.pop(0)))
        recovered = [self.shelly_status(), self.components(0, 0)]
        self.assertEqual(
            self.logic["read_shelly1"](lambda _url: recovered.pop(0))["is_locked"], 0)

    def test_incomplete_or_wrong_type_shelly_cycle_is_wholly_unavailable(self):
        self.assertIsNone(self.logic["normalize_shelly1_cycle"](
            self.shelly_status(), self.components(include_counter=False)))
        self.assertIsNone(self.logic["normalize_shelly1_cycle"](
            {"switch:0": {"output": 1}, "input:0": {"state": True}},
            self.components()))
        self.assertIsNone(self.logic["normalize_shelly1_cycle"]("bad", {}))

    def test_em_complete_missing_wrong_failed_timeout_and_recovery(self):
        self.assertEqual(self.logic["read_shelly"](lambda _url: self.em())["power"], 2800.0)
        for invalid in ({**self.em(), "power": "2800"},
                        {key: value for key, value in self.em().items() if key != "voltage"},
                        self.em(is_valid=False), "malformed", None):
            self.assertIsNone(self.logic["read_shelly"](lambda _url, value=invalid: value))
        self.assertIsNone(self.logic["read_shelly"](
            lambda _url: (_ for _ in ()).throw(TimeoutError())))
        self.assertEqual(self.logic["read_shelly"](lambda _url: self.em())["voltage"], 240.0)

    def test_tab5_record_missing_wrong_and_recovery_are_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            for mutation in ("missing", "wrong"):
                observation = self.observation()
                if mutation == "missing":
                    observation["status"].pop("clock_synced")
                else:
                    observation["values"]["adc_raw"] = "14307"
                result = self.logic["run_rules_v3_cycle"](runtime, observation, 0)
                self.assertIn("tab5-main", result["unavailableDeviceIds"])
                for field in ("ADCRaw", "ADCValid", "ClockSynchronized",
                              "PressurePSI"):
                    self.assertNotIn(field, result["snapshot"])
                self.assertEqual(result["snapshot"]["TankFlowQuality"],
                                 "PRESSURE_INVALID")
            recovered = self.logic["run_rules_v3_cycle"](
                runtime, self.observation(), 1000)
            self.assertIn("tab5-main", recovered["acceptedDeviceIds"])
            self.assertIn("PressurePSI", recovered["snapshot"])

    def test_cycle_accepts_complete_devices_calculates_then_freezes_one_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            result = self.logic["run_rules_v3_cycle"](runtime, self.observation(), 0)
            self.assertEqual(set(result["acceptedDeviceIds"]),
                             {"shelly-em-main", "shelly-1-main", "tab5-main"})
            self.assertEqual(result["unavailableDeviceIds"], [])
            self.assertAlmostEqual(result["snapshot"]["LoadRatioPercent"],
                                   2800 / 2900 * 100)
            self.assertAlmostEqual(result["snapshot"]["PressurePSI"],
                                   (14307 - 3732.02) / 211.492)
            self.assertEqual(result["snapshot"]["TankFlowQuality"],
                             "INSUFFICIENT_HISTORY")
            self.assertEqual(result["records"], [])

    def test_invalid_device_record_cannot_partially_supply_calculations_or_events(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            observation = self.observation(voltage=270.0)
            observation["values"]["pf"] = "bad"
            result = self.logic["run_rules_v3_cycle"](runtime, observation, 0)
            self.assertIn("shelly-em-main", result["unavailableDeviceIds"])
            for field in ("PumpWatts", "SupplyVoltage", "PowerFactor",
                          "ShellyEnergyWh", "ShellyEMAvailable", "LoadRatioPercent"):
                self.assertNotIn(field, result["snapshot"])
            self.assertEqual(result["records"], [])

    def test_boyle_history_uses_cycle_snapshots_and_propagates_unavailable_pressure(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            result = None
            for index in range(11):
                observation = self.observation()
                observation["values"]["adc_raw"] = 12000 + index * 10
                result = self.logic["run_rules_v3_cycle"](
                    runtime, observation, index * 1000)
            self.assertEqual(result["snapshot"]["TankFlowQuality"], "VALID")
            self.assertGreater(result["snapshot"]["PressureSlopePSIPerMinute"], 0)
            broken = self.observation()
            broken["values"]["adc_raw"] = None
            result = self.logic["run_rules_v3_cycle"](runtime, broken, 11000)
            self.assertIn("tab5-main", result["unavailableDeviceIds"])
            self.assertNotIn("PressurePSI", result["snapshot"])
            self.assertEqual(result["snapshot"]["TankFlowQuality"], "PRESSURE_INVALID")

    def test_only_exact_zero_lock_can_select_or_execute_reenable(self):
        with tempfile.TemporaryDirectory() as directory:
            for lock in (-1, 8, None, 0):
                runtime, _path = self.start(directory)
                runtime["kernel"]["releasePending"] = True
                observation = self.observation(lock=0 if lock is None else lock)
                if lock is None:
                    observation["values"].pop("shelly1_lock")
                result = self.logic["run_rules_v3_cycle"](runtime, observation, 0)
                enables = [item for item in result["actions"]
                           if item["target"] == "PumpEnable" and item["value"] is True]
                self.assertEqual(bool(enables), lock == 0)
                if enables:
                    calls = []
                    reply = types.SimpleNamespace(json=lambda: {}, close=lambda: None)
                    self.logic["requests"] = types.SimpleNamespace(
                        get=lambda url, timeout: calls.append((url, timeout)) or reply)
                    outcome = self.logic["issue_rules_v3_action"](
                        runtime["resolved"], enables[0], observation)
                    self.assertEqual(outcome, "issued")
                    self.assertEqual(len(calls), 1)

            runtime, _path = self.start(directory)
            action = {"target": "PumpEnable", "value": True}
            for lock in (-1, 9, None):
                observation = self.observation(lock=0 if lock is None else lock)
                if lock is None:
                    observation["values"].pop("shelly1_lock")
                self.logic["requests"] = types.SimpleNamespace(
                    get=lambda *_args, **_kwargs: self.fail("blocked enable wrote"))
                self.assertEqual(self.logic["issue_rules_v3_action"](
                    runtime["resolved"], action, observation),
                    "lock-evidence-unavailable-or-locked")

    def test_stage_b_does_not_replace_running_a_and_restart_adopts_fresh_b(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime_a, path = self.start(directory)
            runtime_a["kernel"]["owners"] = {"PumpEnable": {
                "value": False, "instances": {"old": "E007"}}}
            package_b = json.loads(self.raw_a)
            package_b.update({"releaseId": "20260911120100-event-v3-v2", "packageVersion": 2})
            raw_b = json.dumps(package_b, separators=(",", ":"))
            pointer_b = self.pointer(raw_b, package_b["releaseId"], 2)
            staged, outcome = self.logic["stage_rules_v3_release"](
                {"metadata": pointer_b, "release": raw_b}, runtime_a["reference"],
                str(path), str(path.parent / ".rules-runtime-v3-staged.download"))
            self.assertEqual(outcome, "staged")
            self.assertEqual(runtime_a["reference"]["packageVersion"], 1)
            self.assertIn("PumpEnable", runtime_a["kernel"]["owners"])
            rejected, _reason = self.logic["stage_rules_v3_release"](
                {"metadata": pointer_b, "release": raw_b + " "}, staged["reference"],
                str(path), str(path.parent / ".rules-runtime-v3-staged.download"))
            self.assertIsNone(rejected)
            self.assertEqual(path.read_text(encoding="utf-8"), raw_b)
            runtime_b, reason = self.logic["start_rules_v3_runtime"](str(path))
            self.assertIsNone(reason)
            self.assertEqual(runtime_b["reference"]["packageVersion"], 2)
            self.assertEqual(runtime_b["kernel"]["owners"], {})
            self.assertFalse(any(item["active"] for item in runtime_b["kernel"]["events"].values()))

    def test_normal_loop_has_no_v2_evaluation_or_v2_relay_dispatch(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        loop = source[source.index("while True:", source.index("# --- boot sequence ---")):]
        for forbidden in ("evaluate_runtime_events(", "advance_runtime_event(",
                          "issue_runtime_stop(", "adopt_runtime_release("):
            self.assertNotIn(forbidden, loop)
        self.assertIn("run_rules_v3_cycle(", loop)
        self.assertIn("issue_rules_v3_action(", loop)

    def test_durable_observation_uses_running_v3_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            record = self.logic["build_durable_observation"](
                self.observation(), "boot_12345678", "material-change",
                runtime["reference"])
            self.assertEqual(record["rulesRelease"]["version"], 1)
            self.assertEqual(record["rulesRelease"]["contentHash"],
                             runtime["reference"]["contentHash"])


if __name__ == "__main__":
    unittest.main()
