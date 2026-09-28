"""M6.45: the Tab5's own readings are accepted one at a time; Shellys stay atomic.

Runs the real published v46 runtime package (fixture byte-identical to release
20260924205736-event-v3-v46, sha256 372cee44...). Host tests prove decisions,
not physical behavior.
"""

import copy
import json
import pathlib
import unittest

from test_tab5_v3_integration import load_logic


ROOT = pathlib.Path(__file__).parents[1]
V46 = json.loads((ROOT / "tests" / "fixtures" /
                  "rules-runtime-package-v3-v46-2026-09-24.json").read_text(encoding="utf-8"))
ADC_72_PSI = round(72 * 211.492 + 3732.02)


def tab5_only(adc=ADC_72_PSI, **status):
    """First cycles after a boot with no network and no battery."""
    base = {"pressure_sensor_commissioned": True, "adc_available": True,
            "clock_synced": False, "wifi_connected": False,
            "buffer_used_pct": 0.0, "records_lost": 0, "acquisition_begun": False}
    base.update(status)
    return {"values": {"adc_raw": adc, "battery_percent": None}, "status": base}


def with_shellys(observation):
    """Internet down, LAN up: both Shellys answer."""
    observation = copy.deepcopy(observation)
    observation["values"].update({
        "power": 12.0, "voltage": 250.0, "pf": -0.5, "total": 200000.0,
        "shelly1_sw0": False, "shelly1_rly0": True, "shelly1_lock": 0,
        "shelly1_tab5lock": False})
    observation["status"].update({"wifi_connected": True, "acquisition_begun": True,
                                  "shelly_available": True, "shelly1_available": True})
    return observation


class LocalReadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_logic({
            "resolve_rules_v3_package", "run_rules_v3_cycle", "restart_rules_v3_kernel",
            "new_rules_v3_calculation_state", "accept_rules_v3_device_record"})
        cls.resolved = cls.logic["resolve_rules_v3_package"](copy.deepcopy(V46))
        assert cls.resolved is not None

    def runtime(self):
        return {"resolved": self.resolved,
                "kernel": self.logic["restart_rules_v3_kernel"](self.resolved),
                "calculations": self.logic["new_rules_v3_calculation_state"]()}

    def run_cycles(self, observations):
        runtime, results = self.runtime(), []
        for index, observation in enumerate(observations):
            results.append(self.logic["run_rules_v3_cycle"](
                runtime, copy.deepcopy(observation), 1000 + 2000 * index))
        return results

    def test_boot_with_no_network_and_no_battery_has_pressure_and_its_rules(self):
        first, second = self.run_cycles([tab5_only(), tab5_only()])
        self.assertAlmostEqual(first["snapshot"]["PressurePSI"], 72.0, places=1)
        self.assertIn("tab5-main", first["acceptedDeviceIds"])
        for unknown in ("CloudAvailable", "BatteryPercent"):
            self.assertNotIn(unknown, first["snapshot"])  # left out, not invented
        self.assertFalse(first["snapshot"]["WiFiConnected"])
        # W07: above 70 psi for 2 readings latches the pump off.
        self.assertEqual([(r["type"], r["eventId"]) for r in second["records"]],
                         [("open", "W07")])

    def test_with_the_lan_up_the_latched_hold_is_requested_at_once(self):
        results = self.run_cycles([with_shellys(tab5_only()), with_shellys(tab5_only())])
        self.assertEqual([(r["type"], r["eventId"]) for r in results[1]["records"]],
                         [("open", "W07")])
        self.assertIn({"target": "Tab5IsLocked", "value": True, "reason": "active-ownership"},
                      results[1]["actions"])

    def test_shelly_devices_stay_all_or_nothing(self):
        accept = self.logic["accept_rules_v3_device_record"]
        record = {"emeter/0.power": 12.0, "emeter/0.voltage": 250.0, "emeter/0.pf": -0.5,
                  "emeter/0.total": 200000.0, "$availability": True}
        self.assertEqual(len(accept(self.resolved, "shelly-em-main", record)), 5)
        del record["emeter/0.pf"]
        self.assertIsNone(accept(self.resolved, "shelly-em-main", record))
        record["emeter/0.pf"] = "bad"
        self.assertIsNone(accept(self.resolved, "shelly-em-main", record))

    def test_a_tab5_reading_is_left_out_only_when_missing_or_mistyped(self):
        accept = self.logic["accept_rules_v3_device_record"]
        record = {"values.adc_raw": 18960, "status.cloud_available": "yes",
                  "values.battery_percent": None, "status.wifi_connected": True}
        self.assertEqual(accept(self.resolved, "tab5-main", record),
                         {"PressureADCCounts": 18960, "WiFiConnected": True})
        self.assertIsNone(accept(self.resolved, "tab5-main", {}))

    def test_a_left_out_reading_is_unknown_like_a_missing_device(self):
        results = self.run_cycles([tab5_only()])
        snapshot = results[0]["snapshot"]
        # Shelly EM did not answer: its readings are absent. So is the left-out battery.
        self.assertNotIn("PumpWatts", snapshot)
        self.assertNotIn("BatteryPercent", snapshot)
        self.assertEqual(results[0]["unavailableDeviceIds"], ["shelly-em-main", "shelly-1-main"])

    def test_an_unknown_reading_holds_the_qualification_timer(self):
        # One qualifying reading, one cycle with no ADC reading, then one more:
        # the count held at 1 across the gap, so the second qualifying reading opens W07.
        results = self.run_cycles([
            tab5_only(), tab5_only(adc=None), tab5_only()])
        self.assertNotIn("PressurePSI", results[1]["snapshot"])
        self.assertEqual(results[1]["records"], [])
        self.assertEqual([(r["type"], r["eventId"]) for r in results[2]["records"]],
                         [("open", "W07")])
        # A definite reading below the limit resets it instead.
        reset = self.run_cycles([
            tab5_only(), tab5_only(adc=round(50 * 211.492 + 3732.02)), tab5_only()])
        self.assertEqual(reset[2]["records"], [])

    def test_pressure_still_requires_its_guards(self):
        for status in ({"pressure_sensor_commissioned": False}, {"adc_available": False}):
            snapshot = self.run_cycles([tab5_only(**status)])[0]["snapshot"]
            self.assertNotIn("PressurePSI", snapshot, status)
        observation = tab5_only()
        del observation["status"]["adc_available"]
        self.assertNotIn("PressurePSI", self.run_cycles([observation])[0]["snapshot"])


if __name__ == "__main__":
    unittest.main()
