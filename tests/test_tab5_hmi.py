"""Host-only pure-logic tests for the bounded Tab5 HMI foundation."""

import ast
import pathlib
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
MAIN_PATH = PILOT_PATH.parent / "main.py"


def _binds_from_main(node):
    """True for the import-time bindings a module takes from __main__.

    pressure_qualification.py and pilot.py both re-bind names main.py owns, such
    as `calibrated_psi_from_raw_count = __main__.calibrated_psi_from_raw_count`.
    Those are plumbing, not logic: executing one here raises NameError, and the
    real definition is lifted from main.py anyway.
    """
    return any(isinstance(child, ast.Name) and child.id == "__main__"
               for child in ast.walk(node.value))

FUNCTIONS = {
    "_is_number",
    "calibrated_psi_from_raw_count",
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
    "operator_control_at",
    "arm_operator_control",
}
CONSTANTS = {
    "SAMPLE_PERIOD_MS",
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
    "CONTROL_Y",
    "CONTROL_H",
    "CONTROL_W",
    "CONTROL_MONITOR_X",
    "CONTROL_TAB5_X",
    "CONTROL_SHELLY_X",
    "OPERATOR_CONFIRM_WINDOW_MS",
    "ADC_DIVIDER",
    "ADC_LSB_UV_AT_PIN",
    "ADC_UV_PER_COUNT",
    "PRESSURE_CALIBRATION_COUNT_INTERCEPT",
    "PRESSURE_CALIBRATION_COUNTS_PER_PSI",
    "PRESSURE_SENSOR_SPAN_PSI",
}


