"""Passive diagnostics: fixture responses only, never load the board application."""
import copy
import types
import unittest
from test_tab5_v3_integration import load_logic


class ShellyDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.logic = load_logic({'_read_json', 'read_shelly1', 'rules_v3_relay_diagnostic'})
        self.lines = []
        self.logic['log'] = self.lines.append
        self.now = 0
        self.logic['time'].ticks_ms = lambda: self.now

    def request(self, data=None, error=None, decode_error=False):
        def get(url, timeout):
            self.now += 120
            if error:
                raise error
            def decode():
                if decode_error:
                    raise ValueError('private response text')
                return data
            return types.SimpleNamespace(status_code=200, json=decode, close=lambda: None)
        self.logic['requests'] = types.SimpleNamespace(get=get)

    def test_timeout_is_bounded_and_recovery_is_identified(self):
        url = self.logic['SHELLY_1_STATUS_URL']
        self.request(error=OSError(116, 'private URL'))
        for _ in range(31):
            self.assertIsNone(self.logic['_read_json'](url))
        self.assertEqual(len(self.lines), 2)
        self.assertIn('Shelly1.GetStatus elapsed_ms=120', self.lines[0])
        self.assertIn('transport:OSError:errno=116', self.lines[0])
        self.assertNotIn('private', '\n'.join(self.lines))
        data = {'switch:0': {'output': False}, 'input:0': {'state': False}}
        self.request(data)
        self.assertIs(self.logic['_read_json'](url), data)
        self.assertIn('RECOVERED', self.lines[-1])
        self.assertIn('preceding_failures=31', self.lines[-1])

    def test_decode_and_rpc_errors_are_distinct_and_return_policy_unchanged(self):
        url = self.logic['SHELLY_1_COMPONENTS_URL']
        self.request(decode_error=True)
        self.assertIsNone(self.logic['_read_json'](url))
        self.assertIn('json-decode:ValueError', self.lines[-1])
        self.logic['_shelly_diagnostic_failures'].clear()
        data = {'code': -1, 'message': 'private response'}
        self.request(data)
        self.assertIs(self.logic['_read_json'](url), data)
        self.assertIn('reason=rpc-error', self.lines[-1])
        self.assertNotIn('private', '\n'.join(self.lines))

    def test_missing_named_component_rejects_whole_cycle(self):
        calls = []
        def get(url, timeout):
            calls.append(url)
            data = ({'switch:0': {'output': True}, 'input:0': {'state': False}}
                    if url == self.logic['SHELLY_1_STATUS_URL'] else {'components': []})
            self.now += 10
            return types.SimpleNamespace(status_code=200, json=lambda: data, close=lambda: None)
        self.logic['requests'] = types.SimpleNamespace(get=get)
        self.assertIsNone(self.logic['read_shelly1']())
        self.assertEqual(calls, [self.logic['SHELLY_1_STATUS_URL'], self.logic['SHELLY_1_COMPONENTS_URL']])
        self.assertIn('reason=missing-IsLocked', self.lines[-1])

    def test_wrong_type_and_range_have_specific_reasons(self):
        url = self.logic['SHELLY_1_COMPONENTS_URL']
        data = {'components': [
            {'key': 'number:201', 'config': {'name': 'IsLocked'}, 'status': {'value': -1}},
            {'key': 'number:202', 'config': {'name': 'loCntr'}, 'status': {'value': 0}}]}
        reason = self.logic['_shelly_read_reason']
        self.assertIsNone(reason(url, data))
        data['components'][0]['status']['value'] = False
        self.assertEqual(reason(url, data), 'wrong-type-IsLocked')
        data['components'][0]['status']['value'] = -2
        self.assertEqual(reason(url, data), 'out-of-range-IsLocked')

    def test_relay_trace_does_not_mutate_kernel_or_observation(self):
        runtime = {'resolved': {'pumpTarget': 'PumpEnable'}, 'kernel': {'releasePending': True}}
        observation = {'status': {'shelly1_available': True},
                       'values': {'shelly1_rly0': False, 'shelly1_lock': 0}}
        actions = [{'target': 'PumpEnable', 'value': True, 'reason': 'owner-release'}]
        before = copy.deepcopy((runtime, observation, actions))
        trace = self.logic['rules_v3_relay_diagnostic'](runtime, observation, actions)
        self.assertEqual(trace, (True, True, False, 0, ((True, 'owner-release'),)))
        self.assertEqual((runtime, observation, actions), before)
