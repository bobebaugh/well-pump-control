"""M6.45: a loop pass that raises is contained, counted, and a run of them stops cleanly.

CPU B's real loop runs here against a Wi-Fi driver that raises. CPU A's loop runs
at module level on the device, so its structure is checked and its counter unit
tested. Host tests prove decisions, not physical behavior.
"""

import ast
import pathlib
import unittest

from test_tab5_cloud_transport import load_cloud
from test_tab5_v3_integration import load_logic


PILOT_PATH = pathlib.Path(__file__).parents[1] / "tab5" / "pilot.py"


class Stop(BaseException):
    """Ends a host run of the endless loop; not an Exception, so never contained."""


class FaultyWlan:
    def __init__(self, script):
        self.script = list(script)

    def active(self, *_):
        return True

    def config(self, *_, **__):
        return None

    def connect(self, *_):
        return None

    def status(self, *_):
        return 0

    def ifconfig(self):
        return ("0.0.0.0",)

    def isconnected(self):
        step = self.script.pop(0) if self.script else "stop"
        if step == "fault":
            raise RuntimeError("injected pass fault")
        if step == "stop":
            raise Stop()
        return False


class CpuBLoopFaultTests(unittest.TestCase):
    def setUp(self):
        self.cloud, _ = load_cloud()
        self.logged = []
        self.cloud.log = self.logged.append
        self.cloud.sys.print_exception = lambda *_: None

    def run_with(self, script):
        self.cloud.network.WLAN = lambda *_: FaultyWlan(script)
        try:
            return self.cloud._run()
        except Stop:
            return "still running"

    def test_a_run_of_faults_stops_cpu_b_cleanly_and_counts_each(self):
        limit = self.cloud.CPU_B_FAULT_STOP_COUNT
        self.assertEqual(limit, 10)
        self.assertIsNone(self.run_with(["fault"] * 50))
        self.assertEqual(self.cloud.transport_status_snapshot()["cpuBFaults"], limit)
        self.assertEqual(self.cloud.status_snapshot()[:3], (False, False, False))
        self.assertIn("CPU B STOPPED after 10 faults in a row", self.logged)

    def test_a_good_pass_resets_the_run_but_not_the_count(self):
        script = ["fault"] * 9 + ["ok"] + ["fault"] * 9 + ["ok", "stop"]
        self.assertEqual(self.run_with(script), "still running")
        self.assertEqual(self.cloud.transport_status_snapshot()["cpuBFaults"], 18)
        self.assertFalse(any("STOPPED" in line for line in self.logged))

    def test_the_counter_step_is_bounded_and_typed(self):
        step = self.cloud._loop_fault_step
        self.assertEqual(step(0, 10), (1, False))
        self.assertEqual(step(9, 10), (10, True))
        self.assertEqual(step(None, 10), (1, False))


class CpuBTimingTests(unittest.TestCase):
    """M6.45: daily SNTP resync, main endpoints."""

    def setUp(self):
        self.cloud, _ = load_cloud()

    def test_sntp_resyncs_daily_and_a_failed_resync_keeps_sync(self):
        delay = self.cloud._next_ntp_delay_ms
        self.assertEqual(self.cloud.NTP_RESYNC_MS, 86400000)
        self.assertEqual(delay(False, True), 86400000)
        self.assertEqual(delay(True, True), 86400000)
        self.assertEqual(delay(False, False), self.cloud.NTP_RETRY_MS)
        self.assertEqual(delay(True, False), 3600000)
        # ticks_diff is valid below 2**29 ms, about 6.2 days.
        self.assertLess(self.cloud.NTP_RESYNC_MS, 1 << 29)


class CpuALoopFaultTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_logic({"loop_fault_step", "CPU_A_FAULT_STOP_COUNT"})
        source = PILOT_PATH.read_text(encoding="utf-8")
        cls.loop = next(node for node in ast.parse(source).body
                        if isinstance(node, ast.While))
        cls.source = source

    def test_the_counter_step_counts_every_fault_and_stops_on_a_run(self):
        step = self.logic["loop_fault_step"]
        self.assertEqual(self.logic["CPU_A_FAULT_STOP_COUNT"], 10)
        self.assertEqual(step(4, 0, 10), (5, 1, False))
        self.assertEqual(step(12, 9, 10), (13, 10, True))
        self.assertEqual(step(None, None, 10), (1, 1, False))

    def test_the_whole_pass_is_contained_and_a_run_breaks_out(self):
        self.assertEqual(len(self.loop.body), 1)
        guarded = self.loop.body[0]
        self.assertIsInstance(guarded, ast.Try)
        self.assertEqual([ast.unparse(h.type) for h in guarded.handlers], ["Exception"])
        last = ast.unparse(guarded.body[-1])
        self.assertEqual(last, "cpu_a_consecutive_faults = 0")
        handler = ast.unparse(guarded.handlers[0])
        self.assertIn("loop_fault_step(", handler)
        self.assertIn("show_cpu_a_stopped(", handler)
        self.assertIn("break", handler)
        self.assertIn("time.sleep_ms(SAMPLE_PERIOD_MS)", handler)

    def test_the_fault_count_reaches_the_health_binding(self):
        body = ast.unparse(self.loop)
        self.assertIn("add_runtime_health(observation, heap_free_after_gc_bytes, "
                      "heap_min_free_bytes, cpu_a_faults, transport_status)", body)


if __name__ == "__main__":
    unittest.main()
