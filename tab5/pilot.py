# Release: 2026-08-25 M6.2 — validate rules releases and report CPU A startup.
# main.py - Tab5 well-pump observational pilot (interpreted port of
# well-pump-control/firmware/tab5/main/app_main.cpp)
#
# Observes the Wi-Fi connection established before this application starts,
# holds a quiet period after got-IP before opening any socket, samples the
# Shelly EM + ADS1110 at 1 Hz,
# publish to Netlify on change or heartbeat, show live status on screen.
#
# Observational only. No pump start/stop/inhibit/relay authority - matches
# the compiled pilot's AGENTS.md safety boundary. Battery charge control is
# the one exception: an automatic hysteresis policy keeps the pack between
# BATTERY_LOW_PCT and BATTERY_HIGH_PCT - see the battery section below.

import M5
import os
import time
import uhashlib
import ujson
import requests
import driver.ads1110 as ads1110
from machine import I2C, Pin, SoftI2C
import cloud

# --- config (values from firmware/tab5/main/pilot_config.h) ---
SHELLY_URL = 'http://192.168.50.141/emeter/0'
SAMPLE_PERIOD_MS = 1000
SHELLY_TIMEOUT_S = 1  # requests has whole-second granularity; C++ used 750ms
STALE_AFTER_MS = 3000

# M5 selection parameters live on CPU A. M6 supplies a validated rules
# reference while CPU B remains a byte-preserving transport only.
SITE_ID = 'well-main'
DEVICE_ID = 'tab5-well-main'
MAX_DURABLE_OBSERVATION_INTERVAL_MS = 600000
EVENT_HISTORY_DEPTH = 600
SHELLY_AVAILABILITY_CONFIRMATION_SAMPLES = 3
ADC_FILTER_SAMPLE_COUNT = 5
ADC_FILTER_SAMPLE_SPACING_MS = 70
MATERIAL_NUMERIC_THRESHOLDS = {
    'values.power': 50.0,
    'values.voltage': 2.0,
    'values.adc_microvolts': 25000.0,
    'values.battery_voltage': 0.1,
    'values.battery_current': 0.1,
    'values.battery_percent': 1.0,
}
MATERIAL_EXACT_CHANGE_PATHS = (
    'values.battery_charging',
    'values.battery_charge_enabled',
    'status.adc_available',
    'status.battery_available',
    'status.clock_synced',
)
RULES_FILE = 'rules.json'
RULES_TEMP_FILE = '.rules.json.download'
RULES_FETCH_RETRY_MS = 60000
MAX_RULES_RELEASE_BYTES = 65536
PACKAGED_RULES_REFERENCE = {
    'version': 1,
    'contentHash': 'ee0220eebdd0fa9b3b9751435180c17a16d3c93cb5f7325f1ab74d8d132e410a',
}
EXPECTED_RULE_IDS = (
    'P001', 'P002', 'P003', 'P004', 'P005', 'P006', 'P007', 'P008',
    'P009', 'P010', 'P011', 'P012', 'P013', 'P014', 'P015', 'P016',
    'E001', 'E002', 'E003', 'E004', 'E005', 'E006', 'E007', 'E008',
    'E009', 'T001', 'T002', 'T003', 'T004', 'T005', 'T006', 'T007',
    'T008', 'T009', 'T010', 'T011', 'T012', 'T013', 'H001', 'H002',
    'H003', 'H004', 'H005', 'H006', 'H007', 'H008', 'H009', 'H010',
    'H011', 'H012', 'H013', 'H014', 'H015', 'H016', 'H017', 'H018',
    'H019', 'H020', 'H021',
)

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
#   - getBatteryVoltage() -> mV, getBatteryCurrent() -> mA, getBatteryLevel() -> 0-100%,
#     isCharging() -> bool, all backed by that same INA226.
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
BATTERY_POLL_PERIOD_MS = 60000

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
# This runs BEFORE M5.begin(), deliberately. The internal bus (SCL 32 / SDA 31)
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

# M5.begin() reclaims the internal I2C peripheral for M5Unified. Nothing of ours
# may hold a machine.I2C handle on ports 0 or 1 after this point - Port A uses
# SoftI2C (immune, bit-banged GPIO) and touch uses M5.Touch.
M5.begin()


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


