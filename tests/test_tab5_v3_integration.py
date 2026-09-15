"""Host-only startup and integrated-cycle tests; never import the live application."""

import ast
import copy
import hashlib
import json
import os
import pathlib
import tempfile
import types
import unittest


ROOT = pathlib.Path(__file__).parents[1]
PILOT_PATH = ROOT / "tab5" / "pilot.py"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "rules-runtime-package-v3-checkpoint1.json"
LEGACY_PATH = ROOT / "tests" / "fixtures" / "rules-runtime-package-v3-legacy-control.json"
# Documentation-based, not a captured device response. See its provenance block.
SHELLY_DOC = json.loads(
    (ROOT / "tests" / "fixtures" / "shelly1-getcomponents-documentation.json")
    .read_text(encoding="utf-8"))


def load_logic(targets):
    # main.py owns the converter, the qualified fit and the shared device
    # address, so both files are scanned and the import-time bindings pilot.py
    # takes from __main__ are skipped - those are plumbing, and executing one
    # here raises NameError while the real definition comes from main.py.
    tree = ast.parse(PILOT_PATH.read_text(encoding="utf-8") + "\n" +
                     (PILOT_PATH.parent / "main.py").read_text(encoding="utf-8"))
    definitions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    assignments = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            if any(isinstance(child, ast.Name) and child.id == "__main__"
                   for child in ast.walk(node.value)):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assignments[target.id] = node
    wanted = set(targets)
    selected_functions = set()
    selected_assignments = set()
    pending = list(targets)
    while pending:
        name = pending.pop()
        node = definitions.get(name)
        if node is not None and name not in selected_functions:
            selected_functions.add(name)
            dependencies = {item.id for item in ast.walk(node)
                            if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}
            pending.extend(dependencies - wanted)
            wanted.update(dependencies)
        assignment = assignments.get(name)
        if assignment is not None and name not in selected_assignments:
            selected_assignments.add(name)
            dependencies = {item.id for item in ast.walk(assignment)
                            if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}
            pending.extend(dependencies - wanted)
            wanted.update(dependencies)
    def _binds_from_main(node):
        return any(isinstance(child, ast.Name) and child.id == "__main__"
                   for child in ast.walk(node.value))

    nodes = [node for node in tree.body
             if ((isinstance(node, ast.FunctionDef) and node.name in selected_functions) or
                 (isinstance(node, ast.Assign) and not _binds_from_main(node) and any(
                     isinstance(target, ast.Name) and target.id in selected_assignments
                     for target in node.targets)))]
    clock = types.SimpleNamespace(
        ticks_diff=lambda left, right: left - right,
        ticks_add=lambda value, delta: value + delta,
        localtime=lambda: (2026, 9, 11, 12, 0, 0, 0, 0),
    )
    namespace = {"time": clock, "ujson": json, "uhashlib": hashlib, "os": os}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(PILOT_PATH), "exec"), namespace)
    return namespace


TARGETS = {
    "read_shelly", "read_shelly1", "normalize_shelly1_filtered",
    "shelly1_component_routing", "shelly1_filtered_keys", "shelly1_filtered_url",
    "start_rules_v3_runtime", "stage_rules_v3_release", "run_rules_v3_cycle",
    "rules_v3_state_report", "issue_rules_v3_action", "dispatch_rules_v3_actions",
    "build_durable_observation",
}


