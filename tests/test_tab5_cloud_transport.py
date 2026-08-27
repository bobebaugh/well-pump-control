"""Host-only logic tests for the interpreted M3/M5 CPU B transport.

These tests stub UIFlow/MicroPython modules. They do not prove TLS, threading,
Wi-Fi, timing, or physical Tab5 behavior.
"""

import importlib.util
import json
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
    def __init__(self, body, status_code=200, text=None):
        self._body = body
        self.status_code = status_code
        self.text = json.dumps(body) if text is None else text
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

    def queue(self, body, status_code=200, text=None):
        self.responses.append(Response(body, status_code, text))

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
        self.cloud._pending_rules_request = None
        self.cloud._pending_rules_release = None
        self.cloud._pending_rules_pointer = None
        self.cloud._applied_rules_reference = dict(
            self.cloud.PRE_M6_TRANSPORT_ONLY_RULES_REFERENCE)
        for key in self.cloud._transport_status:
            self.cloud._transport_status[key] = None

    def test_retry_delay_is_exponential_and_bounded(self):
        self.assertEqual(self.cloud._retry_delay_ms(1), 5000)
        self.assertEqual(self.cloud._retry_delay_ms(2), 10000)
        self.assertEqual(self.cloud._retry_delay_ms(5), 60000)
        self.assertEqual(self.cloud._retry_delay_ms(50), 60000)
        self.assertEqual(self.cloud._durable_retry_delay_ms(1), 5000)
        self.assertEqual(self.cloud._durable_retry_delay_ms(50), 60000)

    def test_cpu_a_session_identity_is_stable(self):
        first = self.cloud.device_session_id()
        self.assertEqual(self.cloud.device_session_id(), first)
        self.assertTrue(first.startswith("boot_"))

    def test_transport_status_reports_confirmed_results_and_queue_depth(self):
        original_observation = self.cloud._pending_observation
        original_durable = self.cloud._pending_durable_records
        try:
            self.cloud._pending_observation = {"sequence": 4}
            self.cloud._pending_durable_records = [{"recordId": "one"}]
            self.assertTrue(
                self.cloud._record_transport_result("telemetry", True, 1000))
            self.assertTrue(
                self.cloud._record_transport_result("telemetry", False, 2000))
            self.assertTrue(
                self.cloud._record_transport_result("rtdb", True, 1500))
            snapshot = self.cloud.transport_status_snapshot()
            self.assertEqual(snapshot["telemetryLastAttemptTicksMs"], 2000)
            self.assertEqual(snapshot["telemetryLastSuccessTicksMs"], 1000)
            self.assertFalse(snapshot["telemetryLastAttemptOk"])
            self.assertEqual(snapshot["rtdbLastSuccessTicksMs"], 1500)
            self.assertTrue(snapshot["observationPending"])
            self.assertEqual(snapshot["durableQueueDepth"], 1)
            self.assertEqual(
                snapshot["durableQueueCapacity"],
                self.cloud.DURABLE_QUEUE_DEPTH,
            )
            snapshot["telemetryLastAttemptOk"] = True
            self.assertFalse(
                self.cloud.transport_status_snapshot()[
                    "telemetryLastAttemptOk"])
        finally:
            self.cloud._pending_observation = original_observation
            self.cloud._pending_durable_records = original_durable

    def test_durable_fifo_is_bounded_and_preserves_record_identity(self):
        original = self.cloud._pending_durable_records
        try:
            self.cloud._pending_durable_records = []
            records = [
                {"schemaVersion": 1, "recordType": "observation", "sequence": sequence}
                for sequence in range(self.cloud.DURABLE_QUEUE_DEPTH + 1)
            ]
            for record in records[:-1]:
                self.assertTrue(self.cloud.submit_durable_record(record))
            self.assertFalse(self.cloud.submit_durable_record(records[-1]))
            first = self.cloud._peek_durable_record()
            self.assertIs(first, records[0])
            self.assertTrue(self.cloud._discard_durable_record(first))
            self.assertIs(self.cloud._peek_durable_record(), records[1])
        finally:
            self.cloud._pending_durable_records = original

    def test_rules_audits_use_the_same_bounded_exact_record_transport(self):
        original = self.cloud._pending_durable_records
        record = {
            "schemaVersion": 1,
            "recordType": "rule-adoption",
            "recordId": "20260825000042-rule-adoption-boot_A7f93k2Q-0000000042",
            "futureAuditField": {"preserved": True},
        }
        try:
            self.cloud._pending_durable_records = []
            self.assertTrue(self.cloud.submit_durable_record(record))
            self.assertIs(self.cloud._peek_durable_record(), record)
        finally:
            self.cloud._pending_durable_records = original

    def test_rules_audit_evicts_oldest_observation_from_full_queue(self):
        original = self.cloud._pending_durable_records
        observations = [
            {"schemaVersion": 1, "recordType": "observation", "sequence": sequence}
            for sequence in range(self.cloud.DURABLE_QUEUE_DEPTH)
        ]
        audit = {
            "schemaVersion": 1,
            "recordType": "rule-adoption",
            "sequence": 99,
        }
        try:
            self.cloud._pending_durable_records = list(observations)
            self.assertTrue(self.cloud.submit_durable_record(audit))
            self.assertNotIn(observations[0], self.cloud._pending_durable_records)
            self.assertIn(audit, self.cloud._pending_durable_records)
            self.assertEqual(
                len(self.cloud._pending_durable_records),
                self.cloud.DURABLE_QUEUE_DEPTH,
            )
        finally:
            self.cloud._pending_durable_records = original

    def test_pending_rules_download_can_follow_disposable_current_only(self):
        self.assertTrue(self.cloud._rules_download_may_follow_rtdb(None))
        self.assertTrue(self.cloud._rules_download_may_follow_rtdb("current-observation"))
        self.assertFalse(self.cloud._rules_download_may_follow_rtdb("rules-metadata"))
        self.assertFalse(self.cloud._rules_download_may_follow_rtdb("commands"))

    def test_rules_pointer_summary_reports_field_names_not_values(self):
        pointer = {"siteId": "well-main", "schemaVersion": 1}
        self.assertEqual(
            self.cloud._rules_pointer_key_summary(pointer),
            "schemaVersion,siteId",
        )
        self.assertEqual(
            self.cloud._rules_pointer_key_summary(None),
            "not-an-object",
        )

    def test_rules_pointer_uses_its_own_latest_value_handoff(self):
        first = {"releaseId": "first"}
        latest = {"releaseId": "latest"}
        self.cloud._queue_rules_pointer(first)
        self.cloud._queue_rules_pointer(latest)
        self.assertIs(self.cloud.take_rules_pointer(), latest)
        self.assertIsNone(self.cloud.take_rules_pointer())

    def test_durable_transport_posts_exact_record_and_accepts_duplicate(self):
        record = {
            "schemaVersion": 1,
            "recordType": "observation",
            "recordId": "20260825000042-observation-boot_A7f93k2Q-0000000042",
            "futureEnvelope": {"preserved": True},
        }
        self.requests.queue({
            "status": "ok",
            "accepted": True,
            "duplicate": True,
            "recordId": record["recordId"],
        }, status_code=200)
        self.assertTrue(self.cloud._publish_durable_record(record))
        method, url, kwargs = self.requests.calls[-1]
        self.assertEqual(method, "POST")
        self.assertEqual(url, self.cloud.DURABLE_INGEST_URL)
        self.assertIs(kwargs["json"], record)
        self.assertEqual(kwargs["headers"]["X-Pilot-Key"], "EXAMPLE_ONLY_INGEST_TOKEN")

        self.requests.queue({
            "status": "ok",
            "accepted": True,
            "duplicate": True,
            "recordId": record["recordId"],
        }, status_code=200)
        self.cloud._publish_durable_record(record)
        self.assertIs(self.requests.calls[-1][2]["json"], record)

    def test_unavailable_current_observation_does_not_replace_legacy_sample(self):
        valid = {
            "sequence": 7,
            "status": {"shelly_available": True},
            "values": {"power": 1000.0},
        }
        unavailable = {
            "sequence": 8,
            "status": {"shelly_available": False},
            "values": {"power": None},
        }
        self.assertIs(self.cloud._legacy_observation_candidate(valid, None), valid)
        self.assertIs(
            self.cloud._legacy_observation_candidate(unavailable, valid), valid
        )

    def test_transport_error_avoids_builtin_exception_init_and_keeps_http_status(self):
        self.assertNotIn("__init__", self.cloud.TransportError.__dict__)
        self.requests.queue({}, status_code=403)
        with self.assertRaises(self.cloud.TransportError) as raised:
            self.cloud._http_json("GET", "https://example.invalid/test")
        self.assertEqual(str(raised.exception), "HTTP 403")
        self.assertEqual(raised.exception.status_code, 403)

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

    def test_sync_request_reports_cpu_a_validated_active_rules(self):
        original_sequence = self.cloud._sync_sequence
        try:
            self.assertTrue(self.cloud.set_applied_rules({
                "version": 2,
                "contentHash": "a" * 64,
            }))
            request = self.cloud._sync_request()
        finally:
            self.cloud._sync_sequence = original_sequence
        self.assertEqual(request["appliedRules"], {
            "version": 2,
            "contentHash": "a" * 64,
        })
        self.assertEqual(request["openEventIds"], [])

    def test_applied_rules_handoff_rejects_invalid_and_copies_valid_reference(self):
        self.assertFalse(self.cloud.set_applied_rules({
            "version": 1,
            "contentHash": "not-a-hash",
        }))
        reference = {"version": 3, "contentHash": "b" * 64}
        self.assertTrue(self.cloud.set_applied_rules(reference))
        reference["version"] = 99
        self.assertEqual(self.cloud._applied_rules_snapshot(), {
            "version": 3,
            "contentHash": "b" * 64,
        })

    def test_rules_release_transport_preserves_exact_body_for_cpu_a(self):
        metadata = {
            "schemaVersion": 1,
            "siteId": "well-main",
            "releaseId": "20260825000000-rules-v1",
            "rulesVersion": 1,
            "rulesSchemaVersion": 1,
            "contentHash": "a" * 64,
            "hashAlgorithm": "sha256",
            "publishedAtMs": 1787616000000,
            "downloadPath": "/.netlify/functions/rules-release/20260825000000-rules-v1.json",
        }
        raw_release = '{"schemaVersion":1,"kind":"well-pump-rules-release"}'
        self.requests.queue({}, text=raw_release)
        self.assertTrue(self.cloud.request_rules_release(metadata))
        queued_request = self.cloud._take_rules_request()
        self.assertEqual(queued_request, metadata)
        self.cloud._queue_rules_release(
            queued_request, self.cloud._download_rules_release(queued_request))
        self.assertEqual(self.cloud.take_rules_release(), {
            "metadata": metadata,
            "release": raw_release,
        })
        method, url, kwargs = self.requests.calls[-1]
        self.assertEqual(method, "GET")
        self.assertEqual(
            url,
            self.cloud.RULES_RELEASE_ORIGIN +
            "/.netlify/functions/rules-release?releaseId=" +
            "20260825000000-rules-v1.json",
        )
        self.assertEqual(kwargs["headers"]["X-Pilot-Key"], "EXAMPLE_ONLY_INGEST_TOKEN")

    def test_rules_release_transport_rejects_unapproved_paths_before_network(self):
        with self.assertRaises(self.cloud.TransportError):
            self.cloud._download_rules_release({
                "downloadPath": "https://example.invalid/rules.json",
            })
        self.assertEqual(self.requests.calls, [])

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
