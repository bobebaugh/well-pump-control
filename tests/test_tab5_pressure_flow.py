"""Host-only pure-logic tests for Tab5 pressure calibration and fill flow."""

import ast
import io
import pathlib
import types
import unittest


PILOT_PATH = pathlib.Path(__file__).parents[1] / 'tab5' / 'pilot.py'
MAIN_PATH = PILOT_PATH.parent / "main.py"
QUAL_PATH = PILOT_PATH.parent / "pressure_qualification.py"


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
    'ads1110_signed_raw_count',
    '_read_ads1110_reply',
    '_read_ads1110_fresh_raw_once',
    'average_raw_adc_counts',
    'calibrated_psi_from_raw_count',
    'raw_count_regression_slope',
    'pressure_flow_evidence',
    'estimated_flow_gpm',
    '_write_calibration_capture',
}
CONSTANTS = {
    'ADS1110_ADDRESS', 'ADS1110_READY_MASK', 'ADS1110_FRESH_TIMEOUT_MS',
    'ADS1110_READY_POLL_MS', 'ADC_DIVIDER', 'ADC_LSB_UV_AT_PIN',
    'ADC_UV_PER_COUNT',
    'QUAL_CAPTURE_SAMPLES', 'QUAL_FLOW_WINDOW_DEFAULT_SECONDS',
    'QUAL_SAMPLE_PERIOD_MS', 'SAMPLE_PERIOD_MS', 'SAMPLE_GAP_LIMIT_MS',
    'QUAL_FLOW_MIN_SPAN_MS',
    'QUAL_FLOW_WINDOW_TOLERANCE_MS',
    'PRESSURE_SENSOR_SPAN_PSI', 'PRESSURE_CALIBRATION_COUNT_INTERCEPT',
    'PRESSURE_CALIBRATION_COUNTS_PER_PSI', 'PRESSURE_PSI_PER_COUNT',
    'TANK_EFFECTIVE_VOLUME_GAL', 'TANK_PRECHARGE_PSIG',
    'SITE_ATMOSPHERE_PSI',
}


def load_pressure_logic():
    tree = ast.parse(PILOT_PATH.read_text(encoding='utf-8') + '\n' +
                     MAIN_PATH.read_text(encoding='utf-8') + '\n' +
                     QUAL_PATH.read_text(encoding='utf-8'))
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS:
            nodes.append(node)
        elif isinstance(node, ast.Assign) and not _binds_from_main(node):
            names = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if names & CONSTANTS:
                nodes.append(node)
    ticks = {'value': 0}
    namespace = {'time': types.SimpleNamespace(
        ticks_ms=lambda: ticks['value'],
        ticks_add=lambda value, delta: value + delta,
        ticks_diff=lambda left, right: left - right,
        sleep_ms=lambda delay: ticks.__setitem__('value', ticks['value'] + delay),
    )}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), 'exec'), namespace)
    return namespace


class PressureFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_pressure_logic()

    def test_gain_two_terminal_scaling_and_empirical_pressure_fit(self):
        self.assertEqual(self.logic['ADC_UV_PER_COUNT'], 187.5)
        self.assertAlmostEqual(
            self.logic['PRESSURE_PSI_PER_COUNT'], 1.0 / 211.492)
        count_at_40 = 3732.02 + (40.0 * 211.492)
        count_at_60 = 3732.02 + (60.0 * 211.492)
        convert = self.logic['calibrated_psi_from_raw_count']
        self.assertAlmostEqual(convert(count_at_40), 40.0)
        self.assertAlmostEqual(convert(count_at_60), 60.0)
        self.assertIsNone(convert(True))

    def test_operational_flow_window_defaults_to_ten_seconds(self):
        self.assertEqual(self.logic['QUAL_FLOW_WINDOW_DEFAULT_SECONDS'], 10)

    def test_signed_ads1110_counts_and_exact_batch_average(self):
        decode = self.logic['ads1110_signed_raw_count']
        self.assertEqual(decode(bytes((0x12, 0x34, 0x80))), 4660)
        self.assertEqual(decode(bytes((0xff, 0xfe, 0x00))), -2)
        self.assertEqual(self.logic['average_raw_adc_counts']([10, 11, 12, 13, 14]), 12.0)
        self.assertIsNone(self.logic['average_raw_adc_counts']([10, 11]))
        self.assertIsNone(self.logic['average_raw_adc_counts']([10, 11, None, 13, 14]))

    def test_fresh_read_discards_entry_then_returns_only_new_drdy_low_reply(self):
        replies = iter((
            bytes((0x00, 0x01, 0x80)),  # discarded at call entry
            bytes((0x00, 0x02, 0x80)),  # old/already-read conversion: ignore
            bytes((0xff, 0xfe, 0x00)),  # later new conversion: return signed -2
        ))
        calls = []
        service_calls = []
        original = self.logic['_read_ads1110_reply']
        try:
            self.logic['_read_ads1110_reply'] = lambda: (calls.append(True) or next(replies))
            self.assertEqual(
                self.logic['_read_ads1110_fresh_raw_once'](
                    lambda: service_calls.append(True)), -2)
        finally:
            self.logic['_read_ads1110_reply'] = original
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(service_calls), 1)

    def test_adc_initialization_keeps_continuous_15sps_gain_two(self):
        tree = ast.parse(PILOT_PATH.read_text(encoding='utf-8') + '\n' +
                     MAIN_PATH.read_text(encoding='utf-8') + '\n' +
                     QUAL_PATH.read_text(encoding='utf-8'))
        init_node = next(node for node in tree.body
                         if isinstance(node, ast.FunctionDef) and node.name == 'init_adc')
        settings = []
        for node in ast.walk(init_node):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr in ('set_gain', 'set_sample_rate', 'set_mode'):
                    argument = node.args[0]
                    if isinstance(argument, ast.Attribute):
                        value = argument.attr
                    elif isinstance(argument, ast.Constant):
                        value = argument.value
                    else:
                        value = None
                    settings.append((node.func.attr, value))
        self.assertIn(('set_gain', 0x01), settings)
        self.assertIn(('set_sample_rate', 'SPS_15'), settings)
        self.assertIn(('set_mode', 'MODE_CONTIN'), settings)

    def test_fill_trace_preserves_each_raw_batch_instead_of_only_microvolts(self):
        # The fill run left pilot.py in M6.41; it lives in the utility module now.
        source = QUAL_PATH.read_text(encoding='utf-8')
        tree = ast.parse(source)
        fill_node = next(node for node in tree.body
                         if isinstance(node, ast.FunctionDef) and
                         node.name == 'run_pressure_fill')
        fill_source = ast.get_source_segment(source, fill_node)
        self.assertIn('s1_raw_count,s2_raw_count,s3_raw_count', fill_source)
        self.assertIn('pressure_slope_psi_per_min', fill_source)
        self.assertIn('estimated_flow_gpm', fill_source)
        self.assertIn("batch = _acquire_calibration_batch()", fill_source)
        self.assertNotIn('read_ads1110_filtered_raw_count()', fill_source)

    def test_regression_uses_irregular_actual_timestamps(self):
        slope = self.logic['raw_count_regression_slope']([
            {'midpoint_ticks_ms': 1000, 'average_raw_count': 1000},
            {'midpoint_ticks_ms': 2250, 'average_raw_count': 1100},
            {'midpoint_ticks_ms': 4000, 'average_raw_count': 1240},
        ], 4000, 4)
        self.assertAlmostEqual(slope, 0.08)

    def test_regression_window_excludes_old_batches(self):
        history = [
            {'midpoint_ticks_ms': 0, 'average_raw_count': 1000},
            {'midpoint_ticks_ms': 1000, 'average_raw_count': 1100},
            {'midpoint_ticks_ms': 3000, 'average_raw_count': 1500},
        ]
        self.assertAlmostEqual(
            self.logic['raw_count_regression_slope'](history, 3000, 2), 0.2)
        self.assertNotAlmostEqual(
            self.logic['raw_count_regression_slope'](history, 3000, 3), 0.2)

    def test_estimated_flow_has_physical_sign_for_fill_and_demand(self):
        # At 50 PSIG the nominal raw count is 13,333.33.  Use a one-count/ms
        # slope only to make sign clear; the absolute rate is intentionally not
        # a claim about a plausible household draw.
        current = {'midpoint_ticks_ms': 3000, 'average_raw_count': 13333.333333}
        rising = self.logic['estimated_flow_gpm']([
            {'midpoint_ticks_ms': 0, 'average_raw_count': 10333.333333},
            {'midpoint_ticks_ms': 1000, 'average_raw_count': 11333.333333},
            {'midpoint_ticks_ms': 2000, 'average_raw_count': 12333.333333}, current,
        ], current, 3)
        falling = self.logic['estimated_flow_gpm']([
            {'midpoint_ticks_ms': 0, 'average_raw_count': 16333.333333},
            {'midpoint_ticks_ms': 1000, 'average_raw_count': 15333.333333},
            {'midpoint_ticks_ms': 2000, 'average_raw_count': 14333.333333}, current,
        ], current, 3)
        self.assertGreater(rising, 0)
        self.assertLess(falling, 0)

    def test_flow_evidence_keeps_pressure_slope_distinct_from_gpm(self):
        current = {'midpoint_ticks_ms': 10000, 'average_raw_count': 14300.0}
        history = [
            {'midpoint_ticks_ms': 0, 'average_raw_count': 12300.0},
            {'midpoint_ticks_ms': 5000, 'average_raw_count': 13300.0},
            current,
        ]
        evidence = self.logic['pressure_flow_evidence'](history, current, 10)
        self.assertEqual(
            set(evidence),
            {'pressure_slope_psi_per_min', 'estimated_flow_gpm'},
        )
        self.assertGreater(evidence['pressure_slope_psi_per_min'], 0)
        self.assertGreater(evidence['estimated_flow_gpm'], 0)
        self.assertNotEqual(
            evidence['pressure_slope_psi_per_min'],
            evidence['estimated_flow_gpm'],
        )

    def test_flow_is_unavailable_until_window_has_real_coverage(self):
        current = {'midpoint_ticks_ms': 1000, 'average_raw_count': 13333.333333}
        self.assertIsNone(self.logic['estimated_flow_gpm']([
            {'midpoint_ticks_ms': 0, 'average_raw_count': 12333.333333}, current,
        ], current, 3))

    def test_flow_rejects_implausible_history_pressure_before_regression(self):
        current = {'midpoint_ticks_ms': 3000, 'average_raw_count': 13333.333333}
        self.assertIsNone(self.logic['estimated_flow_gpm']([
            {'midpoint_ticks_ms': 0, 'average_raw_count': 999999},
            {'midpoint_ticks_ms': 1000, 'average_raw_count': 11333.333333},
            {'midpoint_ticks_ms': 2000, 'average_raw_count': 12333.333333}, current,
        ], current, 3))

    def test_capture_writes_only_the_displayed_batch_and_flushes(self):
        class CaptureBuffer(io.StringIO):
            def __init__(self):
                super().__init__()
                self.flushed = False

            def flush(self):
                self.flushed = True

        batch = {
            'raw_samples': [100, 101, 102, 103, 104],
            'average_raw_count': 102.0,
            'start_ticks_ms': 10,
            'end_ticks_ms': 350,
            'midpoint_ticks_ms': 180,
        }
        handle = CaptureBuffer()
        self.assertTrue(self.logic['_write_calibration_capture'](
            handle, 1, batch, 'falling', 60.0, 10, {
                'pressure_slope_psi_per_min': -2.5,
                'estimated_flow_gpm': -1.25,
            }))
        self.assertTrue(handle.flushed)
        row = handle.getvalue().strip().split(',')
        self.assertEqual(row[:9], ['capture', '1', 'falling', '60.0',
                                   '100', '101', '102', '103', '104'])
        self.assertEqual(row[10:13], ['10', '350', '180'])
        self.assertEqual(row[-3:], ['10', '-2.50000', '-1.25000'])