# --- ADS1110 on the M5 Unit ADC v1.1 (Port A) ---
# The unit is NOT a bare ADS1110. M5 puts a divider in front of it, giving a
# 0-12 V UNIPOLAR terminal range from a converter whose own span is +/-2.048 V.
# Full scale at the terminal is 12.288 V = 6 x 2.048 V, i.e. a 6:1 divider.
# Confirmed on hardware 2026-08-19: a 7.8 V input read 1.3 V at the pin, exactly
# 6.0x. Cross-check: M5 quote 16-bit resolution as "~0.183 mV"; 12.288/65536 =
# 0.1875 mV, same number.
#
# Sample rate sets the resolution on this chip:
#     240 SPS -> 12-bit -> 1000 uV/count at the pin ->   6000 uV at the terminal
#      15 SPS -> 16-bit ->   62.5 uV/count at the pin -> 375 uV at the terminal
# We sample once per second, so there is no reason to run at 240 SPS and give up
# 32x of resolution. 15 SPS it is.
#
# NEGATIVE INPUT IS OUT OF SPEC. The terminal range is 0-12 V. Applying a
# negative voltage rails the reading (observed: -7.8 V read as +2.047 V, the
# positive full-scale code) and may damage the front end.
#
# ADC_DIVIDER is nominal. Divider resistors have tolerance - trim it against two
# known points inside range. Eventually this stops being a voltage calibration
# at all: the transducer will be calibrated in PRESSURE against the well gauge,
# via a boot-menu diagnostic stub, and that constant will live alongside this one.
ADC_DIVIDER = 6.0                  # M5 Unit ADC v1.1 front end, nominal
ADC_LSB_UV_AT_PIN = 62.5           # 15 SPS = 16-bit: 2.048 V / 32768
ADC_UV_PER_COUNT = ADC_LSB_UV_AT_PIN * ADC_DIVIDER    # 375.0 uV at the terminal

adc = None


def init_adc():
    # Port A uses SoftI2C, not hardware I2C(1). Measured on this board
    # 2026-08-19: M5.begin(), M5.update() and M5.Power all reinitialize the
    # ESP-IDF I2C peripheral and invalidate any machine.I2C handle with
    # OSError(259). SoftI2C is bit-banged on plain GPIO, never touches that
    # peripheral, and survived all three plus display drawing across 40
    # driver reads with zero failures. M5 does not use Port A, so nothing
    # contends for these pins.
    #
    # The internal bus (32/31) is the opposite case - M5 owns it, and
    # SoftI2C there fails with OSError(19) once M5.begin() has routed the
    # pins to the peripheral. Do not try to move the touch bus here.
    global adc
    try:
        i2c_a = SoftI2C(scl=Pin(54), sda=Pin(53), freq=100000)
        adc = ads1110.ADS1110(i2c_a)
        adc.set_gain(ads1110.GAIN_ONE)
        adc.set_sample_rate(ads1110.SPS_15)
        adc.set_mode(ads1110.MODE_CONTIN)
        log('ADS1110 configured: 0x48 continuous, 15 SPS (16-bit), PGA 1x, {} uV/count at terminal'.format(ADC_UV_PER_COUNT))
    except Exception as e:
        adc = None
        log('ADS1110 configuration failed: {}'.format(e))


init_adc()


def _read_ads1110_microvolts_once():
    """Read one current ADS1110 conversion, with the established reinit retry."""
    global adc
    if adc is None:
        return None
    try:
        raw = adc.get_adc_raw_value()
        if raw > 32767:
            raw -= 65536  # two's complement over the full 16-bit register
        return int(raw * ADC_UV_PER_COUNT)  # uV at the screw terminal, not the pin
    except Exception as e:
        # Kept as genuine fault recovery. Since Port A moved to SoftI2C this
        # should effectively never fire - if it starts firing, suspect wiring
        # or the ADS1110 itself, not bus contention.
        init_adc()
        if adc is None:
            return None
        try:
            raw = adc.get_adc_raw_value()
            if raw > 32767:
                raw -= 65536
            return int(raw * ADC_UV_PER_COUNT)
        except Exception as e2:
            log('ADS1110 read failed after reinit: {}'.format(e2))
        return None


def trimmed_mean_microvolts(samples):
    """Discard one high and one low value, then average the middle samples."""
    if (not isinstance(samples, list) or
            len(samples) != ADC_FILTER_SAMPLE_COUNT):
        raise ValueError('expected exactly {} ADC samples'.format(
            ADC_FILTER_SAMPLE_COUNT))
    for value in samples:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError('ADC samples must be integer microvolts')
    ordered = list(samples)
    ordered.sort()
    return sum(ordered[1:-1]) // (ADC_FILTER_SAMPLE_COUNT - 2)


