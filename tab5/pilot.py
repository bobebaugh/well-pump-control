# Release: 2026-09-15 M6.42 — pressure sensor commissioned.
# main.py - Tab5 well-pump observational pilot (interpreted port of
# well-pump-control/firmware/tab5/main/app_main.cpp)
#
# Observes the Wi-Fi connection established before this application starts,
# holds a quiet period after got-IP before opening any socket, samples the
# Shelly EM + ADS1110 at 1 Hz,
# publish to Netlify on change or heartbeat, show live status on screen.
#
# V3 may inhibit the relay and may restore its declared normal value only after
# all owners release and current script lock evidence is exactly zero. It never
# creates ordinary pump demand; the mechanical switch remains authoritative.
# Battery charge control is the separate exception: a hysteresis policy keeps the pack between
# BATTERY_LOW_PCT and BATTERY_HIGH_PCT - see the battery section below.

import M5
import __main__
import gc
import os
import time
import uhashlib
import ujson
import requests
from machine import I2C, Pin, reset
import cloud

# --- config (values from firmware/tab5/main/pilot_config.h) ---
SHELLY_1_STATUS_URL = 'http://192.168.50.201/rpc/Shelly.GetStatus'
# Discovery resolves the dynamic component ids by name. The unfiltered call is
# paginated and truncates, so it is never used for acquisition.
SHELLY_1_COMPONENTS_URL = ('http://192.168.50.201/rpc/Shelly.GetComponents?'
                           'dynamic_only=true&include=%5B%22config%22%2C%22status%22%5D')
# Steady-state acquisition: one filtered request naming every component this cycle
# needs. The key list is built from ids resolved by name, never hard-coded.
SHELLY_1_FILTERED_URL = ('http://192.168.50.201/rpc/Shelly.GetComponents?'
                         'keys={}&include=%5B%22config%22%2C%22status%22%5D')
# The filtered URL carries the key list, so it never matches a constant by
# equality. Diagnostics match on this prefix instead; without it every filtered
# acquisition logged as the generic 'Shelly.read' with no reason classified.
SHELLY_1_FILTERED_PREFIX = SHELLY_1_FILTERED_URL.split('{}')[0]
SHELLY_1_STOP_URL = 'http://192.168.50.201/rpc/Switch.Set?id=0&on=false'
SHELLY_1_SWITCH_URL = 'http://192.168.50.201/rpc/Switch.Set?id={}&on={}'
SHELLY_1_BOOLEAN_SET_URL = 'http://192.168.50.201/rpc/Boolean.Set?id={}&value={}'
SHELLY_1_RESTART_URL = 'http://192.168.50.201/rpc/Shelly.Reboot'
SHELLY_1_LOCK_NAME = 'IsLocked'
SHELLY_1_COUNT_NAME = 'loCntr'
SHELLY_1_FLAG_NAME = 'Tab5IsLocked'
# The observation cadence. Five ADS1110 conversions at 15 SPS already cost about
# 335ms of this before any network I/O, and two Shelly reads may each spend up to
# SHELLY_TIMEOUT_S. Anything below derived from this constant must stay derived:
# a count-based threshold silently changes meaning when the cadence changes.
SAMPLE_PERIOD_MS = 2000
SHELLY_TIMEOUT_S = 1  # requests has whole-second granularity; C++ used 750ms
# Three cycles. Derived, not literal: at a 2000ms cadence a fixed 3000ms would
# call a source stale after a single missed read.
STALE_AFTER_MS = SAMPLE_PERIOD_MS * 3
# A regression sample gap wider than this ends the window. Two cycles plus a
# margin, so one late cycle is tolerated and a real stall is still caught. This
# was a bare 2500 while the cadence was 1000ms; the arithmetic preserves it.
SAMPLE_GAP_LIMIT_MS = SAMPLE_PERIOD_MS * 2 + 500
CLOUD_TELEMETRY_FRESH_MS = 90000
CLOUD_RTDB_FRESH_MS = 45000
CLOUD_FAILED_RED_MS = 180000
PUMP_RUNNING_THRESHOLD_W = 1000.0
# The transducer remains at the well while the Tab5 is being bench-developed.
# ADS1110 communication alone must not turn a disconnected input into apparent
# pressure. Field commissioning will replace this bounded release constant with
# the reviewed parameter lifecycle.
# Commissioned 2026-09-15. The fit below is qualified against the well gauge over
# roughly 40-61 PSIG (R2 0.9987, RMS residual 0.23 PSI); see
# docs/pressure-calibration/. Setting this True is what releases pressure to the
# application AND to the rules engine: calc-pressure carries _requiredTrueFields
# guards, so while it was False PressurePSI was never produced at all and
# TankFlowQuality read PRESSURE_INVALID rather than a real quality.
PRESSURE_SENSOR_COMMISSIONED = True
SOFTWARE_RELEASE = 'M6.42'
OPERATOR_COMMAND_LIFETIME_MS = 45000
OPERATOR_CONFIRM_WINDOW_MS = 8000
SHELLY_RESTART_CONFIRM_MS = 60000
TAB5_RESTART_DELAY_MS = 1500

# CPU A validates and adopts the v2 runtime package. CPU B carries only the
# RTDB pointer and exact downloaded bytes; it never interprets package meaning.
SITE_ID = 'well-main'
DEVICE_ID = 'tab5-well-main'
MAX_DURABLE_OBSERVATION_INTERVAL_MS = 600000
EVENT_BOARD_HEARTBEAT_MS = 30000
EVENT_HISTORY_DEPTH = 600
SHELLY_AVAILABILITY_CONFIRMATION_SAMPLES = 3
MATERIAL_NUMERIC_THRESHOLDS = {
    'values.power': 50.0,
    'values.voltage': 2.0,
    # 133 counts is 25000 uV at 187.5 uV/count, the threshold this replaced,
    # and about 0.63 PSI at 211.492 counts/PSI.
    'values.adc_raw': 133.0,
    'values.battery_voltage': 0.1,
    'values.battery_current': 0.1,
    'values.battery_percent': 1.0,
}
MATERIAL_EXACT_CHANGE_PATHS = (
    'values.battery_charging',
    'values.battery_charge_enabled',
    'values.shelly1_sw0',
    'values.shelly1_rly0',
    'values.shelly1_tab5lock',
    'status.adc_available',
    'status.battery_available',
    'status.clock_synced',
    'status.user_monitor_active',
    'status.monitor_mode_active',
    'status.tab5_relay_restoration',
)
MATERIAL_CHANGE_LABELS = {
    'values.power': 'Shelly EM',
    'values.voltage': 'Shelly EM',
    'values.adc_raw': 'pressure ADC',
    'values.battery_voltage': 'Tab5 battery',
    'values.battery_current': 'Tab5 battery',
    'values.battery_percent': 'Tab5 battery',
    'values.battery_charging': 'Tab5 battery',
    'values.battery_charge_enabled': 'Tab5 battery',
    'values.shelly1_sw0': 'Shelly 1',
    'values.shelly1_rly0': 'Shelly 1',
    'values.shelly1_tab5lock': 'Tab5 inhibition',
    'values.shelly1_lock': 'Shelly 1',
    'values.shelly1_lockout_count': 'Shelly 1',
    'values.shelly1_tab5lock': 'Tab5 inhibition',
    'status.adc_available': 'pressure ADC',
    'status.battery_available': 'Tab5 battery',
    'status.clock_synced': 'Tab5 clock',
    'status.user_monitor_active': 'Tab5 operator mode',
    'status.monitor_mode_active': 'Tab5 operating mode',
    'status.tab5_relay_restoration': 'Tab5 relay evidence',
    'status.shelly_available': 'Shelly EM',
    'status.shelly1_available': 'Shelly 1',
}
RULES_RUNTIME_FILE = 'rules-runtime-v2.json'
RULES_RUNTIME_TEMP_FILE = '.rules-runtime-v2.download'
RULES_V3_STAGED_FILE = 'rules-runtime-v3-staged.json'
RULES_V3_STAGED_TEMP_FILE = '.rules-runtime-v3-staged.download'
RULES_FETCH_RETRY_MS = 60000
MAX_RULES_RELEASE_BYTES = 65536
RUNTIME_PACKAGE_KIND = 'well-pump-parameter-runtime'
RUNTIME_POINTER_KIND = 'well-pump-runtime-release-pointer'
RUNTIME_SCHEMA_VERSION = 2
RULES_V3_SCHEMA_VERSION = 3
RULES_V3_POINTER_SCHEMA_VERSION = 4
RULES_V3_POINTER_KIND = 'well-pump-event-v3-runtime-pointer'
RULES_V3_PACKAGE_KIND = 'well-pump-event-runtime-v3'
RUNTIME_DIRECT_BINDINGS = {
    'shelly-gen1-em': {
        'emeter/0.power': ('number', 'W', 'read'),
        'emeter/0.voltage': ('number', 'V', 'read'),
        'emeter/0.pf': ('number', None, 'read'),
        'emeter/0.total': ('number', 'Wh', 'read'),
        '$availability': ('boolean', None, 'read'),
    },
    'shelly-gen4-switch': {
        'SW(0)': ('boolean', None, 'read'),
        # RLY(0) is observed, never written: the Shelly script is its sole writer.
        'RLY(0)': ('boolean', None, 'read'),
        'UDF(IsLocked)': ('integer', 's', 'read'),
        'UDF(Tab5IsLocked)': ('boolean', None, 'readWrite'),
        '$availability': ('boolean', None, 'read'),
    },
    'tab5-runtime': {
        'values.adc_raw': ('integer', 'count', 'read'),
        'status.pressure_sensor_commissioned': ('boolean', None, 'read'),
        'status.adc_available': ('boolean', None, 'read'),
        'status.clock_synced': ('boolean', None, 'read'),
        'status.wifi_connected': ('boolean', None, 'read'),
        'status.cloud_available': ('boolean', None, 'read'),
        'values.battery_percent': ('number', '%', 'read'),
        'status.buffer_used_pct': ('number', '%', 'read'),
        'status.records_lost': ('integer', 'count', 'read'),
    },
}

I2C_ANTENNA_ADDR = 0x43
REG_IO_DIR = 0x03
REG_OUT_SET = 0x05
REG_IN_STA = 0x0F
PI4IOE1_ANTENNA_SELECT_BIT = 0x01
PI4IOE1_EXT_5V_ENABLE_BIT = 0x04

# --- battery charge-life policy ---
# Keeps the pack between BATTERY_LOW_PCT and BATTERY_HIGH_PCT using M5.Power, not a
# hand-rolled I2C driver. Confirmed by connecting to this board over COM3 (mpremote) and
# reading M5Unified's own source (Power_Class.cpp, board_t::board_M5Tab5 case):
#   - M5.begin() already brings up and calibrates the onboard INA226 at 0x41
#     (shunt_res=0.005 ohm, max_expected_current=2.0A) - re-doing that here would only
#     regress the resolution, so this pilot doesn't touch the INA226 directly at all.
#   - getBatteryVoltage() -> mV, getBatteryCurrent() -> mA, and getBatteryLevel() ->
#     0-100% are backed by that INA226. M5Unified master 8530f537 documents current
#     as positive for charge and negative for discharge; its Tab5 path explicitly
#     reverses the hardware shunt sign to provide that API convention. isCharging()
#     separately reports the Tab5 IO-expander CHG_STAT input. The HMI retains the
#     signed current and does not infer direction from it.
#   - setBatteryCharge(bool) drives E2.P7 on the PI4IOE5V6408 0x44 expander (charge
#     enable, confirmed active-high) through the same path M5Stack's own firmware uses -
#     no reason to poke that register ourselves either.
# Live probe also showed quick-charge (E2.P5, active-low) already enabled by whatever
# ran before this pilot; this file never touches that pin.
#
# CHG_EN only gates the IP2326 boost-charge path (confirmed: EN=LOW drops it to 3uA per
# its datasheet, and our own toggle test measured exactly 0mA for 60s with charge off and
# USB connected). It has no bearing on the system's own power draw, which is an entirely
# separate path (through the board's other buck-boost, not through IP2326 at all) - so
# with USB unplugged the pack still discharges under system load regardless of
# charge_enable's state. That's expected, not a leak: charge_enable only ever answers
# "is the charger allowed to push current in", never "is anything pulling current out".
BATTERY_LOW_PCT = 75     # charging turns back on at or below this level
BATTERY_HIGH_PCT = 80    # charging turns off at or above this level
BATTERY_DIAGNOSTIC_PERIOD_MS = 1000
BATTERY_POLICY_PERIOD_MS = 60000

WHITE = 0xFFFFFF
CYAN = 0x9EB4D8
GREEN = 0x16835d
BLUE = 0x2457c5
RED = 0xFF4444
YELLOW = 0xE8B93E
BG = 0x07152e


def log(msg):
    print('[well-pilot] {}'.format(msg))


# --- board I/O + internal antenna confirmation ---
# This historical diagnostic was designed to run before M5.begin(). main.py now
# owns that call so it can present the startup selector; keep this disabled. The
# internal bus (SCL 32 / SDA 31)
# belongs to M5Unified: it drives the INA226, the expanders and the ST7123 touch
# controller. Holding a machine.I2C handle on those pins is what breaks M5.Touch
# and M5.Power - measured on this board 2026-08-19. So this readback takes the
# bus briefly before M5 claims it, and drops the handle immediately afterwards.
# It is a diagnostic read only; it sets nothing.
# DISABLED BY DEFAULT. machine.I2C has no deinit() in this build, so merely
# CONSTRUCTING I2C(0) leaves ESP-IDF port 0 claimed by MicroPython's driver -
# dropping the Python reference does not release it. M5.begin() then cannot
# fully reclaim the internal bus, and M5.Touch never reports anything.
# Measured 2026-08-19: with this enabled, touch is dead; with it disabled,
# touch works. The antenna is hardware-strapped and this pilot never changes
# it, so the readback is a one-time diagnostic, not a runtime requirement.
# Re-enable only in a diagnostic build where touch is not needed.
ANTENNA_READBACK = False

_antenna_latch = None
if ANTENNA_READBACK:
    try:
        _tmp_i2c = I2C(0, scl=Pin(32), sda=Pin(31), freq=100000)
        _antenna_latch = _tmp_i2c.readfrom_mem(I2C_ANTENNA_ADDR, REG_OUT_SET, 1)[0]
        _tmp_i2c = None
    except Exception as _e:
        _tmp_i2c = None

# main.py calls M5.begin() once before its bounded boot selector. Nothing of ours
# may hold a machine.I2C handle on ports 0 or 1 after this point - Port A uses
# SoftI2C (immune, bit-banged GPIO) and touch uses M5.Touch.
# The ADS1110 stack lives in main.py, which owns board initialisation. Bound
# once here rather than reached through __main__ every cycle. This is the only
# ADC name this application needs: one filtered reading per observation.
read_ads1110_filtered_raw_count = __main__.read_ads1110_filtered_raw_count
# One address on the device: the fill run reads this endpoint too, so main.py
# holds it rather than each application carrying its own copy.
SHELLY_EM_URL = __main__.SHELLY_EM_URL
# The qualified sensor fit, produced by tab5/pressure_qualification.py and held
# in main.py beside the converter that feeds it. One copy on the device, so a
# recalibration updates one place and the utility cannot disagree with this loop.
calibrated_psi_from_raw_count = __main__.calibrated_psi_from_raw_count
PRESSURE_SENSOR_SPAN_PSI = __main__.PRESSURE_SENSOR_SPAN_PSI


def confirm_internal_antenna():
    latch = _antenna_latch
    if latch is None:
        log('PI4IOE1 0x43 antenna readback skipped (ANTENNA_READBACK=False)')
        return None
    internal = (latch & PI4IOE1_ANTENNA_SELECT_BIT) == 0
    ext_5v = (latch & PI4IOE1_EXT_5V_ENABLE_BIT) != 0
    log('PI4IOE1 0x43 output latch=0x{:02x}: P0={} ({} antenna), P2={} (Port A 5V)'.format(
        latch, 'LOW' if internal else 'HIGH', 'internal' if internal else 'external',
        'HIGH' if ext_5v else 'LOW'))
    return internal




def read_battery():
    """Returns (voltage_v, current_a, level_pct, charging) from M5.Power - None for every
    field if the read failed. See the battery section above for why this doesn't talk to
    the INA226 directly."""
    try:
        voltage_v = M5.Power.getBatteryVoltage() / 1000.0
        current_a = M5.Power.getBatteryCurrent() / 1000.0
        level_pct = M5.Power.getBatteryLevel()
        charging = M5.Power.isCharging()
        if (not _is_number(voltage_v) or voltage_v <= 0 or
                not _is_number(current_a) or
                not _is_number(level_pct) or not 0 <= level_pct <= 100 or
                not isinstance(charging, bool)):
            raise ValueError('invalid UIFlow battery result')
        return voltage_v, current_a, level_pct, charging
    except Exception:
        return None, None, None, None


def set_charge_enable(enable):
    try:
        M5.Power.setBatteryCharge(enable)
        return True
    except Exception as e:
        log('M5.Power.setBatteryCharge failed: {}'.format(e))
        return False


def battery_charge_policy(level_pct, requested_state, retry_target=None):
    """Return (requested state, retry target, attempted target).

    requested_state is only the last request whose UIFlow setter returned normally;
    it is not charger readback. A failed call makes that state unknown and retains a
    bounded scalar retry target for the next 60-second policy evaluation.
    """
    if _is_number(level_pct) and level_pct <= BATTERY_LOW_PCT:
        target = True
    elif _is_number(level_pct) and level_pct >= BATTERY_HIGH_PCT:
        target = False
    elif retry_target is not None:
        target = retry_target
    elif requested_state is not None:
        return requested_state, None, None
    else:
        # Startup in the hysteresis band (or without a usable reading) explicitly
        # requests charging instead of assuming the charger's prior state.
        target = True
    if requested_state is target and retry_target is None:
        return requested_state, None, None
    if set_charge_enable(target):
        return target, None, target
    return None, target, target


def heap_diagnostics(memory_module, minimum_free=None):
    """Return MicroPython-heap counters and a bounded minimum-free scalar."""
    try:
        free_bytes = memory_module.mem_free()
        allocated_bytes = memory_module.mem_alloc()
    except Exception:
        return None, None, minimum_free
    if minimum_free is None or free_bytes < minimum_free:
        minimum_free = free_bytes
    return free_bytes, allocated_bytes, minimum_free


def elapsed_ticks_ms(start_ticks_ms, end_ticks_ms):
    """Return a nonnegative elapsed interval using wrap-safe MicroPython ticks."""
    return max(0, time.ticks_diff(end_ticks_ms, start_ticks_ms))


# --- CPU B communications status: CPU A observes but never changes Wi-Fi ---
wifi_connected = False
network_traffic_allowed = False
shelly_resume_confirmation_pending = True
shelly1_resume_confirmation_pending = True
# Dynamic component ids resolved by name. Held across cycles so steady state costs
# one request, and discarded whenever the device contradicts it.
shelly1_routing = None


# --- Shelly reads ---
_shelly_diagnostic_failures = {}


def _shelly_read_reason(url, data):
    """Diagnostic only; the existing normalizers remain authoritative."""
    if not isinstance(data, dict):
        return 'response-not-object'
    if 'error' in data or ('code' in data and 'message' in data):
        return 'rpc-error'
    if url == SHELLY_EM_URL:
        for name in ('power', 'reactive', 'pf', 'voltage', 'total', 'total_returned'):
            if not _is_number(data.get(name)):
                return 'missing-or-invalid-' + name
        if data.get('is_valid') is not True:
            return 'is_valid-not-true'
        if not -1 <= data['pf'] <= 1 or data['voltage'] < 0:
            return 'pf-or-voltage-out-of-range'
    elif url == SHELLY_1_STATUS_URL:
        for component, field in (('switch:0', 'output'), ('input:0', 'state')):
            record = data.get(component)
            if not isinstance(record, dict) or not isinstance(record.get(field), bool):
                return 'missing-or-invalid-' + component + '.' + field
    elif url == SHELLY_1_COMPONENTS_URL or url.startswith(SHELLY_1_FILTERED_PREFIX):
        if not isinstance(data.get('components'), list):
            return 'components-not-list'
        if url.startswith(SHELLY_1_FILTERED_PREFIX):
            # The filtered reply carries the two static components as well, and
            # a missing one is the failure most likely to be mistaken for a
            # transport fault. Name it rather than letting it fall through.
            static = {}
            for component in data['components']:
                if isinstance(component, dict) and isinstance(component.get('key'), str):
                    static[component['key']] = component.get('status')
            for key, field in (('switch:0', 'output'), ('input:0', 'state')):
                record = static.get(key)
                if not isinstance(record, dict) or not isinstance(record.get(field), bool):
                    return 'missing-or-invalid-' + key + '.' + field
        found = {}
        prefixes = {SHELLY_1_LOCK_NAME: 'number:', SHELLY_1_COUNT_NAME: 'number:',
                    SHELLY_1_FLAG_NAME: 'boolean:'}
        for component in data['components']:
            if not isinstance(component, dict):
                continue
            key, config, status = component.get('key'), component.get('config'), component.get('status')
            if (not isinstance(key, str) or not isinstance(config, dict) or
                    not isinstance(status, dict)):
                continue
            name = config.get('name')
            prefix = prefixes.get(name)
            if prefix is None:
                continue
            if name in found:
                return 'duplicate-' + name
            if not key.startswith(prefix):
                return 'wrong-component-type-' + name
            found[name] = status.get('value')
        for name, low, high in ((SHELLY_1_LOCK_NAME, -1, 86400),
                                (SHELLY_1_COUNT_NAME, 0, 3)):
            if name not in found:
                return 'missing-' + name
            value = found[name]
            if not isinstance(value, int) or isinstance(value, bool):
                return 'wrong-type-' + name
            if not low <= value <= high:
                return 'out-of-range-' + name
        if SHELLY_1_FLAG_NAME not in found:
            return 'missing-' + SHELLY_1_FLAG_NAME
        if not isinstance(found[SHELLY_1_FLAG_NAME], bool):
            return 'wrong-type-' + SHELLY_1_FLAG_NAME
    return None


def _shelly_read_diagnostic(label, elapsed, reason, http_status=None):
    count = _shelly_diagnostic_failures.get(label, 0)
    if reason is not None:
        count += 1
        _shelly_diagnostic_failures[label] = count
        # Bound output during prolonged outages, but retain the failure count.
        if count == 1 or count % 30 == 0:
            log('SHELLY READ: request={} elapsed_ms={} reason={} http_status={} consecutive_failures={}'.format(
                label, elapsed, reason, http_status, count))
    elif count:
        log('SHELLY READ RECOVERED: request={} elapsed_ms={} preceding_failures={}'.format(
            label, elapsed, count))
        _shelly_diagnostic_failures[label] = 0


def _read_json(url):
    label = ('ShellyEM.status' if url == SHELLY_EM_URL else
             'Shelly1.GetStatus' if url == SHELLY_1_STATUS_URL else
             'Shelly1.GetComponents' if url == SHELLY_1_COMPONENTS_URL else
             'Shelly1.GetComponents(keys)'
             if url.startswith(SHELLY_1_FILTERED_PREFIX) else 'Shelly.read')
    started = time.ticks_ms()
    phase, http_status = 'transport', None
    try:
        r = requests.get(url, timeout=SHELLY_TIMEOUT_S)
        http_status = getattr(r, 'status_code', None)
        phase = 'json-decode'
        data = r.json()
        phase = 'response-close'
        r.close()
    except Exception as error:
        # Do not print arbitrary exception text, response bodies, or URLs.
        errno = getattr(error, 'errno', None)
        if errno is None and error.args and isinstance(error.args[0], int):
            errno = error.args[0]
        reason = '{}:{}:errno={}'.format(phase, type(error).__name__, errno)
        _shelly_read_diagnostic(label, time.ticks_diff(time.ticks_ms(), started), reason, http_status)
        return None
    _shelly_read_diagnostic(label, time.ticks_diff(time.ticks_ms(), started),
                            _shelly_read_reason(url, data), http_status)
    return data


def normalize_shelly_em_status(data):
    """Accept one complete, source-valid Gen-1 EM record or reject all of it."""
    if not isinstance(data, dict):
        return None
    number_fields = ('power', 'reactive', 'pf', 'voltage', 'total', 'total_returned')
    if any(not _is_number(data.get(name)) for name in number_fields):
        return None
    if data.get('is_valid') is not True:
        return None
    if not -1 <= data['pf'] <= 1 or data['voltage'] < 0:
        return None
    return {name: data[name] for name in number_fields + ('is_valid',)}


def read_shelly(read_json=None):
    """Read and validate the complete house-side Gen-1 Shelly EM channel."""
    getter = read_json if callable(read_json) else _read_json
    try:
        response = getter(SHELLY_EM_URL)
    except Exception:
        response = None
    return normalize_shelly_em_status(response)


def normalize_shelly1_status(data):
    """Return strict booleans from the installed Gen4 RPC status."""
    if not isinstance(data, dict):
        return None
    switch0 = data.get('switch:0')
    input0 = data.get('input:0')
    if not isinstance(switch0, dict) or not isinstance(input0, dict):
        return None
    rly0 = switch0.get('output')
    sw0 = input0.get('state')
    if not isinstance(rly0, bool) or not isinstance(sw0, bool):
        return None
    return {'sw0': sw0, 'rly0': rly0}


def _shelly1_component_id(key, prefix):
    """Extract the dynamic numeric id from a component key, or None."""
    if not isinstance(key, str) or not key.startswith(prefix):
        return None
    tail = key[len(prefix):]
    if not tail or not all('0' <= char <= '9' for char in tail):
        return None
    return int(tail)


def _shelly1_lock_value(value):
    return (isinstance(value, int) and not isinstance(value, bool) and
            -1 <= value <= 86400)


def _shelly1_count_value(value):
    return (isinstance(value, int) and not isinstance(value, bool) and
            0 <= value <= 3)


def shelly1_component_routing(data):
    """Resolve the named virtual components to their dynamic ids, by name only.

    The numeric ids are assigned at creation and are not stable across a rebuild,
    so they are discovered every time and never authored. A missing, duplicated or
    malformed match rejects the whole mapping rather than yielding a partial one.
    """
    if not isinstance(data, dict) or not isinstance(data.get('components'), list):
        return None
    wanted = {
        SHELLY_1_LOCK_NAME: ('number:', _shelly1_lock_value),
        SHELLY_1_COUNT_NAME: ('number:', _shelly1_count_value),
        SHELLY_1_FLAG_NAME: ('boolean:', lambda value: isinstance(value, bool)),
    }
    found = {}
    for component in data['components']:
        if not isinstance(component, dict):
            continue
        config = component.get('config')
        status = component.get('status')
        if not isinstance(config, dict) or not isinstance(status, dict):
            continue
        name = config.get('name')
        expected = wanted.get(name)
        if expected is None:
            continue
        prefix, valid = expected
        component_id = _shelly1_component_id(component.get('key'), prefix)
        if component_id is None or not valid(status.get('value')):
            return None  # a malformed declaration is not usable evidence
        if name in found:
            return None  # ambiguous discovery is not usable evidence
        found[name] = component_id
    if len(found) != len(wanted):
        return None
    return found


def shelly1_filtered_keys(routing):
    """Name every component one acquisition needs, static keys included."""
    if not isinstance(routing, dict):
        return None
    try:
        return ['switch:0', 'input:0',
                'number:{}'.format(routing[SHELLY_1_LOCK_NAME]),
                'number:{}'.format(routing[SHELLY_1_COUNT_NAME]),
                'boolean:{}'.format(routing[SHELLY_1_FLAG_NAME])]
    except Exception:
        return None


def _percent_encode_keys(keys):
    """Encode the keys filter as a JSON array without urllib on the device."""
    encoded = '%2C'.join('%22{}%22'.format(key) for key in keys)
    return '%5B{}%5D'.format(encoded)


def shelly1_filtered_url(routing):
    keys = shelly1_filtered_keys(routing)
    if keys is None:
        return None
    return SHELLY_1_FILTERED_URL.format(_percent_encode_keys(keys))