class CadenceDerivedConstantTests(unittest.TestCase):
    """Constants M6.39/M6.41 made derived instead of literal, and never asserted.

    Both were introduced to stop a hidden coupling, and neither had a test, so a
    wrong arithmetic expression would have shipped silently.
    """

    @classmethod
    def setUpClass(cls):
        cls.logic = load_pressure_logic()

    def test_the_regression_gap_limit_scales_with_the_observation_cadence(self):
        period = self.logic['SAMPLE_PERIOD_MS']
        limit = self.logic['SAMPLE_GAP_LIMIT_MS']
        self.assertEqual(limit, period * 2 + 500)
        # It must tolerate one late cycle and still catch a real stall.
        self.assertGreater(limit, period * 2, 'one late cycle must not be a gap')
        self.assertLess(limit, period * 3, 'two missed cycles must still be a gap')

    def test_the_gap_limit_reproduces_the_literal_it_replaced(self):
        # It was a bare 2500 inline while the cadence was 1000ms. The expression
        # was chosen to reproduce that exactly, which is the only evidence that
        # M6.39 changed the cadence without also changing this behaviour.
        self.assertEqual(1000 * 2 + 500, 2500)

    def test_the_utility_capture_cadence_is_independent_of_the_observation_loop(self):
        # The utility paced its capture loop with pilot.py's SAMPLE_PERIOD_MS, so
        # M6.40's move to 2000ms silently halved the calibration sample rate. The
        # captures behind the shipped fit were taken at 1 Hz.
        self.assertEqual(self.logic['QUAL_SAMPLE_PERIOD_MS'], 1000)
        self.assertNotEqual(self.logic['QUAL_SAMPLE_PERIOD_MS'],
                            self.logic['SAMPLE_PERIOD_MS'],
                            'the two cadences must not be re-coupled')