def read_ads1110_microvolts():
    """Use five fresh 15-SPS conversions to reject one high and one low outlier."""
    samples = []
    for index in range(ADC_FILTER_SAMPLE_COUNT):
        value = _read_ads1110_microvolts_once()
        if value is None:
            return None
        samples.append(value)
        if index + 1 < ADC_FILTER_SAMPLE_COUNT:
            # ADS1110 15 SPS conversions are 66.7 ms apart. This makes each
            # retained input a new conversion without overrunning the 1 Hz loop.
            time.sleep_ms(ADC_FILTER_SAMPLE_SPACING_MS)
    return trimmed_mean_microvolts(samples)


def read_battery():
    """Returns (voltage_v, current_a, level_pct, charging) from M5.Power - None for every
    field if the read failed. See the battery section above for why this doesn't talk to
    the INA226 directly."""
    try:
        voltage_v = M5.Power.getBatteryVoltage() / 1000.0
        current_a = M5.Power.getBatteryCurrent() / 1000.0
        level_pct = M5.Power.getBatteryLevel()
        charging = M5.Power.isCharging()
        return voltage_v, current_a, level_pct, charging
    except Exception as e:
        log('M5.Power battery read failed: {}'.format(e))
        return None, None, None, None


def set_charge_enable(enable):
    try:
        M5.Power.setBatteryCharge(enable)
        return True
    except Exception as e:
        log('M5.Power.setBatteryCharge failed: {}'.format(e))
        return False


# --- CPU B communications status: CPU A observes but never changes Wi-Fi ---
wifi_connected = False
network_traffic_allowed = False
shelly_resume_confirmation_pending = True


# --- Shelly read ---
def read_shelly():
    try:
        r = requests.get(SHELLY_URL, timeout=SHELLY_TIMEOUT_S)
        data = r.json()
        r.close()
        return data
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


def build_observation(sequence, observed_ticks_ms, clock_is_synced, shelly,
                      shelly_is_available, shelly_poll_was_attempted,
                      shelly_last_valid_ticks_ms,
                      ads_microvolts, battery_voltage, battery_current,
                      battery_percent, battery_is_charging, battery_is_valid,
                      battery_charge_is_enabled, battery_sample_ticks_ms,
                      wifi_is_connected, traffic_is_allowed, wifi_status,
                      wifi_address, wifi_disconnect_count, shelly_failures):
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
            'adc_microvolts': ads_microvolts,
            'battery_voltage': battery_voltage,
            'battery_current': battery_current,
            'battery_percent': battery_percent,
            'battery_charging': battery_is_charging,
            'battery_charge_enabled': battery_charge_is_enabled,
        },
        'status': {
            'shelly_available': shelly_is_available,
            'shelly_poll_attempted': shelly_poll_was_attempted,
            'shelly_last_valid_ticks_ms': shelly_last_valid_ticks_ms,
            'shelly_age_ms': (time.ticks_diff(
                observed_ticks_ms, shelly_last_valid_ticks_ms)
                if shelly_last_valid_ticks_ms is not None else None),
            'adc_available': ads_microvolts is not None,
            'battery_available': battery_is_valid,
            'battery_sample_ticks_ms': battery_sample_ticks_ms,
            'shelly_failure_count': shelly_failures,
            'wifi_connected': wifi_is_connected,
            'network_traffic_allowed': traffic_is_allowed,
            'clock_synced': clock_is_synced,
            'wifi_driver_status': wifi_status,
            'wifi_ip': wifi_address,
            'wifi_disconnect_count': wifi_disconnect_count,
        },
    }


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


def durable_observation_reason(observation, previous, elapsed_ms,
                               numeric_thresholds=None,
                               exact_change_paths=None,
                               maximum_interval_ms=MAX_DURABLE_OBSERVATION_INTERVAL_MS,
                               confirmed_shelly_availability_change=False):
    """Return CPU A's sparse durable-selection reason, or None.

    The complete one-second observation stays in RAM unless a configured
    material field changes or the maximum interval expires. A valid UTC sample
    time is required by the durable-observation v1 contract.
    """
    if not isinstance(observation, dict) or observation.get('observedAt') is None:
        return None
    if previous is None:
        return 'material-change'
    if numeric_thresholds is None:
        numeric_thresholds = MATERIAL_NUMERIC_THRESHOLDS
    if exact_change_paths is None:
        exact_change_paths = MATERIAL_EXACT_CHANGE_PATHS
    if confirmed_shelly_availability_change:
        return 'material-change'
    for path in exact_change_paths:
        if (_observation_path_value(observation, path) !=
                _observation_path_value(previous, path)):
            return 'material-change'
    for path, threshold in numeric_thresholds.items():
        if _numeric_material_change(
                _observation_path_value(observation, path),
                _observation_path_value(previous, path), threshold):
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
    if rules_reference is None:
        rules_reference = PACKAGED_RULES_REFERENCE
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
        'rulesRelease': dict(rules_reference),
    })
    return record


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


