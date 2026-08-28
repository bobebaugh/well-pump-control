"""Host-only pure-logic tests for the bounded Tab5 HMI foundation."""

import ast
import pathlib
import types
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
    "sample_age_ms",
    "source_age_ms",
    "compact_age_text",
    "transport_age_ms",
    "cloud_indicator_state",
    "cloud_detail_text",
    "build_now_hmi_model",
    "build_system_hmi_model",
    "build_events_hmi_model",
    "navigation_page_at",
    "navigation_selection_allowed",
}
CONSTANTS = {
    "STALE_AFTER_MS",
    "CLOUD_TELEMETRY_FRESH_MS",
    "CLOUD_RTDB_FRESH_MS",
    "CLOUD_FAILED_RED_MS",
    "PUMP_RUNNING_THRESHOLD_W",
    "PRESSURE_SENSOR_COMMISSIONED",
    "SOFTWARE_RELEASE",
    "HMI_PAGE_NOW",
    "HMI_PAGE_SYSTEM",
    "HMI_PAGE_EVENTS",
    "NAV_Y",
    "NAV_H",
    "NAV_NOW_X",
    "NAV_SYSTEM_X",
    "NAV_EVENTS_X",
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
    namespace = {"time": types.SimpleNamespace(
        ticks_diff=lambda left, right: left - right,
    )}
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
            "shelly_last_valid_ticks_ms": 9750,
            "shelly1_available": shelly1_available,
            "shelly1_last_valid_ticks_ms": 9800,
            "adc_available": adc_available,
            "adc_last_valid_ticks_ms": 9900,
            "wifi_connected": True,
            "network_traffic_allowed": True,
        },
        "observedTicksMs": 10000,
    }


