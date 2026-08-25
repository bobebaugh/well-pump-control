"""Host-only tests for M5 CPU A durable-observation selection."""

import ast
import pathlib
import re
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
FUNCTIONS = {
    "format_observed_at",
    "_observation_path_value",
    "_numeric_material_change",
    "build_observation",
    "new_event_history",
    "append_event_history",
    "event_history_values",
    "durable_observation_reason",
    "_record_timestamp_prefix",
    "build_durable_observation",
}
CONSTANTS = {
    "SITE_ID",
    "DEVICE_ID",
    "MAX_DURABLE_OBSERVATION_INTERVAL_MS",
    "EVENT_HISTORY_DEPTH",
    "MATERIAL_NUMERIC_THRESHOLDS",
    "MATERIAL_EXACT_CHANGE_PATHS",
    "PRE_M6_RULES_REFERENCE",
}


def load_selection_logic():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if names & CONSTANTS:
                nodes.append(node)
    namespace = {"time": types.SimpleNamespace(
        ticks_diff=lambda left, right: left - right,
        localtime=lambda: (2026, 8, 25, 0, 0, 8, 0, 0),
    )}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"), namespace)
    return namespace


def observation(sequence=1, power=1000.0, voltage=240.0, **changes):
    value = {
        "schemaVersion": 1,
        "sequence": sequence,
        "observedTicksMs": sequence * 1000,
        "observedAt": "2026-08-25T00:00:{:02d}Z".format(sequence % 60),
        "source": "tab5",
        "values": {
            "power": power,
            "voltage": voltage,
            "adc_microvolts": 7000000,
            "battery_voltage": 7.8,
            "battery_current": 0.0,
            "battery_percent": 76,
            "is_valid": True,
            "battery_charging": True,
            "battery_charge_enabled": True,
            "futureSensor": {"value": 12},
        },
        "status": {
            "shelly_available": True,
            "adc_available": True,
            "battery_available": True,
            "clock_synced": True,
        },
        "futureEnvelope": ["preserved"],
    }
    value.update(changes)
    return value


class ObservationSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_selection_logic()

    def reason(self, current, previous, elapsed, **kwargs):
        return self.logic["durable_observation_reason"](
            current, previous, elapsed, **kwargs)

    def test_first_valid_clocked_observation_is_selected(self):
        self.assertEqual(self.reason(observation(), None, None), "material-change")
        unsynced = observation(observedAt=None)
        self.assertIsNone(self.reason(unsynced, None, None))

    def test_failed_shelly_poll_still_builds_a_matched_observation(self):
        build = self.logic["build_observation"]
        unavailable = build(
            sequence=8,
            observed_ticks_ms=8000,
            clock_is_synced=True,
            shelly={},
            shelly_is_available=False,
            shelly_poll_was_attempted=True,
            shelly_last_valid_ticks_ms=6000,
            ads_microvolts=7000000,
            battery_voltage=7.8,
            battery_current=0.0,
            battery_percent=76,
            battery_is_charging=True,
            battery_is_valid=True,
            battery_charge_is_enabled=True,
            battery_sample_ticks_ms=0,
            wifi_is_connected=True,
            traffic_is_allowed=True,
            wifi_status=1010,
            wifi_address="192.0.2.10",
            wifi_disconnect_count=0,
            shelly_failures=1,
        )
        self.assertFalse(unavailable["status"]["shelly_available"])
        self.assertTrue(unavailable["status"]["shelly_poll_attempted"])
        self.assertEqual(unavailable["status"]["shelly_age_ms"], 2000)
        self.assertIsNone(unavailable["values"]["power"])
        previous = observation()
        self.assertEqual(self.reason(unavailable, previous, 1000), "material-change")

    def test_event_working_history_is_bounded_and_independent(self):
        history = self.logic["new_event_history"](3)
        samples = [observation(sequence=value) for value in range(1, 5)]
        for sample in samples:
            self.logic["append_event_history"](history, sample)
        retained = self.logic["event_history_values"](history)
        self.assertEqual([item["sequence"] for item in retained], [2, 3, 4])
        self.assertIs(retained[-1], samples[-1])
        self.assertEqual(history["count"], 3)

    def test_threshold_is_inclusive_and_parameter_driven(self):
        previous = observation()
        self.assertIsNone(self.reason(observation(2, power=1049.9), previous, 1000))
        self.assertEqual(
            self.reason(observation(2, power=1050.0), previous, 1000),
            "material-change",
        )
        self.assertIsNone(self.reason(
            observation(2, power=1050.0), previous, 1000,
            numeric_thresholds={"values.power": 75.0}, exact_change_paths=(),
        ))

    def test_exact_state_change_is_material(self):
        previous = observation()
        current = observation(2)
        current["status"]["adc_available"] = False
        self.assertEqual(self.reason(current, previous, 1000), "material-change")

    def test_maximum_interval_defaults_to_ten_minutes(self):
        previous = observation()
        self.assertIsNone(self.reason(observation(2), previous, 599999))
        self.assertEqual(
            self.reason(observation(2), previous, 600000),
            "maximum-interval",
        )

    def test_unconfigured_and_insignificant_changes_remain_in_ram(self):
        previous = observation()
        current = observation(2, power=1020.0, voltage=241.0)
        current["values"]["futureSensor"] = {"value": 999}
        self.assertIsNone(self.reason(current, previous, 2000))

    def test_durable_record_has_deterministic_id_and_preserves_unknown_fields(self):
        source = observation(sequence=42)
        record = self.logic["build_durable_observation"](
            source, "boot_A7f93k2Q", "material-change"
        )
        self.assertEqual(
            record["recordId"],
            "20260825000042-observation-boot_A7f93k2Q-0000000042",
        )
        self.assertEqual(record["siteId"], "well-main")
        self.assertEqual(record["deviceId"], "tab5-well-main")
        self.assertEqual(record["futureEnvelope"], ["preserved"])
        self.assertEqual(record["values"]["futureSensor"], {"value": 12})
        self.assertEqual(record["rulesRelease"]["contentHash"], "0" * 64)
        self.assertNotIn("recordType", source)
        self.assert_m4_durable_observation_contract(record)

    def assert_m4_durable_observation_contract(self, record):
        """Check the deployed M4 validator invariants used by Tab5."""
        required = {
            "schemaVersion", "recordType", "recordId", "siteId", "deviceId",
            "sessionId", "sequence", "observedAt", "source", "publishReason",
            "rulesRelease", "values", "status",
        }
        self.assertTrue(required.issubset(record))
        self.assertEqual(record["schemaVersion"], 1)
        self.assertEqual(record["recordType"], "observation")
        self.assertRegex(
            record["recordId"],
            r"^[0-9]{14}-observation-[A-Za-z0-9_-]{8,64}-[0-9]{10}$",
        )
        self.assertRegex(
            record["observedAt"],
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$",
        )
        self.assertEqual(record["source"], "tab5")
        self.assertIn(record["publishReason"], {
            "material-change", "maximum-interval", "event-boundary", "manual"
        })
        self.assertIsInstance(record["values"], dict)
        self.assertIsInstance(record["status"], dict)
        self.assertRegex(record["rulesRelease"]["contentHash"], r"^[a-f0-9]{64}$")
        expected = "{}-observation-{}-{:010d}".format(
            re.sub(r"[-T:]", "", record["observedAt"][:19]),
            record["sessionId"],
            record["sequence"],
        )
        self.assertEqual(record["recordId"], expected)

    def test_invalid_record_inputs_are_not_queued_for_transport(self):
        self.assertIsNone(self.logic["build_durable_observation"](
            observation(observedAt=None), "boot_A7f93k2Q", "material-change"
        ))
        self.assertIsNone(self.logic["build_durable_observation"](
            observation(), "short", "material-change"
        ))
        self.assertIsNone(self.logic["build_durable_observation"](
            observation(), "boot_A7f93k2Q", "event-boundary"
        ))


if __name__ == "__main__":
    unittest.main()