def _valid_rules_release_id(value, version):
    if (not isinstance(value, str) or not isinstance(version, int) or
            isinstance(version, bool) or version < 1):
        return False
    prefix = value[:14]
    suffix = '-rules-v{}'.format(version)
    return prefix.isdigit() and value.endswith(suffix) and len(value) == 14 + len(suffix)


def validate_rules_metadata(metadata):
    """Validate the M2 rules pointer without interpreting rule conditions."""
    if not isinstance(metadata, dict):
        return None
    required = (
        'schemaVersion', 'siteId', 'releaseId', 'rulesVersion',
        'rulesSchemaVersion', 'contentHash', 'hashAlgorithm',
        'publishedAtMs', 'downloadPath',
    )
    if any(field not in metadata for field in required):
        return None
    if metadata.get('schemaVersion') != 1 or metadata.get('siteId') != SITE_ID:
        return None
    if metadata.get('rulesSchemaVersion') != 1 or metadata.get('hashAlgorithm') != 'sha256':
        return None
    if (not isinstance(metadata.get('rulesVersion'), int) or
            isinstance(metadata.get('rulesVersion'), bool) or
            metadata.get('rulesVersion') < 1 or
            not isinstance(metadata.get('publishedAtMs'), int) or
            isinstance(metadata.get('publishedAtMs'), bool) or
            metadata.get('publishedAtMs') < 0 or
            not _valid_rules_hash(metadata.get('contentHash'))):
        return None
    if not _valid_rules_release_id(metadata.get('releaseId'), metadata.get('rulesVersion')):
        return None
    path = metadata.get('downloadPath')
    prefix = '/.netlify/functions/rules-release/'
    if not isinstance(path, str) or not path.startswith(prefix) or not path.endswith('.json'):
        return None
    suffix = path[len(prefix):-5]
    if not suffix or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for char in suffix):
        return None
    return {
        'schemaVersion': 1,
        'siteId': SITE_ID,
        'releaseId': metadata['releaseId'],
        'rulesVersion': metadata['rulesVersion'],
        'rulesSchemaVersion': 1,
        'contentHash': metadata['contentHash'],
        'hashAlgorithm': 'sha256',
        'publishedAtMs': metadata['publishedAtMs'],
        'downloadPath': path,
    }


def validate_rules_release(raw_release, metadata=None):
    """Check release bytes, supported schema, and all workbook rule rows.

    This deliberately validates package shape only. M7 will interpret the
    conditions and create event state; M6 never evaluates a rule.
    """
    if (not isinstance(raw_release, str) or not raw_release or
            len(raw_release.encode('utf-8')) > MAX_RULES_RELEASE_BYTES):
        return None, 'release-size'
    content_hash = _sha256_hex(raw_release)
    if content_hash is None:
        return None, 'release-hash-unavailable'
    if metadata is not None:
        metadata = validate_rules_metadata(metadata)
        if metadata is None:
            return None, 'metadata-invalid'
        if content_hash != metadata.get('contentHash'):
            return None, 'release-hash-mismatch'
    try:
        package = ujson.loads(raw_release)
    except Exception:
        return None, 'release-json-invalid'
    required = (
        'schemaVersion', 'kind', 'releaseId', 'rulesVersion',
        'rulesSchemaVersion', 'sourceWorkbook', 'rules',
    )
    if not isinstance(package, dict) or any(field not in package for field in required):
        return None, 'release-incomplete'
    if (package.get('schemaVersion') != 1 or
            package.get('kind') != 'well-pump-rules-release' or
            package.get('rulesSchemaVersion') != 1 or
            package.get('sourceWorkbook') != 'well_pump_operational_rules_1.xlsx' or
            not isinstance(package.get('rulesVersion'), int) or
            isinstance(package.get('rulesVersion'), bool) or
            package.get('rulesVersion') < 1):
        return None, 'release-schema-unsupported'
    if not _valid_rules_release_id(package.get('releaseId'), package.get('rulesVersion')):
        return None, 'release-schema-unsupported'
    if metadata is not None and (
            package.get('releaseId') != metadata.get('releaseId') or
            package.get('rulesVersion') != metadata.get('rulesVersion')):
        return None, 'release-metadata-mismatch'
    rules = package.get('rules')
    if not isinstance(rules, list) or len(rules) != len(EXPECTED_RULE_IDS):
        return None, 'release-rule-count'
    ids = []
    for rule in rules:
        if not isinstance(rule, dict):
            return None, 'release-rule-shape'
        if (not isinstance(rule.get('id'), str) or
                not isinstance(rule.get('event'), str) or not rule.get('event') or
                not isinstance(rule.get('enabled'), bool) or
                rule.get('level') not in (None, 'Yellow', 'Red') or
                rule.get('response') not in ('Observe', 'Alert', 'Trip—while active',
                                             'Trip—recovery policy', 'Trip—latched/manual reset') or
                not isinstance(rule.get('confirmSeconds'), int) or
                isinstance(rule.get('confirmSeconds'), bool) or rule.get('confirmSeconds') < 1 or
                not isinstance(rule.get('clearSeconds'), int) or
                isinstance(rule.get('clearSeconds'), bool) or rule.get('clearSeconds') < 1 or
                not isinstance(rule.get('conditions'), dict) or not rule.get('conditions') or
                not isinstance(rule.get('notify'), bool) or
                not isinstance(rule.get('commissioningStatus'), str) or not rule.get('commissioningStatus')):
            return None, 'release-rule-invalid'
        ids.append(rule['id'])
    if tuple(ids) != EXPECTED_RULE_IDS:
        return None, 'release-completeness'
    return {
        'package': package,
        'reference': {
            'version': package['rulesVersion'],
            'contentHash': content_hash,
        },
        'metadata': metadata,
    }, None


