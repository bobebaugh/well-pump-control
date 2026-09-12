"""Host tests for bounded M6.34 Tab5 diagnostics and charge policy."""

import ast
import pathlib
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"


def load_logic():
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8"))
    wanted_functions = {
        "_is_number",
        "read_battery",
        "battery_charge_policy",
        "heap_diagnostics",
        "elapsed_ticks_ms",
        "sample_age_ms",
        "source_age_ms",
        "compact_age_text",
        "transport_age_ms",
        "cloud_indicator_state",
        "cloud_detail_text",
        "enabled_rule_count",
        "rules_alignment_status",
        "build_system_hmi_model",
    }
    wanted_constants = {
        "BATTERY_LOW_PCT",
        "BATTERY_HIGH_PCT",
        "PRESSURE_SENSOR_COMMISSIONED",
        "SOFTWARE_RELEASE",
        "CLOUD_TELEMETRY_FRESH_MS",
        "CLOUD_RTDB_FRESH_MS",
        "CLOUD_FAILED_RED_MS",
    }
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id in wanted_constants
                for target in node.targets):
            nodes.append(node)
    namespace = {
        "time": types.SimpleNamespace(ticks_diff=lambda left, right: left - right),
        "set_charge_enable": lambda _target: True,
        "log": lambda _message: None,
        "M5": types.SimpleNamespace(),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"),
         namespace)
    return namespace