def load_hmi_logic():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8") + "\n" +
                     MAIN_PATH.read_text(encoding="utf-8"))
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
        elif isinstance(node, ast.Assign) and not _binds_from_main(node):
            names = set()
            for target in node.targets:
                names.update(assigned_names(target))
            if names & CONSTANTS:
                nodes.append(node)
    namespace = {"time": types.SimpleNamespace(
        ticks_diff=lambda left, right: left - right,
        ticks_add=lambda value, delta: value + delta,
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
            "adc_raw": 16390,
            "battery_voltage": 7.58,
            "battery_current": 0.218,
            "battery_percent": 78,
            "battery_charging": False,
            "battery_charge_enabled": True,
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
            "battery_available": True,
            "battery_sample_ticks_ms": 9950,
            "battery_age_ms": 50,
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
        # Derived, not a literal: the staleness horizon scales with the sample
        # cadence, so a hard-coded age silently stops testing the boundary.
        stale = self.logic["STALE_AFTER_MS"]
        self.assertEqual(state(2920.0, True, stale), "RUNNING",
                         "the horizon itself is still fresh")
        self.assertEqual(state(2920.0, True, stale + 1), "UNAVAILABLE")
        self.assertEqual(state(True, True, 500), "UNAVAILABLE")

    def test_pressure_is_not_presented_before_explicit_commissioning(self):
        pressure = self.logic["pressure_hmi_value"]
        # Explicit, not the module default: the sensor was commissioned in M6.42,
        # and a test that leans on the default stops testing the gate the moment
        # it flips.
        self.assertEqual(pressure(16390, commissioned=False),
                         (None, "NOT COMMISSIONED"))
        value, status = pressure(16390, commissioned=True)
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
        # Follows the commissioning constant rather than restating it.
        commissioned = self.logic["PRESSURE_SENSOR_COMMISSIONED"]
        self.assertEqual(model["pressure_status"],
                         "VALID" if commissioned else "NOT COMMISSIONED")
        if commissioned:
            self.assertIsInstance(model["pressure_psi"], float)
        else:
            self.assertIsNone(model["pressure_psi"])
        self.assertEqual(model["shelly_lock"], "UNKNOWN")
        self.assertEqual(model["shelly1"], "SW0 ON  RLY0 OFF")
        self.assertEqual(model["age_text"], "EM <1s  S1 <1s  ADC <1s")
        self.assertEqual(model["wifi_indicator"], "green")
        self.assertEqual(model["cloud_indicator"], "green")
        self.assertEqual(model["adc_indicator"], "green")

    def test_system_model_reports_running_v3_without_override_authority(self):
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
        self.assertEqual(model["rule_engine"], "V3 RUNNING")
        self.assertEqual(model["system_override"], "NOT AVAILABLE")
        self.assertEqual(
            model["pressure"],
            "COMMISSIONED" if self.logic["PRESSURE_SENSOR_COMMISSIONED"]
            else "NOT COMMISSIONED")
        self.assertEqual(model["rules_status"], "ACTIVE")
        self.assertEqual(model["enabled_rules"], 0)
        self.assertEqual(model["cloud_state"], "green")
        self.assertEqual(
            model["cloud_detail"],
            "CLOUD OK <1s  RTDB OK <1s  Q0/8",
        )

    def test_events_model_exposes_monitor_and_lock_evidence(self):
        sample = observation()
        sample["status"].update({"rules_runtime_state": "RUNNING V3",
                                 "v3_active_event_ids": ["E007"]})
        model = self.logic["build_events_hmi_model"](sample)
        self.assertEqual(model["event_engine"], "RUNNING V3")
        self.assertEqual(model["active_events"], "E007")
        self.assertEqual(model["user_monitor"], "NORMAL")
        self.assertEqual(model["relay_restoration"], "NOT-APPLICABLE")
        self.assertEqual(model["shelly_lock"], "UNKNOWN")
        self.assertIsNone(model["shelly_lockout_count"])

    def test_shelly_lock_states_are_not_conflated(self):
        status = self.logic["shelly_local_lock_status"]
        self.assertEqual(status(True, -1), "FULL LOCKOUT")
        self.assertEqual(status(True, 0), "NORMAL")
        self.assertEqual(status(True, 37), "TEMP 37s")
        self.assertEqual(status(True, None), "UNKNOWN")
        self.assertEqual(status(False, 0), "UNAVAILABLE")

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

    def test_events_page_has_only_the_three_approved_controls(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        node = next(item for item in tree.body
                    if isinstance(item, ast.FunctionDef) and
                    item.name == "render_events")
        events_source = ast.get_source_segment(source, node)
        self.assertIn("enter-user-monitor", events_source)
        self.assertIn("restart-tab5", events_source)
        self.assertIn("restart-shelly1", events_source)
        self.assertNotIn("clear-events", events_source)
        self.assertNotIn("cloud.", events_source)

    def test_operator_controls_require_two_taps_and_are_page_scoped(self):
        at = self.logic["operator_control_at"]
        arm = self.logic["arm_operator_control"]
        events = self.logic["HMI_PAGE_EVENTS"]
        self.assertEqual(at(100, 430, events), "enter-user-monitor")
        self.assertEqual(at(500, 430, events), "restart-tab5")
        self.assertEqual(at(900, 430, events), "restart-shelly1")
        self.assertIsNone(at(100, 430, self.logic["HMI_PAGE_NOW"]))
        action, until, execute = arm("restart-tab5", 1000, None, None)
        self.assertEqual((action, execute), ("restart-tab5", None))
        self.assertEqual(arm("restart-tab5", 2000, action, until)[2],
                         "restart-tab5")
        self.assertIsNone(arm("restart-tab5", 2000, action, until, True)[2])

    def test_release_matches_the_stamped_software_release(self):
        self.assertEqual(self.logic["SOFTWARE_RELEASE"], "M6.42")

    def test_touch_service_is_not_limited_to_remaining_cycle_sleep(self):
        # The ADS1110 stack moved to main.py, which owns board init; the touch
        # servicing it must not starve is still pilot.py's. Read both.
        source = (PILOT_PATH.read_text(encoding="utf-8") + "\n" +
                  MAIN_PATH.read_text(encoding="utf-8"))
        tree = ast.parse(source)

        def function_source(name):
            node = next(item for item in tree.body
                        if isinstance(item, ast.FunctionDef) and
                        item.name == name)
            return ast.get_source_segment(source, node)

        # The microvolt read stack was removed in M6.40; counts are the only
        # ADC representation. The filtered reader is what services touch now.
        self.assertIn(
            "read_ads1110_fresh_raw_count(service)",
            function_source("read_ads1110_filtered_raw_count"),
        )
        service_source = function_source("service_navigation")
        self.assertIn("M5.update()", service_source)
        self.assertIn("check_navigation", service_source)

        boot_loop = source[source.index("while True:\n", source.index(
            "Operational HMI initialized")):]
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
        self.assertIn("EVENT ENGINE: {}", now_source)
        self.assertIn("_draw_communications", now_source)
        field_source = function_source("_draw_field")
        self.assertIn("_field_cache.get(cache_key)", field_source)
        self.assertIn("return False", field_source)


if __name__ == "__main__":
    unittest.main()