def load_packaged_rules(path=RULES_FILE):
    """Load the installed baseline. It must be valid before CPU A starts."""
    try:
        with open(path, 'r') as handle:
            raw_release = handle.read()
    except Exception:
        return None, 'baseline-unavailable'
    return validate_rules_release(raw_release)


def adopt_rules_release(candidate, active_reference,
                        path=RULES_FILE, temporary_path=RULES_TEMP_FILE):
    """Validate in RAM, then use one atomic rename to replace last-known-good."""
    if not isinstance(candidate, dict):
        return None, 'candidate-invalid'
    raw_release = candidate.get('release')
    checked, reason = validate_rules_release(raw_release, candidate.get('metadata'))
    if checked is None:
        return None, reason
    reference = checked['reference']
    if active_reference == reference:
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


# --- display --- (M5.begin() already ran at the top, before any I2C() objects existed)
M5.Lcd.setRotation(1)
M5.Lcd.fillScreen(BG)


def draw_label(text, x, y, font, color, bg=BG):
    M5.Lcd.setFont(font)
    M5.Lcd.setTextColor(color, bg)
    M5.Lcd.drawString(text, x, y)


TOUCH_BTN_X, TOUCH_BTN_Y, TOUCH_BTN_W, TOUCH_BTN_H = 250, 440, 780, 180
BATTERY_LABEL_X, BATTERY_LABEL_Y = 780, 100  # clear of the DejaVu40 title above it
CHARGE_SWITCH_LABEL_Y = 145

# Static elements: drawn once, never redrawn - only the value fields below
# them repaint each cycle, so there's no full-screen flash at poll rate.
draw_label('TAB5 PLATFORM VALIDATION', 200, 30, M5.Lcd.FONTS.DejaVu40, WHITE)
draw_label('SHELLY STATUS', 60, 120, M5.Lcd.FONTS.Montserrat18, CYAN)
draw_label('ACTIVE POWER', 60, 220, M5.Lcd.FONTS.Montserrat18, CYAN)
draw_label('LINE VOLTAGE', 460, 220, M5.Lcd.FONTS.Montserrat18, CYAN)
draw_label('PORT A ADS1110', 60, 320, M5.Lcd.FONTS.Montserrat18, CYAN)

_last_rendered_touch_count = None


