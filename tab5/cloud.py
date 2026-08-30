# Release: 2026-08-30 Unit 4B — bounded V3 event records use CPU B's durable transport only.
"""CPU B communications worker for the interpreted Tab5 pilot.

This module is the sole owner of Wi-Fi activation, association, recovery,
SNTP, and remote Netlify traffic. CPU A may use the established LAN for
Shelly observations, but it never changes the station interface.

One variable-sized observation crosses the CPU boundary by ownership transfer
through a single coalescing slot. CPU A never mutates it after submission and
CPU B preserves every field. If TLS is slow, a newer observation replaces an
older unsent observation instead of blocking the one-second device loop.
"""

import _thread
import os
import sys
import time
import ubinascii
import network
import ntptime
import requests

from device_secrets import INGEST_TOKEN


WIFI_QUIET_PERIOD_MS = 2000
WIFI_RECOVERY_TRIGGER_MS = 5000
WIFI_RECOVERY_REPEAT_MS = 15000
WIFI_RESTART_PAUSE_MS = 250
NTP_RETRY_MS = 30000
NTP_HOSTS = ('pool.ntp.org', 'time.google.com', 'time.cloudflare.com')
PUBLISH_RETRY_MS = 60000
HEARTBEAT_PERIOD_MS = 60000
MONITOR_PUBLISH_PERIOD_MS = 1000
POWER_CHANGE_W = 50.0
VOLTAGE_CHANGE_V = 2.0
DEVICE_ID = 'shelly-em-well'
INGEST_URL = 'https://pilot--well-pump-control.netlify.app/.netlify/functions/ingest-power'
PUBLISH_TIMEOUT_S = 3
DURABLE_INGEST_URL = 'https://pilot--well-pump-control.netlify.app/.netlify/functions/ingest-record'
DURABLE_INGEST_TIMEOUT_S = 3
# Reviewed RAM bound: 192 sparse event/audit records covers four days at two
# transitions per hour while still leaving a fixed, nonpersistent ceiling.
DURABLE_QUEUE_DEPTH = 192
DURABLE_RETRY_BASE_MS = 5000
DURABLE_RETRY_MAX_MS = 60000
RULES_RELEASE_ORIGIN = 'https://pilot--well-pump-control.netlify.app'
MAX_RULES_RELEASE_BYTES = 65536