class V3IntegratedApplicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.logic = load_logic(TARGETS)
        cls.raw_a = FIXTURE_PATH.read_text(encoding="utf-8")

    def pointer(self, raw, release_id, version):
        return {
            "schemaVersion": 4, "kind": "well-pump-event-v3-runtime-pointer",
            "siteId": "well-main", "releaseId": release_id,
            "packageVersion": version, "runtimeSchemaVersion": 3,
            "contentHash": hashlib.sha256(raw.encode()).hexdigest(),
            "hashAlgorithm": "sha256", "byteLength": len(raw.encode()),
            "publishedAtMs": 1789128000000, "executionEnabled": True,
            "downloadPath": "/.netlify/functions/rules-engine-release?version=3&releaseId=" + release_id,
        }

    @staticmethod
    def discovery():
        """The documentation fixture's discovery reply; ids are never assumed."""
        return copy.deepcopy(SHELLY_DOC["discoveryResponse"])

    @classmethod
    def routing_ids(cls):
        components = SHELLY_DOC["discoveryResponse"]["components"]
        by_name = {c["config"]["name"]: c["key"] for c in components}
        return {name: int(by_name[name].split(":")[1])
                for name in ("IsLocked", "loCntr", "Tab5IsLocked")}

    @classmethod
    def filtered(cls, locked=0, counter=0, flag=False, output=True, state=True,
                 drop=None, rename=None):
        """One filtered reply, adjusted per case. Keys come from the fixture."""
        reply = copy.deepcopy(SHELLY_DOC["filteredResponse"])
        ids = cls.routing_ids()
        values = {"number:{}".format(ids["IsLocked"]): locked,
                  "number:{}".format(ids["loCntr"]): counter,
                  "boolean:{}".format(ids["Tab5IsLocked"]): flag}
        kept = []
        for component in reply["components"]:
            key = component["key"]
            if key == drop:
                continue
            if key == "switch:0":
                component["status"]["output"] = output
            elif key == "input:0":
                component["status"]["state"] = state
            elif key in values:
                component["status"]["value"] = values[key]
            if rename and key == rename[0]:
                component["config"]["name"] = rename[1]
            kept.append(component)
        reply["components"] = kept
        return reply

    @staticmethod
    def em(**changes):
        value = {"power": 2800.0, "reactive": 10.0, "pf": 0.98,
                 "voltage": 240.0, "is_valid": True,
                 "total": 1000.0, "total_returned": 0.0}
        value.update(changes)
        return value

    def observation(self, lock=0, voltage=240.0, flag=False, relay=False):
        return {
            "schemaVersion": 1, "sequence": 1, "observedTicksMs": 0,
            "observedAt": "2026-09-11T12:00:00Z", "source": "tab5",
            "values": {
                "power": 2800.0, "reactive": 10.0, "pf": 0.98,
                "voltage": voltage, "is_valid": True, "total": 1000.0,
                "total_returned": 0.0, "shelly1_rly0": relay,
                "shelly1_sw0": True, "shelly1_lock": lock,
                "shelly1_lockout_count": 0, "adc_raw": 14307,
                "shelly1_tab5lock": flag,
                "battery_percent": 78,
            },
            "status": {
                "shelly_available": True, "shelly1_available": True,
                "shelly1_tab5lock_id": self.routing_ids()["Tab5IsLocked"],
                "pressure_sensor_commissioned": True, "adc_available": True,
                "clock_synced": True, "wifi_connected": True,
                "cloud_available": True, "buffer_used_pct": 0.0,
                "records_lost": 0,
            },
        }

    def start(self, directory, raw=None):
        path = pathlib.Path(directory) / "rules-runtime-v3-staged.json"
        path.write_text(self.raw_a if raw is None else raw, encoding="utf-8")
        runtime, reason = self.logic["start_rules_v3_runtime"](str(path))
        self.assertIsNone(reason)
        self.assertIsNotNone(runtime)
        return runtime, path

    def test_discovery_resolves_names_then_steady_state_uses_one_request(self):
        ids = self.routing_ids()
        for lock in (-1, 0, 37):
            urls = []
            replies = [self.discovery(), self.filtered(locked=lock, counter=2)]
            sample, routing = self.logic["read_shelly1"](
                lambda url: urls.append(url) or replies.pop(0))
            self.assertEqual(sample["is_locked"], lock)
            self.assertEqual(sample["lockout_count"], 2)
            self.assertIs(sample["tab5_is_locked"], False)
            self.assertEqual(sample["flag_id"], ids["Tab5IsLocked"])
            self.assertEqual(routing, ids)
            self.assertEqual(len(urls), 2, "discovery then one filtered read")
            self.assertIn("dynamic_only=true", urls[0])
            self.assertIn("keys=", urls[1])
            self.assertNotIn("dynamic_only", urls[1])
            # A known mapping costs exactly one request and no GetStatus at all.
            urls = []
            steady = [self.filtered(locked=lock, counter=2)]
            sample, routing = self.logic["read_shelly1"](
                lambda url: urls.append(url) or steady.pop(0), routing=routing)
            self.assertEqual(len(urls), 1)
            self.assertNotIn("Shelly.GetStatus", urls[0])
            self.assertEqual(sample["is_locked"], lock)

    def test_filtered_request_names_every_component_by_resolved_id(self):
        ids = self.routing_ids()
        keys = self.logic["shelly1_filtered_keys"](ids)
        self.assertEqual(keys, [
            "switch:0", "input:0",
            "number:{}".format(ids["IsLocked"]),
            "number:{}".format(ids["loCntr"]),
            "boolean:{}".format(ids["Tab5IsLocked"])])
        url = self.logic["shelly1_filtered_url"](ids)
        for key in keys:
            self.assertIn("%22{}%22".format(key), url)
        self.assertIn("include=%5B%22config%22%2C%22status%22%5D", url)

    def test_discovery_rejects_missing_duplicate_and_malformed_components(self):
        routing = self.logic["shelly1_component_routing"](self.discovery())
        self.assertEqual(routing, self.routing_ids())
        # Missing the boolean entirely.
        without = self.discovery()
        without["components"] = [c for c in without["components"]
                                 if not c["key"].startswith("boolean:")]
        self.assertIsNone(self.logic["shelly1_component_routing"](without))
        # Two components claiming the same name.
        duplicated = self.discovery()
        clone = copy.deepcopy(
            next(c for c in duplicated["components"] if c["key"].startswith("boolean:")))
        clone["key"] = "boolean:999"
        clone["config"] = dict(clone["config"], id=999)
        duplicated["components"].append(clone)
        self.assertIsNone(self.logic["shelly1_component_routing"](duplicated))
        # Declared as the wrong component type.
        wrong_type = self.discovery()
        for component in wrong_type["components"]:
            if component["config"]["name"] == "Tab5IsLocked":
                component["key"] = "number:246"
        self.assertIsNone(self.logic["shelly1_component_routing"](wrong_type))
        # Present, but not carrying a boolean value.
        malformed = self.discovery()
        for component in malformed["components"]:
            if component["config"]["name"] == "Tab5IsLocked":
                component["status"]["value"] = 1
        self.assertIsNone(self.logic["shelly1_component_routing"](malformed))
        # Unusable key shapes.
        for bad_key in ("boolean:", "boolean:x7", "boolean"):
            broken = self.discovery()
            for component in broken["components"]:
                if component["config"]["name"] == "Tab5IsLocked":
                    component["key"] = bad_key
            self.assertIsNone(self.logic["shelly1_component_routing"](broken))
        self.assertIsNone(self.logic["shelly1_component_routing"]("bad"))
        self.assertIsNone(self.logic["shelly1_component_routing"]({"components": {}}))

    def test_incomplete_or_wrong_type_filtered_cycle_is_wholly_unavailable(self):
        ids = self.routing_ids()
        accept = self.logic["normalize_shelly1_filtered"]
        self.assertIsNotNone(accept(self.filtered(), ids))
        # A short page is never read as valid absence: every requested key must
        # be present, whatever `total` says.
        for missing in ("switch:0", "input:0",
                        "number:{}".format(ids["IsLocked"]),
                        "number:{}".format(ids["loCntr"]),
                        "boolean:{}".format(ids["Tab5IsLocked"])):
            self.assertIsNone(accept(self.filtered(drop=missing), ids), missing)
        # An id that now carries a different component rejects the acquisition.
        self.assertIsNone(accept(self.filtered(
            rename=("boolean:{}".format(ids["Tab5IsLocked"]), "SomethingElse")), ids))
        # Out-of-range and wrong-typed values.
        self.assertIsNone(accept(self.filtered(locked=-2), ids))
        self.assertIsNone(accept(self.filtered(counter=4), ids))
        wrong = self.filtered()
        for component in wrong["components"]:
            if component["key"] == "switch:0":
                component["status"]["output"] = 1
        self.assertIsNone(accept(wrong, ids))
        flag_wrong = self.filtered()
        for component in flag_wrong["components"]:
            if component["key"].startswith("boolean:"):
                component["status"]["value"] = "false"
        self.assertIsNone(accept(flag_wrong, ids))
        self.assertIsNone(accept("bad", ids))
        self.assertIsNone(accept(self.filtered(), None))

    def test_the_captured_device_response_parses(self):
        """Against the owner-captured filtered reply, not a description of one.

        The device returned the components in a different order from the one
        requested, so acceptance is keyed rather than positional, and reported
        total 4 - the number matched by the filter, not the device-wide 20.
        """
        captured = copy.deepcopy(SHELLY_DOC["capturedFilteredResponse"])
        requested = ["switch:0", "input:0", "number:201", "number:202"]
        returned = [item["key"] for item in captured["components"]]
        self.assertEqual(sorted(returned), sorted(requested))
        self.assertNotEqual(returned, requested, "order is not the requested order")
        self.assertEqual(captured["total"], 4, "total is the matched count")
        self.assertEqual(captured["offset"], 0)

        routing = {"IsLocked": 201, "loCntr": 202, "Tab5IsLocked": 250}
        # Tab5IsLocked does not exist on the device yet, so this exact reply must
        # be rejected rather than partially accepted.
        self.assertIsNone(
            self.logic["normalize_shelly1_filtered"](captured, routing),
            "a requested component that is absent rejects the whole acquisition")

        # With the flag present, the same captured envelope is accepted.
        complete = copy.deepcopy(captured)
        complete["components"].append({
            "key": "boolean:250",
            "status": {"value": False, "source": "rpc", "last_update_ts": 1789329464},
            "config": {"id": 250, "name": "Tab5IsLocked", "persisted": False,
                       "default_value": False, "owner": "script:1", "access": "Crw"},
            "attrs": {"owner": "script:1", "role": "tab5IsLocked"}})
        complete["total"] = 5
        record = self.logic["normalize_shelly1_filtered"](complete, routing)
        self.assertEqual(record, {
            "sw0": False, "rly0": True, "is_locked": 0, "lockout_count": 0,
            "tab5_is_locked": False, "flag_id": 250})

        # Order must not matter, and acceptance must not depend on total.
        reversed_order = copy.deepcopy(complete)
        reversed_order["components"].reverse()
        self.assertEqual(self.logic["normalize_shelly1_filtered"](reversed_order, routing),
                         record)
        wrong_total = copy.deepcopy(complete)
        wrong_total["total"] = 20
        self.assertEqual(self.logic["normalize_shelly1_filtered"](wrong_total, routing),
                         record)
        del wrong_total["total"]
        self.assertEqual(self.logic["normalize_shelly1_filtered"](wrong_total, routing),
                         record, "a reply without total is still acceptable")

    def test_an_unknown_key_is_omitted_silently_and_rejects_the_acquisition(self):
        """Captured behavior: the device omits a key it does not have.

        No RPC error and no placeholder - four components and total 4 for a
        five-key request. `total` reports what the filter matched, so the reply
        alone cannot distinguish an unknown key from a truncated page. Presence
        checking every requested key is the only rule that is safe under both.
        """
        ids = self.routing_ids()
        captured = copy.deepcopy(SHELLY_DOC["capturedFilteredResponse"])
        # The owner requested five keys and received these four, total 4.
        self.assertEqual(len(captured["components"]), 4)
        self.assertEqual(captured["total"], 4)

        routing = dict(ids, IsLocked=201, loCntr=202)
        self.assertIsNone(
            self.logic["normalize_shelly1_filtered"](captured, routing),
            "the absent component must reject the whole acquisition")

        # And the mapping is discarded, so the next cycle rediscovers by name
        # rather than asking for an id the device has already declined to answer.
        sample, next_routing = self.logic["read_shelly1"](
            lambda _url: copy.deepcopy(captured), routing=routing)
        self.assertIsNone(sample)
        self.assertIsNone(next_routing)

    def test_transport_failure_keeps_the_mapping_but_a_contradiction_discards_it(self):
        ids = self.routing_ids()
        # A timeout proves nothing about the components; the mapping survives.
        sample, routing = self.logic["read_shelly1"](
            lambda _url: (_ for _ in ()).throw(TimeoutError()), routing=ids)
        self.assertIsNone(sample)
        self.assertEqual(routing, ids)
        # A reply that contradicts the mapping discards it so the next cycle
        # rediscovers by name.
        sample, routing = self.logic["read_shelly1"](
            lambda _url: self.filtered(drop="boolean:{}".format(ids["Tab5IsLocked"])),
            routing=ids)
        self.assertIsNone(sample)
        self.assertIsNone(routing)
        # Discovery that fails yields no mapping and no acquisition.
        sample, routing = self.logic["read_shelly1"](lambda _url: None)
        self.assertIsNone(sample)
        self.assertIsNone(routing)

    def test_em_complete_missing_wrong_failed_timeout_and_recovery(self):
        self.assertEqual(self.logic["read_shelly"](lambda _url: self.em())["power"], 2800.0)
        for invalid in ({**self.em(), "power": "2800"},
                        {key: value for key, value in self.em().items() if key != "voltage"},
                        self.em(is_valid=False), "malformed", None):
            self.assertIsNone(self.logic["read_shelly"](lambda _url, value=invalid: value))
        self.assertIsNone(self.logic["read_shelly"](
            lambda _url: (_ for _ in ()).throw(TimeoutError())))
        self.assertEqual(self.logic["read_shelly"](lambda _url: self.em())["voltage"], 240.0)

    def test_tab5_record_missing_wrong_and_recovery_are_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            for mutation in ("missing", "wrong"):
                observation = self.observation()
                if mutation == "missing":
                    observation["status"].pop("clock_synced")
                else:
                    observation["values"]["adc_raw"] = "14307"
                result = self.logic["run_rules_v3_cycle"](runtime, observation, 0)
                self.assertIn("tab5-main", result["unavailableDeviceIds"])
                for field in ("ADCRaw", "ADCValid", "ClockSynchronized",
                              "PressurePSI"):
                    self.assertNotIn(field, result["snapshot"])
                self.assertEqual(result["snapshot"]["TankFlowQuality"],
                                 "PRESSURE_INVALID")
            recovered = self.logic["run_rules_v3_cycle"](
                runtime, self.observation(), 1000)
            self.assertIn("tab5-main", recovered["acceptedDeviceIds"])
            self.assertIn("PressurePSI", recovered["snapshot"])

    def test_cycle_accepts_complete_devices_calculates_then_freezes_one_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            result = self.logic["run_rules_v3_cycle"](runtime, self.observation(), 0)
            self.assertEqual(set(result["acceptedDeviceIds"]),
                             {"shelly-em-main", "shelly-1-main", "tab5-main"})
            self.assertEqual(result["unavailableDeviceIds"], [])
            self.assertAlmostEqual(result["snapshot"]["LoadRatioPercent"],
                                   2800 / 2900 * 100)
            self.assertAlmostEqual(result["snapshot"]["PressurePSI"],
                                   (14307 - 3732.02) / 211.492)
            self.assertEqual(result["snapshot"]["TankFlowQuality"],
                             "INSUFFICIENT_HISTORY")
            self.assertEqual(result["records"], [])

    def test_invalid_device_record_cannot_partially_supply_calculations_or_events(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            observation = self.observation(voltage=270.0)
            observation["values"]["pf"] = "bad"
            result = self.logic["run_rules_v3_cycle"](runtime, observation, 0)
            self.assertIn("shelly-em-main", result["unavailableDeviceIds"])
            self.assertIs(result["snapshot"]["ShellyEMAvailable"], False)
            for field in ("PumpWatts", "SupplyVoltage", "PowerFactor",
                          "ShellyEnergyWh", "LoadRatioPercent"):
                self.assertNotIn(field, result["snapshot"])
            # H001 opens on exactly this condition, and engaging System Monitor
            # releases rather than applies the inhibition.
            self.assertEqual([(item["eventId"], item["type"]) for item in result["records"]],
                             [("H001", "open")])
            self.assertEqual(result["snapshot"]["OperatingMode"], "Monitor")
            self.assertNotIn(True, [item.get("value") for item in result["actions"]
                                    if item["target"] == "Tab5IsLocked"])

    def test_offline_event_qualifies_and_recovers_without_device_values(self):
        package = json.loads(self.raw_a)
        event = copy.deepcopy(package['events'][0])
        event.update(id='S020', systemName='ShellyOffline', displayName='Shelly Offline')
        event['onOpen'] = {'assignments': [], 'guardedGroups': []}
        event['onClose'] = {'assignments': [], 'guardedGroups': []}
        def condition(value):
            return {'mode': 'all', 'observationCount': 2, 'minimumSeconds': 0,
                    'clauses': [{'field': 'Shelly1Available', 'operator': 'eq', 'value': value}]}
        event['opening'] = {'trigger': {'type': 'condition', 'condition': condition(False)}}
        event['closing'] = {'policy': 'condition', 'condition': condition(True)}
        package['events'] = [event]
        with tempfile.TemporaryDirectory() as directory:
            runtime, _ = self.start(directory, json.dumps(package))
            bad = self.observation()
            bad['status']['shelly1_available'] = False
            # Even retained, apparently valid zero/relay values cannot supply the device.
            for index in range(2):
                result = self.logic['run_rules_v3_cycle'](runtime, bad, index * 1000)
                self.assertIs(result['snapshot']['Shelly1Available'], False)
                for field in ('IsLocked', 'PumpEnable', 'ContactorFlag',
                              'Tab5IsLocked'):
                    self.assertNotIn(field, result['snapshot'])
                self.assertEqual(result['actions'], [])
                self.assertEqual([r['type'] for r in result['records']], [] if index == 0 else ['open'])
            for index in range(2):
                result = self.logic['run_rules_v3_cycle'](runtime, self.observation(), 2000 + index * 1000)
                self.assertIs(result['snapshot']['Shelly1Available'], True)
                self.assertEqual(result['actions'], [])
                self.assertEqual([r['type'] for r in result['records']], [] if index == 0 else ['close'])

    def test_malformed_shelly_evidence_sets_availability_false_without_safe_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _ = self.start(directory)
            for value in (None, '0', False):
                bad = self.observation()
                bad['values']['shelly1_lock'] = value
                result = self.logic['run_rules_v3_cycle'](runtime, bad, 0)
                self.assertIs(result['snapshot']['Shelly1Available'], False)
                self.assertNotIn('IsLocked', result['snapshot'])
                self.assertNotIn('PumpEnable', result['snapshot'])
                self.assertNotIn(True, [a.get('value') for a in result['actions']])

    def test_boyle_history_uses_cycle_snapshots_and_propagates_unavailable_pressure(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            result = None
            for index in range(11):
                observation = self.observation()
                observation["values"]["adc_raw"] = 12000 + index * 10
                result = self.logic["run_rules_v3_cycle"](
                    runtime, observation, index * 1000)
            self.assertEqual(result["snapshot"]["TankFlowQuality"], "VALID")
            self.assertGreater(result["snapshot"]["PressureSlopePSIPerMinute"], 0)
            broken = self.observation()
            broken["values"]["adc_raw"] = None
            result = self.logic["run_rules_v3_cycle"](runtime, broken, 11000)
            self.assertIn("tab5-main", result["unavailableDeviceIds"])
            self.assertNotIn("PressurePSI", result["snapshot"])
            self.assertEqual(result["snapshot"]["TankFlowQuality"], "PRESSURE_INVALID")

    def test_boolean_set_accepts_only_http_200_with_a_json_null_body(self):
        """The supported HTTP GET form answers a bare null and nothing else."""
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            resolved = runtime["resolved"]
            action = {"target": resolved["inhibitionTarget"], "value": True}
            observation = self.observation(flag=False)

            def reply(body, status=200):
                return types.SimpleNamespace(
                    status_code=status, json=lambda: body, close=lambda: None)

            calls = []
            def transport(result):
                def get(url, timeout):
                    calls.append(url)
                    if isinstance(result, Exception):
                        raise result
                    return result
                self.logic["requests"] = types.SimpleNamespace(get=get)

            transport(reply(None))
            self.assertEqual(self.logic["issue_rules_v3_action"](
                resolved, action, observation), "acknowledged")
            self.assertEqual(len(calls), 1, "no readback RPC")
            ids = self.routing_ids()
            self.assertIn("Boolean.Set", calls[0])
            self.assertIn("id={}".format(ids["Tab5IsLocked"]), calls[0])
            self.assertIn("value=true", calls[0])

            # Nothing else counts as success.
            for body, expected in (({}, "invalid-response"),
                                   ({"result": {}}, "invalid-response"),
                                   ([], "invalid-response"),
                                   ("null", "invalid-response"),
                                   ({"error": {"code": -105}}, "rpc-error"),
                                   ({"code": -105, "message": "bad"}, "rpc-error")):
                transport(reply(body))
                self.assertEqual(self.logic["issue_rules_v3_action"](
                    resolved, action, observation), expected, repr(body))

            for status in (204, 400, 404, 500):
                transport(reply(None, status=status))
                self.assertEqual(self.logic["issue_rules_v3_action"](
                    resolved, action, observation), "rpc-http-error")

            transport(TimeoutError("transport"))
            self.assertEqual(self.logic["issue_rules_v3_action"](
                resolved, action, observation), "request-failed:transport")

    def test_flag_write_needs_fresh_evidence_and_never_repeats_a_match(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            resolved = runtime["resolved"]
            target = resolved["inhibitionTarget"]
            action = {"target": target, "value": True}
            self.logic["requests"] = types.SimpleNamespace(
                get=lambda *_a, **_k: self.fail("wrote without fresh evidence"))

            already = self.observation(flag=True)
            self.assertEqual(self.logic["issue_rules_v3_action"](
                resolved, action, already), "observed-desired-state")

            unavailable = self.observation(flag=False)
            unavailable["status"]["shelly1_available"] = False
            self.assertEqual(self.logic["issue_rules_v3_action"](
                resolved, action, unavailable), "shelly-unavailable")

            no_flag = self.observation(flag=False)
            no_flag["values"].pop("shelly1_tab5lock")
            self.assertEqual(self.logic["issue_rules_v3_action"](
                resolved, action, no_flag), "flag-evidence-unavailable")

            no_route = self.observation(flag=False)
            no_route["status"].pop("shelly1_tab5lock_id")
            self.assertEqual(self.logic["issue_rules_v3_action"](
                resolved, action, no_route), "flag-routing-unavailable")

    def test_no_accepted_package_can_dispatch_a_relay_write(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            resolved = runtime["resolved"]
            self.assertIsNone(resolved["pumpTarget"])
            self.assertEqual(resolved["inhibitionTarget"], "Tab5IsLocked")
            self.assertEqual(sorted(resolved["writableTargets"]),
                             ["OperatingMode", "Tab5IsLocked"])
            self.logic["requests"] = types.SimpleNamespace(
                get=lambda *_a, **_k: self.fail("a relay write was dispatched"))
            observation = self.observation()
            for action in ({"target": "PumpEnable", "value": True},
                           {"target": "PumpEnable", "value": False}):
                self.assertEqual(self.logic["issue_rules_v3_action"](
                    resolved, action, observation), "no-write-definition")

    def test_steady_state_writes_nothing_and_a_mismatch_writes_once_per_cycle(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            resolved = runtime["resolved"]
            calls = []
            self.logic["requests"] = types.SimpleNamespace(
                get=lambda url, timeout: calls.append(url) or types.SimpleNamespace(
                    status_code=200, json=lambda: None, close=lambda: None))

            # Nothing owns the flag and the device already reads clear.
            for tick in (0, 1000):
                cycle = self.logic["run_rules_v3_cycle"](
                    runtime, self.observation(flag=False), tick)
                dispatched, _ = self.logic["dispatch_rules_v3_actions"](
                    resolved, cycle["actions"], self.observation(flag=False))
                self.assertEqual(dispatched, [])
            self.assertEqual(calls, [], "correct steady state costs no write")

            # E007 qualifies and the device still reads clear: exactly one write.
            for tick in (2000, 3000):
                observation = self.observation(voltage=270.0, flag=False)
                cycle = self.logic["run_rules_v3_cycle"](runtime, observation, tick)
                dispatched, dropped = self.logic["dispatch_rules_v3_actions"](
                    resolved, cycle["actions"], observation)
                self.assertEqual(dropped, [])
                flag_calls = [item for item in dispatched
                              if item["action"]["target"] == "Tab5IsLocked"]
                self.assertLessEqual(len(flag_calls), 1)
            self.assertEqual(len(calls), 1, "one write per cycle at most")
            self.assertIn("value=true", calls[0])

            # Once the device reflects it, the same ownership writes nothing more.
            for tick in (4000, 5000):
                observation = self.observation(voltage=270.0, flag=True)
                cycle = self.logic["run_rules_v3_cycle"](runtime, observation, tick)
                self.assertEqual(
                    [item for item in cycle["actions"]
                     if item["target"] == "Tab5IsLocked"], [],
                    "no action once the device already agrees")
            self.assertEqual(len(calls), 1, "retry only from a later mismatch")

    def test_stage_b_does_not_replace_running_a_and_restart_adopts_fresh_b(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime_a, path = self.start(directory)
            runtime_a["kernel"]["owners"] = {"PumpEnable": {
                "value": False, "instances": {"old": "E007"}}}
            unsupported = json.loads(self.raw_a)
            unsupported.update({"releaseId": "20260911120000-event-v3-v2",
                                "packageVersion": 2})
            unsupported["devices"][0]["driver"] = "unsupported-driver"
            raw_unsupported = json.dumps(unsupported, separators=(",", ":"))
            rejected, reason = self.logic["stage_rules_v3_release"](
                {"metadata": self.pointer(raw_unsupported, unsupported["releaseId"], 2),
                 "release": raw_unsupported}, runtime_a["reference"],
                str(path), str(path.parent / ".rules-runtime-v3-staged.download"))
            self.assertIsNone(rejected)
            self.assertEqual(reason, "release-runtime-unsupported")
            self.assertEqual(path.read_text(encoding="utf-8"), self.raw_a)
            still_a, reason = self.logic["start_rules_v3_runtime"](str(path))
            self.assertIsNone(reason)
            self.assertEqual(still_a["reference"]["packageVersion"], 1)

            package_b = json.loads(self.raw_a)
            package_b.update({"releaseId": "20260911120100-event-v3-v2", "packageVersion": 2})
            raw_b = json.dumps(package_b, separators=(",", ":"))
            pointer_b = self.pointer(raw_b, package_b["releaseId"], 2)
            staged, outcome = self.logic["stage_rules_v3_release"](
                {"metadata": pointer_b, "release": raw_b}, runtime_a["reference"],
                str(path), str(path.parent / ".rules-runtime-v3-staged.download"))
            self.assertEqual(outcome, "staged")
            self.assertEqual(runtime_a["reference"]["packageVersion"], 1)
            self.assertIn("PumpEnable", runtime_a["kernel"]["owners"])
            rejected, _reason = self.logic["stage_rules_v3_release"](
                {"metadata": pointer_b, "release": raw_b + " "}, staged["reference"],
                str(path), str(path.parent / ".rules-runtime-v3-staged.download"))
            self.assertIsNone(rejected)
            self.assertEqual(path.read_text(encoding="utf-8"), raw_b)
            runtime_b, reason = self.logic["start_rules_v3_runtime"](str(path))
            self.assertIsNone(reason)
            self.assertEqual(runtime_b["reference"]["packageVersion"], 2)
            self.assertEqual(runtime_b["kernel"]["owners"], {})
            self.assertFalse(any(item["active"] for item in runtime_b["kernel"]["events"].values()))

    def test_a_failed_flag_write_is_retried_only_from_a_later_cycle(self):
        """No same-cycle retry and no readback: a later cycle reconciles."""
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            resolved = runtime["resolved"]
            outcomes = [
                types.SimpleNamespace(status_code=200, json=lambda: {"error": {"code": -1}},
                                      close=lambda: None),
                TimeoutError("transport"),
                types.SimpleNamespace(status_code=200, json=lambda: None,
                                      close=lambda: None),
            ]
            calls = []
            def get(url, timeout):
                calls.append(url)
                reply = outcomes.pop(0)
                if isinstance(reply, Exception):
                    raise reply
                return reply
            self.logic["requests"] = types.SimpleNamespace(get=get)

            # E007 qualifies on the second cycle and keeps its owner throughout.
            expected = ["rpc-error", "request-failed:transport", "acknowledged"]
            seen = []
            for index, tick in enumerate((0, 1000, 2000, 3000)):
                observation = self.observation(voltage=270.0, flag=False)
                cycle = self.logic["run_rules_v3_cycle"](runtime, observation, tick)
                dispatched, _ = self.logic["dispatch_rules_v3_actions"](
                    resolved, cycle["actions"], observation)
                seen.extend(item["outcome"] for item in dispatched
                            if item["action"]["target"] == "Tab5IsLocked")
                self.assertLessEqual(len(calls), index + 1,
                                     "at most one attempt per cycle")
            self.assertEqual(seen, expected)
            self.assertIn("Tab5IsLocked", runtime["kernel"]["owners"])

            # The device now agrees, so ownership alone produces no further write.
            settled = self.observation(voltage=270.0, flag=True)
            cycle = self.logic["run_rules_v3_cycle"](runtime, settled, 4000)
            self.assertEqual([item for item in cycle["actions"]
                              if item["target"] == "Tab5IsLocked"], [])
            self.assertEqual(len(calls), 3)

    def test_pressure_requires_current_validity_and_resets_history(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            result = None
            for index in range(11):
                observation = self.observation()
                observation["values"]["adc_raw"] = 12000 + index * 10
                result = self.logic["run_rules_v3_cycle"](
                    runtime, observation, index * 1000)
            self.assertEqual(result["snapshot"]["TankFlowQuality"], "VALID")

            for status_name in ("pressure_sensor_commissioned", "adc_available"):
                invalid = self.observation()
                invalid["status"][status_name] = False
                result = self.logic["run_rules_v3_cycle"](runtime, invalid, 11000)
                self.assertIn("PressureADCCounts", result["snapshot"])
                self.assertNotIn("PressurePSI", result["snapshot"])
                self.assertEqual(result["snapshot"]["TankFlowQuality"],
                                 "PRESSURE_INVALID")

            recovered = self.logic["run_rules_v3_cycle"](
                runtime, self.observation(), 12000)
            self.assertIn("PressurePSI", recovered["snapshot"])
            self.assertEqual(recovered["snapshot"]["TankFlowQuality"],
                             "INSUFFICIENT_HISTORY")

    def test_nonfinite_inputs_packages_and_results_are_unavailable(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            self.assertIsNone(self.logic["read_shelly"](
                lambda _url, bad=value: self.em(power=bad)))

        with tempfile.TemporaryDirectory() as directory:
            runtime, path = self.start(directory)
            observation = self.observation()
            observation["values"]["power"] = float("nan")
            result = self.logic["run_rules_v3_cycle"](runtime, observation, 0)
            self.assertIn("shelly-em-main", result["unavailableDeviceIds"])
            self.assertIs(result["snapshot"]["ShellyEMAvailable"], False)
            for value in (float("nan"), float("inf"), -float("inf")):
                observation = self.observation()
                observation["values"]["adc_raw"] = value
                result = self.logic["run_rules_v3_cycle"](runtime, observation, 0)
                self.assertIn("tab5-main", result["unavailableDeviceIds"])
                self.assertNotIn("PressurePSI", result["snapshot"])

            invalid_package = json.loads(self.raw_a)
            invalid_package.update({"releaseId": "20260911120200-event-v3-v2",
                                    "packageVersion": 2})
            invalid_package["calculations"][0]["program"][1][1] = float("nan")
            raw_invalid = json.dumps(invalid_package, separators=(",", ":"))
            staged, reason = self.logic["stage_rules_v3_release"](
                {"metadata": self.pointer(raw_invalid, invalid_package["releaseId"], 2),
                 "release": raw_invalid}, runtime["reference"], str(path),
                str(path.parent / ".rules-runtime-v3-staged.download"))
            self.assertIsNone(staged)
            self.assertEqual(reason, "release-runtime-unsupported")
            self.assertEqual(path.read_text(encoding="utf-8"), self.raw_a)

            overflow_package = json.loads(self.raw_a)
            overflow_package.update({"releaseId": "20260911120300-event-v3-v2",
                                     "packageVersion": 2})
            overflow_package["calculations"][0]["program"] = [
                ["field", "PumpWatts"], ["number", 1e308], ["operator", "*"]]
            raw_overflow = json.dumps(overflow_package, separators=(",", ":"))
            runtime_overflow, overflow_path = self.start(directory, raw_overflow)
            observation = self.observation()
            observation["values"]["power"] = 1e308
            result = self.logic["run_rules_v3_cycle"](runtime_overflow, observation, 0)
            self.assertNotIn("LoadRatioPercent", result["snapshot"])

    def test_normal_loop_has_no_v2_evaluation_or_v2_relay_dispatch(self):
        source = PILOT_PATH.read_text(encoding="utf-8")
        loop = source[source.index("while True:", source.index("# --- boot sequence ---")):]
        for forbidden in ("evaluate_runtime_events(", "advance_runtime_event(",
                          "issue_runtime_stop(", "adopt_runtime_release("):
            self.assertNotIn(forbidden, loop)
        self.assertIn("run_rules_v3_cycle(", loop)
        self.assertIn("dispatch_rules_v3_actions(", loop)

    def test_durable_observation_uses_running_v3_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime, _path = self.start(directory)
            record = self.logic["build_durable_observation"](
                self.observation(), "boot_12345678", "material-change",
                runtime["reference"])
            self.assertEqual(record["rulesRelease"]["version"], 1)
            self.assertEqual(record["rulesRelease"]["contentHash"],
                             runtime["reference"]["contentHash"])


if __name__ == "__main__":
    unittest.main()