def render(status_text, power_w, voltage_v, ads_uv, touch_count,
           battery_v, battery_level, battery_charging, battery_valid, charge_enable):
    global _last_rendered_touch_count
    # status gets its own full-width row - it's the longest string ("WAITING FOR DATA")
    # and was overlapping the power column when shared a row with it.
    draw_label(status_text + '          ', 60, 155, M5.Lcd.FONTS.DejaVu40, WHITE)
    draw_label('{} W  '.format(power_w) if power_w is not None else '-- W  ', 60, 255, M5.Lcd.FONTS.DejaVu40, WHITE)
    draw_label('{:.1f} V  '.format(voltage_v) if voltage_v is not None else '--.- V  ', 460, 255, M5.Lcd.FONTS.DejaVu40, WHITE)

    if battery_valid:
        if battery_charging:
            state_text, batt_color = 'CHARGING', GREEN
        elif charge_enable:
            state_text, batt_color = 'HOLDING', CYAN
        else:
            state_text, batt_color = 'CHG OFF', WHITE
        batt_text = 'BAT {:.2f}V {}% {}   '.format(battery_v, battery_level, state_text)
    else:
        batt_text, batt_color = 'BAT UNAVAILABLE   ', YELLOW
    draw_label(batt_text, BATTERY_LABEL_X, BATTERY_LABEL_Y, M5.Lcd.FONTS.Montserrat24, batt_color)

    # Separate from the line above on purpose: that one shows live current flow
    # (isCharging()), this one shows the policy's own switch position
    # (setBatteryCharge() target) - they can differ, e.g. switch ON but showing HOLDING
    # because the pack is full and no current is actually moving.
    switch_text = 'CHG SWITCH: {}   '.format('ON' if charge_enable else 'OFF')
    switch_color = GREEN if charge_enable else RED
    draw_label(switch_text, BATTERY_LABEL_X, CHARGE_SWITCH_LABEL_Y, M5.Lcd.FONTS.Montserrat24, switch_color)

    if ads_uv is not None:
        draw_label('{:.6f} V   '.format(ads_uv / 1000000), 60, 355, M5.Lcd.FONTS.DejaVu40, WHITE)
    else:
        draw_label('UNAVAILABLE   ', 60, 355, M5.Lcd.FONTS.DejaVu40, RED)

    if touch_count != _last_rendered_touch_count:
        btn_color = GREEN if (touch_count & 1) else BLUE
        M5.Lcd.fillRoundRect(TOUCH_BTN_X, TOUCH_BTN_Y, TOUCH_BTN_W, TOUCH_BTN_H, 20, btn_color)
        draw_label('TOUCH TEST {}'.format(touch_count), TOUCH_BTN_X + 260, TOUCH_BTN_Y + 65,
                    M5.Lcd.FONTS.DejaVu40, WHITE, bg=btn_color)
        _last_rendered_touch_count = touch_count

    draw_label('wifi: {}  |  cloud: {}   '.format(
        'up' if wifi_connected else 'DOWN',
        'allowed' if network_traffic_allowed else 'quiet period'), 60, 640, M5.Lcd.FONTS.Montserrat24, CYAN)


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


def check_touch_button(was_pressed):
    """was_pressed tracks 'finger was inside the button last poll'.

    Logging is keyed on a separate finger-down edge: was_pressed only goes
    True inside the button, so keying the log off it floods one line per poll
    for the whole time a finger rests anywhere outside it."""
    global _touch_was_down
    p = read_touch_point()
    if p is None:
        _touch_was_down = False
        return False, False
    tx, ty, x, y = p
    inside = (TOUCH_BTN_X <= x <= TOUCH_BTN_X + TOUCH_BTN_W and
              TOUCH_BTN_Y <= y <= TOUCH_BTN_Y + TOUCH_BTN_H)
    if not _touch_was_down:
        log('touch screen=({},{}) inside={}'.format(x, y, inside))
    _touch_was_down = True
    tapped = inside and not was_pressed
    return tapped, inside


# --- boot sequence ---
internal_antenna_ready = confirm_internal_antenna()
log('CPU A device loop initialized; CPU B owns Wi-Fi recovery and Netlify')
log('CPU A release M6.2')

_installed_rules, _rules_error = load_packaged_rules()
if _installed_rules is None:
    # A corrupt or missing shipped baseline is a release-build error. Do not
    # pretend a rule package exists; M7 must never receive an unknown policy.
    raise RuntimeError('validated rules baseline unavailable: {}'.format(_rules_error))
active_rules = _installed_rules['package']
active_rules_reference = _installed_rules['reference']
log('Rules baseline loaded: version={}, hash={}'.format(
    active_rules_reference['version'], active_rules_reference['contentHash'][:12]))

# Assume charging is permitted until the first battery poll below says otherwise -
# M5.Power has no getter for the enable pin itself (only isCharging(), which reflects
# active current flow, not permission), so this is a starting guess that self-corrects
# within BATTERY_POLL_PERIOD_MS regardless of which way it's wrong.
charge_enable = True

