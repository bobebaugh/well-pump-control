# Release: 2026-08-22 — introduce the CPU B Wi-Fi recovery and Netlify worker.
"""CPU B communications worker for the interpreted Tab5 pilot.

This module is the sole owner of Wi-Fi activation, association, recovery,
SNTP, and remote Netlify traffic. CPU A may use the established LAN for
Shelly observations, but it never changes the station interface.

Routine telemetry crosses the CPU boundary as an immutable tuple through a
single coalescing slot. If TLS is slow, a newer observation replaces an older
unsent observation instead of blocking the one-second device loop.
"""

import _thread
import sys
import time
import network
import ntptime

from netlify_client import publish_sample


WIFI_QUIET_PERIOD_MS = 2000
WIFI_RECOVERY_TRIGGER_MS = 5000
WIFI_RECOVERY_REPEAT_MS = 15000
WIFI_RESTART_PAUSE_MS = 250
NTP_RETRY_MS = 30000
NTP_HOSTS = ('pool.ntp.org', 'time.google.com', 'time.cloudflare.com')
PUBLISH_RETRY_MS = 60000
HEARTBEAT_PERIOD_MS = 60000


def log(msg):
    print('[well-cloud] {}'.format(msg))


_state_lock = _thread.allocate_lock()
_state = (False, False, False, None, 'unavailable', 0)
# state fields: connected, traffic_ready, clock_synced, driver_status, IP, disconnect_count

_telemetry_lock = _thread.allocate_lock()
_pending_telemetry = None

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


def submit_telemetry(sample):
    """Copy a Shelly sample into the one-slot routine telemetry queue."""
    global _pending_telemetry
    message = (
        sample.get('power', 0.0),
        sample.get('reactive', 0.0),
        sample.get('pf', 0.0),
        sample.get('voltage', 0.0),
        bool(sample.get('is_valid', False)),
        sample.get('total', 0.0),
        sample.get('total_returned', 0.0),
    )
    _telemetry_lock.acquire()
    try:
        _pending_telemetry = message
    finally:
        _telemetry_lock.release()


def _take_pending_telemetry():
    global _pending_telemetry
    _telemetry_lock.acquire()
    try:
        message = _pending_telemetry
        _pending_telemetry = None
        return message
    finally:
        _telemetry_lock.release()


def _restore_if_slot_empty(message):
    global _pending_telemetry
    _telemetry_lock.acquire()
    try:
        if _pending_telemetry is None:
            _pending_telemetry = message
    finally:
        _telemetry_lock.release()


def _sample_from_message(message):
    return {
        'power': message[0],
        'reactive': message[1],
        'pf': message[2],
        'voltage': message[3],
        'is_valid': message[4],
        'total': message[5],
        'total_returned': message[6],
    }


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
    last_publish_attempt = time.ticks_add(time.ticks_ms(), -PUBLISH_RETRY_MS)
    last_publish = time.ticks_add(time.ticks_ms(), -HEARTBEAT_PERIOD_MS)
    last_published_message = None

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
            retry_due = time.ticks_diff(now, last_publish_attempt) >= PUBLISH_RETRY_MS
            heartbeat_due = time.ticks_diff(now, last_publish) >= HEARTBEAT_PERIOD_MS
            if retry_due:
                message = _take_pending_telemetry()
                reason = 'state-change'
                if message is None and heartbeat_due:
                    message = last_published_message
                    reason = 'heartbeat'
                if message is not None:
                    last_publish_attempt = now
                    if publish_sample(_sample_from_message(message), reason):
                        last_publish = now
                        last_published_message = message
                        log('Netlify publish succeeded ({})'.format(reason))
                    else:
                        _restore_if_slot_empty(message)
                        log('Netlify publish failed ({})'.format(reason))

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
        _thread.start_new_thread(_worker, ())
        return True
    finally:
        _start_lock.release()