class Tab5DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.logic = load_logic()

    def test_startup_low_and_hysteresis_band_explicitly_request_enable(self):
        calls = []
        self.logic["set_charge_enable"] = lambda target: calls.append(target) or True
        policy = self.logic["battery_charge_policy"]
        self.assertEqual(policy(70, None), (True, None, True))
        self.assertEqual(policy(78, None), (True, None, True))
        self.assertEqual(calls, [True, True])

    def test_boot_reads_then_explicitly_establishes_request_once(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        startup = source[source.index(
            "# main.py completed M5.begin()"):source.index("while True:\n", source.index(
                "Operational HMI initialized"))]
        self.assertLess(startup.index("read_battery()"),
                        startup.index("battery_charge_policy("))
        self.assertIn("battery_level, None", startup)
        self.assertIn("last_battery_policy_ms = time.ticks_ms()", startup)

    def test_failed_request_is_unknown_and_retries_same_target(self):
        calls = []

        def fail(target):
            calls.append(target)
            return False

        self.logic["set_charge_enable"] = fail
        policy = self.logic["battery_charge_policy"]
        self.assertEqual(policy(81, True), (None, False, False))
        self.assertEqual(policy(78, None, False), (None, False, False))
        self.assertEqual(calls, [False, False])

    def test_supported_battery_read_retains_signed_current_and_fails_as_a_unit(self):
        power = types.SimpleNamespace(
            getBatteryVoltage=lambda: 7580,
            getBatteryCurrent=lambda: -218,
            getBatteryLevel=lambda: 78,
            isCharging=lambda: False,
        )
        self.logic["M5"] = types.SimpleNamespace(Power=power)
        self.assertEqual(self.logic["read_battery"](),
                         (7.58, -0.218, 78, False))
        power.getBatteryLevel = lambda: None
        self.assertEqual(self.logic["read_battery"](),
                         (None, None, None, None))

    def test_thresholds_retain_75_80_hysteresis(self):
        calls = []
        self.logic["set_charge_enable"] = lambda target: calls.append(target) or True
        policy = self.logic["battery_charge_policy"]
        self.assertEqual(policy(76, False), (False, None, None))
        self.assertEqual(policy(75, False), (True, None, True))
        self.assertEqual(policy(79, True), (True, None, None))
        self.assertEqual(policy(80, True), (False, None, False))
        self.assertEqual(calls, [True, False])

    def test_read_failure_hides_stale_measurements_and_reports_last_good_age(self):
        observation = {
            "values": {
                "battery_voltage": 7.5,
                "battery_current": 0.2,
                "battery_percent": 77,
                "battery_charging": True,
                "battery_charge_enabled": None,
            },
            "status": {
                "battery_available": False,
                "battery_sample_ticks_ms": 9000,
                "wifi_connected": False,
                "network_traffic_allowed": False,
            },
            "observedTicksMs": 10000,
        }
        model = self.logic["build_system_hmi_model"](
            observation, None, None, current_ticks_ms=10000)
        self.assertEqual(model["battery_read_status"], "READ FAILED")
        self.assertEqual(model["battery_age_ms"], 1000)
        self.assertIsNone(model["battery_voltage"])
        self.assertIsNone(model["battery_current"])
        self.assertIsNone(model["battery_percent"])
        self.assertIsNone(model["battery_charging"])
        self.assertIsNone(model["battery_request"])

    def test_signed_current_and_timing_are_retained_in_system_model(self):
        observation = {
            "values": {
                "battery_voltage": 7.58,
                "battery_current": -0.218,
                "battery_percent": 78,
                "battery_charging": False,
                "battery_charge_enabled": True,
            },
            "status": {
                "battery_available": True,
                "battery_sample_ticks_ms": 9900,
                "cycle_work_ms": 820,
                "cycle_interval_ms": 1002,
                "adc_acquisition_ms": 340,
                "shelly_em_acquisition_ms": 105,
                "shelly1_acquisition_ms": 122,
                "v3_processing_ms": 4,
                "heap_free_bytes": 100000,
                "heap_allocated_bytes": 25000,
                "heap_min_free_bytes": 96000,
                "wifi_connected": False,
                "network_traffic_allowed": False,
            },
            "observedTicksMs": 10000,
        }
        model = self.logic["build_system_hmi_model"](
            observation, None, None, current_ticks_ms=10000)
        self.assertEqual(model["battery_current"], -0.218)
        self.assertFalse(model["battery_charging"])
        self.assertEqual(model["cycle_work_ms"], 820)
        self.assertEqual(model["cycle_interval_ms"], 1002)
        self.assertEqual(model["v3_processing_ms"], 4)

    def test_heap_minimum_is_one_bounded_scalar(self):
        samples = iter([(120000, 20000), (118000, 22000), (119000, 21000)])

        class Memory:
            current = None

            @classmethod
            def mem_free(cls):
                cls.current = next(samples)
                return cls.current[0]

            @classmethod
            def mem_alloc(cls):
                return cls.current[1]

        minimum = None
        snapshot = self.logic["heap_diagnostics"]
        free, allocated, minimum = snapshot(Memory, minimum)
        self.assertEqual((free, allocated, minimum), (120000, 20000, 120000))
        free, allocated, minimum = snapshot(Memory, minimum)
        self.assertEqual((free, allocated, minimum), (118000, 22000, 118000))
        free, allocated, minimum = snapshot(Memory, minimum)
        self.assertEqual((free, allocated, minimum), (119000, 21000, 118000))

    def test_loop_timing_uses_wrap_safe_ticks_diff_and_no_per_cycle_collection(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        loop = source[source.index("while True:\n", source.index(
            "Operational HMI initialized")):]
        self.assertIn("elapsed_ticks_ms(last_cycle_start_ms, now)", loop)
        self.assertIn("elapsed_ticks_ms(cycle_started_ms, time.ticks_ms())", loop)
        before_wait = loop[:loop.index("sleep_until = time.ticks_add")]
        self.assertIn("'cycle_work_ms': last_cycle_work_ms", before_wait)
        self.assertEqual(before_wait.count(
            "render_hmi(hmi_page, hmi_observation"), 1)
        self.assertLess(before_wait.index(
            "render_hmi(hmi_page, hmi_observation"), before_wait.index(
                "last_cycle_work_ms = elapsed_ticks_ms"))
        self.assertNotIn("gc.collect()", loop)
        self.assertNotIn("append(", ast.get_source_segment(
            source, next(node for node in ast.parse(source).body
                         if isinstance(node, ast.FunctionDef) and
                         node.name == "heap_diagnostics")))
        # Model MicroPython's wrap-aware ticks_diff with a 1024-tick period.
        self.logic["time"] = types.SimpleNamespace(
            ticks_diff=lambda left, right: ((left - right + 512) % 1024) - 512)
        self.assertEqual(self.logic["elapsed_ticks_ms"](1000, 25), 49)

    def test_battery_diagnostics_and_policy_use_separate_cadences(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        self.assertIn("BATTERY_DIAGNOSTIC_PERIOD_MS = 1000", source)
        self.assertIn("BATTERY_POLICY_PERIOD_MS = 60000", source)
        loop = source[source.index("while True:\n", source.index(
            "Operational HMI initialized")):]
        self.assertIn("BATTERY_DIAGNOSTIC_PERIOD_MS", loop)
        self.assertIn("BATTERY_POLICY_PERIOD_MS", loop)
        self.assertEqual(loop.count("read_battery()"), 1)

    def test_system_layout_labels_measurement_meanings_explicitly(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        node = next(node for node in ast.parse(source).body
                    if isinstance(node, ast.FunctionDef) and
                    node.name == "render_system")
        render = ast.get_source_segment(source, node)
        self.assertIn("{:+.3f} A", render)
        self.assertIn("EST {}%", render)
        self.assertIn("SOFTWARE REQUEST", render)
        self.assertIn("V3 CALC/EVENT", render)
        self.assertIn("WORK LAST", render)
        self.assertIn("WORK EXCLUDES SCHEDULED WAIT", render)
        self.assertIn("MICROPYTHON HEAP", render)
        self.assertIn("HEAP COUNTERS EXCLUDE NATIVE/DEVICE MEMORY", render)


if __name__ == "__main__":
    unittest.main()