last_valid_sample = None
last_valid_sample_ms = None
sample_failure_count = 0
touch_count = 0
touch_pressed = False
battery_v = None
battery_a = None
battery_level = None
battery_charging = None
battery_valid = False
last_battery_poll_ms = -BATTERY_POLL_PERIOD_MS
observation_sequence = 0
device_session_id = cloud.device_session_id()
event_history = new_event_history()
shelly_availability_confirmation = new_shelly_availability_confirmation()
last_durable_observation = None
last_durable_observation_ms = None
next_rules_request_ms = 0

log('Platform validation harness initialized')

while True:
    now = time.ticks_ms()
    observation_sequence += 1
    # M5.update() drives M5.Touch and is REQUIRED for it to report anything.
    # It reinitializes the ESP-IDF I2C peripheral, which used to invalidate the
    # machine.I2C handles for the ADC and the ST7123 - that is what caused the
    # constant bus rebuilding. Both are gone now: Port A is on SoftI2C (immune,
    # bit-banged GPIO) and touch is M5's own. Nothing is left for this to break.
    M5.update()
    tapped, touch_pressed = check_touch_button(touch_pressed)
    if tapped:
        touch_count += 1
        log('Touch test accepted #{}'.format(touch_count))

    was_connected = wifi_connected
    (wifi_connected, network_traffic_allowed, clock_synced,
     wifi_driver_status, wifi_ip, wifi_disconnect_events) = cloud.status_snapshot()
    if wifi_connected and not was_connected:
        shelly_resume_confirmation_pending = True

    # CPU B exposes the RTDB pointer and later an exact downloaded body. CPU A
    # decides whether it is safe to request, validate, and adopt the release;
    # it never waits for either network operation.
    sync_message = cloud.take_sync_message()
    if isinstance(sync_message, dict):
        metadata = validate_rules_metadata(sync_message.get('currentRules'))
        if sync_message.get('currentRules') is not None and metadata is None:
            log('Rules pointer ignored: metadata invalid')
        if (metadata is not None and
                metadata.get('contentHash') != active_rules_reference.get('contentHash') and
                time.ticks_diff(now, next_rules_request_ms) >= 0):
            log('Rules pointer accepted: release={}'.format(metadata['releaseId']))
            if cloud.request_rules_release(metadata):
                next_rules_request_ms = time.ticks_add(now, RULES_FETCH_RETRY_MS)
                log('Rules release request queued for CPU B')
    release_candidate = cloud.take_rules_release()
    if release_candidate is not None:
        candidate_metadata = validate_rules_metadata(
            release_candidate.get('metadata') if isinstance(release_candidate, dict) else None)
        adopted, outcome = adopt_rules_release(
            release_candidate, active_rules_reference)
        if adopted is not None and outcome == 'adopted':
            active_rules = adopted['package']
            active_rules_reference = adopted['reference']
            log('Rules release adopted: version={}, hash={}'.format(
                active_rules_reference['version'],
                active_rules_reference['contentHash'][:12]))
            rules_audit = build_rules_audit_record(
                'rule-adoption', format_observed_at(clock_synced),
                device_session_id, observation_sequence, active_rules_reference,
                candidate_metadata['releaseId'] if candidate_metadata is not None else None)
            if rules_audit is not None and cloud.submit_durable_record(rules_audit):
                log('Rules adoption audit queued: sequence={}'.format(
                    observation_sequence))
        elif outcome != 'already-active':
            # The previous validated flash file remains active. The next
            # coordination snapshot retries after the bounded fetch interval.
            log('Rules release rejected: {}'.format(outcome))
            if candidate_metadata is not None:
                rejected_reference = {
                    'version': candidate_metadata['rulesVersion'],
                    'contentHash': candidate_metadata['contentHash'],
                }
                rules_audit = build_rules_audit_record(
                    'rule-rejection', format_observed_at(clock_synced),
                    device_session_id, observation_sequence, rejected_reference,
                    candidate_metadata['releaseId'], outcome)
                if rules_audit is not None and cloud.submit_durable_record(rules_audit):
                    log('Rules rejection audit queued: sequence={}'.format(
                        observation_sequence))

    ads_uv = read_ads1110_microvolts()

    if time.ticks_diff(now, last_battery_poll_ms) >= BATTERY_POLL_PERIOD_MS:
        last_battery_poll_ms = now
        v, a, level, charging = read_battery()
        battery_valid = v is not None
        if battery_valid:
            battery_v, battery_a = v, a
            battery_level, battery_charging = level, charging
            log('battery: {:.3f} V, {:.3f} A, {}%, {}, charge_enable={}'.format(
                v, a, level, 'charging' if charging else 'not charging', charge_enable))
            if level <= BATTERY_LOW_PCT and not charge_enable:
                if set_charge_enable(True):
                    charge_enable = True
                    log('battery policy: {}% <= {}% -> charging ON'.format(level, BATTERY_LOW_PCT))
            elif level >= BATTERY_HIGH_PCT and charge_enable:
                if set_charge_enable(False):
                    charge_enable = False
                    log('battery policy: {}% >= {}% -> charging OFF'.format(level, BATTERY_HIGH_PCT))
        else:
            log('battery-monitor YELLOW: M5.Power read unavailable; charge_enable left as-is ({})'.format(
                charge_enable))

    sample = None
    shelly_poll_attempted = False
    if wifi_connected and network_traffic_allowed:
        shelly_poll_attempted = True
        sample = read_shelly()
        if sample is None:
            sample_failure_count += 1
        else:
            last_valid_sample = sample
            last_valid_sample_ms = now
            if shelly_resume_confirmation_pending:
                log('Shelly polling confirmed after connection: ticks_ms={}, connected={}, status={}, IP={}'.format(
                    now, wifi_connected, wifi_driver_status, wifi_ip))
                shelly_resume_confirmation_pending = False

    observation = build_observation(
        observation_sequence, now, clock_synced,
        sample if sample is not None else {}, sample is not None,
        shelly_poll_attempted, last_valid_sample_ms, ads_uv,
        battery_v, battery_a, battery_level, battery_charging,
        battery_valid, charge_enable, last_battery_poll_ms,
        wifi_connected, network_traffic_allowed, wifi_driver_status,
        wifi_ip, wifi_disconnect_events, sample_failure_count)
    append_event_history(event_history, observation)
    shelly_availability_pending = shelly_availability_change_pending(
        shelly_availability_confirmation,
        observation['status']['shelly_available'])
    cloud.submit_observation(observation)
    elapsed_since_durable_ms = None
    if last_durable_observation_ms is not None:
        elapsed_since_durable_ms = time.ticks_diff(
            now, last_durable_observation_ms)
    durable_reason = durable_observation_reason(
        observation, last_durable_observation,
        elapsed_since_durable_ms,
        confirmed_shelly_availability_change=shelly_availability_pending)
    if durable_reason is not None:
        durable_record = build_durable_observation(
            observation, device_session_id, durable_reason,
            active_rules_reference)
        if (durable_record is not None and
                cloud.submit_durable_record(durable_record)):
            last_durable_observation = observation
            last_durable_observation_ms = now
            if shelly_availability_pending:
                acknowledge_shelly_availability_change(
                    shelly_availability_confirmation)
            log('Durable observation selected: sequence={}, reason={}'.format(
                observation_sequence, durable_reason))

    stale = last_valid_sample_ms is not None and time.ticks_diff(now, last_valid_sample_ms) > STALE_AFTER_MS
    if last_valid_sample is None:
        status_text = 'WAITING FOR DATA'
    elif stale:
        status_text = 'SHELLY STALE'
    else:
        status_text = 'SHELLY ACTIVE'

    power_w = round(last_valid_sample['power']) if last_valid_sample else None
    voltage_v = last_valid_sample['voltage'] if last_valid_sample else None
    render(status_text, power_w, voltage_v, ads_uv, touch_count,
           battery_v, battery_level, battery_charging, battery_valid, charge_enable)

    # Sleep out the rest of the sample period, but poll touch every 50 ms so
    # taps are not missed. Sensor cadence stays at SAMPLE_PERIOD_MS.
    sleep_until = time.ticks_add(now, SAMPLE_PERIOD_MS)
    while time.ticks_diff(sleep_until, time.ticks_ms()) > 0:
        # M5.Touch only refreshes when M5.update() runs. Pumping it once per
        # second in the outer loop left 19 of every 20 touch polls reading a
        # stale snapshot, which is what made taps feel unresponsive. Safe to
        # call at this rate now: no machine.I2C handle exists for it to break.
        M5.update()
        tapped, touch_pressed = check_touch_button(touch_pressed)
        if tapped:
            touch_count += 1
            log('Touch test accepted #{}'.format(touch_count))
            render(status_text, power_w, voltage_v, ads_uv, touch_count,
                   battery_v, battery_level, battery_charging, battery_valid, charge_enable)
        time.sleep_ms(50)
