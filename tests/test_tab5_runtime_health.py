"""M6.45 long-run health: periodic heap collection and loop-fault counts.

Host tests prove decisions, not physical behavior. Heap figures on the device
come from UIFlow's gc module and are not modelled here.
"""

import pathlib
import types
import unittest

from test_tab5_v3_integration import load_logic


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"
HEALTH = {
    "status.heap_free_after_gc_bytes": ("integer", "B", "read"),
    "status.heap_lowest_free_bytes": ("integer", "B", "read"),
    "status.cpu_a_faults": ("integer", "count", "read"),
    "status.cpu_b_faults": ("integer", "count", "read"),
}


class FakeGc:
    def __init__(self, free):
        self.free = free
        self.collections = 0

    def collect(self):
        self.collections += 1

    def mem_free(self):
        return self.free


class RuntimeHealthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_logic({
            "periodic_heap_collect", "add_runtime_health", "RUNTIME_DIRECT_BINDINGS",
            "HEAP_COLLECT_PERIOD_MS", "collect_rules_v3_device_records",
            "_rules_v3_runtime_supported",
        })

    def test_bindings_are_integers_for_the_tab5_runtime_driver(self):
        bindings = self.logic["RUNTIME_DIRECT_BINDINGS"]["tab5-runtime"]
        for path, binding in HEALTH.items():
            self.assertEqual(bindings[path], binding)

    def test_collection_runs_at_first_cycle_then_only_once_per_period(self):
        collect = self.logic["periodic_heap_collect"]
        period = self.logic["HEAP_COLLECT_PERIOD_MS"]
        self.assertEqual(period, 600000)
        gc = FakeGc(500000)
        state = collect(gc, 1000, None, None)
        self.assertEqual(state, (1000, 500000))
        gc.free = 400000
        self.assertEqual(collect(gc, 1000 + period - 1, *state), state)
        self.assertEqual(gc.collections, 1)
        self.assertEqual(collect(gc, 1000 + period, *state), (1000 + period, 400000))
        self.assertEqual(gc.collections, 2)

    def test_a_failed_collection_keeps_the_last_measurement(self):
        collect = self.logic["periodic_heap_collect"]

        class Broken(FakeGc):
            def collect(self):
                raise MemoryError()

        self.assertEqual(collect(Broken(1), 700000, 0, 480000), (700000, 480000))
        self.assertEqual(collect(Broken(1), 0, None, None), (0, None))

    def test_health_values_are_integers_or_absent_never_invented(self):
        add = self.logic["add_runtime_health"]
        observation = add({"status": {}}, 500000, 420000, 2, {"cpuBFaults": 1})
        self.assertEqual(observation["status"], {
            "heap_free_after_gc_bytes": 500000, "heap_lowest_free_bytes": 420000,
            "cpu_a_faults": 2, "cpu_b_faults": 1})
        # The lowest free seen is never above the post-collection reading.
        self.assertEqual(add({"status": {}}, 300000, 420000, 0, {})["status"]
                         ["heap_lowest_free_bytes"], 300000)
        # Nothing measured: heap keys absent, counts read as none counted.
        self.assertEqual(add({"status": {}}, None, None, None, None)["status"],
                         {"cpu_a_faults": 0, "cpu_b_faults": 0})
        # A raw reading is never relabelled as a post-collection one.
        self.assertNotIn("heap_free_after_gc_bytes",
                         add({"status": {}}, None, 420000, 0, {})["status"])

    def test_a_package_declaring_them_is_supported(self):
        package = {"devices": [{"id": "tab5-health", "driver": "tab5-runtime", "fields": [
            {"systemName": name, "object": path, "type": binding[0], "unit": binding[1],
             "access": binding[2]} for name, (path, binding) in zip(
                ("HeapFreeAfterGc", "HeapLowestFree", "CpuAFaults", "CpuBFaults"),
                HEALTH.items())]}], "calculations": []}
        self.assertTrue(self.logic["_rules_v3_runtime_supported"](package))

    def test_a_separate_tab5_device_keeps_a_missing_value_from_blanking_pressure(self):
        """Device records are atomic. A second tab5-runtime device isolates health
        and battery readings, so a missing one cannot make pressure unavailable."""
        def field(name, path, kind):
            return {"systemName": name, "object": path, "type": kind}
        resolved = {"devices": {
            "tab5-main": {"enabled": True, "driver": "tab5-runtime", "fields": [
                field("PressureADCCounts", "values.adc_raw", "integer")]},
            "tab5-health": {"enabled": True, "driver": "tab5-runtime", "fields": [
                field("BatteryPercent", "values.battery_percent", "number"),
                field("CpuAFaults", "status.cpu_a_faults", "integer")]},
        }}
        observation = {"values": {"adc_raw": 14389, "battery_percent": None},
                       "status": {"cpu_a_faults": 0}}
        accepted, unavailable = self.logic["collect_rules_v3_device_records"](
            resolved, observation)
        self.assertEqual(accepted, {"tab5-main": {"PressureADCCounts": 14389}})
        self.assertEqual(unavailable, ["tab5-health"])
        # The same two fields in one device lose pressure with the battery.
        resolved["devices"]["tab5-main"]["fields"].append(
            field("BatteryPercent", "values.battery_percent", "number"))
        accepted, _ = self.logic["collect_rules_v3_device_records"](resolved, observation)
        self.assertNotIn("tab5-main", accepted)

    def test_the_loop_collects_only_through_the_periodic_helper(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        loop = source[source.index("while True:\n", source.index(
            "Operational HMI initialized")):]
        self.assertNotIn("gc.collect()", loop)
        self.assertEqual(loop.count("periodic_heap_collect("), 1)
        self.assertLess(loop.index("add_runtime_health("),
                        loop.index("run_rules_v3_cycle("))


if __name__ == "__main__":
    unittest.main()