def transport(telemetry_success=9950, rtdb_success=9975, queue_depth=0,
              telemetry_ok=True, rtdb_ok=True):
    return {
        "telemetryLastSuccessTicksMs": telemetry_success,
        "telemetryLastAttemptOk": telemetry_ok,
        "rtdbLastSuccessTicksMs": rtdb_success,
        "rtdbLastAttemptOk": rtdb_ok,
        "durableQueueDepth": queue_depth,
        "durableQueueCapacity": 8,
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
        self.assertEqual(count({"events": [
            {"enabled": True},
            {"enabled": False},
            {"enabled": 1},
            {},
        ]}), 1)

    def test_now_model_hides_uncommissioned_pressure_and_unknown_lock(self):
        model = self.logic["build_now_hmi_model"](
            observation(), transport(), 10000)
        self.assertEqual(model["pump_state"], "RUNNING")
        self.assertEqual(model["pressure_status"], "NOT COMMISSIONED")
        self.assertIsNone(model["pressure_psi"])
        self.assertEqual(model["shelly_lock"], "NOT REPORTED")
        self.assertEqual(model["shelly1"], "SW0 ON  RLY0 OFF")
        self.assertEqual(model["age_text"], "EM <1s  S1 <1s  ADC <1s")
        self.assertEqual(model["wifi_indicator"], "green")
        self.assertEqual(model["cloud_indicator"], "green")
        self.assertEqual(model["adc_indicator"], "green")

    def test_system_model_does_not_claim_unimplemented_authority(self):
        adopted_hash = "aeca11754cae" + ("1" * 52)
        adopted = {"version": 2, "contentHash": adopted_hash}
        model = self.logic["build_system_hmi_model"](
            observation(), adopted,
            {"events": [{"enabled": False}]},
            dict(adopted),
            transport(),
            10000,
        )
        self.assertEqual(model["collection"], "ACTIVE")
        self.assertEqual(model["rule_engine"], "PACKAGE ADOPTION ONLY")
        self.assertEqual(model["system_override"], "NOT AVAILABLE")
        self.assertEqual(model["pressure"], "NOT COMMISSIONED")
        self.assertEqual(model["rules_status"], "ACTIVE")
        self.assertEqual(model["enabled_rules"], 0)
        self.assertEqual(model["cloud_state"], "green")
        self.assertEqual(
            model["cloud_detail"],
            "CLOUD OK <1s  RTDB OK <1s  Q0/8",
        )

    def test_events_model_is_truthful_and_has_no_override_authority(self):
        model = self.logic["build_events_hmi_model"](observation())
        self.assertEqual(model["event_engine"], "NOT IMPLEMENTED")
        self.assertEqual(model["active_events"], "UNAVAILABLE")
        self.assertEqual(model["event_override"], "NOT AVAILABLE")
        self.assertEqual(model["system_override"], "NOT AVAILABLE")
        self.assertEqual(model["shelly_lock"], "NOT REPORTED")
        self.assertEqual(model["shelly_override"], "NOT AVAILABLE")

    def test_cloud_color_requires_confirmed_cpu_b_responses(self):
        state = self.logic["cloud_indicator_state"]
        self.assertEqual(state(transport(), 10000, True, True), "green")
        self.assertEqual(
            state(transport(queue_depth=1), 10000, True, True), "yellow")
        self.assertEqual(state(transport(), 10000, True, False), "yellow")
        self.assertEqual(state(transport(), 10000, False, False), "red")
        failed = transport(telemetry_success=None, telemetry_ok=False)
        self.assertEqual(state(failed, 10000, True, True), "red")

    def test_direct_page_target_recovers_a_missed_release(self):
        allowed = self.logic["navigation_selection_allowed"]
        now = self.logic["HMI_PAGE_NOW"]
        system = self.logic["HMI_PAGE_SYSTEM"]
        events = self.logic["HMI_PAGE_EVENTS"]
        self.assertTrue(allowed(False, now, system))
        self.assertTrue(allowed(True, now, system))
        self.assertTrue(allowed(True, system, events))
        self.assertFalse(allowed(True, system, system))

    def test_navigation_exposes_now_system_and_events(self):
        select = self.logic["navigation_page_at"]
        self.assertEqual(select(100, 650), self.logic["HMI_PAGE_NOW"])
        self.assertEqual(select(500, 650), self.logic["HMI_PAGE_SYSTEM"])
        self.assertEqual(select(900, 650), self.logic["HMI_PAGE_EVENTS"])
        self.assertIsNone(select(430, 650))
        self.assertIsNone(select(850, 650))
        self.assertIsNone(select(100, 500))

    def test_events_page_is_display_only_scaffolding(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        node = next(item for item in tree.body
                    if isinstance(item, ast.FunctionDef) and
                    item.name == "render_events")
        events_source = ast.get_source_segment(source, node)
        self.assertIn("NO EVENT OR OVERRIDE ACTION IS IMPLEMENTED",
                      events_source)
        self.assertNotIn("relay", events_source.lower())
        self.assertNotIn("request", events_source.lower())
        self.assertNotIn("submit", events_source.lower())
        self.assertNotIn("cloud.", events_source)

    def test_release_is_m624(self):
        self.assertEqual(self.logic["SOFTWARE_RELEASE"], "M6.24")

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
            "read_ads1110_filtered_raw_count(service_navigation)", boot_loop)
        self.assertGreaterEqual(boot_loop.count("service_navigation()"), 5)

    def test_now_page_uses_large_bottom_rows_and_dirty_field_cache(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)

        def function_source(name):
            node = next(item for item in tree.body
                        if isinstance(item, ast.FunctionDef) and
                        item.name == name)
            return ast.get_source_segment(source, node)

        now_source = function_source("render_now")
        self.assertGreaterEqual(now_source.count("M5.Lcd.FONTS.DejaVu40"), 6)
        self.assertIn("EVENT ENGINE: NOT IMPLEMENTED", now_source)
        self.assertIn("_draw_communications", now_source)
        field_source = function_source("_draw_field")
        self.assertIn("_field_cache.get(cache_key)", field_source)
        self.assertIn("return False", field_source)


if __name__ == "__main__":
    unittest.main()
