"""Host-only logic tests for the interpreted M3 CPU B transport.

These tests stub UIFlow/MicroPython modules. They do not prove TLS, threading,
Wi-Fi, timing, or physical Tab5 behavior.
"""

import importlib.util
import pathlib
import sys
import types
import unittest


class Lock:
    def acquire(self):
        return True

    def release(self):
        return True


class Response:
    def __init__(self, body, status_code=200):
        self._body = body
        self.status_code = status_code
        self.closed = False

    def json(self):
        return self._body

    def close(self):
        self.closed = True


class RequestsStub(types.ModuleType):
    def __init__(self):
        super().__init__("requests")
        self.responses = []
        self.calls = []

    def queue(self, body, status_code=200):
        self.responses.append(Response(body, status_code))

    def _take(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)

    def get(self, url, **kwargs):
        return self._take("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self._take("POST", url, **kwargs)

    def put(self, url, **kwargs):
        return self._take("PUT", url, **kwargs)


def load_cloud():
    thread = types.ModuleType("_thread")
    thread.allocate_lock = Lock
    thread.start_new_thread = lambda *_: None
    network = types.ModuleType("network")
    network.STA_IF = 0
    network.WLAN = lambda *_: None
    ntptime = types.ModuleType("ntptime")
    ntptime.host = ""
    ntptime.timeout = 0
    ntptime.settime = lambda: None
    secrets = types.ModuleType("device_secrets")
    secrets.INGEST_TOKEN = "EXAMPLE_ONLY_INGEST_TOKEN"
    ubinascii = types.ModuleType("ubinascii")
    import binascii
    ubinascii.hexlify = binascii.hexlify
    requests = RequestsStub()
    host_time = __import__("time")
    micro_time = types.ModuleType("time")
    micro_time.localtime = host_time.localtime
    micro_time.sleep = lambda *_: None
    micro_time.sleep_ms = lambda *_: None
    micro_time.ticks_ms = lambda: 1000
    micro_time.ticks_add = lambda value, delta: value + delta
    micro_time.ticks_diff = lambda left, right: left - right

    stubs = {
        "_thread": thread,
        "network": network,
        "ntptime": ntptime,
        "device_secrets": secrets,
        "ubinascii": ubinascii,
        "requests": requests,
        "time": micro_time,
    }
    original = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        path = pathlib.Path(__file__).parents[1] / "tab5" / "cloud.py"
        spec = importlib.util.spec_from_file_location("tab5_cloud_under_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, requests
    finally:
        for name, previous in original.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


class CloudTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cloud, cls.requests = load_cloud()

    def setUp(self):
        self.requests.responses.clear()
        self.requests.calls.clear()

    def test_retry_delay_is_exponential_and_bounded(self):
        self.assertEqual(self.cloud._retry_delay_ms(1), 5000)
        self.assertEqual(self.cloud._retry_delay_ms(2), 10000)
        self.assertEqual(self.cloud._retry_delay_ms(5), 60000)
        self.assertEqual(self.cloud._retry_delay_ms(50), 60000)

    def test_rtdb_path_is_scoped_to_explicit_json_location(self):
        self.assertEqual(
            self.cloud._rtdb_url("https://example.invalid/", "/v1/sites/well-main", "temporary-token"),
            "https://example.invalid/v1/sites/well-main.json?auth=temporary-token",
        )

    def test_current_observation_preserves_complete_unknown_content(self):
        nested = {"future": [1, {"value": 2}]}
        observation = {
            "schemaVersion": 1,
            "sequence": 42,
            "observedAt": "2026-08-24T20:00:00Z",
            "source": "tab5",
            "values": {"power": 2500, "newSensor": nested},
            "status": {"newStatus": "preserved"},
            "futureEnvelope": {"also": "preserved"},
        }
        current = self.cloud._copy_current_observation(observation, "boot_12345678")
        self.assertIs(current["values"]["newSensor"], nested)
        self.assertEqual(current["futureEnvelope"], {"also": "preserved"})
        self.assertEqual(current["siteId"], "well-main")
        self.assertEqual(current["deviceId"], "tab5-well-main")
        self.assertEqual(current["receivedAtMs"], {".sv": "timestamp"})
        self.assertNotIn("receivedAtMs", observation)

    def test_unsupported_observation_schema_is_rejected(self):
        with self.assertRaises(self.cloud.TransportError):
            self.cloud._copy_current_observation({"schemaVersion": 2}, "boot_12345678")

    def test_commands_are_sequence_aware_and_stale_commands_do_not_repeat(self):
        def command(sequence, **changes):
            value = {
                "schemaVersion": 1,
                "commandId": "command-{}".format(sequence),
                "commandSequence": sequence,
                "siteId": "well-main",
                "targetDeviceId": "tab5-well-main",
                "commandType": "close-event",
                "requestedAt": "2026-08-24T20:00:00Z",
                "requestedBy": {"type": "user", "id": "example-user"},
                "status": "pending",
                "payload": {"future": "preserved"},
            }
            value.update(changes)
            return value

        result = self.cloud._filter_new_commands({
            "newer": command(14),
            "stale": command(11),
            "next": command(12),
            "unsupported": command(13, schemaVersion=2),
            "other": command(15, targetDeviceId="other-device"),
        }, 11)
        self.assertEqual([item["commandSequence"] for item in result], [12, 14])
        self.assertEqual(result[0]["payload"], {"future": "preserved"})
        self.assertEqual(self.cloud._filter_new_commands(result, 14), [])

    def test_custom_token_exchange_and_refresh_keep_only_temporary_credentials(self):
        self.requests.queue({
            "idToken": "EXAMPLE_ONLY_ID_TOKEN",
            "refreshToken": "EXAMPLE_ONLY_REFRESH_TOKEN",
            "expiresIn": "3600",
        })
        auth = self.cloud._exchange_custom_token({
            "firebaseCustomToken": "EXAMPLE_ONLY_CUSTOM_TOKEN",
            "firebaseApiKey": "EXAMPLE_ONLY_API_KEY",
            "rtdbUrl": "https://example.invalid",
            "identityToolkitUrl": "https://identity.example.invalid/token",
            "secureTokenUrl": "https://secure.example.invalid/token",
        })
        self.assertEqual(auth["idToken"], "EXAMPLE_ONLY_ID_TOKEN")
        self.assertNotIn("firebaseCustomToken", auth)

        self.requests.queue({
            "id_token": "EXAMPLE_ONLY_REFRESHED_ID_TOKEN",
            "refresh_token": "EXAMPLE_ONLY_ROTATED_REFRESH_TOKEN",
            "expires_in": "3600",
        })
        refreshed = self.cloud._refresh_firebase_token(auth)
        self.assertEqual(refreshed["idToken"], "EXAMPLE_ONLY_REFRESHED_ID_TOKEN")
        method, _, kwargs = self.requests.calls[-1]
        self.assertEqual(method, "POST")
        self.assertIn("grant_type=refresh_token", kwargs["data"])

    def test_pre_m6_rules_bridge_is_transport_metadata_only(self):
        self.assertEqual(self.cloud.PRE_M6_TRANSPORT_ONLY_RULES_REFERENCE, {
            "version": 1,
            "contentHash": "0" * 64,
        })
        source = (pathlib.Path(__file__).parents[1] / "tab5" / "cloud.py").read_text()
        self.assertNotIn("open('rules", source)
        self.assertNotIn("eval_rules", source)


if __name__ == "__main__":
    unittest.main()