def normalize_shelly1_filtered(data, routing):
    """Accept one filtered reply only when every requested component is present.

    Acceptance is presence-checked rather than derived from `total`, whose meaning
    under a keys filter is not established by a captured response. A short or
    filtered page is therefore never read as valid absence: anything missing
    rejects the acquisition and forces the mapping to be resolved again.
    """
    keys = shelly1_filtered_keys(routing)
    if keys is None or not isinstance(data, dict):
        return None
    components = data.get('components')
    if not isinstance(components, list):
        return None
    by_key = {}
    for component in components:
        if not isinstance(component, dict):
            continue
        key = component.get('key')
        if not isinstance(key, str):
            continue
        if key in by_key:
            return None  # a duplicated key is not usable evidence
        by_key[key] = component
    if any(key not in by_key for key in keys):
        return None  # incomplete page; never interpreted as absence
    switch_status = by_key['switch:0'].get('status')
    input_status = by_key['input:0'].get('status')
    if not isinstance(switch_status, dict) or not isinstance(input_status, dict):
        return None
    rly0 = switch_status.get('output')
    sw0 = input_status.get('state')
    if not isinstance(rly0, bool) or not isinstance(sw0, bool):
        return None
    named = {}
    for name, key, valid in (
            (SHELLY_1_LOCK_NAME, keys[2], _shelly1_lock_value),
            (SHELLY_1_COUNT_NAME, keys[3], _shelly1_count_value),
            (SHELLY_1_FLAG_NAME, keys[4], lambda value: isinstance(value, bool))):
        component = by_key[key]
        config = component.get('config')
        status = component.get('status')
        if not isinstance(config, dict) or not isinstance(status, dict):
            return None
        if config.get('name') != name:
            return None  # the id moved under us; the mapping is obsolete
        value = status.get('value')
        if not valid(value):
            return None
        named[name] = value
    return {
        'sw0': sw0, 'rly0': rly0,
        'is_locked': named[SHELLY_1_LOCK_NAME],
        'lockout_count': named[SHELLY_1_COUNT_NAME],
        'tab5_is_locked': named[SHELLY_1_FLAG_NAME],
        # Dynamic routing travels with the acquisition that proved it, and is kept
        # out of the authored rule values.
        'flag_id': routing[SHELLY_1_FLAG_NAME],
    }


def read_shelly1(read_json=None, routing=None):
    """Acquire one Shelly 1 cycle and return it with the mapping that produced it.

    Steady state is a single filtered request. Discovery is a bounded exception on
    the first cycle and after the mapping is invalidated, never a retry hidden
    inside every cycle. The result is all-or-unavailable; the script's own numbers
    are read and never written.
    """
    getter = read_json if callable(read_json) else _read_json
    attempted_discovery = False
    if not isinstance(routing, dict):
        try:
            discovery = getter(SHELLY_1_COMPONENTS_URL)
        except Exception:
            discovery = None
        routing = shelly1_component_routing(discovery)
        attempted_discovery = True
        if routing is None:
            return None, None
    url = shelly1_filtered_url(routing)
    if url is None:
        return None, None
    try:
        reply = getter(url)
    except Exception:
        reply = None
    if reply is None:
        # A remote failure does not prove the components moved or disappeared, so
        # the mapping is kept and the next cycle costs one request again.
        return None, routing
    record = normalize_shelly1_filtered(reply, routing)
    if record is not None:
        return record, routing
    # The device answered and the answer did not match the mapping: an id moved,
    # a name changed, or the page was incomplete. Discard it so the next cycle
    # rediscovers by name rather than reusing an obsolete route. Discovery is not
    # attempted twice in one cycle.
    return None, (routing if attempted_discovery else None)


def shelly1_restart_request(request_get=None):
    """Issue one supported reboot RPC without retrying an uncertain request."""
    getter = request_get if callable(request_get) else requests.get
    response = None
    try:
        response = getter(SHELLY_1_RESTART_URL, timeout=SHELLY_TIMEOUT_S)
        status_code = getattr(response, 'status_code', None)
        if not isinstance(status_code, int) or not 200 <= status_code < 300:
            return 'failed', 'shelly-restart-http-error'
        body = response.json()
        if not isinstance(body, dict) or body.get('error') is not None:
            return 'failed', 'shelly-restart-rpc-error'
        return 'accepted', 'shelly-restart-acknowledged'
    except Exception:
        # A transport timeout can occur after the device accepted the reboot.
        # Never turn that ambiguity into an automatic second reboot.
        return 'unknown', 'shelly-restart-outcome-unknown'
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def operator_command_execution_decision(command, session_id, utc_ms,
                                        clock_synced, last_command_sequence=0,
                                        last_command_id=None):
    """Enforce identity, session, expiry, and monotonic sequence at execution."""
    if not isinstance(command, dict):
        return 'not-delivered', 'invalid-command'
    if command.get('targetSessionId') != session_id:
        return 'not-delivered', 'old-session'
    if command.get('commandId') == last_command_id:
        return 'not-delivered', 'duplicate-command'
    sequence = command.get('commandSequence')
    if (not isinstance(sequence, int) or isinstance(sequence, bool) or
            sequence < 1):
        return 'not-delivered', 'invalid-command-sequence'
    if sequence <= last_command_sequence:
        return 'not-delivered', 'stale-command-sequence'
    if clock_synced is not True or not isinstance(utc_ms, int):
        return 'not-delivered', 'clock-not-synchronized'
    requested = command.get('requestedAtMs')
    expires = command.get('expiresAtMs')
    if (not isinstance(requested, int) or isinstance(requested, bool) or
            not isinstance(expires, int) or isinstance(expires, bool) or
            expires - requested != OPERATOR_COMMAND_LIFETIME_MS):
        return 'not-delivered', 'invalid-expiry'
    if utc_ms < requested - 5000:
        return 'not-delivered', 'command-from-future'
    if utc_ms > expires:
        return 'not-delivered', 'command-expired'
    return 'accepted', 'execution-boundary-accepted'


def operator_result(command, session_id, outcome, detail_code,
                    relay_restoration='not-applicable'):
    """Build the closed mirrored result; CPU B supplies server receipt time."""
    return {
        'schemaVersion': 1,
        'kind': 'operator-command-result',
        'commandId': command.get('commandId'),
        'commandSequence': command.get('commandSequence'),
        'siteId': SITE_ID,
        'deviceId': DEVICE_ID,
        'targetSessionId': command.get('targetSessionId'),
        'reportingSessionId': session_id,
        'commandType': command.get('commandType'),
        'outcome': outcome,
        'detailCode': detail_code,
        'reportedAtMs': 0,
        'relayRestoration': relay_restoration,
    }


def operator_monitor_occurrence_field(resolved):
    """Find the deliberate manual Monitor event without assuming its ID/name."""
    if not isinstance(resolved, dict):
        return None
    mode_target = resolved.get('operatingModeTarget')
    for event in resolved.get('events', []):
        trigger = event.get('opening', {}).get('trigger', {})
        assignments = event.get('onOpen', {}).get('assignments', [])
        selects_monitor = any(
            item.get('target') == mode_target and item.get('value') == 'Monitor' and
            item.get('ownership') == 'whileOpen'
            for item in assignments if isinstance(item, dict))
        if (event.get('enabled') is True and event.get('eventClass') == 'monitor' and
                trigger.get('type') == 'manual' and selects_monitor and
                event.get('closing', {}).get('policy') == 'clearEvents'):
            return trigger.get('occurrenceField')
    return None


def operator_monitor_event_id(resolved):
    """Identify the manual Monitor event itself, not merely its occurrence."""
    if not isinstance(resolved, dict):
        return None
    mode_target = resolved.get('operatingModeTarget')
    for event in resolved.get('events', []):
        trigger = event.get('opening', {}).get('trigger', {})
        assignments = event.get('onOpen', {}).get('assignments', [])
        selects_monitor = any(
            item.get('target') == mode_target and item.get('value') == 'Monitor' and
            item.get('ownership') == 'whileOpen'
            for item in assignments if isinstance(item, dict))
        if (event.get('enabled') is True and event.get('eventClass') == 'monitor' and
                trigger.get('type') == 'manual' and selects_monitor and
                event.get('closing', {}).get('policy') == 'clearEvents'):
            return event.get('id')
    return None


def user_monitor_instance(runtime, event_id):
    """Return the live instance of the user's Monitor event, or None.

    Ties a user command to the occurrence it actually opened. System Monitor
    engaging the same mode is a different event and never satisfies this.
    """
    if not isinstance(runtime, dict) or not isinstance(event_id, str):
        return None
    state = runtime.get('kernel', {}).get('events', {}).get(event_id)
    if not isinstance(state, dict) or state.get('active') is not True:
        return None
    return state.get('instanceId')


def shelly_restart_confirmation(pending, observation_sequence, now_ticks_ms,
                                shelly_available, reported_lock):
    """Confirm only from a later fresh lock read; otherwise bound ambiguity."""
    if not isinstance(pending, dict):
        return None
    if (observation_sequence > pending.get('acceptedSequence', observation_sequence) and
            shelly_available is True):
        if reported_lock == 0:
            return 'confirmed-completed', 'fresh-islocked-zero'
        if (isinstance(reported_lock, int) and not isinstance(reported_lock, bool) and
                (reported_lock == -1 or reported_lock > 0)):
            return 'failed', 'fresh-lockout-remains'
        return 'unknown', 'fresh-lock-evidence-invalid'
    started = pending.get('startedTicksMs')
    if (isinstance(started, int) and isinstance(now_ticks_ms, int) and
            time.ticks_diff(now_ticks_ms, started) >= SHELLY_RESTART_CONFIRM_MS):
        return 'unknown', 'fresh-lock-evidence-timeout'
    return None