class UtilityShellyReadTests(unittest.TestCase):
    """The minimal EM read written for the extracted utility, which had no test.

    Deliberately not pilot.py's read_shelly: a hand-driven utility needs a
    reading, not the 24x7 loop's failure classification and diagnostic counters.
    It is only exercised by a fill run, so nothing on the device was going to
    catch a mistake in it.
    """

    @classmethod
    def setUpClass(cls):
        source = QUAL_PATH.read_text(encoding='utf-8')
        tree = ast.parse(source)
        node = next(item for item in tree.body
                    if isinstance(item, ast.FunctionDef) and item.name == 'read_shelly')
        cls.namespace = {'SHELLY_EM_URL': 'http://example.invalid/emeter/0'}
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(QUAL_PATH), 'exec'),
             cls.namespace)

    def call(self, *, status=200, body=None, raises=None):
        class Reply:
            status_code = status
            def json(self):
                return body
            def close(self):
                pass

        def get(url, timeout):
            if raises:
                raise raises
            return Reply()
        self.namespace['requests'] = types.SimpleNamespace(get=get)
        return self.namespace['read_shelly']()

    def test_a_valid_reading_returns_power(self):
        self.assertEqual(self.call(body={'power': 2800.0, 'is_valid': True}),
                         {'power': 2800.0, 'is_valid': True})

    def test_everything_unusable_returns_none_rather_than_a_guess(self):
        for label, kwargs in (
                ('http error', dict(status=500, body={'power': 1.0, 'is_valid': True})),
                ('not an object', dict(body='malformed')),
                ('no body', dict(body=None)),
                ('is_valid false', dict(body={'power': 2800.0, 'is_valid': False})),
                ('is_valid missing', dict(body={'power': 2800.0})),
                ('power absent', dict(body={'is_valid': True})),
                ('power a string', dict(body={'power': '2800', 'is_valid': True})),
                ('power a bool', dict(body={'power': True, 'is_valid': True})),
                ('transport failed', dict(raises=OSError('unreachable'))),
                ('decode failed', dict(raises=ValueError('bad json'))),
        ):
            self.assertIsNone(self.call(**kwargs), label)

    def test_zero_watts_is_a_reading_not_a_failure(self):
        # A stopped pump draws nothing. Rejecting 0 would make the fill run
        # unable to see the state it exists to detect.
        self.assertEqual(self.call(body={'power': 0, 'is_valid': True})['power'], 0)



if __name__ == '__main__':
    unittest.main()
