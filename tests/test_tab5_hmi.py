"""Host-only pure-logic tests for the bounded M6.18 Tab5 HMI foundation."""

import ast
import pathlib
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
FUNCTIONS = {
    "_is_number",
    "calibrated_psi_from_raw_count",
    "calibrated_psi_from_microvolts",
    "operational_pump_state",
    "pressure_hmi_value",
    "enabled_rule_count",
    "rules_alignment_status",
    "shelly_local_lock_status",
    "build_now_hmi_model",
    "build_system_hmi_model",
    "navigation_page_at",
}
CONSTANTS = {
    "STALE_AFTER_MS",
    "PUMP_RUNNING_THRESHOLD_W",
    "PRESSURE_SENSOR_COMMISSIONED",
    "SOFTWARE_RELEASE",
    "HMI_PAGE_NOW",
    "HMI_PAGE_SYSTEM",
    "NAV_Y",
    "NAV_H",
    "NAV_NOW_X",
    "NAV_SYSTEM_X",
    "NAV_W",
    "ADC_DIVIDER",
    "ADC_LSB_UV_AT_PIN",
    "ADC_UV_PER_COUNT",
    "PRESSURE_CALIBRATION_COUNT_INTERCEPT",
    "PRESSURE_CALIBRATION_COUNTS_PER_PSI",
    "PRESSURE_SENSOR_SPAN_PSI",
}


def load_hmi_logic():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    nodes = []

    def assigned_names(target):
        if isinstance(target, ast.Name):
            return {target.id}
        if isinstance(target, (ast.Tuple, ast.List)):
            names = set()
            for element in target.elts:
                names.update(assigned_names(element))
            return names
        return set()

    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = set()
            for target in node.targets:
                names.update(assigned_names(target))
            if names & CONSTANTS:
                nodes.append(node)
    namespace = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]),
                 str(PILOT_PATH), "exec"), namespace)
    return namespace


def observation(power=2920.0, shelly_available=True, shelly_age_ms=250,
                shelly1_available=True, adc_available=True):
    return {
        "values": {
            "power": power,
            "voltage": 241.2,
            "adc_microvolts": 3073125,
            "battery_percent": 78,
            "battery_charging": False,
            "shelly1_sw0": True,
            "shelly1_rly0": False,
        },
        "status": {
            "shelly_available": shelly_available,
            "shelly_age_ms": shelly_age_ms,
            "shelly1_available": shelly1_available,
            "adc_available": adc_available,
            "wifi_connected": True,
            "network_traffic_allowed": True,
        },
    }


class HmiFoundationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_hmi_logic()

    def test_pump_state_uses_only_fresh_available_em_power(self):
        state = self.logic["operational_pump_state"]
        self.assertEqual(state(2920.0, True, 500), "RUNNING")
        self.assertEqual(state(12.3, True, 500), "STOPPED")
        self.assertEqual(state(2920.0, False, 500), "UNAVAILABLE")
        self.assertEqual(state(2920.0, True, 3001), "UNAVAILABLE")
        self.assertEqual(state(True, True, 500), "UNAVAILABLE")

    def test_pressure_is_not_presented_before_explicit_commissioning(self):
        pressure = self.logic["pressure_hmi_value"]
        self.assertEqual(pressure(3073125), (None, "NOT COMMISSIONED"))
        value, status = pressure(3073125, commissioned=True)
        self.assertEqual(status, "VALID")
        self.assertIsInstance(value, float)
        self.assertEqual(pressure(None, commissioned=True),
                         (None, "UNAVAILABLE"))

    def test_rules_active_requires_matching_version_and_full_hash(self):
        alignment = self.logic["rules_alignment_status"]
        hash_one = "aeca11754cae" + ("1" * 52)
        hash_two = "aeca11754cae" + ("2" * 52)
        adopted = {"version": 2, "contentHash": hash_one}
        self.assertEqual(alignment(adopted, dict(adopted)), "ACTIVE")
        self.assertEqual(
            alignment(adopted, {"version": 2, "contentHash": hash_two}),
            "MISMATCH",
        )
        self.assertEqual(alignment(adopted, None), "PUBLISHED UNKNOWN")

    def test_enabled_count_accepts_only_explicit_true(self):
        count = self.logic["enabled_rule_count"]
        self.assertEqual(count({"rules": [
            {"enabled": True},
            {"enabled": False},
            {"enabled": 1},
            {},
        ]}), 1)

    def test_now_model_hides_uncommissioned_pressure_and_unknown_lock(self):
        model = self.logic["build_now_hmi_model"](observation())
        self.assertEqual(model["pump_state"], "RUNNING")
        self.assertEqual(model["pressure_status"], "NOT COMMISSIONED")
        self.assertIsNone(model["pressure_psi"])
        self.assertEqual(model["shelly_lock"], "NOT REPORTED")
        self.assertEqual(model["shelly1"], "SW0 ON  RLY0 OFF")

    def test_system_model_does_not_claim_unimplemented_authority(self):
        adopted_hash = "aeca11754cae" + ("1" * 52)
        adopted = {"version": 2, "contentHash": adopted_hash}
        model = self.logic["build_system_hmi_model"](
            observation(), adopted,
            {"rules": [{"enabled": False}]},
            dict(adopted),
        )
        self.assertEqual(model["collection"], "ACTIVE")
        self.assertEqual(model["rule_engine"], "NOT IMPLEMENTED")
        self.assertEqual(model["system_override"], "NOT AVAILABLE")
        self.assertEqual(model["pressure"], "NOT COMMISSIONED")
        self.assertEqual(model["rules_status"], "ACTIVE")
        self.assertEqual(model["enabled_rules"], 0)

    def test_navigation_exposes_only_now_and_system(self):
        select = self.logic["navigation_page_at"]
        self.assertEqual(select(100, 650), self.logic["HMI_PAGE_NOW"])
        self.assertEqual(select(700, 650), self.logic["HMI_PAGE_SYSTEM"])
        self.assertIsNone(select(640, 650))
        self.assertIsNone(select(100, 500))

    def test_touch_service_is_not_limited_to_remaining_cycle_sleep(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)

        def function_source(name):
            node = next(item for item in tree.body
                        if isinstance(item, ast.FunctionDef) and
                        item.name == name)
            return ast.get_source_segment(source, node)

        self.assertIn(
            "read_ads1110_fresh_raw_count(service)",
            function_source("_read_ads1110_microvolts_once"),
        )
        self.assertIn(
            "_read_ads1110_microvolts_once(service)",
            function_source("read_ads1110_microvolts"),
        )
        service_source = function_source("service_navigation")
        self.assertIn("M5.update()", service_source)
        self.assertIn("check_navigation", service_source)

        boot_loop = source[source.index("while True:\n", source.index(
            "Operational HMI foundation initialized")):]
        self.assertIn(
            "read_ads1110_microvolts(service_navigation)", boot_loop)
        self.assertGreaterEqual(boot_loop.count("service_navigation()"), 5)


if __name__ == "__main__":
    unittest.main()