SITE_ID = 'well-main'
RTDB_DEVICE_ID = 'tab5-well-main'
DEVICE_SYNC_URL = 'https://pilot--well-pump-control.netlify.app/.netlify/functions/device-sync'
DEVICE_SYNC_TIMEOUT_S = 3
RTDB_TIMEOUT_S = 1
RTDB_COORDINATION_PERIOD_MS = 10000
RTDB_PRESENCE_PERIOD_MS = 30000
RTDB_RETRY_BASE_MS = 5000
RTDB_RETRY_MAX_MS = 60000
RTDB_MIN_OPERATION_GAP_MS = 100
TOKEN_REFRESH_MARGIN_MS = 300000
COMMAND_QUEUE_DEPTH = 8
APPROVED_FIREBASE_PROJECT_ID = 'well-pump-control'
APPROVED_RTDB_URLS = (
    'https://well-pump-control-default-rtdb.firebaseio.com',
    'https://well-pump-control-default-rtdb.firebasedatabase.app',
)
APPROVED_IDENTITY_TOOLKIT_URL = (
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken')
APPROVED_SECURE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token'

# M3 must send the required device-sync v1 appliedRules field before M6 creates
# or adopts a real rules package. This unmistakable bridge is transport metadata
# only: CPU B never loads, validates, adopts, or evaluates it. M6 replaces it
# with CPU A's actual validated rules reference without changing the M2 schema.
PRE_M6_TRANSPORT_ONLY_RULES_REFERENCE = {
    'version': 1,
    'contentHash': '0' * 64,
}


class TransportError(Exception):
    # UIFlow's MicroPython Exception type does not expose Exception.__init__.
    # Keep the class constructor-free and attach an HTTP status only where one
    # exists, so ordinary Exception(message) construction remains portable.
    status_code = None


def _retry_delay_ms(failure_count):
    """Bound exponential retry delay for RTDB/bootstrap failures."""
    shift = failure_count - 1
    if shift < 0:
        shift = 0
    if shift > 4:
        shift = 4
    delay = RTDB_RETRY_BASE_MS * (1 << shift)
    return min(delay, RTDB_RETRY_MAX_MS)


def _durable_retry_delay_ms(failure_count):
    shift = failure_count - 1
    if shift < 0:
        shift = 0
    if shift > 4:
        shift = 4
    return min(DURABLE_RETRY_BASE_MS * (1 << shift), DURABLE_RETRY_MAX_MS)


def _rtdb_url(base_url, path, id_token):
    return '{}/{}.json?auth={}'.format(base_url.rstrip('/'), path.strip('/'), id_token)


def _copy_current_observation(observation, session_id):
    """Add RTDB transport identity while preserving the complete CPU A message."""
    if not isinstance(observation, dict) or observation.get('schemaVersion') != 1:
        raise TransportError('unsupported observation schemaVersion')
    current = dict(observation)
    current['siteId'] = SITE_ID
    current['deviceId'] = RTDB_DEVICE_ID
    current['sessionId'] = session_id
    current['receivedAtMs'] = {'.sv': 'timestamp'}
    return current


def _new_session_id():
    try:
        random_bytes = os.urandom(6)
    except Exception:
        ticks = time.ticks_ms()
        random_bytes = bytes([(ticks >> shift) & 0xff for shift in (0, 8, 16, 24)])
    return 'boot_' + ubinascii.hexlify(random_bytes).decode()


def _compact_timestamp_utc():
    t = time.localtime()
    return '{:04d}{:02d}{:02d}{:02d}{:02d}{:02d}'.format(
        t[0], t[1], t[2], t[3], t[4], t[5])


def _http_json(method, url, body=None, headers=None, timeout=RTDB_TIMEOUT_S,
               form_body=None):
    response = None
    try:
        if method == 'GET':
            response = requests.get(url, headers=headers, timeout=timeout)
        elif form_body is not None:
            response = requests.post(url, data=form_body, headers=headers, timeout=timeout)
        elif method == 'POST':
            response = requests.post(url, json=body, headers=headers, timeout=timeout)
        elif method == 'PUT':
            response = requests.put(url, json=body, headers=headers, timeout=timeout)
        else:
            raise TransportError('unsupported HTTP method')
        if response.status_code < 200 or response.status_code >= 300:
            error = TransportError('HTTP {}'.format(response.status_code))
            error.status_code = response.status_code
            raise error
        return response.json()
    except TransportError:
        raise
    except Exception as e:
        raise TransportError(str(e))
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def _valid_runtime_release_id(value):
    prefix = '-parameters-v'
    if not isinstance(value, str) or len(value) <= 14 + len(prefix):
        return False
    return (value[:14].isdigit() and value[14:14 + len(prefix)] == prefix and
            value[14 + len(prefix):].isdigit() and
            int(value[14 + len(prefix):]) >= 1)


def _download_rules_release(metadata):
    """Fetch an opaque release body from the approved Netlify origin only."""
    path = metadata.get('downloadPath') if isinstance(metadata, dict) else None
    prefix = '/.netlify/functions/rules-engine-release?releaseId='
    if not isinstance(path, str) or not path.startswith(prefix):
        raise TransportError('rules release path is not approved')
    release_id = path[len(prefix):]
    if not _valid_runtime_release_id(release_id):
        raise TransportError('rules release name is not approved')
    # CPU B accepts only the known relative endpoint.  It neither parses nor
    # validates the runtime package; that belongs exclusively to CPU A.
    request_url = RULES_RELEASE_ORIGIN + path
    response = None
    try:
        response = requests.get(request_url, headers={
            'X-Pilot-Key': INGEST_TOKEN,
        }, timeout=DEVICE_SYNC_TIMEOUT_S)
        if response.status_code < 200 or response.status_code >= 300:
            error = TransportError('HTTP {}'.format(response.status_code))
            error.status_code = response.status_code
            raise error
        raw_release = response.text
        if (not isinstance(raw_release, str) or
                len(raw_release.encode('utf-8')) > MAX_RULES_RELEASE_BYTES):
            raise TransportError('rules release size is not supported')
        return raw_release
    except TransportError:
        raise
    except Exception as e:
        raise TransportError(str(e))
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def _form_value(value):
    # Firebase refresh tokens use URL-safe characters. Escape the remaining
    # form delimiters without importing CPython-only urllib.
    return str(value).replace('%', '%25').replace('+', '%2B').replace('&', '%26').replace('=', '%3D')


def _valid_command_id(value):
    if not isinstance(value, str) or len(value) < 42 or len(value) > 98:
        return False
    if value[14:23] != '-command-' or value[-11] != '-':
        return False
    session = value[23:-11]
    if (not value[:14].isdigit() or not value[-10:].isdigit() or
            len(session) < 8 or len(session) > 64):
        return False
    for char in session:
        if not (('0' <= char <= '9') or ('A' <= char <= 'Z') or
                ('a' <= char <= 'z') or char in '_-'):
            return False
    return True


def _valid_command_time(value):
    return (isinstance(value, str) and 20 <= len(value) <= 35 and
            value[4] == '-' and value[7] == '-' and value[10] in 'Tt' and
            (value[-1] in 'Zz' or '+' in value[11:] or '-' in value[11:]))


def _filter_new_commands(raw_commands, last_sequence):
    if isinstance(raw_commands, dict):
        candidates = raw_commands.values()
    elif isinstance(raw_commands, list):
        candidates = raw_commands
    else:
        return []
    accepted = []
    allowed_fields = (
        'schemaVersion', 'commandId', 'commandSequence', 'siteId',
        'targetDeviceId', 'commandType', 'requestedAt', 'requestedBy',
        'status', 'payload', 'completedAt', 'resultRecordId',
        'rejectionReason')
    command_types = (
        'close-event', 'set-event-override', 'set-global-enable',
        'reset-shelly-lockout')
    for command in candidates:
        if not isinstance(command, dict):
            continue
        if any(field not in allowed_fields for field in command):
            continue
        if command.get('schemaVersion') != 1:
            continue
        if command.get('siteId') != SITE_ID or command.get('targetDeviceId') != RTDB_DEVICE_ID:
            continue
        if command.get('status') != 'pending':
            continue
        if command.get('commandType') not in command_types:
            continue
        if not _valid_command_time(command.get('requestedAt')):
            continue
        actor = command.get('requestedBy')
        if not isinstance(actor, dict) or actor.get('type') not in ('user', 'device', 'system'):
            continue
        if len(actor) != 2 or 'type' not in actor or 'id' not in actor:
            continue
        if (not isinstance(actor.get('id'), str) or
                len(actor.get('id')) < 1 or len(actor.get('id')) > 128):
            continue
        if not isinstance(command.get('payload'), dict):
            continue
        sequence = command.get('commandSequence')
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence <= last_sequence:
            continue
        if not _valid_command_id(command.get('commandId')):
            continue
        accepted.append(command)
    accepted.sort(key=lambda item: item.get('commandSequence'))
    return accepted


def log(msg):
    print('[well-cloud] {}'.format(msg))


def _format_timestamp_utc():
    t = time.localtime()  # ntptime sets the RTC directly to UTC
    return '{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z'.format(
        t[0], t[1], t[2], t[3], t[4], t[5])


def _publish_observation(observation, reason):
    """Publish one record and return (success, reported_monitoring_state)."""
    values = observation.get('values', {})
    body = {
        'schemaVersion': 1,
        'deviceId': DEVICE_ID,
        'observedAt': observation.get('observedAt') or _format_timestamp_utc(),
        'publishReason': reason,
        'power': values.get('power', 0.0),
        'reactive': values.get('reactive', 0.0),
        'pf': values.get('pf', 0.0),
        'voltage': values.get('voltage', 0.0),
        'is_valid': bool(values.get('is_valid', False)),
        'total': values.get('total', 0.0),
        'total_returned': values.get('total_returned', 0.0),
        # The current Netlify validator ignores this additive field. Including
        # it now proves the complete CPU A record can cross CPU B and HTTPS
        # unchanged; Netlify can persist it later without another CPU A rewrite.
        'observation': observation,
    }
    try:
        response = requests.post(INGEST_URL, json=body, headers={
            'Content-Type': 'application/json',
            'X-Pilot-Key': INGEST_TOKEN,
        }, timeout=PUBLISH_TIMEOUT_S)
        ok = 200 <= response.status_code < 300
        if not ok:
            try:
                detail = response.text[:140]
            except Exception:
                detail = ''
            log('Netlify HTTP {} {}'.format(response.status_code, detail))
        monitoring_active = None
        if ok:
            try:
                reply = response.json()
                monitoring = reply.get('monitoring', {})
                if isinstance(monitoring.get('active'), bool):
                    monitoring_active = monitoring.get('active')
            except Exception:
                # Telemetry was accepted. A missing optional monitoring result
                # must not turn the successful write into a retry.
                pass
        response.close()
        return ok, monitoring_active
    except Exception as e:
        log('Netlify publish error: {}'.format(e))
        return False, None


_state_lock = _thread.allocate_lock()
_state = (False, False, False, None, 'unavailable', 0)
# state fields: connected, traffic_ready, clock_synced, driver_status, IP, disconnect_count

_observation_lock = _thread.allocate_lock()
_pending_observation = None

_durable_lock = _thread.allocate_lock()
_pending_durable_records = []

_transport_status_lock = _thread.allocate_lock()
_transport_status = {
    'telemetryLastAttemptTicksMs': None,
    'telemetryLastSuccessTicksMs': None,
    'telemetryLastAttemptOk': None,
    'rtdbLastAttemptTicksMs': None,
    'rtdbLastSuccessTicksMs': None,
    'rtdbLastAttemptOk': None,
    'durableLastAttemptTicksMs': None,
    'durableLastSuccessTicksMs': None,
    'durableLastAttemptOk': None,
}

_command_lock = _thread.allocate_lock()
_pending_commands = []
_last_delivered_command_sequence = 0
_last_applied_command_sequence = 0

_sync_lock = _thread.allocate_lock()
_sync_state = None

_rules_lock = _thread.allocate_lock()
_pending_rules_request = None
_pending_rules_release = None

_rules_pointer_lock = _thread.allocate_lock()
_pending_rules_pointer = None

_applied_rules_lock = _thread.allocate_lock()
_applied_rules_reference = dict(PRE_M6_TRANSPORT_ONLY_RULES_REFERENCE)

_session_id = _new_session_id()
_sync_sequence = 0

_start_lock = _thread.allocate_lock()
_started = False


def _set_state(connected, traffic_ready, clock_synced, driver_status, ip_address,
               disconnect_count):
    global _state
    _state_lock.acquire()
    try:
        _state = (connected, traffic_ready, clock_synced, driver_status,
                  ip_address, disconnect_count)
    finally:
        _state_lock.release()


def status_snapshot():
    """Return one immutable CPU B status snapshot for CPU A."""
    _state_lock.acquire()
    try:
        return _state
    finally:
        _state_lock.release()


def _record_transport_result(channel, succeeded, completed_ticks_ms):
    """Record transport evidence without exposing CPU B working state."""
    prefix = {
        'telemetry': 'telemetry',
        'rtdb': 'rtdb',
        'durable': 'durable',
    }.get(channel)
    if prefix is None or not isinstance(succeeded, bool):
        return False
    attempt_key = '{}LastAttemptTicksMs'.format(prefix)
    success_key = '{}LastSuccessTicksMs'.format(prefix)
    result_key = '{}LastAttemptOk'.format(prefix)
    _transport_status_lock.acquire()
    try:
        _transport_status[attempt_key] = completed_ticks_ms
        _transport_status[result_key] = succeeded
        if succeeded:
            _transport_status[success_key] = completed_ticks_ms
        return True
    finally:
        _transport_status_lock.release()


def transport_status_snapshot():
    """Return immutable response ages and bounded queue occupancy to CPU A."""
    _transport_status_lock.acquire()
    try:
        snapshot = dict(_transport_status)
    finally:
        _transport_status_lock.release()

    _observation_lock.acquire()
    try:
        snapshot['observationPending'] = _pending_observation is not None
    finally:
        _observation_lock.release()

    _durable_lock.acquire()
    try:
        snapshot['durableQueueDepth'] = len(_pending_durable_records)
        snapshot['durableQueueCapacity'] = DURABLE_QUEUE_DEPTH
    finally:
        _durable_lock.release()
    return snapshot


def device_session_id():
    """Return CPU B's immutable boot-session identity for CPU A record IDs."""
    return _session_id


def submit_observation(observation):
    """Transfer ownership into the one-slot variable-sized observation queue."""
    global _pending_observation
    _observation_lock.acquire()
    try:
        _pending_observation = observation
    finally:
        _observation_lock.release()


def _take_pending_observation():
    global _pending_observation
    _observation_lock.acquire()
    try:
        observation = _pending_observation
        _pending_observation = None
        return observation
    finally:
        _observation_lock.release()


def submit_durable_record(record):
    """Queue one complete CPU A-authored record without blocking CPU A."""
    if (not isinstance(record, dict) or record.get('schemaVersion') != 1 or
            record.get('recordType') not in (
                'observation', 'event-open', 'event-close',
                'rule-adoption', 'rule-rejection')):
        return False
    _durable_lock.acquire()
    try:
        high_priority = record.get('recordType') in (
            'event-open', 'event-close', 'rule-adoption', 'rule-rejection')
        if len(_pending_durable_records) >= DURABLE_QUEUE_DEPTH:
            # V3 transitions and rules audits outrank disposable observation
            # history. Evict only the oldest observation before losing one.
            if high_priority:
                for index, pending in enumerate(_pending_durable_records):
                    if pending.get('recordType') == 'observation':
                        _pending_durable_records.pop(index)
                        break
                else:
                    return False
            else:
                return False
        # Retention priority must not reorder the deployed durable FIFO. A
        # high-priority event/audit may evict an observation when full, then
        # joins the tail like every other accepted durable record.
        _pending_durable_records.append(record)
        return True
    finally:
        _durable_lock.release()


def _peek_durable_record():
    _durable_lock.acquire()
    try:
        return _pending_durable_records[0] if _pending_durable_records else None
    finally:
        _durable_lock.release()


def _discard_durable_record(record):
    _durable_lock.acquire()
    try:
        if _pending_durable_records and _pending_durable_records[0] is record:
            _pending_durable_records.pop(0)
            return True
        return False
    finally:
        _durable_lock.release()


def _publish_durable_record(record):
    """Transport the exact CPU A record; the cloud performs no reselection."""
    reply = _http_json('POST', DURABLE_INGEST_URL, body=record, headers={
        'Content-Type': 'application/json',
        'X-Pilot-Key': INGEST_TOKEN,
    }, timeout=DURABLE_INGEST_TIMEOUT_S)
    if (not isinstance(reply, dict) or reply.get('accepted') is not True or
            reply.get('recordId') != record.get('recordId')):
        raise TransportError('durable ingest response mismatch')
    return bool(reply.get('duplicate'))


def take_command():
    """Transfer the next complete command to CPU A, at most once per session."""
    _command_lock.acquire()
    try:
        if not _pending_commands:
            return None
        return _pending_commands.pop(0)
    finally:
        _command_lock.release()


def mark_command_applied(command_id, command_sequence):
    """Record CPU A's applied high-water mark without applying any command."""
    global _last_applied_command_sequence
    if not isinstance(command_id, str) or not isinstance(command_sequence, int):
        return False
    _command_lock.acquire()
    try:
        if command_sequence > _last_applied_command_sequence:
            _last_applied_command_sequence = command_sequence
        return True
    finally:
        _command_lock.release()


def take_sync_message():
    """Transfer the latest noncredential coordination message to CPU A."""
    global _sync_state
    _sync_lock.acquire()
    try:
        value = _sync_state
        _sync_state = None
        return value
    finally:
        _sync_lock.release()


def request_rules_release(metadata):
    """Accept CPU A's already-validated release pointer without waiting."""
    global _pending_rules_request
    if not isinstance(metadata, dict):
        return False
    _rules_lock.acquire()
    try:
        _pending_rules_request = dict(metadata)
        return True
    finally:
        _rules_lock.release()


def take_rules_release():
    """Transfer one exact downloaded release body to CPU A."""
    global _pending_rules_release
    _rules_lock.acquire()
    try:
        candidate = _pending_rules_release
        _pending_rules_release = None
        return candidate
    finally:
        _rules_lock.release()


def take_rules_pointer():
    """Transfer the latest RTDB rules pointer to CPU A independently of bootstrap."""
    global _pending_rules_pointer
    _rules_pointer_lock.acquire()
    try:
        pointer = _pending_rules_pointer
        _pending_rules_pointer = None
        return pointer
    finally:
        _rules_pointer_lock.release()


def _queue_rules_pointer(pointer):
    """Keep only the newest unmodified RTDB pointer for CPU A validation."""
    global _pending_rules_pointer
    _rules_pointer_lock.acquire()
    try:
        _pending_rules_pointer = pointer
    finally:
        _rules_pointer_lock.release()


def set_applied_rules(reference):
    """Accept CPU A's validated active rules reference for later synchronization."""
    global _applied_rules_reference
    if not isinstance(reference, dict):
        return False
    version = reference.get('version')
    content_hash = reference.get('contentHash')
    if (not isinstance(version, int) or isinstance(version, bool) or version < 1 or
            not isinstance(content_hash, str) or len(content_hash) != 64 or
            any(char not in '0123456789abcdef' for char in content_hash)):
        return False
    _applied_rules_lock.acquire()
    try:
        _applied_rules_reference = {
            'version': version,
            'contentHash': content_hash,
        }
        return True
    finally:
        _applied_rules_lock.release()


def _applied_rules_snapshot():
    _applied_rules_lock.acquire()
    try:
        return dict(_applied_rules_reference)
    finally:
        _applied_rules_lock.release()


def _take_rules_request():
    global _pending_rules_request
    _rules_lock.acquire()
    try:
        metadata = _pending_rules_request
        _pending_rules_request = None
        return metadata
    finally:
        _rules_lock.release()


def _rules_download_may_follow_rtdb(rtdb_action):
    """A rare requested package may follow only disposable current transport.

    A new current observation exists every second, so waiting for a completely
    idle RTDB pass would starve a requested M6 release indefinitely. Never
    run after a coordination/presence/bootstrap action; those retain priority.
    """
    return rtdb_action in (None, 'current-observation')


def _queue_rules_release(metadata, raw_release):
    global _pending_rules_release
    _rules_lock.acquire()
    try:
        _pending_rules_release = {
            'metadata': dict(metadata),
            'release': raw_release,
        }
    finally:
        _rules_lock.release()


def _queue_commands(commands):
    global _last_delivered_command_sequence
    _command_lock.acquire()
    try:
        for command in commands:
            sequence = command.get('commandSequence')
            if sequence <= _last_delivered_command_sequence:
                continue
            if len(_pending_commands) >= COMMAND_QUEUE_DEPTH:
                # Commands are ordered. Stop rather than discard an older
                # unseen command or advance the sequence beyond queue capacity.
                break
            _pending_commands.append(command)
            _last_delivered_command_sequence = sequence
    finally:
        _command_lock.release()


def _set_sync_state(value):
    global _sync_state
    _sync_lock.acquire()
    try:
        _sync_state = value
    finally:
        _sync_lock.release()


def _material_change(observation, previous):
    """Return True for fields that justify a normal-mode cloud write."""
    if previous is None:
        return True
    values = observation.get('values', {})
    previous_values = previous.get('values', {})
    if values.get('is_valid') != previous_values.get('is_valid'):
        return True
    if abs(values.get('power', 0.0) - previous_values.get('power', 0.0)) >= POWER_CHANGE_W:
        return True
    if abs(values.get('voltage', 0.0) - previous_values.get('voltage', 0.0)) >= VOLTAGE_CHANGE_V:
        return True
    return False


def _legacy_observation_candidate(observation, previous_valid):
    """Keep legacy telemetry on its last valid Shelly-backed observation."""
    if (isinstance(observation, dict) and
            observation.get('status', {}).get('shelly_available') is True):
        return observation
    return previous_valid


def _safe_status(wlan):
    try:
        return wlan.status()
    except Exception:
        return None


def _safe_ip(wlan):
    try:
        return wlan.ifconfig()[0]
    except Exception:
        return 'unavailable'


def _format_mac(value):
    if isinstance(value, (bytes, bytearray)) and len(value) == 6:
        return ':'.join('{:02x}'.format(octet) for octet in value)
    return str(value) if value is not None else None


def _connected_ap_bssid(wlan):
    # UIFlow documents RSSI but not a current-BSSID accessor. Use only safe,
    # read-only probes; never scan as part of normal recovery.
    try:
        value = wlan.status('bssid')
        if value is not None:
            return _format_mac(value)
    except Exception:
        pass
    try:
        value = wlan.config('bssid')
        if value is not None:
            return _format_mac(value)
    except Exception:
        pass
    return None


def _log_connected_ap(wlan):
    try:
        rssi = wlan.status('rssi')
    except Exception:
        rssi = 'unavailable'
    bssid = _connected_ap_bssid(wlan)
    log('Wi-Fi got-IP AP: RSSI={} dBm, BSSID={}'.format(
        rssi, bssid if bssid is not None else 'unavailable'))


def _configure_and_connect(wlan, recovery):
    """Start a fresh credential-free station connection."""
    if recovery:
        wlan.active(False)
        time.sleep_ms(WIFI_RESTART_PAUSE_MS)
    wlan.active(True)
    wlan.config(reconnects=-1)
    wlan.connect()
    if recovery:
        log('Wi-Fi recovery: station restarted and credential-free connect issued')
    else:
        log('Initial credential-free Wi-Fi connect issued; driver reconnects unlimited')


def _try_ntp_sync():
    for host in NTP_HOSTS:
        try:
            ntptime.host = host
            ntptime.timeout = 5
            ntptime.settime()
            t = time.localtime()
            stamp = '{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z'.format(
                t[0], t[1], t[2], t[3], t[4], t[5])
            log('SNTP sync OK via {} -> {}'.format(host, stamp))
            return True
        except Exception as e:
            log('SNTP via {} failed: {}'.format(host, e))
    return False


def _sync_request():
    global _sync_sequence
    _sync_sequence += 1
    _command_lock.acquire()
    try:
        last_applied = _last_applied_command_sequence
    finally:
        _command_lock.release()
    return {
        'schemaVersion': 1,
        'kind': 'device-sync-request',
        'exchangeId': '{}-sync-{}-{:010d}'.format(
            _compact_timestamp_utc(), _session_id, _sync_sequence),
        'siteId': SITE_ID,
        'deviceId': RTDB_DEVICE_ID,
        'sessionId': _session_id,
        'requestedAt': _format_timestamp_utc(),
        'lastAppliedCommandSequence': last_applied,
        'appliedRules': _applied_rules_snapshot(),
        'openEventIds': [],
        'globalEnable': False,
    }


def _validate_sync_response(reply, request):
    if not isinstance(reply, dict) or reply.get('schemaVersion') != 1:
        raise TransportError('unsupported device-sync response schemaVersion')
    if reply.get('kind') != 'device-sync-response':
        raise TransportError('unexpected device-sync response kind')
    for field in ('exchangeId', 'siteId', 'deviceId', 'sessionId'):
        if reply.get(field) != request.get(field):
            raise TransportError('device-sync identity mismatch: {}'.format(field))
    bootstrap = reply.get('authenticationBootstrap')
    if not isinstance(bootstrap, dict):
        raise TransportError('device-sync authentication bootstrap missing')
    for field in ('firebaseCustomToken', 'firebaseApiKey', 'firebaseProjectId',
                  'rtdbUrl', 'identityToolkitUrl', 'secureTokenUrl'):
        if not isinstance(bootstrap.get(field), str) or not bootstrap.get(field):
            raise TransportError('device-sync bootstrap field missing: {}'.format(field))
    if bootstrap.get('firebaseProjectId') != APPROVED_FIREBASE_PROJECT_ID:
        raise TransportError('device-sync Firebase project is not approved')
    rtdb_url = bootstrap.get('rtdbUrl').rstrip('/')
    if rtdb_url not in APPROVED_RTDB_URLS:
        raise TransportError('device-sync RTDB host is not approved')
    if bootstrap.get('identityToolkitUrl') != APPROVED_IDENTITY_TOOLKIT_URL:
        raise TransportError('device-sync token exchange endpoint is not approved')
    if bootstrap.get('secureTokenUrl') != APPROVED_SECURE_TOKEN_URL:
        raise TransportError('device-sync refresh endpoint is not approved')
    bootstrap['rtdbUrl'] = rtdb_url
    return bootstrap


def _exchange_custom_token(bootstrap):
    url = '{}?key={}'.format(bootstrap['identityToolkitUrl'], bootstrap['firebaseApiKey'])
    reply = _http_json('POST', url, body={
        'token': bootstrap['firebaseCustomToken'],
        'returnSecureToken': True,
    }, headers={'Content-Type': 'application/json'}, timeout=DEVICE_SYNC_TIMEOUT_S)
    if not isinstance(reply, dict) or not isinstance(reply.get('idToken'), str):
        raise TransportError('Firebase token exchange did not return idToken')
    if not isinstance(reply.get('refreshToken'), str):
        raise TransportError('Firebase token exchange did not return refreshToken')
    try:
        lifetime_ms = int(reply.get('expiresIn', 3600)) * 1000
    except Exception:
        lifetime_ms = 3600000
    return {
        'idToken': reply['idToken'],
        'refreshToken': reply['refreshToken'],
        'expiresAtTicks': time.ticks_add(time.ticks_ms(), lifetime_ms),
        'firebaseApiKey': bootstrap['firebaseApiKey'],
        'rtdbUrl': bootstrap['rtdbUrl'],
        'secureTokenUrl': bootstrap['secureTokenUrl'],
    }


def _request_device_sync():
    request = _sync_request()
    reply = _http_json('POST', DEVICE_SYNC_URL, body=request, headers={
        'Content-Type': 'application/json',
        'X-Pilot-Key': INGEST_TOKEN,
    }, timeout=DEVICE_SYNC_TIMEOUT_S)
    bootstrap = _validate_sync_response(reply, request)
    noncredential = dict(reply)
    noncredential.pop('authenticationBootstrap', None)
    _set_sync_state(noncredential)
    _queue_commands(_filter_new_commands(
        reply.get('pendingCommands'), _last_delivered_command_sequence))
    return request, bootstrap


def _refresh_firebase_token(auth):
    url = '{}?key={}'.format(auth['secureTokenUrl'], auth['firebaseApiKey'])
    form = 'grant_type=refresh_token&refresh_token={}'.format(
        _form_value(auth['refreshToken']))
    reply = _http_json('POST', url, headers={
        'Content-Type': 'application/x-www-form-urlencoded',
    }, form_body=form, timeout=DEVICE_SYNC_TIMEOUT_S)
    id_token = reply.get('id_token') if isinstance(reply, dict) else None
    refresh_token = reply.get('refresh_token') if isinstance(reply, dict) else None
    if not isinstance(id_token, str) or not isinstance(refresh_token, str):
        raise TransportError('Firebase refresh did not return temporary credentials')
    try:
        lifetime_ms = int(reply.get('expires_in', 3600)) * 1000
    except Exception:
        lifetime_ms = 3600000
    auth['idToken'] = id_token
    auth['refreshToken'] = refresh_token
    auth['expiresAtTicks'] = time.ticks_add(time.ticks_ms(), lifetime_ms)
    return auth


def _rtdb_get(auth, path):
    return _http_json('GET', _rtdb_url(auth['rtdbUrl'], path, auth['idToken']))


def _rtdb_put(auth, path, value):
    return _http_json('PUT', _rtdb_url(auth['rtdbUrl'], path, auth['idToken']),
                      body=value, headers={'Content-Type': 'application/json'})


def _sync_state_payload(result, exchange_id):
    _command_lock.acquire()
    try:
        last_seen = _last_delivered_command_sequence
        last_applied = _last_applied_command_sequence
    finally:
        _command_lock.release()
    return {
        'schemaVersion': 1,
        'exchangeId': exchange_id,
        'siteId': SITE_ID,
        'deviceId': RTDB_DEVICE_ID,
        'sessionId': _session_id,
        'lastSeenCommandSequence': last_seen,
        'lastAppliedCommandSequence': last_applied,
        'result': result,
        'lastSyncAtMs': {'.sv': 'timestamp'},
    }


def _write_sync_state(auth, result, exchange_id):
    if not exchange_id:
        raise TransportError('completed bootstrap exchangeId is unavailable')
    _rtdb_put(auth, 'v1/sites/{}/devices/{}/syncState'.format(
        SITE_ID, RTDB_DEVICE_ID), _sync_state_payload(result, exchange_id))


def _write_presence(auth):
    _rtdb_put(auth, 'v1/sites/{}/devices/{}/presence'.format(
        SITE_ID, RTDB_DEVICE_ID), {
            'schemaVersion': 1,
            'siteId': SITE_ID,
            'deviceId': RTDB_DEVICE_ID,
            'sessionId': _session_id,
            'lastSeenAtMs': {'.sv': 'timestamp'},
        })


def _new_rtdb_schedule(now):
    return {
        'phase': 'device-sync',
        'auth': None,
        'bootstrap': None,
        'exchangeId': None,
        'failureCount': 0,
        'nextOperationAt': now,
        'lastCurrentSequence': None,
        'nextPresenceAt': now,
        'nextCoordinationAt': now,
        'coordinationStage': None,
        'coordination': {},
        'lastRulesPointerKeySummary': None,
        'syncWritePending': False,
    }


def _rules_pointer_key_summary(value):
    """Describe an RTDB pointer shape without logging any values."""
    if not isinstance(value, dict):
        return 'not-an-object'
    keys = list(value.keys())
    keys.sort()
    if not keys:
        return 'empty-object'
    return ','.join(keys[:12])


def _next_rtdb_action(schedule, now, current_sequence=None):
    if time.ticks_diff(now, schedule['nextOperationAt']) < 0:
        return None
    if schedule['phase'] == 'device-sync':
        return 'device-sync'
    if schedule['phase'] == 'token-exchange':
        return 'token-exchange'

    auth = schedule.get('auth')
    if auth is None:
        schedule['phase'] = 'device-sync'
        return 'device-sync'
    if time.ticks_diff(auth['expiresAtTicks'], now) <= TOKEN_REFRESH_MARGIN_MS:
        return 'token-refresh'
    if schedule['syncWritePending']:
        return 'sync-state'
    # Finish an in-progress coordination snapshot before selecting another
    # class of work. It is a fixed three-read exchange followed by one pending
    # sync-state write, so this cannot create an unbounded current blackout.
    if schedule['coordinationStage'] is not None:
        return schedule['coordinationStage']
    # Disposable current is intentionally lower priority than overdue durable
    # coordination and presence. Fresh observations coalesce while those
    # bounded exchanges run instead of starving command delivery forever.
    if time.ticks_diff(now, schedule['nextCoordinationAt']) >= 0:
        schedule['coordinationStage'] = 'global-enable'
        return schedule['coordinationStage']
    if time.ticks_diff(now, schedule['nextPresenceAt']) >= 0:
        return 'presence'
    if current_sequence is not None and current_sequence != schedule['lastCurrentSequence']:
        return 'current-observation'
    return None


def _complete_rtdb_action(schedule, action, completed_at, success,
                          status_code=None):
    if success:
        schedule['failureCount'] = 0
        schedule['nextOperationAt'] = time.ticks_add(
            completed_at, RTDB_MIN_OPERATION_GAP_MS)
        return

    schedule['failureCount'] += 1
    schedule['nextOperationAt'] = time.ticks_add(
        completed_at, _retry_delay_ms(schedule['failureCount']))
    if status_code in (401, 403) or action == 'token-exchange':
        schedule['phase'] = 'device-sync'
        schedule['auth'] = None
        schedule['bootstrap'] = None
        schedule['syncWritePending'] = False
        schedule['coordinationStage'] = None
        schedule['coordination'] = {}


def _run_rtdb_step(schedule, latest_observation):
    """Perform at most one bounded RTDB/bootstrap network operation."""
    now = time.ticks_ms()
    sequence = (latest_observation.get('sequence')
                if isinstance(latest_observation, dict) else None)
    action = _next_rtdb_action(schedule, now, sequence)
    if action is None:
        return None

    try:
        auth = schedule.get('auth')
        if action == 'device-sync':
            request, bootstrap = _request_device_sync()
            schedule['bootstrap'] = bootstrap
            schedule['exchangeId'] = request['exchangeId']
            schedule['phase'] = 'token-exchange'
        elif action == 'token-exchange':
            schedule['auth'] = _exchange_custom_token(schedule['bootstrap'])
            schedule['phase'] = 'ready'
            schedule['syncWritePending'] = True
            log('Firebase temporary credentials established for {}'.format(
                RTDB_DEVICE_ID))
        elif action == 'token-refresh':
            schedule['auth'] = _refresh_firebase_token(auth)
            log('Firebase temporary credentials refreshed')
        elif action == 'sync-state':
            _write_sync_state(auth, 'ok', schedule['exchangeId'])
            schedule['syncWritePending'] = False
        elif action == 'current-observation':
            current = _copy_current_observation(latest_observation, _session_id)
            _rtdb_put(auth,
                      'v1/sites/{}/devices/{}/currentObservation'.format(
                          SITE_ID, RTDB_DEVICE_ID), current)
            schedule['lastCurrentSequence'] = sequence
        elif action == 'presence':
            _write_presence(auth)
        elif action == 'global-enable':
            schedule['coordination']['globalEnable'] = _rtdb_get(
                auth, 'v1/sites/{}/control/globalEnable'.format(SITE_ID))
            schedule['coordinationStage'] = 'rules-metadata'
        elif action == 'rules-metadata':
            schedule['coordination']['currentRules'] = _rtdb_get(
                auth, 'v1/sites/{}/rules/current'.format(SITE_ID))
            _queue_rules_pointer(schedule['coordination']['currentRules'])
            key_summary = _rules_pointer_key_summary(
                schedule['coordination']['currentRules'])
            if key_summary != schedule['lastRulesPointerKeySummary']:
                schedule['lastRulesPointerKeySummary'] = key_summary
                log('RTDB rules pointer read [M6.7 keys={}]'.format(key_summary))
            schedule['coordinationStage'] = 'commands'
        elif action == 'commands':
            commands = _rtdb_get(
                auth, 'v1/sites/{}/devices/{}/commands'.format(
                    SITE_ID, RTDB_DEVICE_ID))
            fresh = _filter_new_commands(
                commands, _last_delivered_command_sequence)
            _queue_commands(fresh)
            _set_sync_state({
                'schemaVersion': 1,
                'kind': 'rtdb-coordination-snapshot',
                'siteId': SITE_ID,
                'deviceId': RTDB_DEVICE_ID,
                'sessionId': _session_id,
                'globalEnable': schedule['coordination'].get('globalEnable'),
                'currentRules': schedule['coordination'].get('currentRules'),
                'pendingCommandCount': len(fresh),
            })
            schedule['coordinationStage'] = None
            schedule['coordination'] = {}
            schedule['syncWritePending'] = True
        else:
            raise TransportError('unknown RTDB schedule action')

        completed_at = time.ticks_ms()
        if action == 'presence':
            schedule['nextPresenceAt'] = time.ticks_add(
                completed_at, RTDB_PRESENCE_PERIOD_MS)
        elif action == 'commands':
            schedule['nextCoordinationAt'] = time.ticks_add(
                completed_at, RTDB_COORDINATION_PERIOD_MS)
        _complete_rtdb_action(schedule, action, completed_at, True)
        _record_transport_result('rtdb', True, completed_at)
        return action
    except Exception as e:
        completed_at = time.ticks_ms()
        status_code = e.status_code if isinstance(e, TransportError) else None
        _complete_rtdb_action(
            schedule, action, completed_at, False, status_code)
        _record_transport_result('rtdb', False, completed_at)
        delay = time.ticks_diff(schedule['nextOperationAt'], completed_at)
        log('RTDB {} error: {}; retry in {} ms'.format(action, e, delay))
        return action


def _run():
    wlan = network.WLAN(network.STA_IF)
    _configure_and_connect(wlan, False)

    connected = False
    traffic_ready = False
    clock_synced = False
    disconnect_count = 0
    quiet_deadline = None
    next_recovery = time.ticks_add(time.ticks_ms(), WIFI_RECOVERY_TRIGGER_MS)
    next_ntp_attempt = time.ticks_ms()
    next_publish_attempt = time.ticks_ms()
    last_publish = time.ticks_add(time.ticks_ms(), -HEARTBEAT_PERIOD_MS)
    last_published_observation = None
    latest_observation = None
    latest_legacy_observation = None
    monitoring_active = False
    rtdb_schedule = _new_rtdb_schedule(time.ticks_ms())
    next_durable_attempt = time.ticks_ms()
    durable_failure_count = 0
    durable_yield_to_rtdb = False

    while True:
        now = time.ticks_ms()
        was_connected = connected
        connected = wlan.isconnected()

        if connected and not was_connected:
            _log_connected_ap(wlan)
            traffic_ready = False
            quiet_deadline = time.ticks_add(now, WIFI_QUIET_PERIOD_MS)
            next_recovery = None
            log('Wi-Fi connected; network traffic remains paused for {} ms'.format(
                WIFI_QUIET_PERIOD_MS))
        elif not connected and was_connected:
            disconnect_count += 1
            traffic_ready = False
            quiet_deadline = None
            next_recovery = time.ticks_add(now, WIFI_RECOVERY_TRIGGER_MS)
            log('Wi-Fi disconnected #{}; fresh recovery scheduled in {} ms'.format(
                disconnect_count, WIFI_RECOVERY_TRIGGER_MS))

        if not connected and next_recovery is not None:
            if time.ticks_diff(now, next_recovery) >= 0:
                try:
                    _configure_and_connect(wlan, True)
                except Exception as e:
                    log('Wi-Fi recovery attempt failed: {}'.format(e))
                next_recovery = time.ticks_add(now, WIFI_RECOVERY_REPEAT_MS)

        if connected and not traffic_ready and quiet_deadline is not None:
            if time.ticks_diff(now, quiet_deadline) >= 0:
                traffic_ready = True
                log('Wi-Fi quiet period complete; Shelly and remote traffic enabled')

        if connected and traffic_ready and not clock_synced:
            if time.ticks_diff(now, next_ntp_attempt) >= 0:
                clock_synced = _try_ntp_sync()
                if not clock_synced:
                    next_ntp_attempt = time.ticks_add(now, NTP_RETRY_MS)

        _set_state(connected, traffic_ready, clock_synced, _safe_status(wlan),
                   _safe_ip(wlan), disconnect_count)

        if connected and traffic_ready and clock_synced:
            pending = _take_pending_observation()
            if pending is not None:
                latest_observation = pending
                latest_legacy_observation = _legacy_observation_candidate(
                    pending, latest_legacy_observation)

            retry_due = time.ticks_diff(now, next_publish_attempt) >= 0
            heartbeat_due = time.ticks_diff(now, last_publish) >= HEARTBEAT_PERIOD_MS
            monitor_due = (monitoring_active and latest_legacy_observation is not None and
                           time.ticks_diff(now, last_publish) >= MONITOR_PUBLISH_PERIOD_MS)
            change_due = (not monitoring_active and latest_legacy_observation is not None and
                          _material_change(latest_legacy_observation, last_published_observation))

            reason = None
            if monitor_due:
                reason = 'monitoring'
            elif change_due:
                reason = 'state-change'
            elif heartbeat_due:
                reason = 'heartbeat'

            if retry_due and reason is not None:
                observation = (latest_legacy_observation if latest_legacy_observation is not None
                               else last_published_observation)
                if observation is not None:
                    ok, reported_monitoring = _publish_observation(observation, reason)
                    _record_transport_result(
                        'telemetry', ok, time.ticks_ms())
                    if ok:
                        last_publish = now
                        last_published_observation = observation
                        next_publish_attempt = now
                        if (reported_monitoring is not None and
                                reported_monitoring != monitoring_active):
                            monitoring_active = reported_monitoring
                            log('Web monitoring mode {}'.format(
                                'ON (1 Hz)' if monitoring_active else 'OFF (on-change)'))
                        log('Netlify publish succeeded ({})'.format(reason))
                    else:
                        next_publish_attempt = time.ticks_add(now, PUBLISH_RETRY_MS)
                        log('Netlify publish failed ({}); retry in {} ms'.format(
                            reason, PUBLISH_RETRY_MS))

            # Legacy Netlify publication above retains first service priority.
            # Sparse durable records outrank disposable RTDB work, but CPU B
            # performs at most one additional bounded network call per pass and
            # yields to RTDB after every accepted durable record.
            durable_attempted = False
            durable_record = _peek_durable_record()
            if (durable_record is not None and not durable_yield_to_rtdb and
                    time.ticks_diff(now, next_durable_attempt) >= 0):
                durable_attempted = True
                try:
                    duplicate = _publish_durable_record(durable_record)
                    _discard_durable_record(durable_record)
                    _record_transport_result(
                        'durable', True, time.ticks_ms())
                    durable_failure_count = 0
                    next_durable_attempt = time.ticks_ms()
                    durable_yield_to_rtdb = True
                    if durable_record.get('recordType') == 'observation':
                        log('Durable observation accepted: sequence={}, duplicate={}'.format(
                            durable_record.get('sequence'), duplicate))
                    else:
                        log('Rules audit accepted: type={}, sequence={}, duplicate={}'.format(
                            durable_record.get('recordType'),
                            durable_record.get('sequence'), duplicate))
                except Exception as e:
                    _record_transport_result(
                        'durable', False, time.ticks_ms())
                    durable_failure_count += 1
                    delay = _durable_retry_delay_ms(durable_failure_count)
                    next_durable_attempt = time.ticks_add(time.ticks_ms(), delay)
                    log('Durable observation transport error: {}; retry in {} ms'.format(
                        e, delay))
            if not durable_attempted:
                rtdb_action = _run_rtdb_step(rtdb_schedule, latest_observation)
                durable_yield_to_rtdb = False
                # Rules bytes are lower priority than legacy telemetry,
                # durable records, and RTDB coordination. A continuous 1 Hz
                # disposable-current stream is the one safe exception: serve
                # one pending package after that update so it cannot starve.
                # CPU B neither parses nor validates the rules package.
                if _rules_download_may_follow_rtdb(rtdb_action):
                    metadata = _take_rules_request()
                    if metadata is not None:
                        try:
                            _queue_rules_release(metadata,
                                                 _download_rules_release(metadata))
                            log('Runtime release downloaded for CPU A: release={}'.format(
                                metadata.get('releaseId')))
                        except Exception as e:
                            log('Rules release transport error: {}'.format(e))

        time.sleep_ms(100)


def _worker():
    try:
        _run()
    except Exception as e:
        _set_state(False, False, False, None, 'unavailable', 0)
        log('CPU B CRASHED:')
        sys.print_exception(e)


def start():
    """Start CPU B exactly once. Returns True when a new worker was started."""
    global _started
    _start_lock.acquire()
    try:
        if _started:
            return False
        _started = True
        log('CPU B release M6.20: cloud response and queue status')
        _thread.start_new_thread(_worker, ())
        return True
    finally:
        _start_lock.release()
