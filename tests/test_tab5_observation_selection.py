"""Host-only tests for M5 CPU A durable-observation selection."""

import ast
import hashlib
import json
import pathlib
import re
import tempfile
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
FUNCTIONS = {
    "format_observed_at",
    "_observation_path_value",
    "_numeric_material_change",
    "_material_change_detail",
    "material_change_details",
    "trimmed_mean_microvolts",
    "normalize_shelly1_status",
    "summarize_adc_samples",
    "qualification_pump_running",
    "qualification_midpoint_ticks",
    "calibrated_psi_from_raw_count",
    "calibrated_psi_from_microvolts",
    "build_observation",
    "new_event_history",
    "append_event_history",
    "event_history_values",
    "new_shelly_availability_confirmation",
    "shelly_availability_change_pending",
    "acknowledge_shelly_availability_change",
    "durable_observation_reason",
    "_record_timestamp_prefix",
    "build_durable_observation",
    "build_rules_audit_record",
    "_sha256_hex",
    "_valid_rules_hash",
    "_valid_rules_release_id",
    "_check_rules_metadata",
    "rules_metadata_rejection_reason",
    "rules_metadata_key_summary",
    "validate_rules_metadata",
    "validate_rules_release",
    "load_packaged_rules",
    "adopt_rules_release",
}
CONSTANTS = {
    "SITE_ID",
    "DEVICE_ID",
    "MAX_DURABLE_OBSERVATION_INTERVAL_MS",
    "EVENT_HISTORY_DEPTH",
    "SHELLY_AVAILABILITY_CONFIRMATION_SAMPLES",
    "ADC_FILTER_SAMPLE_COUNT",
    "PRESSURE_SENSOR_COMMISSIONED",
    "QUAL_PUMP_START_W",
    "QUAL_PUMP_STOP_W",
    "QUAL_CALIBRATION_START_PSI",
    "QUAL_CALIBRATION_START_DIRECTION",
    "ADC_DIVIDER",
    "ADC_LSB_UV_AT_PIN",
    "ADC_UV_PER_COUNT",
    "PRESSURE_CALIBRATION_COUNT_INTERCEPT",
    "PRESSURE_CALIBRATION_COUNTS_PER_PSI",
    "MATERIAL_NUMERIC_THRESHOLDS",
    "MATERIAL_EXACT_CHANGE_PATHS",
    "MATERIAL_CHANGE_LABELS",
    "RULES_FILE",
    "RULES_TEMP_FILE",
    "RULES_FETCH_RETRY_MS",
    "MAX_RULES_RELEASE_BYTES",
    "PACKAGED_RULES_REFERENCE",
    "EXPECTED_RULE_IDS",
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
        ticks_add=lambda value, delta: value + delta,
        localtime=lambda: (2026, 8, 25, 0, 0, 8, 0, 0),
    ), "ujson": json, "uhashlib": hashlib, "os": __import__("os")}
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
            "pressure_psi": 158.877,
            "battery_voltage": 7.8,
            "battery_current": 0.0,
            "battery_percent": 76,
            "is_valid": True,
            "battery_charging": True,
            "battery_charge_enabled": True,
            "shelly1_sw0": None,
            "shelly1_rly0": None,
            "futureSensor": {"value": 12},
        },
        "status": {
            "shelly_available": True,
            "adc_available": True,
            "battery_available": True,
            "shelly1_available": False,
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

    def material_details(self, current, previous, **kwargs):
        return self.logic["material_change_details"](
            current, previous, **kwargs)

    def test_first_valid_clocked_observation_is_selected(self):
        self.assertEqual(self.reason(observation(), None, None), "material-change")
        unsynced = observation(observedAt=None)
        self.assertIsNone(self.reason(unsynced, None, None))

    def test_initial_material_change_has_an_explicit_diagnostic_label(self):
        self.assertEqual(
            self.material_details(observation(), None),
            ["initial valid observation"],
        )

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
        self.assertAlmostEqual(
            unavailable["values"]["pressure_psi"],
            self.logic["calibrated_psi_from_microvolts"](7000000),
        )
        self.assertFalse(unavailable["status"]["pressure_sensor_commissioned"])
        self.assertFalse(unavailable["status"]["pressure_valid"])
        previous = observation()
        self.assertIsNone(self.reason(unavailable, previous, 1000))

    def test_adc_trimmed_mean_discards_one_high_and_one_low_sample(self):
        filtered = self.logic["trimmed_mean_microvolts"](
            [4800000, 4826625, 4830000, 4840000, 4900000]
        )
        self.assertEqual(filtered, 4832208)
        with self.assertRaises(ValueError):
            self.logic["trimmed_mean_microvolts"]([1, 2, 3, 4])

    def test_shelly1_status_normalizes_only_gen4_rpc_boolean_state(self):
        normalize = self.logic["normalize_shelly1_status"]
        self.assertEqual(normalize({
            "switch:0": {"id": 0, "output": False},
            "input:0": {"id": 0, "state": True},
        }), {"sw0": True, "rly0": False})
        self.assertIsNone(normalize({"switch:0": {}, "input:0": {}}))
        self.assertIsNone(normalize({
            "switch:0": {"output": "off"},
            "input:0": {"state": False},
        }))

    def test_pressure_qualification_summarizes_raw_adc_points(self):
        summarize = self.logic["summarize_adc_samples"]
        self.assertEqual(summarize([4010000, 3990000, None, 4000000, 4020000]), {
            "count": 4,
            "representativeMicrovolts": 4010000,
            "spreadMicrovolts": 30000,
        })
        self.assertIsNone(summarize([None, True]))

    def test_pressure_fill_pump_state_uses_local_hysteresis(self):
        classify = self.logic["qualification_pump_running"]
        self.assertIsNone(classify(None, None))
        self.assertFalse(classify(999.0, None))
        self.assertTrue(classify(1000.0, False))
        self.assertTrue(classify(500.0, True))
        self.assertFalse(classify(100.0, True))

    def test_pressure_measurement_time_is_adc_interval_midpoint(self):
        midpoint = self.logic["qualification_midpoint_ticks"]
        self.assertEqual(midpoint(1000, 1280), 1140)
        self.assertEqual(midpoint(1000, 1281), 1140)

    def test_pressure_calibration_starts_at_sixty_and_falls(self):
        self.assertEqual(self.logic["QUAL_CALIBRATION_START_PSI"], 60.0)
        self.assertEqual(self.logic["QUAL_CALIBRATION_START_DIRECTION"], "falling")

    def test_normal_observation_preserves_raw_adc_and_derived_pressure(self):
        built = self.logic["build_observation"](
            sequence=9,
            observed_ticks_ms=9000,
            clock_is_synced=True,
            shelly={},
            shelly_is_available=False,
            shelly_poll_was_attempted=True,
            shelly_last_valid_ticks_ms=None,
            ads_microvolts=3073125,
            battery_voltage=None,
            battery_current=None,
            battery_percent=None,
            battery_is_charging=None,
            battery_is_valid=False,
            battery_charge_is_enabled=True,
            battery_sample_ticks_ms=0,
            wifi_is_connected=True,
            traffic_is_allowed=True,
            wifi_status=1010,
            wifi_address="192.0.2.10",
            wifi_disconnect_count=0,
            shelly_failures=0,
        )
        self.assertEqual(built["values"]["adc_microvolts"], 3073125)
        expected_count = 3073125 / self.logic["ADC_UV_PER_COUNT"]
        self.assertAlmostEqual(
            built["values"]["pressure_psi"],
            (expected_count - self.logic["PRESSURE_CALIBRATION_COUNT_INTERCEPT"]) /
            self.logic["PRESSURE_CALIBRATION_COUNTS_PER_PSI"],
        )
        self.assertFalse(built["status"]["pressure_sensor_commissioned"])
        self.assertFalse(built["status"]["pressure_valid"])

    def test_transient_shelly_poll_failures_do_not_select_durable_records(self):
        confirmation = self.logic["new_shelly_availability_confirmation"](3)
        confirm = self.logic["shelly_availability_change_pending"]
        for available in (True, True, True, False, True, False, True):
            self.assertFalse(confirm(confirmation, available))
        previous = observation()
        unavailable = observation(8)
        unavailable["status"]["shelly_available"] = False
        unavailable["values"]["is_valid"] = None
        self.assertIsNone(self.reason(unavailable, previous, 1000))

    def test_confirmed_shelly_availability_transitions_select_once(self):
        confirmation = self.logic["new_shelly_availability_confirmation"](3)
        confirm = self.logic["shelly_availability_change_pending"]
        acknowledge = self.logic["acknowledge_shelly_availability_change"]
        for _ in range(3):
            self.assertFalse(confirm(confirmation, True))
        self.assertFalse(confirm(confirmation, False))
        self.assertFalse(confirm(confirmation, False))
        self.assertTrue(confirm(confirmation, False))
        previous = observation()
        unavailable = observation(8)
        unavailable["status"]["shelly_available"] = False
        unavailable["values"]["is_valid"] = None
        self.assertEqual(self.reason(
            unavailable, previous, 3000,
            confirmed_shelly_availability_change=True),
            "material-change",
        )
        acknowledge(confirmation)
        self.assertFalse(confirm(confirmation, False))
        self.assertFalse(confirm(confirmation, True))
        self.assertFalse(confirm(confirmation, True))
        self.assertTrue(confirm(confirmation, True))

    def test_confirmed_availability_change_retries_until_cpu_b_accepts(self):
        confirmation = self.logic["new_shelly_availability_confirmation"](3)
        confirm = self.logic["shelly_availability_change_pending"]
        acknowledge = self.logic["acknowledge_shelly_availability_change"]
        for _ in range(3):
            self.assertFalse(confirm(confirmation, True))
        for _ in range(3):
            pending = confirm(confirmation, False)
        self.assertTrue(pending)
        previous = observation()
        unavailable = observation(8)
        unavailable["status"]["shelly_available"] = False
        unavailable["values"]["is_valid"] = None
        # A full CPU B FIFO rejects this attempt, so the transition is retained.
        self.assertEqual(self.reason(
            unavailable, previous, 3000,
            confirmed_shelly_availability_change=pending),
            "material-change",
        )
        self.assertTrue(confirm(confirmation, False))
        # Once CPU B accepts a later exact CPU A record, no duplicate remains.
        acknowledge(confirmation)
        self.assertFalse(confirm(confirmation, False))

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
        self.assertEqual(
            self.material_details(current, previous),
            ["pressure ADC (status.adc_available): True -> False"],
        )

    def test_numeric_material_change_names_sensor_field_and_values(self):
        previous = observation()
        current = observation(2, power=1050.0)
        self.assertEqual(
            self.material_details(current, previous),
            ["Shelly EM (values.power): 1000.0 -> 1050.0"],
        )

    def test_compound_material_change_reports_all_triggering_fields(self):
        previous = observation()
        current = observation(2, power=1060.0)
        current["status"]["adc_available"] = False
        self.assertEqual(
            self.material_details(current, previous),
            [
                "pressure ADC (status.adc_available): True -> False",
                "Shelly EM (values.power): 1000.0 -> 1060.0",
            ],
        )

    def test_confirmed_shelly_availability_change_has_sensor_and_values(self):
        previous = observation()
        current = observation(2)
        current["status"]["shelly_available"] = False
        current["values"]["is_valid"] = None
        self.assertEqual(
            self.material_details(
                current, previous,
                confirmed_shelly_availability_change=True),
            ["Shelly EM (status.shelly_available): True -> False"],
        )

    def test_confirmed_shelly1_availability_change_has_sensor_and_values(self):
        previous = observation()
        previous["status"]["shelly1_available"] = True
        current = observation(2)
        current["status"]["shelly1_available"] = False
        self.assertEqual(
            self.material_details(
                current, previous,
                confirmed_shelly1_availability_change=True),
            ["Shelly 1 (status.shelly1_available): True -> False"],
        )

    def test_shelly1_sw0_and_rly0_changes_are_material(self):
        previous = observation()
        previous["values"].update({"shelly1_sw0": False, "shelly1_rly0": False})
        current = observation(2)
        current["values"].update({"shelly1_sw0": True, "shelly1_rly0": False})
        self.assertEqual(self.reason(current, previous, 1000), "material-change")

    def test_one_missed_shelly1_poll_is_not_a_state_change(self):
        previous = observation()
        previous["values"].update({"shelly1_sw0": False, "shelly1_rly0": False})
        previous["status"]["shelly1_available"] = True
        current = observation(2)
        current["values"].update({"shelly1_sw0": None, "shelly1_rly0": None})
        current["status"]["shelly1_available"] = False
        self.assertIsNone(self.reason(current, previous, 1000))

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
        self.assertEqual(
            record["rulesRelease"], self.logic["PACKAGED_RULES_REFERENCE"])
        self.assertNotIn("recordType", source)
        self.assert_m4_durable_observation_contract(record)

    def test_packaged_rules_are_complete_and_match_the_reviewed_hash(self):
        raw = (PILOT_PATH.parent / "rules.json").read_text(encoding="utf-8")
        checked, reason = self.logic["validate_rules_release"](raw)
        self.assertIsNone(reason)
        self.assertEqual(checked["reference"], self.logic["PACKAGED_RULES_REFERENCE"])
        self.assertEqual(
            tuple(rule["id"] for rule in checked["package"]["rules"]),
            self.logic["EXPECTED_RULE_IDS"],
        )

    def test_remote_release_requires_matching_pointer_hash_and_identity(self):
        raw = (PILOT_PATH.parent / "rules.json").read_text(encoding="utf-8")
        content_hash = self.logic["_sha256_hex"](raw)
        metadata = {
            "schemaVersion": 1,
            "siteId": "well-main",
            "releaseId": "20260825000000-rules-v1",
            "rulesVersion": 1,
            "rulesSchemaVersion": 1,
            "contentHash": content_hash,
            "hashAlgorithm": "sha256",
            "publishedAtMs": 1787616000000,
            "downloadPath": "/.netlify/functions/rules-release/20260825000000-rules-v1.json",
        }
        checked, reason = self.logic["validate_rules_release"](raw, metadata)
        self.assertIsNone(reason)
        self.assertEqual(checked["metadata"], metadata)
        metadata["contentHash"] = "0" * 64
        self.assertEqual(
            self.logic["validate_rules_release"](raw, metadata)[1],
            "release-hash-mismatch",
        )

    def test_invalid_release_never_replaces_last_valid_rules_file(self):
        raw = (PILOT_PATH.parent / "rules.json").read_text(encoding="utf-8")
        content_hash = self.logic["_sha256_hex"](raw)
        metadata = {
            "schemaVersion": 1,
            "siteId": "well-main",
            "releaseId": "20260825000000-rules-v1",
            "rulesVersion": 1,
            "rulesSchemaVersion": 1,
            "contentHash": content_hash,
            "hashAlgorithm": "sha256",
            "publishedAtMs": 1787616000000,
            "downloadPath": "/.netlify/functions/rules-release/20260825000000-rules-v1.json",
        }
        with tempfile.TemporaryDirectory() as directory:
            active_path = pathlib.Path(directory) / "rules.json"
            temporary_path = pathlib.Path(directory) / ".rules.json.download"
            active_path.write_text(raw, encoding="utf-8")
            rejected, outcome = self.logic["adopt_rules_release"](
                {"metadata": metadata, "release": raw + " "},
                self.logic["PACKAGED_RULES_REFERENCE"],
                str(active_path), str(temporary_path),
            )
            self.assertIsNone(rejected)
            self.assertEqual(outcome, "release-hash-mismatch")
            self.assertEqual(active_path.read_text(encoding="utf-8"), raw)

    def test_changed_valid_release_atomically_replaces_active_rules_file(self):
        baseline = (PILOT_PATH.parent / "rules.json").read_text(encoding="utf-8")
        changed = baseline.replace(
            '"releaseId": "20260825000000-rules-v1"',
            '"releaseId": "20260825010000-rules-v1"',
            1,
        )
        content_hash = self.logic["_sha256_hex"](changed)
        metadata = {
            "schemaVersion": 1,
            "siteId": "well-main",
            "releaseId": "20260825010000-rules-v1",
            "rulesVersion": 1,
            "rulesSchemaVersion": 1,
            "contentHash": content_hash,
            "hashAlgorithm": "sha256",
            "publishedAtMs": 1787619600000,
            "downloadPath": "/.netlify/functions/rules-release/20260825010000-rules-v1.json",
        }
        with tempfile.TemporaryDirectory() as directory:
            active_path = pathlib.Path(directory) / "rules.json"
            temporary_path = pathlib.Path(directory) / ".rules.json.download"
            active_path.write_text(baseline, encoding="utf-8")
            adopted, outcome = self.logic["adopt_rules_release"](
                {"metadata": metadata, "release": changed},
                self.logic["PACKAGED_RULES_REFERENCE"],
                str(active_path), str(temporary_path),
            )
            self.assertEqual(outcome, "adopted")
            self.assertEqual(adopted["reference"], {
                "version": 1,
                "contentHash": content_hash,
            })
            self.assertEqual(active_path.read_text(encoding="utf-8"), changed)
            self.assertFalse(temporary_path.exists())

            # Exercise the same load-and-validate path used by a fresh CPU A
            # process after restart, rather than proving only the rename.
            reloaded, reason = self.logic["load_packaged_rules"](str(active_path))
            self.assertIsNone(reason)
            self.assertEqual(reloaded["reference"], adopted["reference"])
            self.assertEqual(reloaded["package"]["releaseId"], metadata["releaseId"])

    def test_rules_adoption_is_the_only_runtime_flash_write(self):
        pilot_source = PILOT_PATH.read_text(encoding="utf-8")
        launcher_source = (PILOT_PATH.parent / "main.py").read_text(encoding="utf-8")
        cloud_source = (PILOT_PATH.parent / "cloud.py").read_text(encoding="utf-8")

        self.assertIn("with open(temporary_path, 'w')", pilot_source)
        self.assertNotIn("open('/flash/", launcher_source)
        self.assertNotRegex(cloud_source, r"\bopen\s*\([^\n]*['\"](?:w|a|x)[+b]?['\"]")

    def test_rules_metadata_accepts_the_exact_v1_release_identifier_shape(self):
        metadata = {
            "schemaVersion": 1,
            "siteId": "well-main",
            "releaseId": "20260825010000-rules-v1",
            "rulesVersion": 1,
            "rulesSchemaVersion": 1,
            "contentHash": "93eca75b9fbf774c10350580a8e0c116a733af6f6cd5274bdd7b29a698e05a08",
            "hashAlgorithm": "sha256",
            "publishedAtMs": 1787619600000,
            "downloadPath": "/.netlify/functions/rules-release/20260825010000-rules-v1.json",
        }
        self.assertEqual(
            self.logic["validate_rules_metadata"](metadata)["releaseId"],
            metadata["releaseId"],
        )
        metadata["publishedAtMs"] = float(metadata["publishedAtMs"])
        self.assertEqual(
            self.logic["validate_rules_metadata"](metadata)["releaseId"],
            metadata["releaseId"],
        )
        del metadata["downloadPath"]
        self.assertEqual(
            self.logic["rules_metadata_rejection_reason"](metadata),
            "missing-downloadPath",
        )

    def test_rules_pointer_summary_reports_field_names_not_values(self):
        metadata = {"siteId": "well-main", "schemaVersion": 1}
        self.assertEqual(
            self.logic["rules_metadata_key_summary"](metadata),
            "schemaVersion,siteId",
        )
        self.assertEqual(
            self.logic["rules_metadata_key_summary"](None),
            "not-an-object",
        )

    def test_rules_adoption_and_rejection_audits_have_deterministic_records(self):
        reference = self.logic["PACKAGED_RULES_REFERENCE"]
        adopted = self.logic["build_rules_audit_record"](
            "rule-adoption", "2026-08-25T00:00:42Z", "boot_A7f93k2Q", 42,
            reference, "20260825000000-rules-v1",
        )
        self.assertEqual(
            adopted["recordId"],
            "20260825000042-rule-adoption-boot_A7f93k2Q-0000000042",
        )
        self.assertEqual(adopted["activeRules"], reference)
        rejected = self.logic["build_rules_audit_record"](
            "rule-rejection", "2026-08-25T00:00:43Z", "boot_A7f93k2Q", 43,
            reference, "20260825000000-rules-v1", "release-hash-mismatch",
        )
        self.assertEqual(rejected["rejectionReason"], "release-hash-mismatch")
        self.assertNotIn("activeRules", rejected)

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