def _utc_tuple_epoch_ms(value):
    """Convert SNTP UTC calendar fields without assuming MicroPython's epoch."""
    if not isinstance(value, (tuple, list)) or len(value) < 6:
        return None
    year, month, day, hour, minute, second = value[:6]
    if (not all(isinstance(item, int) for item in value[:6]) or
            not 1970 <= year <= 2200 or not 1 <= month <= 12 or
            not 1 <= day <= 31 or not 0 <= hour <= 23 or
            not 0 <= minute <= 59 or not 0 <= second <= 60):
        return None
    def leap(candidate):
        return candidate % 4 == 0 and (
            candidate % 100 != 0 or candidate % 400 == 0)
    month_days = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if day > month_days[month - 1] + (1 if month == 2 and leap(year) else 0):
        return None
    days = 0
    for candidate in range(1970, year):
        days += 366 if leap(candidate) else 365
    for candidate in range(1, month):
        days += month_days[candidate - 1]
        if candidate == 2 and leap(year):
            days += 1
    days += day - 1
    return (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000


def utc_epoch_ms(clock_synced):
    if clock_synced is not True:
        return None
    try:
        return _utc_tuple_epoch_ms(time.localtime())
    except Exception:
        return None


def format_observed_at(clock_is_synced):
    """Return the CPU A sample time in UTC, or None before SNTP is valid."""
    if not clock_is_synced:
        return None
    try:
        t = time.localtime()
        return '{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z'.format(
            t[0], t[1], t[2], t[3], t[4], t[5])
    except Exception:
        return None


def sample_age_ms(reference_ticks_ms, sample_ticks_ms):
    """Return a nonnegative within-session age using MicroPython tick math."""
    if sample_ticks_ms is None:
        return None
    return max(0, time.ticks_diff(reference_ticks_ms, sample_ticks_ms))


def build_observation(sequence, observed_ticks_ms, clock_is_synced, shelly,
                      shelly_is_available, shelly_poll_was_attempted,
                      shelly_last_valid_ticks_ms,
                      adc_last_valid_ticks_ms,
                      battery_voltage, battery_current,
                      battery_percent, battery_is_charging, battery_is_valid,
                      battery_charge_is_enabled, battery_sample_ticks_ms,
                      wifi_is_connected, traffic_is_allowed, wifi_status,
                      wifi_address, wifi_disconnect_count, shelly_failures,
                      shelly1=None, shelly1_is_available=False,
                      shelly1_poll_was_attempted=False,
                      shelly1_last_valid_ticks_ms=None,
                      shelly1_failures=0, ads_raw_count=None,
                      acquisition_begun=True):
    """Build the variable-sized record whose ownership transfers to CPU B."""
    return {
        'schemaVersion': 1,
        'sequence': sequence,
        'observedTicksMs': observed_ticks_ms,
        'observedAt': format_observed_at(clock_is_synced),
        'source': 'tab5',
        'values': {
            # Preserve the complete Gen-1 Shelly EM source record unchanged.
            # The units of total and total_returned remain source-native until
            # they are independently confirmed.
            'power': shelly.get('power'),
            'reactive': shelly.get('reactive'),
            'pf': shelly.get('pf'),
            'voltage': shelly.get('voltage'),
            'is_valid': shelly.get('is_valid'),
            'total': shelly.get('total'),
            'total_returned': shelly.get('total_returned'),
            # Native filtered ADC counts, and the only ADC representation.
            # A microvolt field was published alongside this until M6.40; it was
            # converted straight back to counts by every consumer, so it was a
            # lossy intermediate that existed only to be undone.
            'adc_raw': ads_raw_count,
            # Preserve the M6.17 end-to-end calculation as separate evidence.
            # pressure_valid below prevents an uncommissioned input from being
            # presented as an operational measurement.
            'pressure_psi': calibrated_psi_from_raw_count(ads_raw_count),
            'battery_voltage': battery_voltage,
            'battery_current': battery_current,
            'battery_percent': battery_percent,
            'battery_charging': battery_is_charging,
            'battery_charge_enabled': battery_charge_is_enabled,
            'shelly1_sw0': shelly1.get('sw0') if isinstance(shelly1, dict) else None,
            'shelly1_rly0': shelly1.get('rly0') if isinstance(shelly1, dict) else None,
            'shelly1_lock': (shelly1.get('is_locked')
                             if isinstance(shelly1, dict) else None),
            'shelly1_lockout_count': (shelly1.get('lockout_count')
                                      if isinstance(shelly1, dict) else None),
            'shelly1_tab5lock': (shelly1.get('tab5_is_locked')
                                 if isinstance(shelly1, dict) else None),
        },
        'status': {
            'shelly_available': shelly_is_available,
            # Latched once the first acquisition attempt is permitted, and never
            # cleared. Distinct from shelly_poll_attempted, which is per cycle:
            # this says whether ANY attempt has yet been allowed to happen.
            'acquisition_begun': acquisition_begun,
            'shelly_poll_attempted': shelly_poll_was_attempted,
            'shelly_last_valid_ticks_ms': shelly_last_valid_ticks_ms,
            'shelly_age_ms': sample_age_ms(
                observed_ticks_ms, shelly_last_valid_ticks_ms),
            'adc_available': ads_raw_count is not None,
            'adc_last_valid_ticks_ms': adc_last_valid_ticks_ms,
            'adc_age_ms': sample_age_ms(
                observed_ticks_ms, adc_last_valid_ticks_ms),
            'pressure_sensor_commissioned': PRESSURE_SENSOR_COMMISSIONED,
            'pressure_valid': (PRESSURE_SENSOR_COMMISSIONED and
                               ads_raw_count is not None),
            'battery_available': battery_is_valid,
            'battery_sample_ticks_ms': battery_sample_ticks_ms,
            'shelly_failure_count': shelly_failures,
            'shelly1_available': shelly1_is_available,
            'shelly1_poll_attempted': shelly1_poll_was_attempted,
            'shelly1_last_valid_ticks_ms': shelly1_last_valid_ticks_ms,
            'shelly1_age_ms': sample_age_ms(
                observed_ticks_ms, shelly1_last_valid_ticks_ms),
            'shelly1_failure_count': shelly1_failures,
            # Dispatch routing proved by this acquisition, never an authored value.
            'shelly1_tab5lock_id': (shelly1.get('flag_id')
                                    if isinstance(shelly1, dict) else None),
            'wifi_connected': wifi_is_connected,
            'network_traffic_allowed': traffic_is_allowed,
            'clock_synced': clock_is_synced,
            'wifi_driver_status': wifi_status,
            'wifi_ip': wifi_address,
            'wifi_disconnect_count': wifi_disconnect_count,
        },
    }


def add_transport_evidence(observation, transport_status, current_ticks_ms):
    """Add only measured CPU-B queue/result evidence needed by the V3 package."""
    if not isinstance(observation, dict) or not isinstance(transport_status, dict):
        return observation
    status = observation.get('status')
    if not isinstance(status, dict):
        return observation
    depth = transport_status.get('durableQueueDepth')
    capacity = transport_status.get('durableQueueCapacity')
    lost = transport_status.get('durableRecordsLost')
    if (isinstance(depth, int) and not isinstance(depth, bool) and depth >= 0 and
            isinstance(capacity, int) and not isinstance(capacity, bool) and capacity > 0 and
            depth <= capacity):
        status['buffer_used_pct'] = (100.0 * depth) / capacity
    if isinstance(lost, int) and not isinstance(lost, bool) and lost >= 0:
        status['records_lost'] = lost
    telemetry_ok = transport_status.get('telemetryLastAttemptOk')
    rtdb_ok = transport_status.get('rtdbLastAttemptOk')
    if isinstance(telemetry_ok, bool) and isinstance(rtdb_ok, bool):
        telemetry_age = transport_age_ms(
            transport_status, 'telemetryLastSuccessTicksMs', current_ticks_ms)
        rtdb_age = transport_age_ms(
            transport_status, 'rtdbLastSuccessTicksMs', current_ticks_ms)
        status['cloud_available'] = (
            telemetry_ok and rtdb_ok and _is_number(telemetry_age) and
            telemetry_age <= CLOUD_TELEMETRY_FRESH_MS and _is_number(rtdb_age) and
            rtdb_age <= CLOUD_RTDB_FRESH_MS)
    return observation


def new_event_history(depth=EVENT_HISTORY_DEPTH):
    """Allocate the bounded CPU A RAM loop used by later event evaluation."""
    if not isinstance(depth, int) or isinstance(depth, bool) or depth < 1:
        raise ValueError('event history depth must be positive')
    return {
        'samples': [None] * depth,
        'nextIndex': 0,
        'count': 0,
    }


def append_event_history(history, observation):
    """Retain a complete matched sample separately from durable selection."""
    samples = history['samples']
    index = history['nextIndex']
    samples[index] = observation
    history['nextIndex'] = (index + 1) % len(samples)
    if history['count'] < len(samples):
        history['count'] += 1


def event_history_values(history):
    """Return retained samples oldest-first for host tests and future M7 use."""
    count = history['count']
    samples = history['samples']
    start = (history['nextIndex'] - count) % len(samples)
    return [samples[(start + offset) % len(samples)] for offset in range(count)]


RUNTIME_OBJECT_PATHS = {
    'shelly-gen1-em': {
        'emeter/0.power': 'values.power', 'emeter/0.voltage': 'values.voltage',
        'emeter/0.pf': 'values.pf', 'emeter/0.total': 'values.total',
        '$availability': 'status.shelly_available',
    },
    'shelly-gen4-switch': {
        'SW(0)': 'values.shelly1_sw0', 'RLY(0)': 'values.shelly1_rly0',
        'UDF(IsLocked)': 'values.shelly1_lock',
        'UDF(Tab5IsLocked)': 'values.shelly1_tab5lock',
        '$availability': 'status.shelly1_available',
    },
}


def runtime_observation_path_value(observation, path):
    value = observation
    for part in path.split('.'):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def runtime_direct_field_values(package, observation):
    """Resolve the fixed catalog into named values without device I/O."""
    values = {}
    if not isinstance(package, dict) or not isinstance(observation, dict):
        return values
    for device in package.get('devices', []):
        if not isinstance(device, dict):
            continue
        driver = device.get('driver')
        for field in device.get('fields', []):
            if not isinstance(field, dict):
                continue
            system_name = field.get('systemName')
            object_name = field.get('object')
            if not isinstance(system_name, str):
                continue
            if driver == 'tab5-runtime':
                path = object_name
            else:
                path = RUNTIME_OBJECT_PATHS.get(driver, {}).get(object_name)
            values[system_name] = (runtime_observation_path_value(observation, path)
                                   if isinstance(path, str) else None)
    return values


def _finite_number(value):
    """Recognize finite Python/MicroPython numbers without requiring math.isfinite."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        # NaN is unequal to itself; either infinity minus itself is NaN.
        return value == value and value - value == 0
    except Exception:
        return False


def _runtime_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return value == value and value - value == 0
    except Exception:
        return False


def evaluate_runtime_program(program, named_values):
    """Evaluate the web-compiled postfix arithmetic subset with bounded RAM."""
    if not isinstance(program, list) or len(program) > 128 or not isinstance(named_values, dict):
        return None
    stack = []
    for instruction in program:
        if not isinstance(instruction, list) or len(instruction) != 2:
            return None
        kind, value = instruction
        if kind == 'number':
            if not _runtime_number(value):
                return None
            stack.append(value)
        elif kind == 'field':
            value = named_values.get(value)
            if not _runtime_number(value):
                return None
            stack.append(value)
        elif kind == 'operator':
            try:
                if value == 'neg':
                    if not stack:
                        return None
                    stack[-1] = -stack[-1]
                    continue
                if len(stack) < 2:
                    return None
                right = stack.pop()
                left = stack.pop()
                if value == '+':
                    stack.append(left + right)
                elif value == '-':
                    stack.append(left - right)
                elif value == '*':
                    stack.append(left * right)
                elif value == '/':
                    if right == 0:
                        return None
                    stack.append(left / right)
                else:
                    return None
            except Exception:
                return None
        else:
            return None
        if len(stack) > 64:
            return None
    return stack[0] if len(stack) == 1 and _runtime_number(stack[0]) else None


def evaluate_runtime_calculations(package, named_values):
    """Run only compiled expressions; function models remain explicit TBDs."""
    if not isinstance(package, dict) or not isinstance(named_values, dict):
        return named_values
    for calculation in package.get('calculations', []):
        if not isinstance(calculation, dict):
            continue
        if calculation.get('kind') == 'expression':
            output = calculation.get('output')
            if isinstance(output, dict) and isinstance(output.get('systemName'), str):
                named_values[output['systemName']] = evaluate_runtime_program(
                    calculation.get('program'), named_values)
        elif calculation.get('kind') == 'function':
            # The web compiler permits Boyle tank calculations, but its time
            # window and quality semantics are a later bounded CPU-A unit.
            for output in calculation.get('outputs', []):
                if isinstance(output, dict) and isinstance(output.get('systemName'), str):
                    named_values[output['systemName']] = None
    return named_values


def runtime_logging_policies(package):
    """Return every V3 field logging policy and its stable field metadata."""
    policies = {}
    if not isinstance(package, dict):
        return policies
    for device in package.get('devices', []):
        if not isinstance(device, dict):
            continue
        for field in device.get('fields', []):
            if isinstance(field, dict) and isinstance(field.get('systemName'), str):
                logging = field.get('logging')
                if isinstance(logging, dict):
                    policy = dict(logging)
                    policy.update({'fieldKind': 'Device', 'type': field.get('type')})
                    policies[field['systemName']] = policy
    for calculation in package.get('calculations', []):
        if not isinstance(calculation, dict):
            continue
        outputs = ([calculation.get('output')] if isinstance(calculation.get('output'), dict)
                   else calculation.get('outputs', []))
        for output in outputs:
            if isinstance(output, dict) and isinstance(output.get('systemName'), str):
                logging = output.get('logging')
                if isinstance(logging, dict):
                    policy = dict(logging)
                    policy.update({'fieldKind': 'Calculated', 'type': output.get('type')})
                    policies[output['systemName']] = policy
    for field in package.get('systemFields', []):
        if isinstance(field, dict) and isinstance(field.get('systemName'), str):
            logging = field.get('logging')
            if isinstance(logging, dict):
                policy = dict(logging)
                policy.update({'fieldKind': 'System', 'type': field.get('type')})
                policies[field['systemName']] = policy
    return policies


def durable_field_states(snapshot, policies, unavailable_reason='source-unavailable'):
    """Project the package-fixed logging-enabled field set from frozen evidence."""
    if not isinstance(snapshot, dict) or not isinstance(policies, dict):
        return None
    fields = {}
    for name, policy in policies.items():
        if not isinstance(name, str) or not isinstance(policy, dict):
            return None
        mode = policy.get('mode')
        if mode == 'none':
            continue
        if mode not in ('always', 'change', 'delta'):
            return None
        value = snapshot.get(name)
        if value is None or (isinstance(value, (int, float)) and
                             not isinstance(value, bool) and not _runtime_number(value)):
            fields[name] = {'state': 'unavailable', 'reason': unavailable_reason}
        else:
            fields[name] = {'state': 'available', 'value': value}
    return fields


def durable_trigger_reasons(fields, baselines, policies):
    """Select change/delta reasons against last admitted available values."""
    if not all(isinstance(item, dict) for item in (fields, baselines, policies)):
        return []
    reasons = []
    for name, field in fields.items():
        policy = policies.get(name, {})
        if field.get('state') != 'available' or name not in baselines:
            continue
        current = field.get('value')
        previous = baselines.get(name)
        mode = policy.get('mode')
        if mode == 'change' and current != previous:
            reasons.append({'kind': 'change', 'field': name,
                            'from': previous, 'to': current})
        elif mode == 'delta':
            threshold = policy.get('threshold')
            if (_runtime_number(current) and _runtime_number(previous) and
                    _runtime_number(threshold) and threshold > 0 and
                    abs(current - previous) >= threshold):
                reasons.append({'kind': 'delta', 'field': name,
                                'from': previous, 'to': current,
                                'threshold': threshold})
    return reasons


def event_boundary_reasons(records):
    reasons = []
    for record in records if isinstance(records, list) else ():
        if (isinstance(record, dict) and record.get('type') in ('open', 'close') and
                isinstance(record.get('eventId'), str) and
                isinstance(record.get('eventInstanceId'), str)):
            reasons.append({
                'kind': 'event-boundary', 'transition': record['type'],
                'eventKey': record['eventId'],
                'occurrenceId': record['eventInstanceId'],
            })
    return reasons


def admitted_durable_baselines(fields, previous=None):
    """Advance only available values after CPU B admits the encoded record."""
    baselines = dict(previous) if isinstance(previous, dict) else {}
    for name, field in fields.items() if isinstance(fields, dict) else ():
        if isinstance(field, dict) and field.get('state') == 'available':
            baselines[name] = field.get('value')
    return baselines


def runtime_logging_change_details(values, previous_values, policies):
    """Name v2 logging-policy changes; unavailable samples never fabricate edges."""
    if not isinstance(values, dict) or not isinstance(previous_values, dict) or not isinstance(policies, dict):
        return []
    details = []
    for name, logging in policies.items():
        if not isinstance(name, str) or not isinstance(logging, dict):
            continue
        current = values.get(name)
        previous = previous_values.get(name)
        if current is None or previous is None:
            continue
        mode = logging.get('mode')
        changed = (mode == 'change' and current != previous)
        if mode == 'delta':
            threshold = logging.get('threshold')
            changed = (_runtime_number(current) and _runtime_number(previous) and
                       _runtime_number(threshold) and threshold >= 0 and
                       abs(current - previous) >= threshold)
        if changed:
            details.append('{}: {} -> {}'.format(name, previous, current))
    return details


def runtime_stop_only_action(event):
    """Accept exactly one reviewed rules consequence; never accept an ON write."""
    if not isinstance(event, dict) or event.get('enabled') is not True:
        return False
    actions = event.get('actions')
    if not isinstance(actions, list) or len(actions) != 1:
        return False
    action = actions[0]
    return (isinstance(action, dict) and action.get('target') == 'PumpEnable' and
            action.get('value') is False and len(action) == 2)


def issue_runtime_stop(observation):
    """Request the installed Shelly STOP state; a later poll confirms it."""
    if not isinstance(observation, dict):
        return 'invalid-observation'
    status = observation.get('status', {})
    values = observation.get('values', {})
    if status.get('shelly1_available') is not True:
        return 'shelly-unavailable'
    if values.get('shelly1_rly0') is not True:
        return 'already-off'
    try:
        # The installed UIFlow requests client has been proven with GET-only
        # Shelly RPC/status calls. Shelly RPC accepts this idempotent command
        # as a query URL, avoiding an unproven requests.post code path.
        reply = requests.get(SHELLY_1_STOP_URL, timeout=SHELLY_TIMEOUT_S)
        data = reply.json()
        reply.close()
        return 'requested' if isinstance(data, dict) else 'invalid-response'
    except Exception as error:
        return 'request-failed:{}'.format(error)


def _issue_boolean_set(observation, value):
    """Write Tab5's inhibition flag using the id this acquisition proved.

    No readback and no same-cycle retry: a later cycle reconciles. The device is
    asked over the GET-style RPC the installed requests client is proven with.
    """
    status = observation.get('status', {})
    values = observation.get('values', {})
    if status.get('shelly1_available') is not True:
        return 'shelly-unavailable'
    observed = values.get('shelly1_tab5lock')
    if not isinstance(observed, bool):
        return 'flag-evidence-unavailable'
    if observed is value:
        return 'observed-desired-state'
    component_id = status.get('shelly1_tab5lock_id')
    if not isinstance(component_id, int) or isinstance(component_id, bool):
        return 'flag-routing-unavailable'
    url = SHELLY_1_BOOLEAN_SET_URL.format(
        component_id, 'true' if value else 'false')
    reply = None
    try:
        reply = requests.get(url, timeout=SHELLY_TIMEOUT_S)
        status_code = getattr(reply, 'status_code', None)
        if not isinstance(status_code, int) or status_code != 200:
            return 'rpc-http-error'
        body = reply.json()
        # The supported HTTP GET form answers a bare JSON null for this method.
        # Nothing else is accepted as success: not {}, not an arbitrary error-free
        # object, not an invented envelope.
        if body is not None:
            return 'rpc-error' if isinstance(body, dict) and (
                'error' in body or 'code' in body) else 'invalid-response'
        return 'acknowledged'
    except Exception as error:
        return 'request-failed:{}'.format(error)
    finally:
        if reply is not None:
            try:
                reply.close()
            except Exception:
                pass


def issue_rules_v3_action(resolved, action, observation):
    """Issue one kernel-selected write to the installed Shelly (GET-only RPC).

    Acknowledgement means only that the request was accepted. It is never evidence
    that the flag now reads back, nor that RLY0 moved.
    """
    target = action.get('target')
    value = action.get('value')
    spec = resolved.get('writableTargets', {}).get(target)
    if not isinstance(spec, dict):
        return 'no-write-definition'
    if not isinstance(value, bool):
        return 'unsupported-value:{}'.format(value)
    method = spec.get('method')
    if method == 'Boolean.Set':
        if target != resolved.get('inhibitionTarget'):
            return 'unsupported-boolean-target'
        return _issue_boolean_set(observation, value)
    if method != 'Switch.Set':
        return 'unsupported-method:{}'.format(method)
    # Retained compatibility path. No accepted package can reach it: the runtime
    # support gate rejects RLY(0) as readWrite, so no relay write is authored.
    if observation.get('status', {}).get('shelly1_available') is not True:
        return 'shelly-unavailable'
    observed = observation.get('values', {}).get('shelly1_rly0')
    if isinstance(observed, bool) and observed is value:
        return 'observed-desired-state'
    if value is True and observation.get('values', {}).get('shelly1_lock') != 0:
        return 'lock-evidence-unavailable-or-locked'
    switch_id = spec.get('parameters', {}).get('id', 0)
    url = SHELLY_1_SWITCH_URL.format(switch_id, 'true' if value else 'false')
    try:
        reply = requests.get(url, timeout=SHELLY_TIMEOUT_S)
        data = reply.json()
        reply.close()
        if not isinstance(data, dict):
            return 'invalid-response'
        if 'error' in data or ('code' in data and 'message' in data):
            return 'rpc-error'
        result = data.get('result', data)
        return ('acknowledged' if isinstance(result, dict) and
                isinstance(result.get('was_on'), bool) else 'invalid-response')
    except Exception as error:
        return 'request-failed:{}'.format(error)


def rules_v3_field_values(resolved, observation):
    """Resolve declared V3 device fields from the complete observation."""
    values = {}
    for device_id, device in resolved.get('devices', {}).items():
        if device.get('enabled') is not True:
            continue
        driver = device.get('driver')
        for field in device.get('fields', []):
            name = field.get('systemName')
            if driver == 'tab5-runtime':
                path = field.get('object')
            else:
                path = RUNTIME_OBJECT_PATHS.get(driver, {}).get(field.get('object'))
            values[name] = (runtime_observation_path_value(observation, path)
                            if isinstance(path, str) else None)
    return values


def rules_v3_collapse_actions(resolved, actions):
    """One write per target per cycle; a disabling write wins any conflict."""
    chosen = {}
    dropped = []
    for action in actions:
        target = action.get('target')
        existing = chosen.get(target)
        if existing is None:
            chosen[target] = action
            continue
        normal = resolved.get('writableTargets', {}).get(target, {}).get('normalValue')
        if existing.get('value') != normal and action.get('value') == normal:
            dropped.append(action)
        elif existing.get('value') == normal and action.get('value') != normal:
            dropped.append(existing)
            chosen[target] = action
        else:
            dropped.append(action)
    return list(chosen.values()), dropped


def dispatch_rules_v3_actions(resolved, actions, observation):
    """Dispatch at most one write per target using this cycle's observed state."""
    selected, dropped = rules_v3_collapse_actions(resolved, actions)
    results = []
    for action in selected:
        results.append({
            'action': action,
            'outcome': issue_rules_v3_action(resolved, action, observation),
        })
    return results, dropped


def rules_v3_relay_diagnostic(runtime, observation, actions):
    """Observe the existing kernel and snapshot decisions; create no action."""
    resolved, kernel = runtime['resolved'], runtime['kernel']
    target = resolved.get('inhibitionTarget') or resolved.get('pumpTarget')
    values = observation.get('values', {})
    available = observation.get('status', {}).get('shelly1_available') is True
    held = target is not None and _rules_v3_has_owner(kernel, target)
    selected = tuple((item.get('value'), item.get('reason')) for item in actions
                     if item.get('target') == target)
    return (held, available, values.get('shelly1_rly0'),
            values.get('shelly1_tab5lock'), values.get('shelly1_lock'), selected)


def runtime_condition_value(condition, fields):
    """Return True, False, or None when a required field is unavailable."""
    if not isinstance(condition, dict) or not isinstance(fields, dict):
        return None
    clauses = condition.get('clauses')
    if condition.get('mode') not in ('all', 'any') or not isinstance(clauses, list) or not clauses:
        return None
    results = []
    for clause in clauses:
        if not isinstance(clause, dict):
            return None
        current = fields.get(clause.get('field'))
        expected = clause.get('value')
        operator = clause.get('operator')
        if current is None:
            return None
        if operator == 'eq':
            result = current == expected
        elif operator == 'neq':
            result = current != expected
        elif not (_runtime_number(current) and _runtime_number(expected)):
            return None
        elif operator == 'lt':
            result = current < expected
        elif operator == 'lte':
            result = current <= expected
        elif operator == 'gt':
            result = current > expected
        elif operator == 'gte':
            result = current >= expected
        elif operator in ('between', 'outside'):
            if (not isinstance(expected, list) or len(expected) != 2 or
                    not _runtime_number(expected[0]) or not _runtime_number(expected[1])):
                return None
            inside = expected[0] <= current <= expected[1]
            result = inside if operator == 'between' else not inside
        else:
            # Transition and signal operators require a later history-aware
            # evaluator. They are never fabricated into a true condition.
            return None
        results.append(result)
    return all(results) if condition.get('mode') == 'all' else any(results)


def new_runtime_event_state(event_id):
    return {
        'eventId': event_id, 'active': False, 'openCount': 0,
        'openSinceMs': None, 'closeCount': 0, 'closeSinceMs': None,
    }


def _runtime_qualified(count, since_ms, condition, now_ms):
    if not isinstance(condition, dict):
        return False
    observations = condition.get('observationCount')
    seconds = condition.get('minimumSeconds')
    if (not isinstance(observations, int) or observations < 1 or
            not _runtime_number(seconds) or seconds < 0):
        return False
    return count >= observations and since_ms is not None and (
        now_ms - since_ms >= int(seconds * 1000))


def advance_runtime_event(event, state, open_result, close_result, now_ms):
    """Advance one v2 event without generating a control request or I/O."""
    if (not isinstance(event, dict) or not isinstance(state, dict) or
            not isinstance(event.get('id'), str) or state.get('eventId') != event['id'] or
            not isinstance(now_ms, int) or isinstance(now_ms, bool)):
        raise ValueError('invalid runtime event input')
    next_state = dict(state)
    if event.get('enabled') is not True:
        transition = ({'type': 'close', 'reason': 'rules_sync', 'eventId': event['id']}
                      if next_state.get('active') is True else None)
        return new_runtime_event_state(event['id']), transition
    if open_result is None:
        next_state['openCount'] = 0
        next_state['openSinceMs'] = None
    elif open_result:
        if next_state['openCount'] == 0:
            next_state['openSinceMs'] = now_ms
        next_state['openCount'] += 1
    else:
        next_state['openCount'] = 0
        next_state['openSinceMs'] = None
    if not next_state.get('active'):
        if open_result is True and _runtime_qualified(
                next_state['openCount'], next_state['openSinceMs'], event.get('open'), now_ms):
            next_state['active'] = True
            next_state['closeCount'] = 0
            next_state['closeSinceMs'] = None
            return next_state, {'type': 'open', 'reason': 'condition_confirmed', 'eventId': event['id']}
        return next_state, None
    if event.get('latched') is True or close_result is None:
        next_state['closeCount'] = 0
        next_state['closeSinceMs'] = None
        return next_state, None
    if close_result:
        if next_state['closeCount'] == 0:
            next_state['closeSinceMs'] = now_ms
        next_state['closeCount'] += 1
        if _runtime_qualified(next_state['closeCount'], next_state['closeSinceMs'],
                              event.get('close'), now_ms):
            return new_runtime_event_state(event['id']), {
                'type': 'close', 'reason': 'condition_cleared', 'eventId': event['id']}
    else:
        next_state['closeCount'] = 0
        next_state['closeSinceMs'] = None
    return next_state, None


def evaluate_runtime_events(package, event_board, fields, now_ms):
    """Evaluate v2 events locally; action lists are intentionally ignored."""
    board = event_board if isinstance(event_board, dict) else {}
    next_board = {}
    transitions = []
    events = package.get('events') if isinstance(package, dict) else []
    for event in events if isinstance(events, list) else []:
        if not isinstance(event, dict) or not isinstance(event.get('id'), str):
            continue
        previous = board.get(event['id'])
        if not isinstance(previous, dict):
            previous = new_runtime_event_state(event['id'])
        open_result = runtime_condition_value(event.get('open'), fields)
        if event.get('close', {}).get('basis') == 'openingFalse':
            close_result = None if open_result is None else not open_result
        else:
            close_result = runtime_condition_value(event.get('close'), fields)
        current, transition = advance_runtime_event(
            event, previous, open_result, close_result, now_ms)
        next_board[event['id']] = current
        if transition is not None:
            transitions.append(transition)
    # A new package or deleted event cannot inherit an open event state.
    for event_id, previous in board.items():
        if event_id not in next_board and isinstance(previous, dict) and previous.get('active') is True:
            transitions.append({'type': 'close', 'reason': 'rules_sync', 'eventId': event_id})
    return next_board, transitions


def clear_runtime_event_board(event_board):
    transitions = []
    if isinstance(event_board, dict):
        for event_id, state in event_board.items():
            if isinstance(state, dict) and state.get('active') is True:
                transitions.append({'type': 'close', 'reason': 'rules_sync', 'eventId': event_id})
    return {}, transitions


def new_rule_event_state(rule_id):
    """Allocate one volatile CPU A lifecycle state; no consequence exists."""
    if not isinstance(rule_id, str) or not rule_id:
        raise ValueError('event rule id is required')
    return {
        'ruleId': rule_id,
        'phase': 'inactive',
        'active': False,
        'conditionActive': False,
        'confirmSinceMs': None,
        'clearSinceMs': None,
        'openedAtMs': None,
    }


def _event_rule_latched(rule):
    return (isinstance(rule, dict) and
            rule.get('response') == 'Trip—latched/manual reset')


def _valid_event_rule_timing(rule):
    if not isinstance(rule, dict):
        return False
    for name in ('confirmSeconds', 'clearSeconds'):
        value = rule.get(name)
        if (not isinstance(value, int) or isinstance(value, bool) or
                value < 1):
            return False
    return (isinstance(rule.get('id'), str) and bool(rule.get('id')) and
            isinstance(rule.get('enabled'), bool))


def advance_rule_event(rule, state, condition_result, now_ms):
    """Advance qualification/clear timing without evaluating or controlling.

    ``condition_result`` is deliberately supplied by a later condition layer:
    True and False are qualified evidence; None is unavailable evidence. The
    function returns a copied state and at most one ``open`` or ``close``
    transition. It never writes flash, submits cloud data, or drives a relay.
    """
    if (not _valid_event_rule_timing(rule) or not isinstance(state, dict) or
            state.get('ruleId') != rule.get('id') or
            not isinstance(now_ms, int) or isinstance(now_ms, bool) or
            (condition_result is not True and condition_result is not False and
             condition_result is not None)):
        raise ValueError('invalid event lifecycle input')
    next_state = dict(state)
    transition = None

    if rule.get('enabled') is not True:
        if next_state.get('active') is True:
            transition = {'type': 'close', 'reason': 'rules_updated'}
        return new_rule_event_state(rule['id']), transition

    phase = next_state.get('phase')
    if phase not in ('inactive', 'confirming', 'active', 'clearing', 'latched'):
        raise ValueError('invalid event lifecycle phase')

    if condition_result is None:
        next_state['conditionActive'] = None
        if phase == 'confirming':
            next_state.update({
                'phase': 'inactive',
                'confirmSinceMs': None,
            })
        elif phase == 'clearing':
            next_state.update({
                'phase': 'active',
                'clearSinceMs': None,
            })
        return next_state, None

    next_state['conditionActive'] = condition_result
    if phase == 'inactive':
        if condition_result:
            next_state.update({
                'phase': 'confirming',
                'confirmSinceMs': now_ms,
            })
        return next_state, None

    if phase == 'confirming':
        if not condition_result:
            return new_rule_event_state(rule['id']), None
        if time.ticks_diff(now_ms, next_state.get('confirmSinceMs')) >= (
                rule['confirmSeconds'] * 1000):
            next_state.update({
                'phase': 'active',
                'active': True,
                'confirmSinceMs': None,
                'openedAtMs': now_ms,
            })
            transition = {'type': 'open', 'reason': 'condition_confirmed'}
        return next_state, transition

    if phase == 'active':
        if condition_result:
            return next_state, None
        if _event_rule_latched(rule):
            next_state['phase'] = 'latched'
        else:
            next_state.update({
                'phase': 'clearing',
                'clearSinceMs': now_ms,
            })
        return next_state, None

    if phase == 'clearing':
        if condition_result:
            next_state.update({
                'phase': 'active',
                'clearSinceMs': None,
            })
            return next_state, None
        if time.ticks_diff(now_ms, next_state.get('clearSinceMs')) >= (
                rule['clearSeconds'] * 1000):
            transition = {'type': 'close', 'reason': 'condition_cleared'}
            return new_rule_event_state(rule['id']), transition
        return next_state, None

    if phase == 'latched' and condition_result:
        next_state['phase'] = 'active'
    return next_state, None


def new_shelly_availability_confirmation(
        required_samples=SHELLY_AVAILABILITY_CONFIRMATION_SAMPLES):
    """Keep transient Shelly poll failures out of the durable log."""
    if (not isinstance(required_samples, int) or
            isinstance(required_samples, bool) or required_samples < 1):
        raise ValueError('required_samples must be a positive integer')
    return {
        'stable': None,
        'pending': None,
        'pendingCount': 0,
        'materialChangePending': False,
        'requiredSamples': required_samples,
    }


def shelly_availability_change_pending(confirmation, available):
    """Confirm a raw availability change and retain it until CPU B accepts it."""
    if not isinstance(available, bool):
        raise ValueError('available must be boolean')
    if confirmation['stable'] == available:
        confirmation['pending'] = None
        confirmation['pendingCount'] = 0
        return confirmation['materialChangePending']
    elif confirmation['pending'] != available:
        confirmation['pending'] = available
        confirmation['pendingCount'] = 1
    else:
        confirmation['pendingCount'] += 1
    if confirmation['pendingCount'] < confirmation['requiredSamples']:
        return confirmation['materialChangePending']
    changed = confirmation['stable'] is not None
    confirmation['stable'] = available
    confirmation['pending'] = None
    confirmation['pendingCount'] = 0
    if changed:
        confirmation['materialChangePending'] = True
    return confirmation['materialChangePending']


def acknowledge_shelly_availability_change(confirmation):
    """Clear a confirmed transition only after its durable record is queued."""
    confirmation['materialChangePending'] = False


def _observation_path_value(observation, path):
    value = observation
    for part in path.split('.'):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def _numeric_material_change(current, previous, threshold):
    if isinstance(current, bool) or isinstance(previous, bool):
        return False
    if not isinstance(current, (int, float)) or not isinstance(previous, (int, float)):
        return False
    return abs(current - previous) >= threshold


def _material_change_detail(path, previous_value, current_value):
    """Name one diagnostic-only material change without altering its record."""
    label = MATERIAL_CHANGE_LABELS.get(path, path)
    return '{} ({}): {} -> {}'.format(
        label, path, previous_value, current_value)


def material_change_details(observation, previous, numeric_thresholds=None,
                            exact_change_paths=None,
                            confirmed_shelly_availability_change=False,
                            confirmed_shelly1_availability_change=False):
    """Return every independent material-change detail for operator logging.

    This is deliberately presentation-only. Durable selection and the record
    sent to CPU B retain their existing contract and identity.
    """
    if previous is None:
        return ['initial valid observation']
    if numeric_thresholds is None:
        numeric_thresholds = MATERIAL_NUMERIC_THRESHOLDS
    if exact_change_paths is None:
        exact_change_paths = MATERIAL_EXACT_CHANGE_PATHS
    details = []
    detail_paths = set()
    for path in exact_change_paths:
        current_value = _observation_path_value(observation, path)
        previous_value = _observation_path_value(previous, path)
        # A missed Shelly 1 poll produces null state. Availability is confirmed
        # independently, so one failed read must not look like an SW0/RLY0 edge.
        if (path in ('values.shelly1_sw0', 'values.shelly1_rly0') and
                (not isinstance(current_value, bool) or
                 not isinstance(previous_value, bool))):
            continue
        if current_value != previous_value:
            details.append(_material_change_detail(
                path, previous_value, current_value))
            detail_paths.add(path)
    for path, threshold in numeric_thresholds.items():
        current_value = _observation_path_value(observation, path)
        previous_value = _observation_path_value(previous, path)
        if _numeric_material_change(current_value, previous_value, threshold):
            details.append(_material_change_detail(
                path, previous_value, current_value))
            detail_paths.add(path)
    if confirmed_shelly_availability_change:
        path = 'status.shelly_available'
        if path not in detail_paths:
            details.append(_material_change_detail(
                path, _observation_path_value(previous, path),
                _observation_path_value(observation, path)))
    if confirmed_shelly1_availability_change:
        path = 'status.shelly1_available'
        if path not in detail_paths:
            details.append(_material_change_detail(
                path, _observation_path_value(previous, path),
                _observation_path_value(observation, path)))
    return details


def durable_observation_reason(observation, previous, elapsed_ms,
                               numeric_thresholds=None,
                               exact_change_paths=None,
                               maximum_interval_ms=MAX_DURABLE_OBSERVATION_INTERVAL_MS,
                               confirmed_shelly_availability_change=False,
                               confirmed_shelly1_availability_change=False):
    """Return CPU A's sparse durable-selection reason, or None.

    The complete one-second observation stays in RAM unless a configured
    material field changes or the maximum interval expires. A valid UTC sample
    time is required by the durable-observation v1 contract.
    """
    if not isinstance(observation, dict) or observation.get('observedAt') is None:
        return None
    if material_change_details(
            observation, previous, numeric_thresholds, exact_change_paths,
            confirmed_shelly_availability_change,
            confirmed_shelly1_availability_change):
        return 'material-change'
    if elapsed_ms is not None and elapsed_ms >= maximum_interval_ms:
        return 'maximum-interval'
    return None


def _record_timestamp_prefix(observed_at):
    """Return YYYYMMDDhhmmss for the CPU A contract timestamp."""
    if (not isinstance(observed_at, str) or len(observed_at) < 20 or
            observed_at[4] != '-' or observed_at[7] != '-' or
            observed_at[10] != 'T' or observed_at[13] != ':' or
            observed_at[16] != ':'):
        return None
    prefix = ''.join((observed_at[0:4], observed_at[5:7],
                      observed_at[8:10], observed_at[11:13],
                      observed_at[14:16], observed_at[17:19]))
    return prefix if prefix.isdigit() and len(prefix) == 14 else None


def build_durable_observation(observation, session_id, publish_reason,
                              rules_reference=None):
    """Wrap the complete CPU A observation in the durable v1 contract."""
    timestamp_prefix = _record_timestamp_prefix(observation.get('observedAt'))
    sequence = observation.get('sequence')
    if (timestamp_prefix is None or not isinstance(session_id, str) or
            len(session_id) < 8 or not isinstance(sequence, int) or
            isinstance(sequence, bool) or sequence < 0):
        return None
    if publish_reason not in ('material-change', 'maximum-interval'):
        return None
    if not isinstance(rules_reference, dict):
        return None
    legacy_rules_reference = {
        'version': rules_reference.get('version'),
        'contentHash': rules_reference.get('contentHash'),
    }
    if (not isinstance(legacy_rules_reference['version'], int) or
            legacy_rules_reference['version'] < 1 or
            not _valid_rules_hash(legacy_rules_reference['contentHash'])):
        return None
    record = dict(observation)
    record.update({
        'schemaVersion': 1,
        'recordType': 'observation',
        'recordId': '{}-observation-{}-{:010d}'.format(
            timestamp_prefix, session_id, sequence),
        'siteId': SITE_ID,
        'deviceId': DEVICE_ID,
        'sessionId': session_id,
        'source': 'tab5',
        'publishReason': publish_reason,
        # M4 durable-observation ingestion has a two-field rulesRelease
        # contract.  The full v2 adoption reference remains local/RTDB state
        # until the separate durable-record contract upgrade.
        'rulesRelease': legacy_rules_reference,
    })
    return record


def build_durable_observation_v2(observation, session_id, rules_reference,
                                 trigger_reasons, fields, uptime_ms=None):
    """Build one rules-selected, pre-dispatch observation without invented time."""
    sequence = observation.get('sequence') if isinstance(observation, dict) else None
    if uptime_ms is None:
        uptime_ms = observation.get('observedTicksMs') if isinstance(observation, dict) else None
    if (not isinstance(session_id, str) or len(session_id) < 8 or
            not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0 or
            not isinstance(uptime_ms, int) or isinstance(uptime_ms, bool) or uptime_ms < 0 or
            not isinstance(rules_reference, dict) or
            not isinstance(trigger_reasons, list) or not trigger_reasons or
            not isinstance(fields, dict)):
        return None
    release_id = rules_reference.get('releaseId')
    package_version = rules_reference.get('packageVersion')
    content_hash = rules_reference.get('contentHash')
    if (not isinstance(release_id, str) or
            not isinstance(package_version, int) or package_version < 1 or
            not _valid_rules_hash(content_hash)):
        return None
    time_evidence = {'uptimeMs': uptime_ms}
    observed_at = observation.get('observedAt')
    if isinstance(observed_at, str):
        time_evidence['observedAt'] = observed_at
    return {
        'schemaVersion': 2,
        'recordType': 'observation',
        'recordId': 'obs_{}_{:010d}'.format(session_id, sequence),
        'siteId': SITE_ID,
        'deviceId': DEVICE_ID,
        'sessionId': session_id,
        'cycleSequence': sequence,
        'time': time_evidence,
        'source': 'tab5',
        'rulesRelease': {
            'releaseId': release_id,
            'packageVersion': package_version,
            'contentHash': content_hash,
        },
        'snapshotPhase': 'observed-pre-dispatch',
        'triggerReasons': list(trigger_reasons),
        'fields': dict(fields),
    }


def _event_opening_kind(event):
    trigger = event.get('opening', {}).get('trigger', {}) if isinstance(event, dict) else {}
    return ('condition-qualified' if trigger.get('type') == 'condition'
            else 'occurrence-qualified' if trigger.get('type') in ('manual', 'internal')
            else 'unknown')


def build_current_event_board(runtime, session_id, board_sequence,
                              cycle_sequence, produced_uptime_ms,
                              produced_at=None):
    """Copy the committed sparse kernel board; never derive it from transitions."""
    if (not isinstance(runtime, dict) or not isinstance(session_id, str) or
            not isinstance(board_sequence, int) or board_sequence < 1 or
            not isinstance(cycle_sequence, int) or cycle_sequence < 0 or
            not isinstance(produced_uptime_ms, int) or produced_uptime_ms < 0):
        return None
    resolved = runtime.get('resolved')
    kernel = runtime.get('kernel')
    reference = runtime.get('reference')
    if not all(isinstance(item, dict) for item in (resolved, kernel, reference)):
        return None
    definitions = {event.get('id'): event for event in resolved.get('events', [])
                   if isinstance(event, dict) and isinstance(event.get('id'), str)}
    open_events = {}
    for event_id, state in kernel.get('events', {}).items():
        if not isinstance(state, dict) or state.get('active') is not True:
            continue
        event = definitions.get(event_id)
        occurrence_id = state.get('instanceId')
        if not isinstance(event, dict) or not isinstance(occurrence_id, str):
            return None
        opening = state.get('opening')
        if not isinstance(opening, dict):
            opening = {'kind': _event_opening_kind(event),
                       'cycleSequence': cycle_sequence,
                       'uptimeMs': produced_uptime_ms}
        open_events[event_id] = {
            'occurrenceId': occurrence_id,
            'displayName': event.get('displayName'),
            'severity': event.get('severity'),
            'eventClass': event.get('eventClass'),
            'opening': dict(opening),
        }
    board = {
        'schemaVersion': 1,
        'kind': 'current-event-board',
        'siteId': SITE_ID,
        'deviceId': DEVICE_ID,
        'sessionId': session_id,
        'boardSequence': board_sequence,
        'complete': True,
        'producedUptimeMs': produced_uptime_ms,
        'rulesRelease': {
            'releaseId': reference.get('releaseId'),
            'packageVersion': reference.get('packageVersion'),
            'contentHash': reference.get('contentHash'),
        },
        'openEvents': open_events,
    }
    if isinstance(produced_at, str):
        board['producedAt'] = produced_at
    return board


def event_board_signature(board):
    """Return the only content whose change requires a prompt new board."""
    if not isinstance(board, dict) or not isinstance(board.get('openEvents'), dict):
        return None
    try:
        return ujson.dumps(board['openEvents'])
    except Exception:
        return None


def build_rules_audit_record(record_type, observed_at, session_id, sequence,
                             rules_reference, release_id, rejection_reason=None):
    """Build the M6 adoption/rejection audit record; no M7 event state exists."""
    timestamp_prefix = _record_timestamp_prefix(observed_at)
    if (record_type not in ('rule-adoption', 'rule-rejection') or
            timestamp_prefix is None or not isinstance(session_id, str) or
            len(session_id) < 8 or not isinstance(sequence, int) or
            isinstance(sequence, bool) or sequence < 0 or
            not isinstance(release_id, str) or
            not isinstance(rules_reference, dict)):
        return None
    reference = {
        'version': rules_reference.get('version'),
        'contentHash': rules_reference.get('contentHash'),
    }
    if (not isinstance(reference['version'], int) or reference['version'] < 1 or
            not _valid_rules_hash(reference['contentHash'])):
        return None
    record = {
        'schemaVersion': 1,
        'recordType': record_type,
        'recordId': '{}-{}-{}-{:010d}'.format(
            timestamp_prefix, record_type, session_id, sequence),
        'siteId': SITE_ID,
        'deviceId': DEVICE_ID,
        'sessionId': session_id,
        'sequence': sequence,
        'observedAt': observed_at,
        'rulesRelease': reference,
        'releaseId': release_id,
        'actor': {'type': 'device', 'id': DEVICE_ID},
    }
    if record_type == 'rule-adoption':
        record['activeRules'] = dict(reference)
    else:
        if not isinstance(rejection_reason, str) or not rejection_reason:
            return None
        record['rejectionReason'] = rejection_reason
    return record


def _sha256_hex(value):
    """Return the lower-case SHA-256 for the exact UTF-8 release bytes."""
    if not isinstance(value, str):
        return None
    try:
        digest = uhashlib.sha256(value.encode('utf-8')).digest()
        return ''.join('{:02x}'.format(octet) for octet in digest)
    except Exception:
        return None


def _valid_rules_hash(value):
    if not isinstance(value, str) or len(value) != 64:
        return False
    for char in value:
        if char not in '0123456789abcdef':
            return False
    return True


def _valid_runtime_release_id(value, version):
    prefix = '-parameters-v'
    if (not isinstance(value, str) or not isinstance(version, int) or
            isinstance(version, bool) or version < 1):
        return False
    suffix = '{}{}'.format(prefix, version)
    return value[:14].isdigit() and value.endswith(suffix) and len(value) == 14 + len(suffix)


def _valid_integral_nonnegative(value):
    return (isinstance(value, int) and not isinstance(value, bool) and value >= 0) or (
        isinstance(value, float) and value >= 0 and value == int(value))


def _check_runtime_pointer(pointer):
    """Validate only the RTDB v2 delivery pointer on CPU A."""
    if not isinstance(pointer, dict):
        return None, 'pointer-not-an-object'
    required = ('schemaVersion', 'kind', 'siteId', 'releaseId', 'packageVersion',
                'runtimeSchemaVersion', 'contentHash', 'hashAlgorithm',
                'byteLength', 'publishedAtMs', 'downloadPath')
    for field in required:
        if field not in pointer:
            return None, 'pointer-missing-{}'.format(field)
    if (pointer.get('schemaVersion') != RUNTIME_SCHEMA_VERSION or
            pointer.get('kind') != RUNTIME_POINTER_KIND or pointer.get('siteId') != SITE_ID or
            pointer.get('runtimeSchemaVersion') != RUNTIME_SCHEMA_VERSION or
            pointer.get('hashAlgorithm') != 'sha256'):
        return None, 'pointer-schema'
    version = pointer.get('packageVersion')
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return None, 'pointer-packageVersion'
    if not _valid_runtime_release_id(pointer.get('releaseId'), version):
        return None, 'pointer-releaseId'
    if not _valid_rules_hash(pointer.get('contentHash')):
        return None, 'pointer-contentHash'
    if (not _valid_integral_nonnegative(pointer.get('publishedAtMs')) or
            not _valid_integral_nonnegative(pointer.get('byteLength')) or
            pointer.get('byteLength') < 1 or pointer.get('byteLength') > MAX_RULES_RELEASE_BYTES):
        return None, 'pointer-size-or-time'
    expected_path = '/.netlify/functions/rules-engine-release?releaseId={}'.format(pointer['releaseId'])
    if pointer.get('downloadPath') != expected_path:
        return None, 'pointer-downloadPath'
    return {
        'schemaVersion': RUNTIME_SCHEMA_VERSION, 'kind': RUNTIME_POINTER_KIND,
        'siteId': SITE_ID, 'releaseId': pointer['releaseId'],
        'packageVersion': version, 'runtimeSchemaVersion': RUNTIME_SCHEMA_VERSION,
        'contentHash': pointer['contentHash'], 'hashAlgorithm': 'sha256',
        'byteLength': int(pointer['byteLength']), 'publishedAtMs': int(pointer['publishedAtMs']),
        'downloadPath': expected_path,
    }, None


def validate_runtime_pointer(pointer):
    normalized, _reason = _check_runtime_pointer(pointer)
    return normalized


def runtime_pointer_rejection_reason(pointer):
    _normalized, reason = _check_runtime_pointer(pointer)
    return reason


def runtime_pointer_key_summary(pointer):
    if not isinstance(pointer, dict):
        return 'not-an-object'
    keys = list(pointer.keys())
    keys.sort()
    return ','.join(keys[:12]) if keys else 'empty-object'


def _runtime_field_valid(field, driver, names):
    if not isinstance(field, dict) or not isinstance(field.get('systemName'), str):
        return False
    name = field['systemName']
    if not name or name in names or not isinstance(field.get('logging'), dict):
        return False
    binding = RUNTIME_DIRECT_BINDINGS.get(driver, {}).get(field.get('object'))
    if binding is None:
        return False
    if (field.get('type'), field.get('unit'), field.get('access')) != binding:
        return False
    if field.get('access') == 'readWrite':
        write = field.get('write')
        if (not isinstance(write, dict) or write.get('method') != 'Switch.Set' or
                write.get('parameters') != {'id': 0, 'valueParameter': 'on'} or
                write.get('normalValue') is not True):
            return False
    names.add(name)
    return True


def _runtime_package_valid(package):
    if not isinstance(package, dict):
        return False
    required = ('schemaVersion', 'kind', 'releaseId', 'packageVersion', 'deliveryEnabled',
                'devices', 'calculations', 'events')
    if any(field not in package for field in required):
        return False
    if (package.get('schemaVersion') != RUNTIME_SCHEMA_VERSION or
            package.get('kind') != RUNTIME_PACKAGE_KIND or
            not isinstance(package.get('packageVersion'), int) or
            isinstance(package.get('packageVersion'), bool) or package.get('packageVersion') < 1 or
            not _valid_runtime_release_id(package.get('releaseId'), package.get('packageVersion')) or
            package.get('deliveryEnabled') is not False):
        return False
    devices = package.get('devices')
    calculations = package.get('calculations')
    events = package.get('events')
    if (not isinstance(devices, list) or not devices or len(devices) > 8 or
            not isinstance(calculations, list) or len(calculations) > 32 or
            not isinstance(events, list) or len(events) > 64):
        return False
    names = set()
    device_ids = set()
    for device in devices:
        if (not isinstance(device, dict) or not isinstance(device.get('id'), str) or
                not device['id'] or device['id'] in device_ids or
                device.get('driver') not in RUNTIME_DIRECT_BINDINGS or
                not isinstance(device.get('address'), str) or not device['address'] or
                not isinstance(device.get('enabled'), bool) or
                not isinstance(device.get('fields'), list) or not device['fields'] or
                len(device['fields']) > 32):
            return False
        device_ids.add(device['id'])
        for field in device['fields']:
            if not _runtime_field_valid(field, device['driver'], names):
                return False
    for calculation in calculations:
        if not isinstance(calculation, dict) or calculation.get('kind') not in ('expression', 'function'):
            return False
        if calculation.get('kind') == 'expression':
            program = calculation.get('program')
            output = calculation.get('output')
            if (not isinstance(program, list) or not program or len(program) > 128 or
                    not isinstance(output, dict) or not isinstance(output.get('systemName'), str)):
                return False
            for instruction in program:
                if (not isinstance(instruction, list) or len(instruction) != 2 or
                        instruction[0] not in ('number', 'field', 'operator')):
                    return False
            names.add(output['systemName'])
        elif calculation.get('functionId') != 'boyle_tank':
            return False
    event_ids = set()
    for event in events:
        if (not isinstance(event, dict) or not isinstance(event.get('id'), str) or
                not event['id'] or event['id'] in event_ids or
                not isinstance(event.get('enabled'), bool) or not isinstance(event.get('actions'), list) or
                not isinstance(event.get('open'), dict) or not isinstance(event.get('close'), dict)):
            return False
        event_ids.add(event['id'])
    return True


def validate_runtime_release(raw_release, pointer=None):
    """Verify v2 bytes and the bounded runtime shape before any flash write."""
    if not isinstance(raw_release, str) or not raw_release:
        return None, 'release-empty'
    try:
        byte_length = len(raw_release.encode('utf-8'))
    except Exception:
        return None, 'release-encoding'
    if byte_length > MAX_RULES_RELEASE_BYTES:
        return None, 'release-size'
    content_hash = _sha256_hex(raw_release)
    if content_hash is None:
        return None, 'release-hash-unavailable'
    normalized_pointer = None
    if pointer is not None:
        normalized_pointer = validate_runtime_pointer(pointer)
        if normalized_pointer is None:
            return None, 'pointer-invalid'
        if (content_hash != normalized_pointer['contentHash'] or
                byte_length != normalized_pointer['byteLength']):
            return None, 'release-integrity-mismatch'
    try:
        package = ujson.loads(raw_release)
    except Exception:
        return None, 'release-json-invalid'
    if not _runtime_package_valid(package):
        return None, 'release-runtime-unsupported'
    if normalized_pointer is not None and (
            package.get('releaseId') != normalized_pointer['releaseId'] or
            package.get('packageVersion') != normalized_pointer['packageVersion']):
        return None, 'release-pointer-mismatch'
    reference = {
        'releaseId': package['releaseId'], 'packageVersion': package['packageVersion'],
        'runtimeSchemaVersion': RUNTIME_SCHEMA_VERSION, 'contentHash': content_hash,
    }
    # device-sync v1 still carries version/hash only. CPU B derives that small
    # compatibility view from this CPU-A-created reference.
    reference['version'] = package['packageVersion']
    return {'package': package, 'reference': reference, 'pointer': normalized_pointer}, None


def load_runtime_package(path=RULES_RUNTIME_FILE):
    try:
        with open(path, 'r') as handle:
            raw_release = handle.read()
    except Exception:
        return None, 'runtime-unavailable'
    return validate_runtime_release(raw_release)


def adopt_runtime_release(candidate, active_reference,
                          path=RULES_RUNTIME_FILE,
                          temporary_path=RULES_RUNTIME_TEMP_FILE):
    if not isinstance(candidate, dict):
        return None, 'candidate-invalid'
    raw_release = candidate.get('release')
    checked, reason = validate_runtime_release(raw_release, candidate.get('metadata'))
    if checked is None:
        return None, reason
    if active_reference == checked['reference']:
        return checked, 'already-active'
    try:
        with open(temporary_path, 'w') as handle:
            handle.write(raw_release)
            try:
                handle.flush()
            except Exception:
                pass
        os.rename(temporary_path, path)
    except Exception:
        try:
            os.remove(temporary_path)
        except Exception:
            pass
        return None, 'atomic-replace-failed'
    return checked, 'adopted'


# V3 package validation remains independent of every V2 evaluator. Closed-schema
# validation is followed by V3 runtime-support resolution before staging.
def _v3_closed(value, required, allowed=None):
    if not isinstance(value, dict):
        return False
    keys = set(value.keys())
    allowed = set(required if allowed is None else allowed)
    return set(required).issubset(keys) and keys.issubset(allowed)


def _v3_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return value == value and value - value == 0
    except Exception:
        return False


def _v3_integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _v3_name(value):
    if not isinstance(value, str) or len(value) < 2 or len(value) > 64:
        return False
    if not (('A' <= value[0] <= 'Z') or ('a' <= value[0] <= 'z')):
        return False
    return all(('A' <= char <= 'Z') or ('a' <= char <= 'z') or
               ('0' <= char <= '9') or char == '_' for char in value[1:])


def _v3_id(value):
    if not isinstance(value, str) or len(value) < 2 or len(value) > 64:
        return False
    return all(('A' <= char <= 'Z') or ('a' <= char <= 'z') or
               ('0' <= char <= '9') or char in '_-' for char in value)


def _v3_scalar(value):
    return value is None or isinstance(value, (str, bool)) or _v3_number(value)


def _v3_logging(value):
    if not isinstance(value, dict):
        return False
    if value.get('mode') == 'delta':
        return (_v3_closed(value, ('mode', 'threshold')) and
                _v3_number(value.get('threshold')) and value['threshold'] > 0)
    return (_v3_closed(value, ('mode',)) and
            value.get('mode') in ('none', 'change', 'always'))


def _v3_typed_value(value, field_type, enum_values=None):
    if field_type == 'number':
        return _v3_number(value)
    if field_type == 'integer':
        return _v3_integer(value)
    if field_type == 'boolean':
        return isinstance(value, bool)
    if field_type == 'enum':
        return isinstance(value, str) and isinstance(enum_values, list) and value in enum_values
    if field_type == 'signal':
        return value is None
    return False


def _v3_enum_values(value):
    return (isinstance(value, list) and 2 <= len(value) <= 32 and
            all(isinstance(item, str) and item for item in value) and
            len(set(value)) == len(value))


# Each supported device method has its own exact parameter shape. The branches are
# discriminated by method and stay closed, so an id is never made optional for a
# method that requires it, nor accepted for one that does not carry it.
RULES_V3_WRITE_SHAPES = {
    'Switch.Set': ('id', 'valueParameter'),
    'Boolean.Set': ('valueParameter',),
}
# The one physical object that carries Tab5's inhibition. Resolved by device
# binding rather than by an editable system name.
RULES_V3_INHIBITION_OBJECT = 'UDF(Tab5IsLocked)'
# The switch input the contactor drives, which is what says the pump is running.
# Bound the same way and for the same reason: the system name behind it is the
# owner's to rename, the object is not.
RULES_V3_PUMP_RUNNING_OBJECT = 'SW(0)'


def _v3_write_parameters(method, parameters):
    required = RULES_V3_WRITE_SHAPES.get(method)
    if required is None or not _v3_closed(parameters, required):
        return False
    if 'id' in required:
        if (not _v3_integer(parameters.get('id')) or
                not 0 <= parameters['id'] <= 255):
            return False
    return _v3_name(parameters.get('valueParameter'))


def _v3_field(value):
    required = ('systemName', 'type', 'unit', 'logging', 'object', 'access')
    if not _v3_closed(value, required, required + ('enumValues', 'write')):
        return None
    field_type = value.get('type')
    if (not _v3_name(value.get('systemName')) or field_type not in
            ('number', 'integer', 'boolean', 'enum', 'signal') or
            not isinstance(value.get('unit'), (str, type(None))) or
            not _v3_logging(value.get('logging')) or
            not isinstance(value.get('object'), str) or not value['object'] or
            len(value['object']) > 128 or value.get('access') not in ('read', 'readWrite')):
        return None
    enums = value.get('enumValues')
    if field_type == 'enum':
        if not _v3_enum_values(enums):
            return None
    elif enums is not None:
        return None
    write = value.get('write')
    if value['access'] == 'readWrite':
        if (not _v3_closed(write, ('method', 'parameters', 'normalValue')) or
                not _v3_write_parameters(write.get('method'), write.get('parameters')) or
                not _v3_typed_value(write.get('normalValue'), field_type, enums)):
            return None
    elif write is not None:
        return None
    return {'type': field_type, 'enumValues': enums,
            'assignmentTarget': value['access'] == 'readWrite',
            'inhibitionTarget': value['object'] == RULES_V3_INHIBITION_OBJECT}


def _v3_output(value):
    required = ('systemName', 'type', 'unit', 'logging')
    if not _v3_closed(value, required, required + ('enumValues',)):
        return None
    field_type = value.get('type')
    enums = value.get('enumValues')
    if (not _v3_name(value.get('systemName')) or
            field_type not in ('number', 'integer', 'boolean', 'enum', 'signal') or
            not isinstance(value.get('unit'), (str, type(None))) or
            not _v3_logging(value.get('logging'))):
        return None
    if field_type == 'enum':
        if not _v3_enum_values(enums):
            return None
    elif enums is not None:
        return None
    return {'type': field_type, 'enumValues': enums, 'assignmentTarget': False,
            'inhibitionTarget': False}


def _v3_system_field(value):
    common = ('id', 'systemName', 'label', 'source', 'runtimeRole', 'type', 'unit', 'logging')
    if not _v3_closed(value, common, common + ('enumValues', 'initialValue',
                                                'assignmentTarget', 'occurrenceKey')):
        return None
    if (not _v3_id(value.get('id')) or not _v3_name(value.get('systemName')) or
            not isinstance(value.get('label'), str) or not value['label'] or
            not isinstance(value.get('unit'), (str, type(None))) or
            not _v3_logging(value.get('logging'))):
        return None
    role = value.get('runtimeRole')
    if role == 'operatingMode':
        exact = common + ('enumValues', 'initialValue', 'assignmentTarget')
        if (not _v3_closed(value, exact) or value.get('source') != 'session' or
                value.get('type') != 'enum' or value.get('enumValues') != ['Normal', 'Monitor'] or
                value.get('initialValue') != 'Normal' or value.get('assignmentTarget') is not True):
            return None
    elif role == 'working':
        exact = common + ('initialValue', 'assignmentTarget')
        if value.get('type') == 'enum':
            exact += ('enumValues',)
        if (not _v3_closed(value, exact) or value.get('source') != 'session' or
                value.get('type') not in ('number', 'integer', 'boolean', 'enum') or
                not isinstance(value.get('assignmentTarget'), bool) or
                not _v3_typed_value(value.get('initialValue'), value.get('type'),
                                    value.get('enumValues'))):
            return None
        if value.get('type') == 'enum' and not _v3_enum_values(value.get('enumValues')):
            return None
    elif role == 'occurrence':
        exact = common + ('occurrenceKey',)
        if (not _v3_closed(value, exact) or value.get('source') not in
                ('manualOccurrence', 'internalOccurrence') or value.get('type') != 'signal' or
                not _v3_name(value.get('occurrenceKey'))):
            return None
    else:
        return None
    return {'type': value['type'], 'enumValues': value.get('enumValues'),
            'assignmentTarget': value.get('assignmentTarget') is True,
            'inhibitionTarget': False,
            'role': role, 'source': value['source']}


def _v3_clause(value, fields):
    if not _v3_closed(value, ('field', 'operator', 'value')):
        return False
    field = fields.get(value.get('field'))
    operator = value.get('operator')
    if field is None or operator not in ('lt', 'lte', 'gt', 'gte', 'eq', 'neq',
                                         'between', 'outside', 'changes',
                                         'changes_from', 'changes_to', 'occurs'):
        return False
    field_type = field['type']
    compared = value.get('value')
    if operator in ('lt', 'lte', 'gt', 'gte'):
        return field_type in ('number', 'integer') and _v3_number(compared)
    if operator in ('between', 'outside'):
        return (field_type in ('number', 'integer') and isinstance(compared, list) and
                len(compared) == 2 and all(_v3_number(item) for item in compared))
    if operator == 'occurs':
        return field_type == 'signal' and compared is None
    return _v3_typed_value(compared, field_type, field.get('enumValues'))


def _v3_condition(value, fields, qualified):
    required = ('mode', 'clauses') + (('observationCount', 'minimumSeconds') if qualified else ())
    if not _v3_closed(value, required):
        return False
    clauses = value.get('clauses')
    if (value.get('mode') not in ('all', 'any') or not isinstance(clauses, list) or
            not 1 <= len(clauses) <= 16 or not all(_v3_clause(item, fields) for item in clauses)):
        return False
    if qualified:
        return (_v3_integer(value.get('observationCount')) and
                1 <= value['observationCount'] <= 86400 and _v3_number(value.get('minimumSeconds')) and
                0 <= value['minimumSeconds'] <= 86400)
    return True


def _v3_phase(value, fields, event_class, close_phase):
    if not _v3_closed(value, ('assignments', 'guardedGroups')):
        return False
    assignments = value.get('assignments')
    groups = value.get('guardedGroups')
    if (not isinstance(assignments, list) or len(assignments) > 32 or
            not isinstance(groups, list) or len(groups) > 16):
        return False
    all_assignments = list(assignments)
    for group in groups:
        if (not _v3_closed(group, ('guard', 'assignments')) or
                not _v3_condition(group.get('guard'), fields, False) or
                not isinstance(group.get('assignments'), list) or
                not 1 <= len(group['assignments']) <= 32):
            return False
        all_assignments.extend(group['assignments'])
    for assignment in all_assignments:
        if not _v3_closed(assignment, ('target', 'value', 'ownership')):
            return False
        target = fields.get(assignment.get('target'))
        if (target is None or target.get('assignmentTarget') is not True or
                assignment.get('ownership') not in ('transition', 'whileOpen') or
                not _v3_typed_value(assignment.get('value'), target['type'],
                                    target.get('enumValues'))):
            return False
        if close_phase and assignment['ownership'] != 'transition':
            return False
        if target.get('inhibitionTarget') is True:
            # Release is a consequence of ownership and mode, never an authored
            # value. Only a held opening assignment may request inhibition.
            if (close_phase or assignment['value'] is not True or
                    assignment['ownership'] != 'whileOpen'):
                return False
        if target.get('role') == 'operatingMode':
            if (event_class != 'monitor' or assignment['value'] != 'Monitor' or
                    assignment['ownership'] != 'whileOpen'):
                return False
        elif event_class == 'monitor':
            return False
    return True


def _v3_dependencies_acyclic(dependencies):
    """Check declared calculated-name references without evaluating anything."""
    visiting = set()
    completed = set()

    def visit(name):
        if name in completed:
            return True
        if name in visiting:
            return False
        visiting.add(name)
        for dependency in dependencies.get(name, ()):
            if not visit(dependency):
                return False
        visiting.remove(name)
        completed.add(name)
        return True

    return all(visit(name) for name in dependencies)


def _rules_v3_package_valid(package):
    root = ('schemaVersion', 'kind', 'releaseId', 'packageVersion', 'adoption',
            'lifecycle', 'devices', 'calculations', 'systemFields', 'events')
    if not _v3_closed(package, root):
        return False
    if (package.get('schemaVersion') != RULES_V3_SCHEMA_VERSION or
            package.get('kind') != RULES_V3_PACKAGE_KIND or
            not _v3_integer(package.get('packageVersion')) or package['packageVersion'] < 1 or
            not isinstance(package.get('releaseId'), str) or
            package['releaseId'] != '{}-event-v3-v{}'.format(
                package['releaseId'][:14], package['packageVersion']) or
            not package['releaseId'][:14].isdigit()):
        return False
    if (not _v3_closed(package.get('adoption'), ('runtimeSchemaVersion', 'legacyPackagePolicy')) or
            package['adoption'].get('runtimeSchemaVersion') != 3 or
            package['adoption'].get('legacyPackagePolicy') != 'reject'):
        return False
    lifecycle = package.get('lifecycle')
    if (not _v3_closed(lifecycle, ('qualification', 'ownership', 'monitor')) or
            lifecycle.get('ownership') != 'event_instance_set' or
            not _v3_closed(lifecycle.get('qualification'),
                           ('observationCount', 'minimumSeconds', 'countAndTimeBothRequired',
                            'missingEvidence')) or
            lifecycle['qualification'] != {'observationCount': 'consecutive',
                                           'minimumSeconds': 'continuous',
                                           'countAndTimeBothRequired': True,
                                           'missingEvidence': 'freezes_qualification'} or
            not _v3_closed(lifecycle.get('monitor'), ('resource',)) or
            lifecycle['monitor'].get('resource') != 'declared_operating_mode'):
        return False
    devices = package.get('devices')
    if not isinstance(devices, list) or not 1 <= len(devices) <= 16:
        return False
    fields = {}
    ids = set()
    for device in devices:
        if (not _v3_closed(device, ('id', 'driver', 'address', 'enabled', 'fields')) or
                not _v3_id(device.get('id')) or device['id'] in ids or
                not isinstance(device.get('driver'), str) or not device['driver'] or
                not isinstance(device.get('address'), str) or not device['address'] or
                not isinstance(device.get('enabled'), bool) or
                not isinstance(device.get('fields'), list) or not 1 <= len(device['fields']) <= 32):
            return False
        ids.add(device['id'])
        for field in device['fields']:
            checked = _v3_field(field)
            if checked is None or field['systemName'] in fields:
                return False
            fields[field['systemName']] = checked
    system_fields = package.get('systemFields')
    if not isinstance(system_fields, list) or not 1 <= len(system_fields) <= 32:
        return False
    for field in system_fields:
        checked = _v3_system_field(field)
        if checked is None or field['systemName'] in fields:
            return False
        fields[field['systemName']] = checked
    if not any(item.get('role') == 'operatingMode' for item in fields.values()):
        return False
    calculations = package.get('calculations')
    if not isinstance(calculations, list) or len(calculations) > 64:
        return False
    calculation_ids = set()
    calculated_output_owner = {}
    for item in calculations:
        if not isinstance(item, dict) or not _v3_id(item.get('id')) or item['id'] in calculation_ids:
            return False
        calculation_ids.add(item['id'])
        outputs = ([item.get('output')] if item.get('kind') == 'expression'
                   else item.get('outputs'))
        if not isinstance(outputs, list):
            outputs = [outputs]
        for output in outputs:
            checked = _v3_output(output)
            if checked is None or output['systemName'] in fields:
                return False
            fields[output['systemName']] = checked
            calculated_output_owner[output['systemName']] = item['id']
    dependencies = {item['id']: set() for item in calculations}
    for item in calculations:
        if item.get('kind') == 'expression':
            if (not _v3_closed(item, ('id', 'kind', 'expression', 'program', 'output')) or
                    not isinstance(item.get('expression'), str) or len(item['expression']) > 512 or
                    not isinstance(item.get('program'), list) or not item['program'] or len(item['program']) > 128):
                return False
            for token in item['program']:
                if (not isinstance(token, list) or len(token) != 2 or token[0] not in
                        ('number', 'field', 'operator') or
                        (token[0] == 'number' and not _v3_number(token[1])) or
                        (token[0] == 'field' and token[1] not in fields) or
                        (token[0] == 'operator' and token[1] not in ('+', '-', '*', '/'))):
                    return False
                if token[0] == 'field' and token[1] in calculated_output_owner:
                    dependencies[item['id']].add(calculated_output_owner[token[1]])
        elif item.get('kind') == 'function':
            required = ('id', 'kind', 'functionId', 'inputs', 'parameters', 'outputs')
            if (not _v3_closed(item, required) or item.get('functionId') != 'boyle_tank' or
                    not _v3_closed(item.get('inputs'), ('pressure',)) or
                    item['inputs'].get('pressure') not in fields or
                    not _v3_closed(item.get('parameters'),
                                   ('effectiveTankGallons', 'prechargeGaugePsi',
                                    'atmosphericPressurePsi', 'regressionWindowSeconds',
                                    'minimumSamples')) or
                    not all(_v3_number(value) for value in item['parameters'].values()) or
                    not isinstance(item.get('outputs'), list) or len(item['outputs']) != 5):
                return False
            input_name = item['inputs']['pressure']
            if input_name in calculated_output_owner:
                dependencies[item['id']].add(calculated_output_owner[input_name])
        else:
            return False
    if not _v3_dependencies_acyclic(dependencies):
        return False
    events = package.get('events')
    if not isinstance(events, list) or len(events) > 64:
        return False
    event_ids = set()
    event_names = set()
    for event in events:
        required = ('id', 'systemName', 'displayName', 'severity', 'enabled', 'eventClass',
                    'opening', 'closing', 'onOpen', 'onClose', 'summary')
        if (not _v3_closed(event, required) or not _v3_id(event.get('id')) or
                event['id'] in event_ids or not _v3_name(event.get('systemName')) or
                event['systemName'] in event_names or not isinstance(event.get('displayName'), str) or
                not 1 <= len(event['displayName']) <= 160 or event.get('severity') not in
                ('Info', 'Yellow', 'Red') or not isinstance(event.get('enabled'), bool) or
                event.get('eventClass') not in ('transient', 'latched', 'monitor') or
                not _v3_closed(event.get('opening'), ('trigger',))):
            return False
        event_ids.add(event['id'])
        event_names.add(event['systemName'])
        trigger = event['opening'].get('trigger')
        if not isinstance(trigger, dict) or trigger.get('type') not in ('condition', 'manual', 'internal'):
            return False
        if trigger['type'] == 'condition':
            if not _v3_closed(trigger, ('type', 'condition')) or not _v3_condition(trigger.get('condition'), fields, True):
                return False
        else:
            if (not _v3_closed(trigger, ('type', 'occurrenceField', 'qualification')) or
                    fields.get(trigger.get('occurrenceField'), {}).get('role') != 'occurrence' or
                    fields[trigger['occurrenceField']].get('source') !=
                    ('manualOccurrence' if trigger['type'] == 'manual' else 'internalOccurrence') or
                    not _v3_closed(trigger.get('qualification'), ('observationCount', 'minimumSeconds')) or
                    not _v3_integer(trigger['qualification'].get('observationCount')) or
                    not 1 <= trigger['qualification']['observationCount'] <= 86400 or
                    not _v3_number(trigger['qualification'].get('minimumSeconds')) or
                    not 0 <= trigger['qualification']['minimumSeconds'] <= 86400):
                return False
        closing = event.get('closing')
        if not isinstance(closing, dict) or closing.get('policy') not in ('condition', 'clearEvents', 'immediate'):
            return False
        if closing['policy'] == 'condition':
            if not _v3_closed(closing, ('policy', 'condition')) or not _v3_condition(closing.get('condition'), fields, True):
                return False
        elif not _v3_closed(closing, ('policy',)):
            return False
        if ((event['eventClass'] == 'latched' and closing['policy'] != 'clearEvents') or
                (event['eventClass'] == 'transient' and closing['policy'] not in ('condition', 'immediate')) or
                (event['eventClass'] == 'monitor' and closing['policy'] not in ('condition', 'clearEvents')) or
                not _v3_phase(event.get('onOpen'), fields, event['eventClass'], False) or
                not _v3_phase(event.get('onClose'), fields, event['eventClass'], True)):
            return False
        summary = event.get('summary')
        if not _v3_closed(summary, ('durationOutput', 'aggregates')) or not isinstance(summary.get('aggregates'), list) or len(summary['aggregates']) > 32:
            return False
        if summary['durationOutput'] is not None and _v3_output(summary['durationOutput']) is None:
            return False
        for aggregate in summary['aggregates']:
            if (not _v3_closed(aggregate, ('source', 'operation', 'scale', 'output')) or
                    aggregate.get('source') not in fields or aggregate.get('operation') not in
                    ('start', 'end', 'delta', 'average', 'minimum', 'maximum') or
                    not _v3_number(aggregate.get('scale')) or _v3_output(aggregate.get('output')) is None):
                return False
    return True


def _check_rules_v3_pointer(pointer):
    required = ('schemaVersion', 'kind', 'siteId', 'releaseId', 'packageVersion',
                'runtimeSchemaVersion', 'contentHash', 'hashAlgorithm', 'byteLength',
                'publishedAtMs', 'downloadPath', 'executionEnabled')
    if not _v3_closed(pointer, required):
        return None, 'pointer-closure'
    version = pointer.get('packageVersion')
    release_id = pointer.get('releaseId')
    expected_path = '/.netlify/functions/rules-engine-release?version=3&releaseId={}'.format(release_id)
    if (pointer.get('schemaVersion') != RULES_V3_POINTER_SCHEMA_VERSION or
            pointer.get('kind') != RULES_V3_POINTER_KIND or
            pointer.get('siteId') != SITE_ID or not _v3_integer(version) or version < 1 or
            not isinstance(release_id, str) or release_id != '{}-event-v3-v{}'.format(release_id[:14], version) or
            not release_id[:14].isdigit() or pointer.get('runtimeSchemaVersion') != 3 or
            not _valid_rules_hash(pointer.get('contentHash')) or pointer.get('hashAlgorithm') != 'sha256' or
            not _v3_integer(pointer.get('byteLength')) or
            not 1 <= pointer['byteLength'] <= MAX_RULES_RELEASE_BYTES or
            not _v3_integer(pointer.get('publishedAtMs')) or pointer['publishedAtMs'] < 0 or
            pointer.get('downloadPath') != expected_path or pointer.get('executionEnabled') is not True):
        return None, 'pointer-invalid'
    return dict(pointer), None


def validate_rules_v3_pointer(pointer):
    checked, _reason = _check_rules_v3_pointer(pointer)
    return checked


def rules_v3_pointer_rejection_reason(pointer):
    _checked, reason = _check_rules_v3_pointer(pointer)
    return reason


def validate_rules_v3_staged_release(raw_release, pointer=None):
    """Validate exact bytes and resolve supported runtime behavior before staging."""
    if not isinstance(raw_release, str) or not raw_release:
        return None, 'release-empty'
    try:
        byte_length = len(raw_release.encode('utf-8'))
    except Exception:
        return None, 'release-encoding'
    if byte_length > MAX_RULES_RELEASE_BYTES:
        return None, 'release-size'
    content_hash = _sha256_hex(raw_release)
    if content_hash is None:
        return None, 'release-hash-unavailable'
    normalized = validate_rules_v3_pointer(pointer) if pointer is not None else None
    if pointer is not None and normalized is None:
        return None, 'pointer-invalid'
    if normalized is not None and (content_hash != normalized['contentHash'] or
                                   byte_length != normalized['byteLength']):
        return None, 'release-integrity-mismatch'
    try:
        package = ujson.loads(raw_release)
    except Exception:
        return None, 'release-json-invalid'
    if not _rules_v3_package_valid(package):
        return None, 'release-runtime-unsupported'
    if normalized is not None and (package.get('releaseId') != normalized['releaseId'] or
                                   package.get('packageVersion') != normalized['packageVersion']):
        return None, 'release-pointer-mismatch'
    resolved = resolve_rules_v3_package(package)
    if resolved is None:
        return None, 'release-runtime-unsupported'
    reference = {'releaseId': package['releaseId'], 'packageVersion': package['packageVersion'],
                 'runtimeSchemaVersion': 3, 'contentHash': content_hash,
                 'version': package['packageVersion']}
    return {'package': package, 'reference': reference, 'pointer': normalized,
            'resolved': resolved}, None


def load_rules_v3_staged_package(path=RULES_V3_STAGED_FILE):
    try:
        with open(path, 'r') as handle:
            raw_release = handle.read()
    except Exception:
        return None, 'runtime-unavailable'
    return validate_rules_v3_staged_release(raw_release)


def stage_rules_v3_release(candidate, staged_reference,
                           path=RULES_V3_STAGED_FILE,
                           temporary_path=RULES_V3_STAGED_TEMP_FILE):
    if not isinstance(candidate, dict):
        return None, 'candidate-invalid'
    checked, reason = validate_rules_v3_staged_release(
        candidate.get('release'), candidate.get('metadata'))
    if checked is None:
        return None, reason
    if staged_reference == checked['reference']:
        return checked, 'already-staged'
    try:
        with open(temporary_path, 'w') as handle:
            handle.write(candidate['release'])
            try:
                handle.flush()
            except Exception:
                pass
        os.rename(temporary_path, path)
    except Exception:
        try:
            os.remove(temporary_path)
        except Exception:
            pass
        return None, 'atomic-replace-failed'
    return checked, 'staged'


def _rules_v3_reference(value):
    if not isinstance(value, dict):
        return None
    required = ('releaseId', 'packageVersion', 'runtimeSchemaVersion', 'contentHash')
    if any(name not in value for name in required):
        return None
    return {name: value[name] for name in required}


def rules_v3_state_report(running=None, desired=None, staged=None, rejected=None):
    """Report distinct runtime and next-restart package identities truthfully."""
    running_reference = _rules_v3_reference(running)
    return {
        'kind': 'rules-v3-runtime-state',
        'executionEnabled': running_reference is not None,
        'executionState': ('running' if running_reference is not None else 'unavailable'),
        'running': running_reference,
        'desired': _rules_v3_reference(desired),
        'staged': _rules_v3_reference(staged),
        'rejected': dict(rejected) if isinstance(rejected, dict) else None,
    }


# Structural validity is not runtime support. This application executes exactly one
# device write, on the inhibition Boolean. A package declaring RLY(0) as readWrite
# is rejected here even though that shape remains structurally valid, which is what
# makes old and new control packages mutually incompatible across the cutover.
RULES_V3_SUPPORTED_WRITES = {
    RULES_V3_INHIBITION_OBJECT: {
        'method': 'Boolean.Set',
        'parameters': {'valueParameter': 'value'},
        'normalValue': False,
    },
}


def _rules_v3_runtime_supported(package):
    """Reject schema-valid declarations that this device application cannot execute."""
    for device in package.get('devices', []):
        bindings = RUNTIME_DIRECT_BINDINGS.get(device.get('driver'))
        if not isinstance(bindings, dict):
            return False
        for field in device.get('fields', []):
            binding = bindings.get(field.get('object'))
            if binding != (field.get('type'), field.get('unit'), field.get('access')):
                return False
            if field.get('access') == 'readWrite':
                write = field.get('write')
                supported = RULES_V3_SUPPORTED_WRITES.get(field.get('object'))
                if (device.get('driver') != 'shelly-gen4-switch' or
                        supported is None or not isinstance(write, dict) or
                        write.get('method') != supported['method'] or
                        write.get('parameters') != supported['parameters'] or
                        write.get('normalValue') is not supported['normalValue']):
                    return False
    for calculation in package.get('calculations', []):
        if calculation.get('kind') == 'expression':
            if calculation.get('output', {}).get('type') != 'number':
                return False
        elif calculation.get('kind') == 'function':
            parameters = calculation.get('parameters', {})
            outputs = calculation.get('outputs', [])
            if (calculation.get('functionId') != 'boyle_tank' or
                    len(outputs) != 5 or
                    [item.get('type') for item in outputs] !=
                    ['number', 'number', 'number', 'number', 'enum'] or
                    not _v3_number(parameters.get('effectiveTankGallons')) or
                    parameters['effectiveTankGallons'] <= 0 or
                    not _v3_number(parameters.get('atmosphericPressurePsi')) or
                    parameters['atmosphericPressurePsi'] <= 0 or
                    not _v3_number(parameters.get('prechargeGaugePsi')) or
                    not _v3_number(parameters.get('regressionWindowSeconds')) or
                    parameters['regressionWindowSeconds'] <= 0 or
                    not _v3_integer(parameters.get('minimumSamples')) or
                    parameters['minimumSamples'] < 2):
                return False
            required_quality = {
                'VALID', 'INSUFFICIENT_HISTORY', 'PRESSURE_INVALID',
                'SAMPLE_GAP', 'TREND_UNRESOLVED', 'TANK_MODEL_INVALID'}
            if set(outputs[4].get('enumValues') or ()) != required_quality:
                return False
        else:
            return False
    for event in package.get('events', []):
        summary = event.get('summary', {})
        if summary.get('durationOutput') is not None or summary.get('aggregates'):
            return False
    return True


def rules_v3_cadence_warnings(package, period_ms):
    """Name regression windows this sample cadence cannot fill.

    A window is collected in wall-clock time but gated on a sample COUNT, so
    slowing the loop starves it: the quality output pins at INSUFFICIENT_HISTORY
    and the calculation never produces a value again. Nothing rejects such a
    package and nothing should - every other rule in it still runs - so this is
    reported loudly rather than enforced. It exists because the failure is
    otherwise completely silent.
    """
    warnings = []
    if not isinstance(package, dict) or not _is_number(period_ms) or period_ms <= 0:
        return warnings
    calculations = package.get('calculations')
    if not isinstance(calculations, list):
        return warnings
    for calculation in calculations:
        if not isinstance(calculation, dict) or calculation.get('kind') != 'function':
            continue
        parameters = calculation.get('parameters')
        if not isinstance(parameters, dict):
            continue
        window_s = parameters.get('regressionWindowSeconds')
        minimum = parameters.get('minimumSamples')
        if not _is_number(window_s) or not _v3_integer(minimum):
            continue
        # Best case is one sample per cycle across the window, plus the one taken
        # at this instant. The collector's tolerance is ignored on purpose: a
        # window that only fills because of it has no margin left.
        available = int(window_s * 1000 // period_ms) + 1
        if available < minimum:
            warnings.append('{} needs {} samples but a {}ms cycle yields {} in {}s'.format(
                calculation.get('id') or 'calculation', minimum,
                int(period_ms), available, window_s))
    return warnings


def resolve_rules_v3_package(package):
    """Resolve one validated V3 package for the pure kernel; perform no I/O."""
    if isinstance(package, str):
        try:
            package = ujson.loads(package)
        except Exception:
            return None
    if not _rules_v3_package_valid(package) or not _rules_v3_runtime_supported(package):
        return None
    devices = {}
    writable = {}
    field_types = {}
    for device in package['devices']:
        resolved_fields = []
        for field in device['fields']:
            resolved_field = {
                'object': field['object'], 'systemName': field['systemName'],
                'type': field['type'], 'enumValues': field.get('enumValues'),
            }
            resolved_fields.append(resolved_field)
            field_types[field['systemName']] = {
                'type': field['type'], 'enumValues': field.get('enumValues')}
            if field.get('access') == 'readWrite':
                writable[field['systemName']] = {
                    'type': field['type'], 'enumValues': field.get('enumValues'),
                    'normalValue': field['write']['normalValue'],
                    'method': field['write'].get('method'),
                    'parameters': field['write'].get('parameters') or {},
                    'deviceId': device['id'], 'object': field['object'],
                }
        devices[device['id']] = {
            'enabled': device['enabled'], 'fields': resolved_fields,
            'driver': device['driver']}
    initial_fields = {}
    operating_mode_target = None
    for field in package['systemFields']:
        field_types[field['systemName']] = {
            'type': field['type'], 'enumValues': field.get('enumValues')}
        if 'initialValue' in field:
            initial_fields[field['systemName']] = field['initialValue']
        if field.get('assignmentTarget') is True:
            writable[field['systemName']] = {
                'type': field['type'], 'enumValues': field.get('enumValues'),
                'normalValue': field.get('initialValue'),
            }
        if field.get('runtimeRole') == 'operatingMode':
            operating_mode_target = field['systemName']
    pump_target = 'PumpEnable' if 'PumpEnable' in writable else None
    lock_field = 'IsLocked' if 'IsLocked' in field_types else None
    # Resolved by its exact device binding so an editable system name, or an alias
    # declaring the same object twice, cannot create a second competing target.
    inhibition_target = None
    for device in package['devices']:
        if device.get('driver') != 'shelly-gen4-switch':
            continue
        for field in device['fields']:
            if field['object'] != RULES_V3_INHIBITION_OBJECT:
                continue
            if field.get('access') != 'readWrite':
                continue
            if inhibition_target is not None:
                return None  # two targets for one physical component
            inhibition_target = field['systemName']
    # Read-only, and bound exactly like the inhibition target above. A second
    # alias for the same switch would make "is the pump running" ambiguous at
    # the moment it matters most, so it is refused rather than guessed.
    pump_running_field = None
    for device in package['devices']:
        if device.get('driver') != 'shelly-gen4-switch':
            continue
        for field in device['fields']:
            if (field['object'] != RULES_V3_PUMP_RUNNING_OBJECT or
                    field['type'] != 'boolean'):
                continue
            if pump_running_field is not None:
                return None  # two names for one physical switch
            pump_running_field = field['systemName']
    tab5_objects = {}
    for device in package['devices']:
        if device.get('driver') == 'tab5-runtime':
            tab5_objects.update({field['object']: field['systemName']
                                 for field in device['fields']})
    adc_field = tab5_objects.get('values.adc_raw')
    pressure_guards = [
        tab5_objects.get('status.pressure_sensor_commissioned'),
        tab5_objects.get('status.adc_available'),
    ]
    available = set(field['systemName'] for device in package['devices']
                    for field in device['fields'])
    available.update(field['systemName'] for field in package['systemFields'])
    remaining = list(package['calculations'])
    calculation_plan = []
    while remaining:
        progressed = False
        for calculation in list(remaining):
            dependencies = ([token[1] for token in calculation.get('program', [])
                             if token[0] == 'field']
                            if calculation['kind'] == 'expression' else
                            [calculation['inputs']['pressure']])
            if all(name in available for name in dependencies):
                resolved_calculation = dict(calculation)
                if calculation['kind'] == 'expression' and adc_field in dependencies:
                    if adc_field is None or any(name is None for name in pressure_guards):
                        return None
                    resolved_calculation['_requiredTrueFields'] = list(pressure_guards)
                calculation_plan.append(resolved_calculation)
                outputs = ([calculation['output']] if calculation['kind'] == 'expression'
                           else calculation['outputs'])
                available.update(output['systemName'] for output in outputs)
                remaining.remove(calculation)
                progressed = True
        if not progressed:
            return None
    return {
        'releaseId': package['releaseId'],
        'packageVersion': package['packageVersion'],
        'events': list(package['events']),
        'devices': devices,
        'fieldTypes': field_types,
        'initialFields': initial_fields,
        'writableTargets': writable,
        'operatingModeTarget': operating_mode_target,
        'pumpTarget': pump_target,
        'inhibitionTarget': inhibition_target,
        'pumpRunningField': pump_running_field,
        'lockField': lock_field,
        'calculations': calculation_plan,
    }


def accept_rules_v3_device_record(resolved, device_id, record):
    """Accept all declared fields from one device atomically, or reject all."""
    if not isinstance(resolved, dict) or not isinstance(record, dict):
        return None
    device = resolved.get('devices', {}).get(device_id)
    if not isinstance(device, dict) or device.get('enabled') is not True:
        return None
    accepted = {}
    for field in device.get('fields', []):
        object_name = field['object']
        system_name = field['systemName']
        if object_name in record:
            value = record[object_name]
        elif system_name in record:
            value = record[system_name]
        else:
            return None
        if not _v3_typed_value(value, field['type'], field.get('enumValues')):
            return None
        if object_name == '$availability' and value is not True:
            return None
        accepted[system_name] = value
    return accepted


def freeze_rules_v3_snapshot(resolved, device_records, system_values=None):
    """Build one immutable-by-convention selection snapshot from current records."""
    if not isinstance(resolved, dict):
        return None
    snapshot = dict(resolved.get('initialFields', {}))
    if isinstance(device_records, dict):
        for values in device_records.values():
            if isinstance(values, dict):
                snapshot.update(values)
    if isinstance(system_values, dict):
        for name, value in system_values.items():
            checked = resolved.get('fieldTypes', {}).get(name)
            if (isinstance(checked, dict) and
                    _v3_typed_value(value, checked['type'], checked.get('enumValues'))):
                snapshot[name] = value
    return snapshot


def collect_rules_v3_device_records(resolved, observation):
    """Atomically accept each enabled device from this cycle's observation only."""
    accepted = {}
    unavailable = []
    for device_id, device in resolved.get('devices', {}).items():
        if device.get('enabled') is not True:
            continue
        record = {}
        for field in device.get('fields', []):
            driver = device.get('driver')
            path = (field.get('object') if driver == 'tab5-runtime' else
                    RUNTIME_OBJECT_PATHS.get(driver, {}).get(field.get('object')))
            if isinstance(path, str):
                record[field['object']] = runtime_observation_path_value(observation, path)
        checked = accept_rules_v3_device_record(resolved, device_id, record)
        if checked is None:
            unavailable.append(device_id)
        else:
            accepted[device_id] = checked
    return accepted, unavailable


def rules_v3_acquisition_availability(resolved, accepted_records,
                                      acquisition_begun=True):
    """Tab5's acquisition result survives rejection of device measurements.

    Before the first PERMITTED acquisition attempt there is no evidence either
    way, so availability is left ABSENT rather than reported False. An absent
    field reads as unknown, and unknown neither advances nor resets an event's
    qualification - it freezes it. That is the whole correction: CPU B holds
    network traffic for a quiet period after boot while CPU A is already
    cycling, and reporting "unavailable" during that hold is a claim the device
    has not earned. It let availability events open on a reboot and close again
    once polling started.

    A blanket delay of event processing would be less safe. This leaves every
    protective event evaluating from the first real acquisition, so a lock is
    reasserted as promptly as before.

    acquisition_begun defaults True so an observation carrying no startup
    evidence behaves exactly as it did before this gate existed.
    """
    values = {}
    for device_id, device in resolved.get('devices', {}).items():
        if device.get('enabled') is not True:
            continue
        for field in device.get('fields', []):
            if field.get('object') == '$availability' and field.get('type') == 'boolean':
                accepted = device_id in accepted_records
                # Real evidence always wins: a device that answered is available
                # whatever the startup flag says.
                if not accepted and acquisition_begun is not True:
                    continue
                values[field['systemName']] = accepted
    return values


def new_rules_v3_calculation_state():
    return {'histories': {}, 'pumpRunning': {}}


def _rules_v3_linear_slope(history):
    if not isinstance(history, list) or len(history) < 2:
        return None
    try:
        origin = history[-1][0]
        points = [(time.ticks_diff(item[0], origin) / 1000.0, item[1])
                  for item in history]
        mean_x = sum(item[0] for item in points) / len(points)
        mean_y = sum(item[1] for item in points) / len(points)
        denominator = sum((item[0] - mean_x) ** 2 for item in points)
        if denominator <= 0:
            return None
        slope = (sum((item[0] - mean_x) * (item[1] - mean_y)
                     for item in points) / denominator) * 60.0
    except Exception:
        return None
    return slope if _v3_number(slope) else None


def _rules_v3_boyle_outputs(calculation, fields, state, now_ms, pump_field=None):
    """Evaluate the package's five positional Boyle outputs from real tick history."""
    parameters = calculation['parameters']
    outputs = calculation['outputs']
    names = [item['systemName'] for item in outputs]
    result = {names[4]: 'TANK_MODEL_INVALID'}
    histories = state.setdefault('histories', {})
    volume = parameters['effectiveTankGallons']
    precharge = parameters['prechargeGaugePsi']
    atmosphere = parameters['atmosphericPressurePsi']
    window_ms = int(parameters['regressionWindowSeconds'] * 1000)
    minimum_samples = parameters['minimumSamples']
    if (volume <= 0 or atmosphere <= 0 or precharge + atmosphere <= 0 or
            window_ms <= 0 or minimum_samples < 2):
        return result
    pressure = fields.get(calculation['inputs']['pressure'])
    if (not _v3_number(pressure) or pressure + atmosphere <= 0):
        histories[calculation['id']] = []
        result[names[4]] = 'PRESSURE_INVALID'
        return result
    try:
        air_gallons = volume * (precharge + atmosphere) / (pressure + atmosphere)
        water_gallons = volume - air_gallons
    except Exception:
        histories[calculation['id']] = []
        result[names[4]] = 'PRESSURE_INVALID'
        return result
    if (not _v3_number(air_gallons) or not _v3_number(water_gallons) or
            water_gallons < 0 or water_gallons > volume):
        histories[calculation['id']] = []
        result[names[4]] = 'PRESSURE_INVALID'
        return result
    result[names[0]] = water_gallons
    history = histories.setdefault(calculation['id'], [])
    # A pump transition puts a discontinuity inside the window: the manifold
    # steps about 1.5 PSI at a start, and at a stop the tank air begins shedding
    # the heat of its own compression. Neither is water moving. A regression
    # spanning one reports flow that is confidently wrong - inflow while the
    # tank is draining - and marks it VALID, which is worse than saying nothing.
    # Dropping the window leaves INSUFFICIENT_HISTORY standing until real
    # post-transition samples rebuild it.
    #
    # This cycle's sample goes with it. One cycle is not one instant: the ADC
    # burst, the switch read and the energy meter are three reads taken moments
    # apart, so on the edge cycle nothing says which side of the transition this
    # pressure came from. Gallons still stands - it is instantaneous, and true
    # whenever the pressure is - and only the slope needs clean provenance.
    #
    # Absent evidence is not a transition. A switch read that failed leaves the
    # field missing, and a missing field neither flushes the window nor advances
    # what is remembered, the same way an absent availability freezes an event
    # rather than resolving it.
    pump_states = state.setdefault('pumpRunning', {})
    running = fields.get(pump_field) if isinstance(pump_field, str) else None
    if isinstance(running, bool):
        previous = pump_states.get(calculation['id'])
        pump_states[calculation['id']] = running
        if isinstance(previous, bool) and previous != running:
            history[:] = []
            result[names[4]] = 'INSUFFICIENT_HISTORY'
            return result
    history.append((now_ms, pressure))
    tolerance_ms = 350
    history[:] = [item for item in history
                  if 0 <= time.ticks_diff(now_ms, item[0]) <= window_ms + tolerance_ms]
    if len(history) < minimum_samples:
        result[names[4]] = 'INSUFFICIENT_HISTORY'
        return result
    ordered = sorted(history, key=lambda item: time.ticks_diff(item[0], now_ms))
    ages = [time.ticks_diff(now_ms, item[0]) for item in ordered]
    # The oldest survivor lands wherever the cadence put it, so the window is
    # covered once it spans everything but the final sample interval. Requiring
    # coverage within tolerance of the window edge asked that sample to land in
    # a 700ms zone at a 2000ms cadence, and the timestamp carries the whole
    # acquisition burst - the ADC batch plus both Shelly reads - which reaches
    # well past that. Good windows were being discarded for their age alone.
    # Derived from the cadence, not written as a literal, for the same reason
    # SAMPLE_GAP_LIMIT_MS is.
    if max(ages) < max(0, window_ms - SAMPLE_PERIOD_MS - tolerance_ms):
        result[names[4]] = 'INSUFFICIENT_HISTORY'
        return result
    forward = ordered
    if any(time.ticks_diff(forward[index][0], forward[index - 1][0]) > SAMPLE_GAP_LIMIT_MS
           for index in range(1, len(forward))):
        result[names[4]] = 'SAMPLE_GAP'
        return result
    slope = _rules_v3_linear_slope(forward)
    if not _v3_number(slope):
        result[names[4]] = 'TREND_UNRESOLVED'
        return result
    try:
        dwater_dpressure = volume * (precharge + atmosphere) / ((pressure + atmosphere) ** 2)
        net_flow = dwater_dpressure * slope
    except Exception:
        result[names[4]] = 'TANK_MODEL_INVALID'
        return result
    if not _v3_number(dwater_dpressure) or not _v3_number(net_flow):
        result[names[4]] = 'TANK_MODEL_INVALID'
        return result
    result.update({names[1]: slope, names[2]: net_flow,
                   names[3]: max(0.0, -net_flow), names[4]: 'VALID'})
    return result


def evaluate_rules_v3_calculations(resolved, fields, state, now_ms):
    """Run the resolved V3 plan and preserve unavailable-input propagation."""
    values = dict(fields) if isinstance(fields, dict) else {}
    state = state if isinstance(state, dict) else new_rules_v3_calculation_state()
    for calculation in resolved.get('calculations', []):
        if calculation['kind'] == 'expression':
            required = calculation.get('_requiredTrueFields', ())
            value = (evaluate_runtime_program(calculation['program'], values)
                     if all(values.get(name) is True for name in required) else None)
            if _v3_number(value):
                values[calculation['output']['systemName']] = value
        elif calculation['kind'] == 'function':
            values.update(_rules_v3_boyle_outputs(
                calculation, values, state, now_ms,
                resolved.get('pumpRunningField')))
        else:
            raise ValueError('unsupported V3 calculation')
    return values, state


def start_rules_v3_runtime(path=RULES_V3_STAGED_FILE):
    """Adopt the last valid staged file only at process start with fresh state."""
    checked, reason = load_rules_v3_staged_package(path)
    if checked is None:
        return None, reason
    resolved = checked.get('resolved')
    if resolved is None:
        return None, 'release-runtime-unsupported'
    return {
        'package': checked['package'], 'reference': checked['reference'],
        'resolved': resolved, 'kernel': restart_rules_v3_kernel(resolved),
        'calculations': new_rules_v3_calculation_state(),
    }, None


def run_rules_v3_cycle(runtime, observation, now_ms, occurrences=None,
                       clear_event_ids=None, cycle_sequence=None,
                       observed_at=None, opening_uptime_ms=None):
    """Run one integrated atomic-input, calculation, snapshot, and V3 event cycle."""
    if not isinstance(runtime, dict) or not isinstance(observation, dict):
        raise ValueError('invalid V3 application cycle')
    resolved = runtime['resolved']
    device_records, unavailable = collect_rules_v3_device_records(resolved, observation)
    inputs = freeze_rules_v3_snapshot(resolved, device_records)
    # Absent means "no startup evidence recorded", which is the pre-gate
    # behaviour; only an explicit False holds availability at unknown.
    inputs.update(rules_v3_acquisition_availability(
        resolved, device_records,
        observation.get('status', {}).get('acquisition_begun') is not False))
    calculated, calculation_state = evaluate_rules_v3_calculations(
        resolved, inputs, runtime.get('calculations'), now_ms)
    snapshot = dict(calculated)  # one cycle image shared by every event
    kernel, actions, records = advance_rules_v3_kernel(
        resolved, runtime.get('kernel'), snapshot, now_ms,
        occurrences=occurrences, clear_event_ids=clear_event_ids)
    mode_target = resolved.get('operatingModeTarget')
    if isinstance(mode_target, str):
        snapshot[mode_target] = rules_v3_effective_mode(resolved, kernel)
    runtime['kernel'] = kernel
    runtime['calculations'] = calculation_state
    for record in records:
        if record.get('type') != 'open':
            continue
        state = kernel.get('events', {}).get(record.get('eventId'))
        event = next((item for item in resolved.get('events', [])
                      if item.get('id') == record.get('eventId')), None)
        if isinstance(state, dict) and isinstance(event, dict):
            opening = {'kind': _event_opening_kind(event),
                       'uptimeMs': (opening_uptime_ms
                                    if isinstance(opening_uptime_ms, int)
                                    else now_ms)}
            if isinstance(cycle_sequence, int) and cycle_sequence >= 0:
                opening['cycleSequence'] = cycle_sequence
            if isinstance(observed_at, str):
                opening['observedAt'] = observed_at
            state['opening'] = opening
    return {
        'snapshot': snapshot, 'actions': actions, 'records': records,
        'acceptedDeviceIds': list(device_records.keys()),
        'unavailableDeviceIds': unavailable,
    }


# Absent evidence, distinct from a clause this runtime cannot evaluate at all.
# Unknown participates in all/any; invalid poisons the whole condition, because a
# clause that could not be read must never be rescued by a definite sibling.
RULES_V3_UNKNOWN = ('unknown',)


def _rules_v3_clause_value(clause, fields, previous_fields, occurrences):
    """Evaluate one clause as True, False, RULES_V3_UNKNOWN, or None for invalid."""
    if not isinstance(clause, dict):
        return None
    name = clause.get('field')
    operator = clause.get('operator')
    expected = clause.get('value')
    if operator == 'occurs':
        return occurrences.get(name) is True
    current = fields.get(name)
    if current is None:
        return RULES_V3_UNKNOWN  # no evidence this cycle
    if operator == 'eq':
        return current == expected
    if operator == 'neq':
        return current != expected
    if operator in ('between', 'outside'):
        if (not isinstance(expected, list) or len(expected) != 2 or
                not all(_v3_number(item) for item in expected)):
            return None
        if not _v3_number(current):
            return None  # a declared number arrived unusable; not merely absent
        inside = expected[0] <= current <= expected[1]
        return inside if operator == 'between' else not inside
    if operator in ('changes', 'changes_from', 'changes_to'):
        previous = previous_fields.get(name)
        if previous is None:
            return RULES_V3_UNKNOWN  # present now, but no prior value to compare
        if operator == 'changes':
            return current != previous
        if operator == 'changes_from':
            return previous == expected and current != previous
        return current == expected and previous != current
    if operator not in ('lt', 'lte', 'gt', 'gte'):
        return None
    if not (_v3_number(current) and _v3_number(expected)):
        return None
    if operator == 'lt':
        return current < expected
    if operator == 'lte':
        return current <= expected
    if operator == 'gt':
        return current > expected
    return current >= expected


def rules_v3_condition_value(condition, fields, previous_fields=None, occurrences=None):
    """Evaluate a V3 condition as True, False, or unavailable (None).

    Three-valued across clauses: for all, one definite false decides regardless of
    what is unknown; for any, one definite true decides. Otherwise an unknown
    clause leaves the condition unavailable. A structurally invalid or
    unsupported clause still rejects the whole condition, unchanged.
    """
    if not isinstance(condition, dict) or not isinstance(fields, dict):
        return None
    clauses = condition.get('clauses')
    mode = condition.get('mode')
    if mode not in ('all', 'any') or not isinstance(clauses, list) or not clauses:
        return None
    previous_fields = previous_fields if isinstance(previous_fields, dict) else {}
    occurrences = occurrences if isinstance(occurrences, dict) else {}
    decisive = False if mode == 'all' else True
    saw_unknown = False
    saw_decisive = False
    for clause in clauses:
        result = _rules_v3_clause_value(clause, fields, previous_fields, occurrences)
        if result is None:
            return None  # invalid clauses are never outvoted
        if result is RULES_V3_UNKNOWN:
            saw_unknown = True
        elif result is decisive:
            saw_decisive = True
    if saw_decisive:
        return decisive
    if saw_unknown:
        return None
    return not decisive


def _new_rules_v3_event_state(event_id):
    return {
        'eventId': event_id, 'active': False, 'instanceId': None,
        'nextInstance': 1, 'openCount': 0, 'openSinceMs': None,
        'closeCount': 0, 'closeSinceMs': None, 'opening': None,
    }


def new_rules_v3_kernel(resolved):
    """Start one volatile V3 session with an empty event board and owner sets."""
    if not isinstance(resolved, dict):
        return None
    events = {}
    for event in resolved.get('events', []):
        events[event['id']] = _new_rules_v3_event_state(event['id'])
    return {
        'releaseId': resolved.get('releaseId'), 'events': events,
        'owners': {}, 'previousFields': {}, 'releasePending': False,
    }


def _copy_rules_v3_kernel(state, resolved):
    if not isinstance(state, dict) or not isinstance(resolved, dict):
        return new_rules_v3_kernel(resolved)
    events = {}
    for event in resolved.get('events', []):
        previous = state.get('events', {}).get(event['id'])
        events[event['id']] = (dict(previous) if isinstance(previous, dict)
                               else _new_rules_v3_event_state(event['id']))
    owners = {}
    for target, owned in state.get('owners', {}).items():
        if isinstance(owned, dict) and isinstance(owned.get('instances'), dict):
            owners[target] = {
                'value': owned.get('value'),
                'instances': dict(owned['instances']),
            }
    return {
        'releaseId': resolved.get('releaseId'), 'events': events,
        'owners': owners,
        'previousFields': dict(state.get('previousFields', {})),
        'releasePending': state.get('releasePending') is True,
    }


def _rules_v3_qualified(count, since_ms, condition, now_ms):
    return (isinstance(condition, dict) and
            count >= condition.get('observationCount', 0) and
            since_ms is not None and
            now_ms - since_ms >= int(condition.get('minimumSeconds', 0) * 1000))


def _rules_v3_open_value(event, fields, previous_fields, occurrences):
    trigger = event['opening']['trigger']
    if trigger['type'] == 'condition':
        return rules_v3_condition_value(
            trigger['condition'], fields, previous_fields, occurrences), trigger['condition']
    occurrence_field = trigger['occurrenceField']
    return occurrences.get(occurrence_field) is True, trigger['qualification']


def _rules_v3_phase_assignments(event, phase, fields, previous_fields, occurrences):
    selected = list(event[phase]['assignments'])
    for group in event[phase]['guardedGroups']:
        if rules_v3_condition_value(
                group['guard'], fields, previous_fields, occurrences) is True:
            selected.extend(group['assignments'])
    return selected


def _rules_v3_add_owner(state, target, value, instance_id, event_id):
    owned = state['owners'].get(target)
    if not isinstance(owned, dict):
        owned = {'value': value, 'instances': {}}
        state['owners'][target] = owned
    if owned.get('value') == value:
        owned['instances'][instance_id] = event_id


def _rules_v3_remove_owner(state, instance_id):
    empty = []
    for target, owned in state['owners'].items():
        owned.get('instances', {}).pop(instance_id, None)
        if not owned.get('instances'):
            empty.append(target)
    for target in empty:
        state['owners'].pop(target, None)


def _rules_v3_has_owner(state, target):
    owned = state.get('owners', {}).get(target)
    return isinstance(owned, dict) and bool(owned.get('instances'))


def rules_v3_effective_mode(resolved, state):
    target = resolved.get('operatingModeTarget') if isinstance(resolved, dict) else None
    return ('Monitor' if target is not None and _rules_v3_has_owner(state, target)
            else 'Normal')


def _rules_v3_action(target, value, reason, event_id=None, instance_id=None,
                     phase=None, ownership=None):
    action = {'target': target, 'value': value, 'reason': reason}
    if event_id is not None:
        action['eventId'] = event_id
    if instance_id is not None:
        action['eventInstanceId'] = instance_id
    if phase is not None:
        action['phase'] = phase
    if ownership is not None:
        action['ownership'] = ownership
    return action


def _rules_v3_append_action(actions, action):
    for existing in actions:
        if (existing.get('target') == action.get('target') and
                existing.get('value') == action.get('value')):
            return
    actions.append(action)


def advance_rules_v3_kernel(resolved, state, fields, now_ms,
                            occurrences=None, clear_event_ids=None):
    """Advance pure V3 selection; return state, selected actions, and records."""
    if (not isinstance(resolved, dict) or not isinstance(fields, dict) or
            not isinstance(now_ms, int) or isinstance(now_ms, bool)):
        raise ValueError('invalid V3 kernel input')
    next_state = _copy_rules_v3_kernel(state, resolved)
    previous_fields = next_state['previousFields']
    frozen = dict(resolved.get('initialFields', {}))
    frozen.update(fields)
    occurrences = occurrences if isinstance(occurrences, dict) else {}
    clear_all = clear_event_ids is True
    clear_ids = set(clear_event_ids if isinstance(clear_event_ids, (list, tuple, set)) else ())
    old_mode = rules_v3_effective_mode(resolved, next_state)
    # Decision one: the mode carried INTO the cycle selects what is evaluated. In
    # Monitor, non-monitor events are not evaluated at all - their active state,
    # owners and qualification counts are carried untouched, neither advanced nor
    # reset. Monitor-class events keep running so System Monitor can exit and
    # logging-only monitor events keep highlighting conditions.
    suspend_non_monitor = old_mode == 'Monitor'
    pump_target = resolved.get('pumpTarget')
    inhibition_target = resolved.get('inhibitionTarget')
    old_pump_owner = (pump_target is not None and
                      _rules_v3_has_owner(next_state, pump_target))
    actions = []
    records = []
    for event in resolved.get('events', []):
        event_state = next_state['events'][event['id']]
        if suspend_non_monitor and event.get('eventClass') != 'monitor':
            continue
        if event.get('enabled') is not True:
            if event_state.get('active') is True:
                instance_id = event_state.get('instanceId')
                _rules_v3_remove_owner(next_state, instance_id)
                records.append({
                    'type': 'close', 'reason': 'rule_disabled',
                    'eventId': event['id'], 'eventInstanceId': instance_id,
                    'atMs': now_ms})
                next_instance = event_state.get('nextInstance', 1)
                event_state = _new_rules_v3_event_state(event['id'])
                event_state['nextInstance'] = next_instance
                next_state['events'][event['id']] = event_state
            continue
        open_value, opening_qualification = _rules_v3_open_value(
            event, frozen, previous_fields, occurrences)
        if event_state.get('active') is not True:
            if open_value is True:
                if event_state['openCount'] == 0:
                    event_state['openSinceMs'] = now_ms
                event_state['openCount'] += 1
            elif open_value is False:
                event_state['openCount'] = 0
                event_state['openSinceMs'] = None
            if (open_value is True and _rules_v3_qualified(
                    event_state['openCount'], event_state['openSinceMs'],
                    opening_qualification, now_ms)):
                sequence = event_state['nextInstance']
                instance_id = '{}:{}:{}'.format(
                    resolved['releaseId'], event['id'], sequence)
                event_state['active'] = True
                event_state['instanceId'] = instance_id
                event_state['nextInstance'] = sequence + 1
                event_state['closeCount'] = 0
                event_state['closeSinceMs'] = None
                records.append({
                    'type': 'open', 'reason': 'opening_qualified',
                    'eventId': event['id'], 'eventInstanceId': instance_id,
                    'atMs': now_ms})
                for assignment in _rules_v3_phase_assignments(
                        event, 'onOpen', frozen, previous_fields, occurrences):
                    if assignment['ownership'] == 'whileOpen':
                        _rules_v3_add_owner(
                            next_state, assignment['target'], assignment['value'],
                            instance_id, event['id'])
                    elif (assignment['target'] == pump_target and
                          assignment['value'] is True):
                        next_state['releasePending'] = True
                    else:
                        _rules_v3_append_action(actions, _rules_v3_action(
                            assignment['target'], assignment['value'],
                            'event-transition', event['id'], instance_id,
                            'onOpen', assignment['ownership']))
            continue
        closing = event['closing']
        close_value = False
        close_qualification = None
        if closing['policy'] == 'condition':
            close_qualification = closing['condition']
            close_value = rules_v3_condition_value(
                close_qualification, frozen, previous_fields, occurrences)
            if open_value is True:
                close_value = False
        elif closing['policy'] == 'immediate':
            close_value = True
        elif closing['policy'] == 'clearEvents':
            close_value = clear_all or event['id'] in clear_ids
        close_now = False
        if closing['policy'] in ('immediate', 'clearEvents'):
            close_now = close_value is True
        elif close_value is True:
            if event_state['closeCount'] == 0:
                event_state['closeSinceMs'] = now_ms
            event_state['closeCount'] += 1
            close_now = _rules_v3_qualified(
                event_state['closeCount'], event_state['closeSinceMs'],
                close_qualification, now_ms)
        elif close_value is False:
            event_state['closeCount'] = 0
            event_state['closeSinceMs'] = None
        if close_now:
            instance_id = event_state['instanceId']
            _rules_v3_remove_owner(next_state, instance_id)
            for assignment in _rules_v3_phase_assignments(
                    event, 'onClose', frozen, previous_fields, occurrences):
                if assignment['target'] == pump_target and assignment['value'] is True:
                    next_state['releasePending'] = True
                else:
                    _rules_v3_append_action(actions, _rules_v3_action(
                        assignment['target'], assignment['value'],
                        'event-transition', event['id'], instance_id,
                        'onClose', assignment['ownership']))
            records.append({
                'type': 'close',
                'reason': ('clear_events' if closing['policy'] == 'clearEvents'
                           else 'closing_qualified'),
                'eventId': event['id'], 'eventInstanceId': instance_id,
                'atMs': now_ms})
            next_instance = event_state['nextInstance']
            event_state = _new_rules_v3_event_state(event['id'])
            event_state['nextInstance'] = next_instance
            next_state['events'][event['id']] = event_state
    new_mode = rules_v3_effective_mode(resolved, next_state)
    mode_target = resolved.get('operatingModeTarget')
    if mode_target is not None and new_mode != old_mode:
        _rules_v3_append_action(actions, _rules_v3_action(
            mode_target, new_mode, 'effective-mode'))
    if new_mode == 'Monitor' and pump_target is not None:
        actions = [item for item in actions if item.get('target') != pump_target]
    new_pump_owner = (pump_target is not None and
                      _rules_v3_has_owner(next_state, pump_target))
    if old_pump_owner and not new_pump_owner:
        next_state['releasePending'] = True
    if old_mode == 'Normal' and new_mode == 'Monitor' and old_pump_owner:
        next_state['releasePending'] = True
    if new_mode == 'Normal' and new_pump_owner:
        next_state['releasePending'] = False
        if frozen.get(pump_target) is not False:
            _rules_v3_append_action(actions, _rules_v3_action(
                pump_target, False, 'active-ownership'))
    elif next_state['releasePending'] is True:
        lock_field = resolved.get('lockField')
        current = frozen.get(pump_target)
        lock_value = frozen.get(lock_field) if lock_field is not None else None
        if isinstance(current, bool) and lock_value == 0:
            if current is False:
                normal_value = resolved['writableTargets'][pump_target]['normalValue']
                _rules_v3_append_action(actions, _rules_v3_action(
                    pump_target, normal_value, 'owner-release'))
            else:
                next_state['releasePending'] = False
    if inhibition_target is not None:
        # Decision two: the mode and ownership resulting from THIS cycle select the
        # final flag value, and this reconciliation is authoritative. Any other
        # action for this target is removed first: the ordinary collapse prefers a
        # non-normal value, whose normal value here is false, so appending a
        # release beside an inhibit would silently keep the inhibit. Only this
        # target is reconciled; unrelated transition assignments keep their own
        # established behavior.
        actions = [item for item in actions
                   if item.get('target') != inhibition_target]
        desired = (False if new_mode == 'Monitor'
                   else _rules_v3_has_owner(next_state, inhibition_target))
        observed = frozen.get(inhibition_target)
        if isinstance(observed, bool) and observed is not desired:
            _rules_v3_append_action(actions, _rules_v3_action(
                inhibition_target, desired,
                'monitor-release' if new_mode == 'Monitor' else
                'active-ownership' if desired else 'owner-release'))
    for name, value in frozen.items():
        if value is not None:
            next_state['previousFields'][name] = value
    return next_state, actions, records


def restart_rules_v3_kernel(resolved):
    """Create the deliberate restart boundary: no board, owners, or blind enable."""
    return new_rules_v3_kernel(resolved)


def _is_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return value == value and value - value == 0
    except Exception:
        return False


def operational_pump_state(power_w, shelly_available, shelly_age_ms):
    """Return an observational pump state derived only from fresh EM power."""
    if not shelly_available:
        return 'UNAVAILABLE'
    if (_is_number(shelly_age_ms) and
            shelly_age_ms > STALE_AFTER_MS):
        return 'UNAVAILABLE'
    if not _is_number(power_w):
        return 'UNAVAILABLE'
    return 'RUNNING' if power_w >= PUMP_RUNNING_THRESHOLD_W else 'STOPPED'


def pressure_hmi_value(ads_raw_count, commissioned=PRESSURE_SENSOR_COMMISSIONED):
    """Gate displayed PSI on explicit sensor commissioning, not ADC presence."""
    if not commissioned:
        return None, 'NOT COMMISSIONED'
    if not _is_number(ads_raw_count):
        return None, 'UNAVAILABLE'
    pressure_psi = calibrated_psi_from_raw_count(ads_raw_count)
    if (pressure_psi is None or pressure_psi < 0 or
            pressure_psi > PRESSURE_SENSOR_SPAN_PSI):
        return None, 'UNAVAILABLE'
    return pressure_psi, 'VALID'


def enabled_rule_count(rules_package):
    """Count only explicit enabled events in an adopted v2 package."""
    if not isinstance(rules_package, dict):
        return 0
    events = rules_package.get('events')
    if not isinstance(events, list):
        return 0
    return sum(1 for event in events
               if isinstance(event, dict) and event.get('enabled') is True)


def rules_alignment_status(adopted_reference, published_reference):
    """Never report ACTIVE without matching version and complete SHA-256 hash."""
    if not isinstance(adopted_reference, dict):
        return 'UNAVAILABLE'
    if not isinstance(published_reference, dict):
        return 'PUBLISHED UNKNOWN'
    adopted_hash = adopted_reference.get('contentHash')
    published_hash = published_reference.get('contentHash')
    if (adopted_reference.get('packageVersion', adopted_reference.get('version')) ==
            published_reference.get('packageVersion', published_reference.get('version')) and
            isinstance(adopted_hash, str) and len(adopted_hash) == 64 and
            adopted_hash == published_hash):
        return 'ACTIVE'
    return 'MISMATCH'


def shelly_local_lock_status(shelly1_available, reported_lock=None):
    """Display only current script-supplied lock evidence."""
    if not shelly1_available:
        return 'UNAVAILABLE'
    if isinstance(reported_lock, int) and not isinstance(reported_lock, bool):
        if reported_lock == -1:
            return 'FULL LOCKOUT'
        if reported_lock == 0:
            return 'NORMAL'
        if reported_lock > 0:
            return 'TEMP {}s'.format(reported_lock)
    return 'UNKNOWN'


def source_age_ms(status, last_ticks_key, stored_age_key, current_ticks_ms):
    """Prefer an actual source timestamp; retain older-record compatibility."""
    last_ticks_ms = status.get(last_ticks_key)
    if _is_number(current_ticks_ms) and _is_number(last_ticks_ms):
        return sample_age_ms(current_ticks_ms, last_ticks_ms)
    stored_age_ms = status.get(stored_age_key)
    return stored_age_ms if _is_number(stored_age_ms) else None


def compact_age_text(age_ms):
    """Fit three independently measured ages in one large-font HMI field."""
    if not _is_number(age_ms):
        return '--'
    if age_ms < 1000:
        return '<1s'
    seconds = int(age_ms / 1000)
    return '{}s'.format(seconds) if seconds <= 99 else '99+s'


def transport_age_ms(transport_status, key, current_ticks_ms):
    if not isinstance(transport_status, dict):
        return None
    ticks_ms = transport_status.get(key)
    if not (_is_number(current_ticks_ms) and _is_number(ticks_ms)):
        return None
    return sample_age_ms(current_ticks_ms, ticks_ms)


def cloud_indicator_state(transport_status, current_ticks_ms,
                          wifi_connected, network_ready):
    """Summarize confirmed CPU B responses without treating queueing as success."""
    if not wifi_connected:
        return 'red'
    if not network_ready:
        return 'yellow'
    if not isinstance(transport_status, dict):
        return 'yellow'

    telemetry_age_ms = transport_age_ms(
        transport_status, 'telemetryLastSuccessTicksMs', current_ticks_ms)
    rtdb_age_ms = transport_age_ms(
        transport_status, 'rtdbLastSuccessTicksMs', current_ticks_ms)
    telemetry_ok = transport_status.get('telemetryLastAttemptOk')
    rtdb_ok = transport_status.get('rtdbLastAttemptOk')
    queue_depth = transport_status.get('durableQueueDepth')
    queue_depth = queue_depth if isinstance(queue_depth, int) else 0

    if ((telemetry_ok is False and telemetry_age_ms is None) or
            (rtdb_ok is False and rtdb_age_ms is None) or
            (_is_number(telemetry_age_ms) and
             telemetry_age_ms > CLOUD_FAILED_RED_MS) or
            (_is_number(rtdb_age_ms) and
             rtdb_age_ms > CLOUD_FAILED_RED_MS)):
        return 'red'
    if (_is_number(telemetry_age_ms) and
            telemetry_age_ms <= CLOUD_TELEMETRY_FRESH_MS and
            _is_number(rtdb_age_ms) and
            rtdb_age_ms <= CLOUD_RTDB_FRESH_MS and
            telemetry_ok is not False and rtdb_ok is not False and
            queue_depth == 0):
        return 'green'
    return 'yellow'


def cloud_detail_text(transport_status, current_ticks_ms):
    telemetry_age = transport_age_ms(
        transport_status, 'telemetryLastSuccessTicksMs', current_ticks_ms)
    rtdb_age = transport_age_ms(
        transport_status, 'rtdbLastSuccessTicksMs', current_ticks_ms)
    queue_depth = (transport_status.get('durableQueueDepth')
                   if isinstance(transport_status, dict) else None)
    queue_capacity = (transport_status.get('durableQueueCapacity')
                      if isinstance(transport_status, dict) else None)
    queue_text = ('{}/{}'.format(queue_depth, queue_capacity)
                  if isinstance(queue_depth, int) and
                  isinstance(queue_capacity, int) else '--')
    telemetry_result = (transport_status.get('telemetryLastAttemptOk')
                        if isinstance(transport_status, dict) else None)
    rtdb_result = (transport_status.get('rtdbLastAttemptOk')
                   if isinstance(transport_status, dict) else None)
    telemetry_text = ('OK' if telemetry_result is True else
                      'ERR' if telemetry_result is False else 'WAIT')
    rtdb_text = ('OK' if rtdb_result is True else
                 'ERR' if rtdb_result is False else 'WAIT')
    return 'CLOUD {} {}  RTDB {} {}  Q{}'.format(
        telemetry_text, compact_age_text(telemetry_age),
        rtdb_text, compact_age_text(rtdb_age), queue_text)


def build_now_hmi_model(observation, transport_status=None,
                        current_ticks_ms=None):
    """Create the small current-state view without retaining mutable input."""
    if not isinstance(observation, dict):
        observation = {}
    values = observation.get('values')
    status = observation.get('status')
    values = values if isinstance(values, dict) else {}
    status = status if isinstance(status, dict) else {}
    if not _is_number(current_ticks_ms):
        current_ticks_ms = observation.get('observedTicksMs')
    shelly_age_ms = source_age_ms(
        status, 'shelly_last_valid_ticks_ms', 'shelly_age_ms',
        current_ticks_ms)
    shelly1_age_ms = source_age_ms(
        status, 'shelly1_last_valid_ticks_ms', 'shelly1_age_ms',
        current_ticks_ms)
    adc_age_ms = source_age_ms(
        status, 'adc_last_valid_ticks_ms', 'adc_age_ms',
        current_ticks_ms)
    pressure_psi, pressure_status = pressure_hmi_value(
        values.get('adc_raw'))
    shelly1_available = status.get('shelly1_available') is True
    sw0 = values.get('shelly1_sw0')
    rly0 = values.get('shelly1_rly0')
    if shelly1_available and isinstance(sw0, bool) and isinstance(rly0, bool):
        shelly1_text = 'SW0 {}  RLY0 {}'.format(
            'ON' if sw0 else 'OFF', 'ON' if rly0 else 'OFF')
    else:
        shelly1_text = 'UNAVAILABLE'
    return {
        'pump_state': operational_pump_state(
            values.get('power'), status.get('shelly_available') is True,
            shelly_age_ms),
        'power_w': values.get('power') if _is_number(values.get('power')) else None,
        'voltage_v': values.get('voltage') if _is_number(values.get('voltage')) else None,
        'pressure_psi': pressure_psi,
        'pressure_status': pressure_status,
        'shelly1': shelly1_text,
        'shelly_lock': shelly_local_lock_status(
            shelly1_available, values.get('shelly1_lock')),
        'shelly_age_ms': shelly_age_ms,
        'shelly1_age_ms': shelly1_age_ms,
        'adc_age_ms': adc_age_ms,
        'age_text': 'EM {}  S1 {}  ADC {}'.format(
            compact_age_text(shelly_age_ms),
            compact_age_text(shelly1_age_ms),
            compact_age_text(adc_age_ms)),
        'wifi_connected': status.get('wifi_connected') is True,
        'network_ready': status.get('network_traffic_allowed') is True,
        'wifi_indicator': ('green'
                           if status.get('network_traffic_allowed') is True
                           else 'yellow'
                           if status.get('wifi_connected') is True else 'red'),
        'cloud_indicator': cloud_indicator_state(
            transport_status, current_ticks_ms,
            status.get('wifi_connected') is True,
            status.get('network_traffic_allowed') is True),
        'adc_indicator': ('green'
                          if status.get('adc_available') is True and
                          _is_number(adc_age_ms) and adc_age_ms <= STALE_AFTER_MS
                          else 'yellow'
                          if _is_number(adc_age_ms) and
                          adc_age_ms <= STALE_AFTER_MS else 'red'),
        'event_engine': status.get('rules_runtime_state', 'UNAVAILABLE'),
    }


def build_system_hmi_model(observation, adopted_reference, rules_package,
                           published_reference=None, transport_status=None,
                           current_ticks_ms=None):
    """Create truthful V3 runtime status without adding HMI control commands."""
    if not isinstance(observation, dict):
        observation = {}
    values = observation.get('values')
    status = observation.get('status')
    values = values if isinstance(values, dict) else {}
    status = status if isinstance(status, dict) else {}
    if not _is_number(current_ticks_ms):
        current_ticks_ms = observation.get('observedTicksMs')
    battery_available = status.get('battery_available') is True
    battery_age_ms = source_age_ms(
        status, 'battery_sample_ticks_ms', 'battery_age_ms', current_ticks_ms)
    adopted_hash = (adopted_reference.get('contentHash')
                    if isinstance(adopted_reference, dict) else None)
    published_hash = (published_reference.get('contentHash')
                      if isinstance(published_reference, dict) else None)
    return {
        'release': SOFTWARE_RELEASE,
        'collection': 'ACTIVE',
        'rule_engine': ('V3 RUNNING' if isinstance(adopted_reference, dict)
                        else 'RULES UNAVAILABLE'),
        'system_override': 'NOT AVAILABLE',
        'wifi': 'UP' if status.get('wifi_connected') is True else 'DOWN',
        'network': ('READY' if status.get('network_traffic_allowed') is True
                    else 'QUIET'),
        'cloud_state': cloud_indicator_state(
            transport_status, current_ticks_ms,
            status.get('wifi_connected') is True,
            status.get('network_traffic_allowed') is True),
        'cloud_detail': cloud_detail_text(
            transport_status, current_ticks_ms),
        'shelly_em': ('AVAILABLE' if status.get('shelly_available') is True
                      else 'UNAVAILABLE'),
        'shelly1': ('AVAILABLE' if status.get('shelly1_available') is True
                    else 'UNAVAILABLE'),
        'adc': ('AVAILABLE' if status.get('adc_available') is True
                else 'UNAVAILABLE'),
        'pressure': ('COMMISSIONED' if PRESSURE_SENSOR_COMMISSIONED
                     else 'NOT COMMISSIONED'),
        'battery_voltage': (values.get('battery_voltage')
                            if battery_available and
                            _is_number(values.get('battery_voltage')) else None),
        'battery_current': (values.get('battery_current')
                            if battery_available and
                            _is_number(values.get('battery_current')) else None),
        'battery_percent': (values.get('battery_percent')
                            if battery_available and
                            _is_number(values.get('battery_percent')) else None),
        'battery_charging': (values.get('battery_charging')
                             if battery_available and
                             isinstance(values.get('battery_charging'), bool)
                             else None),
        'battery_request': (values.get('battery_charge_enabled')
                            if isinstance(values.get('battery_charge_enabled'), bool)
                            else None),
        'battery_available': battery_available,
        'battery_age_ms': battery_age_ms,
        'battery_read_status': ('OK' if battery_available else 'READ FAILED'),
        'cycle_work_ms': status.get('cycle_work_ms'),
        'cycle_interval_ms': status.get('cycle_interval_ms'),
        'adc_acquisition_ms': status.get('adc_acquisition_ms'),
        'shelly_em_acquisition_ms': status.get('shelly_em_acquisition_ms'),
        'shelly1_acquisition_ms': status.get('shelly1_acquisition_ms'),
        'v3_processing_ms': status.get('v3_processing_ms'),
        'heap_free_bytes': status.get('heap_free_bytes'),
        'heap_allocated_bytes': status.get('heap_allocated_bytes'),
        'heap_min_free_bytes': status.get('heap_min_free_bytes'),
        'adopted_version': (adopted_reference.get('version')
                            if isinstance(adopted_reference, dict) else None),
        'adopted_hash_prefix': (adopted_hash[:12]
                                if isinstance(adopted_hash, str) else None),
        'published_version': (published_reference.get('version')
                              if isinstance(published_reference, dict) else None),
        'published_hash_prefix': (published_hash[:12]
                                  if isinstance(published_hash, str) else None),
        'rules_status': rules_alignment_status(
            adopted_reference, published_reference),
        'enabled_rules': enabled_rule_count(rules_package),
    }


def build_events_hmi_model(observation):
    """Show event, deliberate Monitor, restart, and Shelly lock evidence."""
    if not isinstance(observation, dict):
        observation = {}
    status = observation.get('status')
    status = status if isinstance(status, dict) else {}
    shelly1_available = status.get('shelly1_available') is True
    values = observation.get('values')
    values = values if isinstance(values, dict) else {}
    active = status.get('v3_active_event_ids')
    active = active if isinstance(active, list) else None
    return {
        'event_engine': status.get('rules_runtime_state', 'UNAVAILABLE'),
        'active_events': (', '.join(active) if active else
                          'NONE' if active is not None else 'UNAVAILABLE'),
        'user_monitor': ('USER' if status.get('user_monitor_active') is True
                         else 'SYSTEM' if status.get('monitor_mode_active') is True
                         else 'NORMAL'),
        'relay_restoration': status.get(
            'tab5_relay_restoration', 'not-applicable').upper(),
        'shelly_lock': shelly_local_lock_status(
            shelly1_available, values.get('shelly1_lock')),
        'shelly_lockout_count': (values.get('shelly1_lockout_count')
                                 if shelly1_available else None),
        'control_status': status.get('operator_control_status', 'READY'),
        'staged_restart_adoption': status.get('staged_restart_adoption'),
    }


# --- display --- (main.py already ran M5.begin() before starting CPU A)
M5.Lcd.setRotation(1)
M5.Lcd.fillScreen(BG)


def draw_label(text, x, y, font, color, bg=BG):
    M5.Lcd.setFont(font)
    M5.Lcd.setTextColor(color, bg)
    M5.Lcd.drawString(text, x, y)


HMI_PAGE_NOW = 'now'
HMI_PAGE_SYSTEM = 'system'
HMI_PAGE_EVENTS = 'events'
NAV_Y, NAV_H = 630, 70
NAV_NOW_X, NAV_SYSTEM_X, NAV_EVENTS_X, NAV_W = 35, 450, 865, 380
CONTROL_Y, CONTROL_H, CONTROL_W = 405, 92, 360
CONTROL_MONITOR_X, CONTROL_TAB5_X, CONTROL_SHELLY_X = 45, 460, 875
_last_rendered_page = None
_field_cache = {}
operator_armed_action = None
operator_armed_until_ms = None
operator_local_pending_action = None
operator_control_status = 'READY'
shelly_restart_pending = None
tab5_restart_due_ms = None


def operator_control_at(x, y, page):
    if page != HMI_PAGE_EVENTS or not (_is_number(x) and _is_number(y)):
        return None
    if not CONTROL_Y <= y <= CONTROL_Y + CONTROL_H:
        return None
    if CONTROL_MONITOR_X <= x <= CONTROL_MONITOR_X + CONTROL_W:
        return 'enter-user-monitor'
    if CONTROL_TAB5_X <= x <= CONTROL_TAB5_X + CONTROL_W:
        return 'restart-tab5'
    if CONTROL_SHELLY_X <= x <= CONTROL_SHELLY_X + CONTROL_W:
        return 'restart-shelly1'
    return None


def arm_operator_control(action, now_ms, armed_action, armed_until_ms,
                         busy=False):
    """Require two distinct taps of one action inside a short window."""
    if busy or action not in (
            'enter-user-monitor', 'restart-tab5', 'restart-shelly1'):
        return armed_action, armed_until_ms, None
    if (armed_action == action and isinstance(armed_until_ms, int) and
            time.ticks_diff(armed_until_ms, now_ms) >= 0):
        return None, None, action
    return action, time.ticks_add(now_ms, OPERATOR_CONFIRM_WINDOW_MS), None


def operator_button_label(action):
    labels = {
        'enter-user-monitor': 'USER MONITOR',
        'restart-tab5': 'RESTART TAB5',
        'restart-shelly1': 'RESTART SHELLY 1',
    }
    label = labels.get(action, action)
    return '{} - TAP AGAIN'.format(label) if operator_armed_action == action else label


def navigation_page_at(x, y):
    """Return the selected implemented page, or None outside navigation."""
    if not (_is_number(x) and _is_number(y) and NAV_Y <= y <= NAV_Y + NAV_H):
        return None
    if NAV_NOW_X <= x <= NAV_NOW_X + NAV_W:
        return HMI_PAGE_NOW
    if NAV_SYSTEM_X <= x <= NAV_SYSTEM_X + NAV_W:
        return HMI_PAGE_SYSTEM
    if NAV_EVENTS_X <= x <= NAV_EVENTS_X + NAV_W:
        return HMI_PAGE_EVENTS
    return None


def _draw_field(text, x, y, width, height, font, color=WHITE,
                cache_key=None):
    state = (text, color)
    if cache_key is not None and _field_cache.get(cache_key) == state:
        return False
    M5.Lcd.fillRect(x, y, width, height, BG)
    draw_label(text, x, y, font, color)
    if cache_key is not None:
        _field_cache[cache_key] = state
    return True


def _indicator_color(state):
    if state == 'green':
        return GREEN
    if state == 'red':
        return RED
    return YELLOW


def _draw_communications(model):
    state = (model['wifi_indicator'], model['cloud_indicator'],
             model['adc_indicator'])
    if _field_cache.get('now.communications') == state:
        return False
    M5.Lcd.fillRect(665, 498, 570, 55, BG)
    draw_label('WiFi', 665, 498, M5.Lcd.FONTS.DejaVu40,
               _indicator_color(model['wifi_indicator']))
    draw_label('Cloud', 825, 498, M5.Lcd.FONTS.DejaVu40,
               _indicator_color(model['cloud_indicator']))
    draw_label('ADC', 1060, 498, M5.Lcd.FONTS.DejaVu40,
               _indicator_color(model['adc_indicator']))
    _field_cache['now.communications'] = state
    return True


def _draw_navigation(page):
    now_color = GREEN if page == HMI_PAGE_NOW else BLUE
    system_color = GREEN if page == HMI_PAGE_SYSTEM else BLUE
    events_color = GREEN if page == HMI_PAGE_EVENTS else BLUE
    M5.Lcd.fillRoundRect(NAV_NOW_X, NAV_Y, NAV_W, NAV_H, 14, now_color)
    M5.Lcd.fillRoundRect(NAV_SYSTEM_X, NAV_Y, NAV_W, NAV_H, 14, system_color)
    M5.Lcd.fillRoundRect(NAV_EVENTS_X, NAV_Y, NAV_W, NAV_H, 14, events_color)
    draw_label('NOW', NAV_NOW_X + 145, NAV_Y + 20,
               M5.Lcd.FONTS.Montserrat24, WHITE, bg=now_color)
    draw_label('SYSTEM', NAV_SYSTEM_X + 125, NAV_Y + 20,
               M5.Lcd.FONTS.Montserrat24, WHITE, bg=system_color)
    draw_label('EVENTS', NAV_EVENTS_X + 125, NAV_Y + 20,
               M5.Lcd.FONTS.Montserrat24, WHITE, bg=events_color)


def _draw_page_frame(page):
    _field_cache.clear()
    M5.Lcd.fillScreen(BG)
    title = ('WELL PUMP - NOW' if page == HMI_PAGE_NOW else
             'WELL PUMP - EVENTS' if page == HMI_PAGE_EVENTS else
             'WELL PUMP - SYSTEM')
    draw_label(title, 40, 22, M5.Lcd.FONTS.DejaVu40, WHITE)
    draw_label('{}  V3 PILOT'.format(SOFTWARE_RELEASE), 965, 36,
               M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_navigation(page)


def render_now(model):
    pump_color = (GREEN if model['pump_state'] == 'RUNNING'
                  else WHITE if model['pump_state'] == 'STOPPED' else YELLOW)
    draw_label('PUMP', 45, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field(model['pump_state'], 45, 128, 560, 55,
                M5.Lcd.FONTS.DejaVu40, pump_color, 'now.pump')

    draw_label('PRESSURE', 665, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    pressure_text = ('{:.2f} PSI'.format(model['pressure_psi'])
                     if model['pressure_psi'] is not None
                     else model['pressure_status'])
    pressure_color = WHITE if model['pressure_psi'] is not None else YELLOW
    _draw_field(pressure_text, 665, 128, 570, 55,
                M5.Lcd.FONTS.DejaVu40, pressure_color, 'now.pressure')

    draw_label('POWER', 45, 215, M5.Lcd.FONTS.Montserrat18, CYAN)
    power_text = ('{:.0f} W'.format(model['power_w'])
                  if model['power_w'] is not None else 'UNAVAILABLE')
    _draw_field(power_text, 45, 248, 560, 55, M5.Lcd.FONTS.DejaVu40,
                cache_key='now.power')
    draw_label('VOLTAGE', 665, 215, M5.Lcd.FONTS.Montserrat18, CYAN)
    voltage_text = ('{:.1f} V'.format(model['voltage_v'])
                    if model['voltage_v'] is not None else 'UNAVAILABLE')
    _draw_field(voltage_text, 665, 248, 570, 55, M5.Lcd.FONTS.DejaVu40,
                cache_key='now.voltage')

    draw_label('SHELLY 1', 45, 340, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field(model['shelly1'], 45, 373, 560, 55,
                M5.Lcd.FONTS.DejaVu40, cache_key='now.shelly1')
    draw_label('SHELLY LOCAL LOCK', 665, 340, M5.Lcd.FONTS.Montserrat18, CYAN)
    lock_color = RED if model['shelly_lock'] == 'LOCKED' else YELLOW
    _draw_field(model['shelly_lock'], 665, 373, 570, 55,
                M5.Lcd.FONTS.DejaVu40, lock_color, 'now.shelly_lock')

    draw_label('DATA AGE', 45, 465, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field(model['age_text'], 45, 498, 560, 55,
                M5.Lcd.FONTS.DejaVu40, cache_key='now.data_age')
    draw_label('COMMUNICATIONS', 665, 465, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_communications(model)
    _draw_field('EVENT ENGINE: {}'.format(model['event_engine']), 45, 575, 1190, 35,
                M5.Lcd.FONTS.Montserrat24, YELLOW, 'now.event')


def render_system(model):
    def ms(value):
        return '{}ms'.format(value) if isinstance(value, int) else '--'

    draw_label('RUNTIME / DEVICES', 45, 88, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field('{}  |  COLLECTION {}'.format(
        model['rule_engine'], model['collection']), 45, 118, 570, 30,
        M5.Lcd.FONTS.Montserrat18, YELLOW, 'system.runtime')
    _draw_field('WIFI {} NET {}  EM {}  S1 {}'.format(
        model['wifi'], model['network'], model['shelly_em'], model['shelly1']),
        45, 153, 570, 30, M5.Lcd.FONTS.Montserrat18,
        cache_key='system.devices1')
    _draw_field('ADC {}  PSI {}'.format(model['adc'], model['pressure']),
                45, 188, 570, 30, M5.Lcd.FONTS.Montserrat18,
                cache_key='system.devices2')
    _draw_field(model['cloud_detail'], 45, 223, 570, 30,
                M5.Lcd.FONTS.Montserrat18,
                _indicator_color(model['cloud_state']), 'system.cloud')

    draw_label('RULES PACKAGE', 45, 270, M5.Lcd.FONTS.Montserrat18, CYAN)
    adopted = 'RUNNING v{} {}'.format(
        model['adopted_version'] if model['adopted_version'] is not None else '?',
        model['adopted_hash_prefix'] or 'UNKNOWN')
    published = 'PUBLISHED v{} {}'.format(
        model['published_version'] if model['published_version'] is not None else '?',
        model['published_hash_prefix'] or 'UNKNOWN')
    _draw_field(adopted, 45, 300, 570, 30, M5.Lcd.FONTS.Montserrat18,
                cache_key='system.adopted')
    _draw_field(published, 45, 335, 570, 30, M5.Lcd.FONTS.Montserrat18,
                cache_key='system.published')
    rules_color = GREEN if model['rules_status'] == 'ACTIVE' else YELLOW
    _draw_field('STATUS {}  |  ENABLED {}'.format(
        model['rules_status'], model['enabled_rules']),
        45, 370, 570, 30, M5.Lcd.FONTS.Montserrat18, rules_color,
        'system.rules_status')

    draw_label('BATTERY (UIFLOW)', 665, 88, M5.Lcd.FONTS.Montserrat18, CYAN)
    if model['battery_available']:
        battery_measurement = '{:.3f} V   {:+.3f} A'.format(
            model['battery_voltage'], model['battery_current'])
        charge_status = ('CHARGING' if model['battery_charging'] is True
                         else 'NOT CHARGING')
        battery_state = 'EST {}%  |  {}'.format(
            int(model['battery_percent']), charge_status)
        battery_read = 'READ OK  AGE {}'.format(
            compact_age_text(model['battery_age_ms']))
    else:
        battery_measurement = 'VOLTAGE --   CURRENT --'
        battery_state = 'EST --%  |  CHARGE STATUS UNKNOWN'
        last_good = compact_age_text(model['battery_age_ms'])
        battery_read = 'READ FAILED  |  LAST GOOD {}'.format(last_good)
    request_text = ('ENABLED' if model['battery_request'] is True else
                    'DISABLED' if model['battery_request'] is False else 'UNKNOWN')
    _draw_field(battery_measurement, 665, 118, 570, 30,
                M5.Lcd.FONTS.Montserrat18, cache_key='system.battery1')
    _draw_field(battery_state, 665, 153, 570, 30,
                M5.Lcd.FONTS.Montserrat18, cache_key='system.battery2')
    _draw_field('SOFTWARE REQUEST {}'.format(request_text), 665, 188, 570, 30,
                M5.Lcd.FONTS.Montserrat18, cache_key='system.battery3')
    _draw_field(battery_read, 665, 223, 570, 30,
                M5.Lcd.FONTS.Montserrat18,
                WHITE if model['battery_available'] else YELLOW,
                'system.battery4')

    draw_label('LOOP TIMING', 665, 270, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field('WORK LAST {}  INTERVAL {}'.format(
        ms(model['cycle_work_ms']), ms(model['cycle_interval_ms'])),
        665, 300, 570, 30, M5.Lcd.FONTS.Montserrat18,
        cache_key='system.timing1')
    _draw_field('ADC {}  EM {}  S1 {}'.format(
        ms(model['adc_acquisition_ms']), ms(model['shelly_em_acquisition_ms']),
        ms(model['shelly1_acquisition_ms'])),
        665, 335, 570, 30, M5.Lcd.FONTS.Montserrat18,
        cache_key='system.timing2')
    _draw_field('V3 CALC/EVENT {}'.format(ms(model['v3_processing_ms'])),
                665, 370, 570, 30, M5.Lcd.FONTS.Montserrat18,
                cache_key='system.timing3')

    draw_label('MICROPYTHON HEAP', 45, 430, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field('FREE {} B  MIN {} B  ALLOC {} B'.format(
        model['heap_free_bytes'] if isinstance(model['heap_free_bytes'], int) else '--',
        model['heap_min_free_bytes'] if isinstance(model['heap_min_free_bytes'], int) else '--',
        model['heap_allocated_bytes'] if isinstance(model['heap_allocated_bytes'], int) else '--'),
        45, 460, 1190, 30, M5.Lcd.FONTS.Montserrat18,
        cache_key='system.heap')
    _draw_field('WORK EXCLUDES SCHEDULED WAIT  |  RELEASE {}'.format(model['release']),
                45, 510, 1190, 30, M5.Lcd.FONTS.Montserrat18, CYAN,
                'system.release')
    _draw_field('HEAP COUNTERS EXCLUDE NATIVE/DEVICE MEMORY',
                45, 555, 1190, 30, M5.Lcd.FONTS.Montserrat18, CYAN,
                'system.footer')


def render_events(model):
    draw_label('ACTIVE EVENTS', 45, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field('ENGINE: {}'.format(model['event_engine']),
                45, 128, 570, 42, M5.Lcd.FONTS.Montserrat24, YELLOW,
                'events.engine')
    _draw_field('ACTIVE LIST: {}'.format(model['active_events']),
                45, 180, 570, 42, M5.Lcd.FONTS.Montserrat24, YELLOW,
                'events.active')

    draw_label('USER MONITOR', 665, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    monitor_color = RED if model['user_monitor'] == 'ACTIVE' else GREEN
    _draw_field('{}  RELAY {}'.format(
        model['user_monitor'], model['relay_restoration']),
        665, 128, 570, 55, M5.Lcd.FONTS.Montserrat24, monitor_color,
        'events.monitor')

    draw_label('SHELLY LOCAL LOCK', 45, 265,
               M5.Lcd.FONTS.Montserrat18, CYAN)
    lock_color = (GREEN if model['shelly_lock'] == 'NORMAL' else RED
                  if model['shelly_lock'] in ('FULL LOCKOUT', 'UNAVAILABLE', 'UNKNOWN')
                  else YELLOW)
    _draw_field('{}  LOCNTR {}'.format(
        model['shelly_lock'],
        model['shelly_lockout_count'] if isinstance(
            model['shelly_lockout_count'], int) else '--'),
        45, 298, 1190, 55, M5.Lcd.FONTS.DejaVu40, lock_color,
        'events.shelly_lock')

    for action, x in (
            ('enter-user-monitor', CONTROL_MONITOR_X),
            ('restart-tab5', CONTROL_TAB5_X),
            ('restart-shelly1', CONTROL_SHELLY_X)):
        _draw_field(operator_button_label(action), x, CONTROL_Y,
                    CONTROL_W, CONTROL_H, M5.Lcd.FONTS.Montserrat24,
                    YELLOW, 'events.button.' + action)
    _draw_field('STATUS: {}'.format(model['control_status']),
                45, 515, 1190, 35, M5.Lcd.FONTS.Montserrat18, YELLOW,
                'events.control_status')
    adoption = model['staged_restart_adoption']
    _draw_field(('RESTART WILL ADOPT STAGED {}'.format(adoption)
                 if adoption else
                 'RESTART CREATES A FRESH EVENT BOARD AND SESSION'),
                45, 560, 1190, 35, M5.Lcd.FONTS.Montserrat18, CYAN,
                'events.footer')


def render_hmi(page, observation, adopted_reference, rules_package,
               published_reference=None):
    global _last_rendered_page
    if page not in (HMI_PAGE_NOW, HMI_PAGE_SYSTEM, HMI_PAGE_EVENTS):
        page = HMI_PAGE_NOW
    if page != _last_rendered_page:
        _draw_page_frame(page)
        _last_rendered_page = page
    transport_status = cloud.transport_status_snapshot()
    rendered_ticks_ms = time.ticks_ms()
    if page == HMI_PAGE_EVENTS:
        render_events(build_events_hmi_model(observation))
    elif page == HMI_PAGE_SYSTEM:
        render_system(build_system_hmi_model(
            observation, adopted_reference, rules_package,
            published_reference, transport_status, rendered_ticks_ms))
    else:
        render_now(build_now_hmi_model(
            observation, transport_status, rendered_ticks_ms))


# --- touch: M5.Touch (M5Unified's own API) ---
# This replaces ~75 lines that read the ST7123 at 0x55 directly over
# machine.I2C(0). Measured on this board 2026-08-19:
#
#   * M5.Touch works. 673 of 706 polls registered over a 30 s live test with
#     M5.update() pumping and no machine.I2C handle in existence. The earlier
#     "M5.Touch is not wired to Tab5" finding was confounded: every previous
#     test held a competing machine.I2C(0) on the same pins, which M5.begin()
#     invalidates.
#   * getX()/getY() already return rotated landscape coordinates, identical
#     to what the hand-rolled mapping computed (screen_y = 719 - raw_x).
#     No calibration and no swap table needed.
#   * getCount() is the finger-down gate. getX()/getY() LATCH the last
#     position after release, so they must never be read without it.
#
# The direct ST7123 path was removed because holding machine.I2C(0) on the
# internal bus is what forced the whole rebuild-and-retry workaround. With no
# machine.I2C anywhere, M5.update() and M5.Power are free to be called.


def read_touch_point():
    """Returns (raw_x, raw_y, screen_x, screen_y) or None when untouched.

    Shape is kept identical to the old ST7123 reader so callers are unchanged.
    M5.Touch already applies the rotation, so raw and screen are the same."""
    try:
        if M5.Touch.getCount() <= 0:
            return None
        x = M5.Touch.getX()
        y = M5.Touch.getY()
        if x is None or y is None or x < 0 or y < 0:
            return None
        return x, y, x, y
    except Exception as e:
        log('M5.Touch read failed: {}'.format(e))
        return None


_touch_was_down = False


def navigation_selection_allowed(was_pressed, current_page, selected_page):
    """Allow a held direct-selection button to recover a missed release."""
    return (selected_page is not None and
            (not was_pressed or selected_page != current_page))


def check_navigation(was_pressed, current_page):
    """Return a direct page selection from a fresh or held target touch.

    was_pressed tracks whether the finger was inside either navigation button
    on the previous poll. A different target remains selectable if an entire
    release occurred between polls. Logging remains keyed on the finger edge."""
    global _touch_was_down, operator_armed_action, operator_armed_until_ms
    global operator_local_pending_action, operator_control_status
    p = read_touch_point()
    if p is None:
        _touch_was_down = False
        return current_page, False
    tx, ty, x, y = p
    fresh_touch = not _touch_was_down
    selected_page = navigation_page_at(x, y)
    inside = selected_page is not None
    if not _touch_was_down:
        log('touch screen=({},{}) page={}'.format(
            x, y, selected_page if selected_page is not None else 'none'))
    _touch_was_down = True
    if fresh_touch and selected_page is None:
        action = operator_control_at(x, y, current_page)
        if action is not None:
            busy = (operator_local_pending_action is not None or
                    shelly_restart_pending is not None or
                    tab5_restart_due_ms is not None)
            (operator_armed_action, operator_armed_until_ms,
             selected_action) = arm_operator_control(
                action, time.ticks_ms(), operator_armed_action,
                operator_armed_until_ms, busy)
            if selected_action is not None:
                operator_local_pending_action = selected_action
                operator_control_status = 'LOCAL {} ACCEPTED'.format(
                    selected_action.upper())
                log('HMI operator action accepted after confirmation: {}'.format(
                    selected_action))
            else:
                operator_control_status = 'TAP SAME CONTROL AGAIN WITHIN 8s'
            return current_page, True
    if navigation_selection_allowed(
            was_pressed, current_page, selected_page):
        return selected_page, True
    return current_page, inside


def service_navigation():
    """Service touch independently of how much of the 1 s cycle remains."""
    global hmi_page, navigation_pressed, operator_armed_action
    global operator_armed_until_ms, operator_control_status
    M5.update()
    arm_expired = (operator_armed_action is not None and
                   isinstance(operator_armed_until_ms, int) and
                   time.ticks_diff(operator_armed_until_ms,
                                   time.ticks_ms()) < 0)
    if arm_expired:
        operator_armed_action = None
        operator_armed_until_ms = None
        operator_control_status = 'READY'
    previous_page = hmi_page
    hmi_page, navigation_pressed = check_navigation(
        navigation_pressed, hmi_page)
    if hmi_page != previous_page:
        log('HMI page selected: {}'.format(hmi_page))
        return True
    return arm_expired


# --- boot sequence ---

internal_antenna_ready = confirm_internal_antenna()
log('CPU A device loop initialized; CPU B owns Wi-Fi recovery and Netlify')
log('CPU A release M6.42: pressure commissioned; V3 authority')

# The last validated staged V3 file becomes running only across this restart
# boundary. A later download can replace the staged file, never this object.
rules_v3_runtime, _rules_v3_error = start_rules_v3_runtime()
rules_v3_last_mode = 'Normal'
rules_v3_last_relay_diagnostic = None
rules_v3_desired_reference = None
rules_v3_staged_reference = None
rules_v3_running_reference = None
rules_v3_rejected = None
active_rules = None
active_rules_reference = None
rules_runtime_state = 'UNAVAILABLE'
rules_runtime_reason = _rules_v3_error
if rules_v3_runtime is not None:
    active_rules = rules_v3_runtime['package']
    active_rules_reference = rules_v3_runtime['reference']
    rules_v3_running_reference = active_rules_reference
    rules_v3_staged_reference = active_rules_reference
    rules_runtime_state = 'RUNNING V3'
    rules_runtime_reason = None
    if not cloud.set_applied_rules(active_rules_reference):
        raise RuntimeError('validated V3 runtime reference handoff failed')
    rules_v3_last_mode = rules_v3_effective_mode(
        rules_v3_runtime['resolved'], rules_v3_runtime['kernel'])
    log('V3 ENGINE RUNNING: release={} version={} hash={}'.format(
        active_rules_reference['releaseId'], active_rules_reference['packageVersion'],
        active_rules_reference['contentHash'][:12]))
    for _cadence_warning in rules_v3_cadence_warnings(active_rules, SAMPLE_PERIOD_MS):
        log('V3 CADENCE STARVED: {}; its quality output stays INSUFFICIENT_HISTORY'.format(
            _cadence_warning))
else:
    rules_v3_rejected = {'reason': _rules_v3_error}
    log('V3 ENGINE UNAVAILABLE: {}'.format(_rules_v3_error))
cloud.set_rules_v3_state(rules_v3_state_report(
    rules_v3_running_reference, rules_v3_desired_reference,
    rules_v3_staged_reference, rules_v3_rejected))

# main.py completed M5.begin() before importing this worker. Read through the supported
# UIFlow interface, then explicitly establish a software charging request. isCharging()
# reports charger status, not CHG_EN readback; charge_enable remains unknown unless the
# setter returns normally.
battery_v, battery_a, battery_level, battery_charging = read_battery()
battery_valid = battery_v is not None
battery_sample_ms = time.ticks_ms() if battery_valid else None
battery_last_read_ok = battery_valid
if not battery_valid:
    log('battery-monitor YELLOW: initial M5.Power read unavailable')
charge_enable, charge_retry_target, startup_charge_target = battery_charge_policy(
    battery_level, None)
last_battery_policy_ms = time.ticks_ms()
if startup_charge_target is not None:
    log('battery policy startup: requested charging {} ({})'.format(
        'ON' if startup_charge_target else 'OFF',
        'accepted' if charge_enable is startup_charge_target else
        'failed; state unknown'))

last_valid_sample = None
last_valid_sample_ms = None
sample_failure_count = 0
last_valid_adc_ms = None
last_valid_shelly1 = None
last_valid_shelly1_ms = None
shelly1_failure_count = 0
# Latched true on the first cycle permitted to reach the network, and never
# cleared. CPU B holds traffic for a quiet period after boot while CPU A is
# already cycling; until an attempt has been allowed, "unavailable" would be a
# claim about the devices that this application has not earned.
acquisition_begun = False
hmi_page = HMI_PAGE_NOW
navigation_pressed = False
last_observation = None
last_battery_diagnostic_ms = time.ticks_ms()
observation_sequence = 0
device_session_id = cloud.device_session_id()
event_history = new_event_history()
durable_available_baselines = {}
last_durable_admission_ms = None
durable_session_started = False
event_board_sequence = 0
last_event_board_signature = None
last_event_board_submit_ms = None
next_rules_v3_request_ms = 0
published_rules_reference = None
last_cycle_start_ms = None
last_cycle_work_ms = None
session_uptime_ms = 0
heap_min_free_bytes = None
last_operator_command_id = None
last_operator_command_sequence = 0
online_operator_command = None
monitor_result_command = None
monitor_result_event_id = None
monitor_result_instance = None
monitor_relay_restoration = 'not-applicable'

log('Operational HMI initialized; V3 runs only when a valid startup package exists')
render_hmi(hmi_page, {}, active_rules_reference, active_rules,
           published_rules_reference)

while True:
    now = time.ticks_ms()
    if (isinstance(tab5_restart_due_ms, int) and
            time.ticks_diff(now, tab5_restart_due_ms) >= 0):
        log('TAB5 RESTART: machine.reset begins a new CPU A/CPU B session')
        reset()
    cycle_started_ms = now
    cycle_interval_ms = (None if last_cycle_start_ms is None else
                         elapsed_ticks_ms(last_cycle_start_ms, now))
    if isinstance(cycle_interval_ms, int) and cycle_interval_ms >= 0:
        session_uptime_ms += cycle_interval_ms
    last_cycle_start_ms = now
    observation_sequence += 1
    # M5.update() drives M5.Touch and is REQUIRED for it to report anything.
    # It reinitializes the ESP-IDF I2C peripheral, which used to invalidate the
    # machine.I2C handles for the ADC and the ST7123 - that is what caused the
    # constant bus rebuilding. Both are gone now: Port A is on SoftI2C (immune,
    # bit-banged GPIO) and touch is M5's own. Nothing is left for this to break.
    service_navigation()

    was_connected = wifi_connected
    (wifi_connected, network_traffic_allowed, clock_synced,
     wifi_driver_status, wifi_ip, wifi_disconnect_events) = cloud.status_snapshot()
    online_operator_command = cloud.take_operator_command()
    if wifi_connected and not was_connected:
        shelly_resume_confirmation_pending = True
        shelly1_resume_confirmation_pending = True

    # Downloads may replace only the next-restart staged file. They never
    # replace rules_v3_runtime or its volatile event/ownership state here.
    rules_v3_pointer = cloud.take_rules_v3_pointer()
    if rules_v3_pointer is not None:
        v3_metadata = validate_rules_v3_pointer(rules_v3_pointer)
        if v3_metadata is None:
            rules_v3_rejected = {'reason': rules_v3_pointer_rejection_reason(rules_v3_pointer)}
            log('V3 staging pointer ignored: {}'.format(rules_v3_rejected['reason']))
        else:
            rules_v3_desired_reference = {
                'releaseId': v3_metadata['releaseId'],
                'packageVersion': v3_metadata['packageVersion'],
                'runtimeSchemaVersion': 3,
                'contentHash': v3_metadata['contentHash'],
            }
            published_rules_reference = dict(rules_v3_desired_reference)
            published_rules_reference['version'] = v3_metadata['packageVersion']
            rules_v3_rejected = None
            if (rules_v3_staged_reference is None or
                    rules_v3_staged_reference.get('contentHash') !=
                    rules_v3_desired_reference.get('contentHash')) and \
                    time.ticks_diff(now, next_rules_v3_request_ms) >= 0:
                if cloud.request_rules_v3_release(v3_metadata):
                    next_rules_v3_request_ms = time.ticks_add(now, RULES_FETCH_RETRY_MS)
                    log('V3 staging release request queued: {}'.format(
                        v3_metadata['releaseId']))
        cloud.set_rules_v3_state(rules_v3_state_report(
            rules_v3_running_reference, rules_v3_desired_reference,
            rules_v3_staged_reference, rules_v3_rejected))
    v3_candidate = cloud.take_rules_v3_release()
    if v3_candidate is not None:
        staged_v3, v3_outcome = stage_rules_v3_release(
            v3_candidate, rules_v3_staged_reference)
        if staged_v3 is not None:
            rules_v3_staged_reference = staged_v3['reference']
            rules_v3_rejected = None
            log('V3 release staged only: release={}, hash={}'.format(
                rules_v3_staged_reference['releaseId'],
                rules_v3_staged_reference['contentHash'][:12]))
        elif v3_outcome != 'already-staged':
            rejected_pointer = (v3_candidate.get('metadata')
                                if isinstance(v3_candidate, dict) else None)
            rejected_reference = validate_rules_v3_pointer(rejected_pointer)
            rules_v3_rejected = {
                'reason': v3_outcome,
                'releaseId': (rejected_reference or {}).get('releaseId'),
                'packageVersion': (rejected_reference or {}).get('packageVersion'),
                'contentHash': (rejected_reference or {}).get('contentHash'),
            }
            log('V3 staging release rejected: {}'.format(v3_outcome))
        cloud.set_rules_v3_state(rules_v3_state_report(
            rules_v3_running_reference, rules_v3_desired_reference,
            rules_v3_staged_reference, rules_v3_rejected))

    # The fresh 15-SPS conversions occupy a material portion of every
    # cycle. Service touch inside their DRDY waits instead of limiting touch
    # detection to whatever sleep time happens to remain afterward.
    adc_started_ms = time.ticks_ms()
    ads_raw_count = read_ads1110_filtered_raw_count(service_navigation)
    adc_completed_ms = time.ticks_ms()
    adc_acquisition_ms = elapsed_ticks_ms(adc_started_ms, adc_completed_ms)
    if ads_raw_count is not None:
        last_valid_adc_ms = adc_completed_ms

    if (time.ticks_diff(now, last_battery_diagnostic_ms) >=
            BATTERY_DIAGNOSTIC_PERIOD_MS):
        last_battery_diagnostic_ms = now
        v, a, level, charging = read_battery()
        battery_valid = v is not None
        if battery_valid:
            battery_v, battery_a = v, a
            battery_level, battery_charging = level, charging
            battery_sample_ms = time.ticks_ms()
            if battery_last_read_ok is False:
                log('battery monitor recovered: M5.Power readings available')
        elif battery_last_read_ok is not False:
            log('battery-monitor YELLOW: M5.Power read unavailable; prior measurements stale')
        battery_last_read_ok = battery_valid
    if time.ticks_diff(now, last_battery_policy_ms) >= BATTERY_POLICY_PERIOD_MS:
        last_battery_policy_ms = now
        charge_enable, charge_retry_target, attempted_target = battery_charge_policy(
            battery_level if battery_valid else None,
            charge_enable, charge_retry_target)
        if attempted_target is not None:
            log('battery policy: {}% estimate -> charging request {} ({})'.format(
                battery_level if battery_valid else 'unavailable',
                'ON' if attempted_target else 'OFF',
                'accepted' if charge_enable is attempted_target else 'failed; state unknown'))
    service_navigation()

    sample = None
    shelly1_sample = None
    shelly_poll_attempted = False
    shelly1_poll_attempted = False
    shelly_em_acquisition_ms = None
    shelly1_acquisition_ms = None
    if wifi_connected and network_traffic_allowed:
        acquisition_begun = True   # latched before the reads it authorises
        shelly_poll_attempted = True
        service_navigation()
        shelly_em_started_ms = time.ticks_ms()
        sample = read_shelly()
        shelly_em_acquisition_ms = elapsed_ticks_ms(
            shelly_em_started_ms, time.ticks_ms())
        service_navigation()
        if sample is None:
            sample_failure_count += 1
        else:
            last_valid_sample = sample
            last_valid_sample_ms = time.ticks_ms()
            if shelly_resume_confirmation_pending:
                log('Shelly polling confirmed after connection: ticks_ms={}, connected={}, status={}, IP={}'.format(
                    last_valid_sample_ms, wifi_connected,
                    wifi_driver_status, wifi_ip))
                shelly_resume_confirmation_pending = False
        shelly1_poll_attempted = True
        shelly1_started_ms = time.ticks_ms()
        shelly1_sample, shelly1_routing = read_shelly1(routing=shelly1_routing)
        shelly1_acquisition_ms = elapsed_ticks_ms(
            shelly1_started_ms, time.ticks_ms())
        service_navigation()
        if shelly1_sample is None:
            shelly1_failure_count += 1
        else:
            last_valid_shelly1 = shelly1_sample
            last_valid_shelly1_ms = time.ticks_ms()
            if shelly1_resume_confirmation_pending:
                log('Shelly 1 polling confirmed: SW0={}, RLY0={}'.format(
                    'ON' if shelly1_sample['sw0'] else 'OFF',
                    'ON' if shelly1_sample['rly0'] else 'OFF'))
                shelly1_resume_confirmation_pending = False

    observation_ticks_ms = time.ticks_ms()
    observation = build_observation(
        observation_sequence, observation_ticks_ms, clock_synced,
        sample if sample is not None else {}, sample is not None,
        shelly_poll_attempted, last_valid_sample_ms,
        last_valid_adc_ms,
        battery_v, battery_a, battery_level, battery_charging,
        battery_valid, charge_enable, battery_sample_ms,
        wifi_connected, network_traffic_allowed, wifi_driver_status,
        wifi_ip, wifi_disconnect_events, sample_failure_count,
        shelly1_sample, shelly1_sample is not None,
        shelly1_poll_attempted, last_valid_shelly1_ms,
        shelly1_failure_count, ads_raw_count=ads_raw_count,
        acquisition_begun=acquisition_begun)
    transport_status = cloud.transport_status_snapshot()
    add_transport_evidence(observation, transport_status, observation_ticks_ms)
    observation['status']['rules_runtime_state'] = rules_runtime_state
    observation['status']['rules_runtime_reason'] = rules_runtime_reason
    operator_occurrences = None

    # First finish any Shelly restart only from a later, fresh acquisition.
    if shelly_restart_pending is not None:
        fresh_lock = observation['values'].get('shelly1_lock')
        confirmation = shelly_restart_confirmation(
            shelly_restart_pending, observation_sequence,
            observation_ticks_ms,
            observation['status'].get('shelly1_available'), fresh_lock)
        if confirmation is not None:
            outcome, detail = confirmation
            command = shelly_restart_pending.get('command')
            if command is not None:
                cloud.submit_operator_result(operator_result(
                    command, device_session_id, outcome, detail))
            operator_control_status = (
                'SHELLY RESTART CONFIRMED: ISLOCKED 0'
                if outcome == 'confirmed-completed' else
                'SHELLY RESTART FAILED: LOCKOUT REMAINS'
                if outcome == 'failed' else
                'SHELLY RESTART UNKNOWN: NO VALID FRESH LOCK EVIDENCE')
            shelly_restart_pending = None

    selected_action = None
    selected_command = None
    if online_operator_command is not None:
        # One online request wins this cycle; discard an unexecuted local tap
        # rather than silently applying two operator actions back-to-back.
        operator_local_pending_action = None
        decision, detail = operator_command_execution_decision(
            online_operator_command, device_session_id,
            utc_epoch_ms(clock_synced), clock_synced,
            last_operator_command_sequence, last_operator_command_id)
        received_sequence = online_operator_command.get('commandSequence')
        if (online_operator_command.get('targetSessionId') == device_session_id and
                isinstance(received_sequence, int) and
                not isinstance(received_sequence, bool) and
                received_sequence > last_operator_command_sequence):
            last_operator_command_sequence = received_sequence
            last_operator_command_id = online_operator_command.get('commandId')
        if decision != 'accepted':
            cloud.submit_operator_result(operator_result(
                online_operator_command, device_session_id,
                'not-delivered', detail))
            operator_control_status = 'ONLINE NOT DELIVERED: {}'.format(
                detail.upper())
        else:
            cloud.mark_operator_command_applied(
                online_operator_command.get('commandId'), received_sequence)
            selected_action = online_operator_command.get('commandType')
            selected_command = online_operator_command
    elif operator_local_pending_action is not None:
        selected_action = operator_local_pending_action
        operator_local_pending_action = None

    if selected_action == 'enter-user-monitor':
        occurrence_field = operator_monitor_occurrence_field(
            rules_v3_runtime['resolved'] if rules_v3_runtime is not None else None)
        if occurrence_field is None:
            if selected_command is not None:
                cloud.submit_operator_result(operator_result(
                    selected_command, device_session_id, 'failed',
                    'monitor-event-unavailable'))
            operator_control_status = 'USER MONITOR FAILED: EVENT UNAVAILABLE'
        else:
            # Ownership of the inhibition flag, resolved by its device binding.
            # After RLY0 became read-only there is no pump target to consult, and
            # reporting "not needed" from its absence would fabricate lock state.
            inhibit_target = rules_v3_runtime['resolved'].get('inhibitionTarget')
            had_inhibit = (inhibit_target is not None and _rules_v3_has_owner(
                rules_v3_runtime['kernel'], inhibit_target))
            relay_on = observation['values'].get('shelly1_rly0')
            lock_value = observation['values'].get('shelly1_lock')
            monitor_relay_restoration = (
                'confirmed' if had_inhibit and relay_on is True and lock_value == 0
                else 'unconfirmed' if had_inhibit else 'not-needed')
            operator_occurrences = {occurrence_field: True}
            monitor_result_command = selected_command
            monitor_result_event_id = operator_monitor_event_id(
                rules_v3_runtime['resolved'])
            monitor_result_instance = None
            if selected_command is not None:
                cloud.submit_operator_result(operator_result(
                    selected_command, device_session_id, 'accepted',
                    'monitor-request-accepted', monitor_relay_restoration))
            operator_control_status = 'USER MONITOR ACCEPTED; RELAY {}'.format(
                monitor_relay_restoration.upper())
    elif selected_action == 'restart-tab5':
        restart_evidence_ready = (
            selected_command is None or
            cloud.prepare_tab5_restart(selected_command))
        if restart_evidence_ready:
            if selected_command is not None:
                cloud.submit_operator_result(operator_result(
                    selected_command, device_session_id, 'accepted',
                    'tab5-restart-scheduled'))
            operator_control_status = 'TAB5 RESTART ACCEPTED; NEW SESSION PENDING'
            tab5_restart_due_ms = time.ticks_add(
                observation_ticks_ms, TAB5_RESTART_DELAY_MS)
        else:
            cloud.submit_operator_result(operator_result(
                selected_command, device_session_id, 'failed',
                'tab5-restart-evidence-write-failed'))
            operator_control_status = 'TAB5 RESTART FAILED: EVIDENCE NOT SAVED'
    elif selected_action == 'restart-shelly1':
        if observation['status'].get('shelly1_available') is not True:
            outcome, detail = 'failed', 'shelly-unavailable-before-request'
        else:
            outcome, detail = shelly1_restart_request()
        if outcome == 'accepted':
            shelly_restart_pending = {
                'command': selected_command,
                'startedTicksMs': observation_ticks_ms,
                'acceptedSequence': observation_sequence,
            }
            operator_control_status = 'SHELLY RESTART ACCEPTED; CLEAR UNCONFIRMED'
        else:
            operator_control_status = 'SHELLY RESTART {}: {}'.format(
                outcome.upper(), detail.upper())
        if selected_command is not None:
            cloud.submit_operator_result(operator_result(
                selected_command, device_session_id, outcome, detail))
    durable_fields = None
    durable_reasons = []
    v3_processing_ms = None
    if rules_v3_runtime is not None:
        v3_actions = []
        v3_records = []
        v3_started_ms = time.ticks_ms()
        try:
            v3_cycle = run_rules_v3_cycle(
                rules_v3_runtime, observation, observation_ticks_ms,
                occurrences=operator_occurrences,
                cycle_sequence=observation_sequence,
                observed_at=observation.get('observedAt'),
                opening_uptime_ms=session_uptime_ms)
            v3_actions = v3_cycle['actions']
            v3_records = v3_cycle['records']
            observation['values'].update(v3_cycle['snapshot'])
            observation['status']['v3_unavailable_devices'] = v3_cycle['unavailableDeviceIds']
            observation['status']['v3_active_event_ids'] = [
                event_id for event_id, state in
                rules_v3_runtime['kernel']['events'].items()
                if state.get('active') is True]
            logging_policies = runtime_logging_policies(active_rules)
            durable_fields = durable_field_states(
                v3_cycle['snapshot'], logging_policies)
            if durable_fields is not None:
                durable_reasons.extend(durable_trigger_reasons(
                    durable_fields, durable_available_baselines,
                    logging_policies))
                durable_reasons.extend(event_boundary_reasons(v3_records))

            candidate_board = build_current_event_board(
                rules_v3_runtime, device_session_id,
                event_board_sequence + 1, observation_sequence,
                session_uptime_ms, observation.get('observedAt'))
            candidate_signature = event_board_signature(candidate_board)
            board_due = (
                last_event_board_submit_ms is None or
                candidate_signature != last_event_board_signature or
                time.ticks_diff(observation_ticks_ms,
                                last_event_board_submit_ms) >=
                EVENT_BOARD_HEARTBEAT_MS)
            if board_due:
                if (candidate_board is not None and
                        candidate_signature is not None and
                        cloud.submit_event_board(candidate_board)):
                    event_board_sequence += 1
                    last_event_board_signature = candidate_signature
                last_event_board_submit_ms = observation_ticks_ms
        except Exception as v3_error:
            log('V3 ENGINE ERROR: {}'.format(v3_error))
        for record in v3_records:
            log('V3 EVENT {}: id={} instance={} reason={}'.format(
                str(record.get('type')).upper(), record.get('eventId'),
                record.get('eventInstanceId'), record.get('reason')))
        mode_now = rules_v3_effective_mode(
            rules_v3_runtime['resolved'], rules_v3_runtime['kernel'])
        if mode_now != rules_v3_last_mode:
            log('V3 MODE: {} -> {}'.format(rules_v3_last_mode, mode_now))
            rules_v3_last_mode = mode_now
        # Completion is tied to the instance of the user's own Monitor event, not
        # to effective mode. System Monitor holds the same mode target, so mode
        # alone would let an unrelated H001 close out a stale user request.
        live_monitor_instance = user_monitor_instance(
            rules_v3_runtime, monitor_result_event_id)
        if operator_occurrences is not None:
            if live_monitor_instance is not None:
                monitor_result_instance = live_monitor_instance
                operator_control_status = 'USER MONITOR ACTIVE; RELAY {}'.format(
                    monitor_relay_restoration.upper())
                if monitor_result_command is not None:
                    cloud.submit_operator_result(operator_result(
                        monitor_result_command, device_session_id,
                        'confirmed-completed', 'monitor-active',
                        monitor_relay_restoration))
                    monitor_result_command = None
            else:
                # The request was accepted but its event did not open. Resolve the
                # pending result rather than leaving it to be satisfied later by
                # something the operator did not ask for.
                operator_control_status = 'USER MONITOR FAILED: EVENT DID NOT OPEN'
                if monitor_result_command is not None:
                    cloud.submit_operator_result(operator_result(
                        monitor_result_command, device_session_id, 'failed',
                        'monitor-event-did-not-open', monitor_relay_restoration))
                    monitor_result_command = None
                monitor_result_event_id = None
                monitor_relay_restoration = 'not-applicable'
        if (monitor_result_instance is not None and
                live_monitor_instance == monitor_result_instance and
                monitor_relay_restoration == 'unconfirmed' and
                observation['status'].get('shelly1_available') is True and
                observation['values'].get('shelly1_lock') == 0 and
                observation['values'].get('shelly1_rly0') is True):
            # Fresh physical evidence, still required: an accepted Monitor never
            # proves RLY0 moved.
            monitor_relay_restoration = 'confirmed'
            operator_control_status = 'USER MONITOR ACTIVE; RELAY CONFIRMED'
        if monitor_result_instance is not None and live_monitor_instance is None:
            # The user's Monitor instance ended with this runtime; nothing later
            # may report against it.
            monitor_result_instance = None
            monitor_result_event_id = None
        relay_diagnostic = rules_v3_relay_diagnostic(rules_v3_runtime, observation, v3_actions)
        if relay_diagnostic != rules_v3_last_relay_diagnostic:
            log('V3 RELAY EVIDENCE: sequence={} inhibit_held={} available={} observed_rly0={} observed_flag={} lock={} selected={}'.format(
                observation_sequence, *relay_diagnostic))
            rules_v3_last_relay_diagnostic = relay_diagnostic
        v3_processing_ms = elapsed_ticks_ms(v3_started_ms, time.ticks_ms())
        if v3_actions:
            dispatch_started = time.ticks_ms()
            dispatched, dropped = dispatch_rules_v3_actions(
                rules_v3_runtime['resolved'], v3_actions, observation)
            for action in dropped:
                log('V3 ACTION DROPPED (conflict): {}={} reason={}'.format(
                    action.get('target'), action.get('value'), action.get('reason')))
            for dispatch in dispatched:
                action = dispatch['action']
                signature = (action.get('target'), action.get('value'))
                log('V3 ACTION SELECTED: {}={} reason={} event={}'.format(
                    action.get('target'), action.get('value'),
                    action.get('reason'), action.get('eventId')))
                log('V3 ACTION DISPATCH: {}={} -> {} sequence={} elapsed_ms={}'.format(
                    signature[0], signature[1], dispatch['outcome'], observation_sequence,
                    time.ticks_diff(time.ticks_ms(), dispatch_started)))
    monitor_active = (rules_v3_runtime is not None and
                      rules_v3_effective_mode(
                          rules_v3_runtime['resolved'],
                          rules_v3_runtime['kernel']) == 'Monitor')
    # Monitor mode is now reachable from System Monitor as well, so the two are
    # reported separately. Relay restoration describes the user's own request and
    # is not applicable to a Monitor the operator did not ask for.
    observation['status']['monitor_mode_active'] = monitor_active
    observation['status']['user_monitor_active'] = monitor_result_instance is not None
    observation['status']['tab5_relay_restoration'] = (
        monitor_relay_restoration if monitor_result_instance is not None
        else 'not-applicable')
    observation['status']['operator_control_status'] = operator_control_status
    if (isinstance(rules_v3_staged_reference, dict) and
            (not isinstance(rules_v3_running_reference, dict) or
             rules_v3_staged_reference.get('contentHash') !=
             rules_v3_running_reference.get('contentHash'))):
        observation['status']['staged_restart_adoption'] = (
            rules_v3_staged_reference.get('releaseId'))
    last_observation = observation
    append_event_history(event_history, observation)
    cloud.submit_observation(observation)
    if durable_fields is not None and active_rules_reference is not None:
        if not durable_session_started:
            durable_reasons.insert(0, {'kind': 'session-start'})
        elapsed_since_durable_ms = (
            None if last_durable_admission_ms is None else
            time.ticks_diff(now, last_durable_admission_ms))
        if (elapsed_since_durable_ms is not None and
                elapsed_since_durable_ms >= MAX_DURABLE_OBSERVATION_INTERVAL_MS):
            durable_reasons.append({
                'kind': 'maximum-interval',
                'intervalMs': MAX_DURABLE_OBSERVATION_INTERVAL_MS,
            })
        if durable_reasons:
            durable_record = build_durable_observation_v2(
                observation, device_session_id, active_rules_reference,
                durable_reasons, durable_fields, session_uptime_ms)
            if (durable_record is not None and
                    cloud.submit_durable_record(durable_record)):
                durable_available_baselines = admitted_durable_baselines(
                    durable_fields, durable_available_baselines)
                last_durable_admission_ms = now
                durable_session_started = True
                log('Durable observation selected: sequence={}, reasons={}'.format(
                    observation_sequence, len(durable_reasons)))

    heap_free_bytes, heap_allocated_bytes, heap_min_free_bytes = heap_diagnostics(
        gc, heap_min_free_bytes)
    # Local diagnostics are kept out of the operational/current and durable record
    # interfaces. A bounded shallow display copy prevents cross-thread mutation after
    # submit_observation transfers ownership of the operational object to CPU B.
    hmi_observation = dict(observation)
    hmi_observation['status'] = dict(observation['status'])
    hmi_observation['status'].update({
        'cycle_interval_ms': cycle_interval_ms,
        'cycle_work_ms': last_cycle_work_ms,
        'adc_acquisition_ms': adc_acquisition_ms,
        'shelly_em_acquisition_ms': shelly_em_acquisition_ms,
        'shelly1_acquisition_ms': shelly1_acquisition_ms,
        'v3_processing_ms': v3_processing_ms,
        'heap_free_bytes': heap_free_bytes,
        'heap_allocated_bytes': heap_allocated_bytes,
        'heap_min_free_bytes': heap_min_free_bytes,
    })
    render_hmi(hmi_page, hmi_observation, active_rules_reference, active_rules,
               published_rules_reference)

    # Sleep out the rest of the sample period, but poll touch every 50 ms so
    # taps are not missed. Sensor cadence stays at SAMPLE_PERIOD_MS.
    last_cycle_work_ms = elapsed_ticks_ms(cycle_started_ms, time.ticks_ms())
    sleep_until = time.ticks_add(now, SAMPLE_PERIOD_MS)
    while time.ticks_diff(sleep_until, time.ticks_ms()) > 0:
        # M5.Touch only refreshes when M5.update() runs. Pumping it once per
        # second in the outer loop left 19 of every 20 touch polls reading a
        # stale snapshot, which is what made taps feel unresponsive. Safe to
        # call at this rate now: no machine.I2C handle exists for it to break.
        if service_navigation():
            render_hmi(hmi_page, hmi_observation, active_rules_reference,
                       active_rules, published_rules_reference)
        time.sleep_ms(50)
