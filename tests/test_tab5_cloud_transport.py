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
                "commandId": "20260824173458-command-web_2kP9mQ7z-{:010d}".format(sequence),
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

    def test_malformed_command_extra_fields_are_rejected(self):
        command = {
            "schemaVersion": 1,
            "commandId": "20260824173458-command-web_2kP9mQ7z-0000000012",
            "commandSequence": 12,
            "siteId": "well-main",
            "targetDeviceId": "tab5-well-main",
            "commandType": "close-event",
            "requestedAt": "2026-08-24T20:00:00Z",
            "requestedBy": {"type": "user", "id": "example-user"},
            "status": "pending",
            "payload": {},
            "unexpected": True,
        }
        self.assertEqual(self.cloud._filter_new_commands({"bad": command}, 0), [])
        del command["unexpected"]
        for changes in (
            {"requestedBy": {"type": "user", "id": "example-user", "role": "admin"}},
            {"requestedBy": {"type": "user", "id": "x" * 129}},
            {"requestedAt": "not-a-date"},
            {"commandId": "command-12"},
            {"commandSequence": 0},
        ):
            malformed = dict(command)
            malformed.update(changes)
            self.assertEqual(
                self.cloud._filter_new_commands({"bad": malformed}, 0), [])

    def test_queue_full_command_is_redelivered_after_capacity_returns(self):
        original_queue = self.cloud._pending_commands
        original_delivered = self.cloud._last_delivered_command_sequence
        try:
            self.cloud._pending_commands = []
            self.cloud._last_delivered_command_sequence = 0
            commands = []
            for sequence in range(1, self.cloud.COMMAND_QUEUE_DEPTH + 2):
                commands.append({
                    "schemaVersion": 1,
                    "commandId": "command-{}".format(sequence),
                    "commandSequence": sequence,
                })
            self.cloud._queue_commands(commands)
            self.assertEqual(len(self.cloud._pending_commands), self.cloud.COMMAND_QUEUE_DEPTH)
            self.assertEqual(self.cloud._last_delivered_command_sequence, self.cloud.COMMAND_QUEUE_DEPTH)
            self.cloud.take_command()
            self.cloud._queue_commands(commands)
            self.assertEqual(self.cloud._pending_commands[-1]["commandSequence"],
                             self.cloud.COMMAND_QUEUE_DEPTH + 1)
        finally:
            self.cloud._pending_commands = original_queue
            self.cloud._last_delivered_command_sequence = original_delivered

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
        original_sequence = self.cloud._sync_sequence
        try:
            request = self.cloud._sync_request()
        finally:
            self.cloud._sync_sequence = original_sequence
        self.assertEqual(request["appliedRules"], {
            "version": 1,
            "contentHash": "0" * 64,
        })
        self.assertEqual(request["openEventIds"], [])

    def test_bootstrap_rejects_unapproved_project_host_and_token_origins(self):
        request = {
            "schemaVersion": 1,
            "kind": "device-sync-request",
            "exchangeId": "20260824200000-sync-boot_12345678-0000000001",
            "siteId": "well-main",
            "deviceId": "tab5-well-main",
            "sessionId": "boot_12345678",
        }

        def reply(**bootstrap_changes):
            bootstrap = {
                "firebaseCustomToken": "EXAMPLE_ONLY_CUSTOM_TOKEN",
                "firebaseApiKey": "EXAMPLE_ONLY_API_KEY",
                "firebaseProjectId": "well-pump-control",
                "rtdbUrl": "https://well-pump-control-default-rtdb.firebaseio.com",
                "identityToolkitUrl": self.cloud.APPROVED_IDENTITY_TOOLKIT_URL,
                "secureTokenUrl": self.cloud.APPROVED_SECURE_TOKEN_URL,
            }
            bootstrap.update(bootstrap_changes)
            return {
                "schemaVersion": 1,
                "kind": "device-sync-response",
                "exchangeId": request["exchangeId"],
                "siteId": request["siteId"],
                "deviceId": request["deviceId"],
                "sessionId": request["sessionId"],
                "authenticationBootstrap": bootstrap,
            }

        self.assertEqual(
            self.cloud._validate_sync_response(reply(), request)["firebaseProjectId"],
            "well-pump-control")
        for changes in (
            {"firebaseProjectId": "other-project"},
            {"rtdbUrl": "https://evil.example"},
            {"identityToolkitUrl": "https://evil.example/token"},
            {"secureTokenUrl": "https://evil.example/refresh"},
        ):
            with self.assertRaises(self.cloud.TransportError):
                self.cloud._validate_sync_response(reply(**changes), request)

    def test_sync_state_payload_includes_completed_bootstrap_exchange_id(self):
        exchange_id = "20260824200000-sync-boot_12345678-0000000001"
        payload = self.cloud._sync_state_payload("ok", exchange_id)
        self.assertEqual(payload, {
            "schemaVersion": 1,
            "exchangeId": exchange_id,
            "siteId": "well-main",
            "deviceId": "tab5-well-main",
            "sessionId": self.cloud._session_id,
            "lastSeenCommandSequence": self.cloud._last_delivered_command_sequence,
            "lastAppliedCommandSequence": self.cloud._last_applied_command_sequence,
            "result": "ok",
            "lastSyncAtMs": {".sv": "timestamp"},
        })

    def test_scheduler_uses_post_operation_deadlines_and_one_action_per_step(self):
        schedule = self.cloud._new_rtdb_schedule(1000)
        schedule["phase"] = "ready"
        schedule["auth"] = {"expiresAtTicks": 1000000}
        schedule["syncWritePending"] = True
        self.assertEqual(self.cloud._next_rtdb_action(schedule, 1000, 1), "sync-state")
        self.cloud._complete_rtdb_action(schedule, "sync-state", 4000, True)
        self.assertEqual(schedule["nextOperationAt"],
                         4000 + self.cloud.RTDB_MIN_OPERATION_GAP_MS)
        self.assertIsNone(self.cloud._next_rtdb_action(schedule, 4000, 1))

    def test_scheduler_gives_legacy_service_first_chance_after_slow_operations(self):
        schedule = self.cloud._new_rtdb_schedule(0)
        schedule["phase"] = "ready"
        schedule["auth"] = {"expiresAtTicks": 1000000}
        schedule["nextPresenceAt"] = 0
        order = []
        now = 0
        for _ in range(3):
            order.append("legacy")  # mirrors _run: legacy block precedes RTDB step
            action = self.cloud._next_rtdb_action(schedule, now, None)
            order.append(action)
            completed = now + 3000  # simulated slow but bounded success
            self.cloud._complete_rtdb_action(schedule, action, completed, True)
            now = schedule["nextOperationAt"]
        self.assertEqual(order[0::2], ["legacy", "legacy", "legacy"])
        self.assertEqual(len(order[1::2]), 3)

    def test_scheduler_bounds_failures_and_rebootstraps_after_auth_denial(self):
        for denied_status in (401, 403):
            schedule = self.cloud._new_rtdb_schedule(0)
            schedule["phase"] = "ready"
            schedule["auth"] = {"expiresAtTicks": 1000000}
            self.cloud._complete_rtdb_action(
                schedule, "current-observation", 2000, False,
                denied_status)
            self.assertEqual(schedule["phase"], "device-sync")
            self.assertIsNone(schedule["auth"])
            self.assertEqual(schedule["nextOperationAt"], 7000)
        for count in range(2, 20):
            completed = schedule["nextOperationAt"]
            self.cloud._complete_rtdb_action(
                schedule, "device-sync", completed, False, None)
        self.assertLessEqual(
            schedule["nextOperationAt"] - completed,
            self.cloud.RTDB_RETRY_MAX_MS)

    def test_rtdb_step_runs_one_operation_and_uses_slow_completion_tick(self):
        schedule = self.cloud._new_rtdb_schedule(1000)
        schedule["phase"] = "ready"
        schedule["auth"] = {
            "idToken": "EXAMPLE_ONLY_ID_TOKEN",
            "rtdbUrl": "https://well-pump-control-default-rtdb.firebaseio.com",
            "expiresAtTicks": 1000000,
        }
        schedule["exchangeId"] = (
            "20260824200000-sync-boot_12345678-0000000001")
        schedule["nextPresenceAt"] = 999999
        schedule["nextCoordinationAt"] = 999999
        observation = {"schemaVersion": 1, "sequence": 7}
        calls = []
        clock = [1000]
        original_ticks = self.cloud.time.ticks_ms
        original_put = self.cloud._rtdb_put
        try:
            self.cloud.time.ticks_ms = lambda: clock[0]

            def slow_put(*args):
                calls.append(args)
                clock[0] += 3000
                return None

            self.cloud._rtdb_put = slow_put
            self.assertEqual(
                self.cloud._run_rtdb_step(schedule, observation),
                "current-observation")
            self.assertEqual(len(calls), 1)
            self.assertEqual(schedule["nextOperationAt"],
                             4000 + self.cloud.RTDB_MIN_OPERATION_GAP_MS)
            self.assertIsNone(self.cloud._run_rtdb_step(schedule, observation))
            self.assertEqual(len(calls), 1)
        finally:
            self.cloud.time.ticks_ms = original_ticks
            self.cloud._rtdb_put = original_put

    def test_slow_fresh_current_cannot_starve_presence_or_coordination(self):
        schedule = self.cloud._new_rtdb_schedule(0)
        schedule["phase"] = "ready"
        schedule["auth"] = {
            "idToken": "EXAMPLE_ONLY_ID_TOKEN",
            "rtdbUrl": "https://well-pump-control-default-rtdb.firebaseio.com",
            "expiresAtTicks": 1000000,
        }
        schedule["exchangeId"] = (
            "20260824200000-sync-boot_12345678-0000000001")
        clock = [0]
        actions = []
        order = []
        original_ticks = self.cloud.time.ticks_ms
        original_put = self.cloud._rtdb_put
        original_get = self.cloud._rtdb_get
        try:
            self.cloud.time.ticks_ms = lambda: clock[0]

            def slow_put(*_args):
                clock[0] += 900

            def slow_get(_auth, path):
                clock[0] += 900
                if path.endswith("globalEnable"):
                    return False
                return {} if path.endswith("commands") else None

            self.cloud._rtdb_put = slow_put
            self.cloud._rtdb_get = slow_get
            for sequence in range(1, 25):
                order.append("legacy")
                action = self.cloud._run_rtdb_step(
                    schedule, {"schemaVersion": 1, "sequence": sequence})
                order.append(action)
                actions.append(action)
                clock[0] = schedule["nextOperationAt"]
        finally:
            self.cloud.time.ticks_ms = original_ticks
            self.cloud._rtdb_put = original_put
            self.cloud._rtdb_get = original_get

        self.assertEqual(order[0::2], ["legacy"] * 24)
        self.assertLessEqual(actions.index("global-enable"), 0)
        self.assertLessEqual(actions.index("rules-metadata"), 1)
        self.assertLessEqual(actions.index("commands"), 2)
        self.assertLessEqual(actions.index("presence"), 4)
        self.assertIn("current-observation", actions[5:])
        self.assertGreater(actions.count("current-observation"), 1)
        self.assertGreater(actions.count("global-enable"), 1)


if __name__ == "__main__":
    unittest.main()
