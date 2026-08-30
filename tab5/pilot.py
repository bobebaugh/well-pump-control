# Release: 2026-08-30 Unit 4D — host-only V3 records, controls, and command adapter remain disconnected.
# main.py - Tab5 well-pump observational pilot (interpreted port of
# well-pump-control/firmware/tab5/main/app_main.cpp)
#
# Observes the Wi-Fi connection established before this application starts,
# holds a quiet period after got-IP before opening any socket, samples the
# Shelly EM + ADS1110 at 1 Hz,
# publish to Netlify on change or heartbeat, show live status on screen.
#
# Observational except for the reviewed STOP-only `PumpEnable: false` rules
# consequence. Rules can never command Output 0 ON. Battery charge control is
# the separate exception: an automatic hysteresis policy keeps the pack between
# BATTERY_LOW_PCT and BATTERY_HIGH_PCT - see the battery section below.
# Unit 2-3 Event V3 is host-only semantic selection/execution, intentionally disconnected from M6.27.

import M5
import __main__
import math
import os
import time
import uhashlib
import ujson
import requests
import driver.ads1110 as ads1110
from machine import I2C, Pin, SoftI2C, reset
import cloud

# --- config (values from firmware/tab5/main/pilot_config.h) ---
SHELLY_EM_URL = 'http://192.168.50.141/emeter/0'
SHELLY_1_STATUS_URL = 'http://192.168.50.201/rpc/Shelly.GetStatus'
SHELLY_1_STOP_URL = 'http://192.168.50.201/rpc/Switch.Set?id=0&on=false'
SAMPLE_PERIOD_MS = 1000
SHELLY_TIMEOUT_S = 1  # requests has whole-second granularity; C++ used 750ms
STALE_AFTER_MS = 3000
CLOUD_TELEMETRY_FRESH_MS = 90000
CLOUD_RTDB_FRESH_MS = 45000
CLOUD_FAILED_RED_MS = 180000
PUMP_RUNNING_THRESHOLD_W = 1000.0
# The transducer remains at the well while the Tab5 is being bench-developed.
# ADS1110 communication alone must not turn a disconnected input into apparent
# pressure. Field commissioning will replace this bounded release constant with
# the reviewed parameter lifecycle.
PRESSURE_SENSOR_COMMISSIONED = False
SOFTWARE_RELEASE = 'M6.27'

# CPU A validates and adopts the v2 runtime package. CPU B carries only the
# RTDB pointer and exact downloaded bytes; it never interprets package meaning.
SITE_ID = 'well-main'
DEVICE_ID = 'tab5-well-main'
MAX_DURABLE_OBSERVATION_INTERVAL_MS = 600000
EVENT_HISTORY_DEPTH = 600
SHELLY_AVAILABILITY_CONFIRMATION_SAMPLES = 3
ADC_FILTER_SAMPLE_COUNT = 5
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
    'values.shelly1_sw0',
    'values.shelly1_rly0',
    'status.adc_available',
    'status.battery_available',
    'status.clock_synced',
)
MATERIAL_CHANGE_LABELS = {
    'values.power': 'Shelly EM',
    'values.voltage': 'Shelly EM',
    'values.adc_microvolts': 'pressure ADC',
    'values.battery_voltage': 'Tab5 battery',
    'values.battery_current': 'Tab5 battery',
    'values.battery_percent': 'Tab5 battery',
    'values.battery_charging': 'Tab5 battery',
    'values.battery_charge_enabled': 'Tab5 battery',
    'values.shelly1_sw0': 'Shelly 1',
    'values.shelly1_rly0': 'Shelly 1',
    'status.adc_available': 'pressure ADC',
    'status.battery_available': 'Tab5 battery',
    'status.clock_synced': 'Tab5 clock',
    'status.shelly_available': 'Shelly EM',
    'status.shelly1_available': 'Shelly 1',
}
RULES_RUNTIME_FILE = 'rules-runtime-v2.json'
RULES_RUNTIME_TEMP_FILE = '.rules-runtime-v2.download'
RULES_FETCH_RETRY_MS = 60000
MAX_RULES_RELEASE_BYTES = 65536
RUNTIME_PACKAGE_KIND = 'well-pump-parameter-runtime'
RUNTIME_POINTER_KIND = 'well-pump-runtime-release-pointer'
RUNTIME_SCHEMA_VERSION = 2
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
        'RLY(0)': ('boolean', None, 'readWrite'),
        'UDF(IsLocked)': ('integer', 's', 'read'),
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
_pressure_qualification_selected = bool(getattr(
    __main__, 'PRESSURE_QUALIFICATION_SELECTED', False))


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
# The unit is NOT a bare ADS1110. M5 puts a 6:1 divider in front of it.  At
# the ADS1110's gain-1 hardware setting that gives a 0-12.288 V terminal
# range from its +/-2.048 V converter span.  This pilot selects PGA 2, so its
# effective terminal range is 0-6.144 V (still comfortably above the pressure
# sensor's 4.5 V maximum output).
# Confirmed on hardware 2026-08-19: a 7.8 V input read 1.3 V at the pin, exactly
# 6.0x. Cross-check: M5 quote 16-bit resolution as "~0.183 mV"; 12.288/65536 =
# 0.1875 mV, same number.
#
# Sample rate sets resolution. At the unit's gain-1 hardware range, 15 SPS is
# 62.5 uV/count at the pin and 375 uV/count at the terminal.  At this pilot's
# PGA 2 configuration it is 31.25 uV/count at the pin and 187.5 uV/count at
# the terminal.
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
ADS1110_ADDRESS = 0x48
ADS1110_READY_MASK = 0x80
ADS1110_FRESH_TIMEOUT_MS = 250
ADS1110_READY_POLL_MS = 4
ADC_LSB_UV_AT_PIN = 31.25          # 15 SPS, PGA 2: 1.024 V / 32768
ADC_UV_PER_COUNT = ADC_LSB_UV_AT_PIN * ADC_DIVIDER    # 187.5 uV at the terminal

adc = None
adc_i2c = None


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
    global adc, adc_i2c
    try:
        adc_i2c = SoftI2C(scl=Pin(54), sda=Pin(53), freq=100000)
        adc = ads1110.ADS1110(adc_i2c)
        # ADS1110 PGA bits 01 select gain 2. Use the numeric setting because
        # older UIFlow driver builds do not all export a GAIN_TWO name.
        adc.set_gain(0x01)
        adc.set_sample_rate(ads1110.SPS_15)
        adc.set_mode(ads1110.MODE_CONTIN)
        log('ADS1110 configured: 0x48 continuous, 15 SPS (16-bit), PGA 2x, {} uV/count at terminal'.format(ADC_UV_PER_COUNT))
    except Exception as e:
        adc = None
        adc_i2c = None
        log('ADS1110 configuration failed: {}'.format(e))


init_adc()


def ads1110_signed_raw_count(reply):
    """Decode the ADS1110's two-byte two's-complement conversion register."""
    if not isinstance(reply, (bytes, bytearray)) or len(reply) != 3:
        raise ValueError('ADS1110 reply must be exactly three bytes')
    raw = (reply[0] << 8) | reply[1]
    return raw - 65536 if raw >= 32768 else raw


def _read_ads1110_reply():
    """Read conversion plus config through the owned public SoftI2C bus."""
    if adc_i2c is None:
        raise OSError('ADS1110 bus unavailable')
    return adc_i2c.readfrom(ADS1110_ADDRESS, 3)


def _read_ads1110_fresh_raw_once(service=None):
    """Wait for a new ADS1110 15-SPS conversion using ST/DRDY, not a delay.

    The ADS1110 sets ST/DRDY high after a conversion has been read and clears
    it when a new conversion arrives.  First discard whatever was present at
    call entry, then return only a later reply whose ST/DRDY bit is clear.
    """
    _read_ads1110_reply()  # mark any already-complete conversion as consumed
    deadline = time.ticks_add(time.ticks_ms(), ADS1110_FRESH_TIMEOUT_MS)
    while time.ticks_diff(deadline, time.ticks_ms()) > 0:
        reply = _read_ads1110_reply()
        new_conversion = (reply[2] & ADS1110_READY_MASK) == 0
        if new_conversion:
            return ads1110_signed_raw_count(reply)
        if service is not None:
            service()
        time.sleep_ms(ADS1110_READY_POLL_MS)
    raise OSError('ADS1110 fresh-conversion timeout')


def read_ads1110_fresh_raw_count(service=None):
    """Return one demonstrably fresh signed count; reinitialize once on fault."""
    global adc
    for attempt in range(2):
        if adc is None:
            return None
        try:
            return _read_ads1110_fresh_raw_once(service)
        except Exception as e:
            if attempt == 0:
                log('ADS1110 fresh read failed, reinitializing: {}'.format(e))
                init_adc()
            else:
                log('ADS1110 fresh read failed after reinit: {}'.format(e))
    return None


def _read_ads1110_microvolts_once(service=None):
    """Return one fresh ADS1110 terminal-voltage conversion in microvolts."""
    raw = read_ads1110_fresh_raw_count(service)
    return None if raw is None else int(raw * ADC_UV_PER_COUNT)


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


def read_ads1110_microvolts(service=None):
    """Use five fresh 15-SPS conversions to reject one high and one low outlier."""
    samples = []
    for index in range(ADC_FILTER_SAMPLE_COUNT):
        value = _read_ads1110_microvolts_once(service)
        if value is None:
            return None
        samples.append(value)
    return trimmed_mean_microvolts(samples)


def read_ads1110_filtered_raw_count(service=None):
    """Return the trimmed five-conversion mean in native ADC counts."""
    samples = []
    for _index in range(ADC_FILTER_SAMPLE_COUNT):
        value = read_ads1110_fresh_raw_count(service)
        if value is None:
            return None
        samples.append(value)
    samples.sort()
    return sum(samples[1:-1]) // (ADC_FILTER_SAMPLE_COUNT - 2)


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
shelly1_resume_confirmation_pending = True


# --- Shelly reads ---
def _read_json(url):
    try:
        r = requests.get(url, timeout=SHELLY_TIMEOUT_S)
        data = r.json()
        r.close()
        return data
    except Exception:
        return None


def read_shelly():
    """Read the house-side Gen-1 Shelly EM channel."""
    return _read_json(SHELLY_EM_URL)


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


def read_shelly1():
    """Read SW0 and RLY0 without changing either one."""
    return normalize_shelly1_status(_read_json(SHELLY_1_STATUS_URL))


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
                      ads_microvolts, adc_last_valid_ticks_ms,
                      battery_voltage, battery_current,
                      battery_percent, battery_is_charging, battery_is_valid,
                      battery_charge_is_enabled, battery_sample_ticks_ms,
                      wifi_is_connected, traffic_is_allowed, wifi_status,
                      wifi_address, wifi_disconnect_count, shelly_failures,
                      shelly1=None, shelly1_is_available=False,
                      shelly1_poll_was_attempted=False,
                      shelly1_last_valid_ticks_ms=None,
                      shelly1_failures=0, ads_raw_count=None):
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
            # The runtime contract uses native filtered ADC counts.  The
            # microvolt field is retained only as pilot diagnostic evidence.
            'adc_raw': ads_raw_count,
            'adc_microvolts': ads_microvolts,
            # Preserve the M6.17 end-to-end calculation as separate evidence.
            # pressure_valid below prevents an uncommissioned input from being
            # presented as an operational measurement.
            'pressure_psi': calibrated_psi_from_microvolts(ads_microvolts),
            'battery_voltage': battery_voltage,
            'battery_current': battery_current,
            'battery_percent': battery_percent,
            'battery_charging': battery_is_charging,
            'battery_charge_enabled': battery_charge_is_enabled,
            'shelly1_sw0': shelly1.get('sw0') if isinstance(shelly1, dict) else None,
            'shelly1_rly0': shelly1.get('rly0') if isinstance(shelly1, dict) else None,
        },
        'status': {
            'shelly_available': shelly_is_available,
            'shelly_poll_attempted': shelly_poll_was_attempted,
            'shelly_last_valid_ticks_ms': shelly_last_valid_ticks_ms,
            'shelly_age_ms': sample_age_ms(
                observed_ticks_ms, shelly_last_valid_ticks_ms),
            'adc_available': ads_microvolts is not None,
            'adc_last_valid_ticks_ms': adc_last_valid_ticks_ms,
            'adc_age_ms': sample_age_ms(
                observed_ticks_ms, adc_last_valid_ticks_ms),
            'pressure_sensor_commissioned': PRESSURE_SENSOR_COMMISSIONED,
            'pressure_valid': (PRESSURE_SENSOR_COMMISSIONED and
                               ads_microvolts is not None),
            'battery_available': battery_is_valid,
            'battery_sample_ticks_ms': battery_sample_ticks_ms,
            'shelly_failure_count': shelly_failures,
            'shelly1_available': shelly1_is_available,
            'shelly1_poll_attempted': shelly1_poll_was_attempted,
            'shelly1_last_valid_ticks_ms': shelly1_last_valid_ticks_ms,
            'shelly1_age_ms': sample_age_ms(
                observed_ticks_ms, shelly1_last_valid_ticks_ms),
            'shelly1_failure_count': shelly1_failures,
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


RUNTIME_OBJECT_PATHS = {
    'shelly-gen1-em': {
        'emeter/0.power': 'values.power', 'emeter/0.voltage': 'values.voltage',
        'emeter/0.pf': 'values.pf', 'emeter/0.total': 'values.total',
        '$availability': 'status.shelly_available',
    },
    'shelly-gen4-switch': {
        'SW(0)': 'values.shelly1_sw0', 'RLY(0)': 'values.shelly1_rly0',
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
        if not isinstance(device, dict) or device.get('enabled') is not True:
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


def _runtime_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


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
    """Return the enabled v2 field logging policies keyed by system name."""
    policies = {}
    if not isinstance(package, dict):
        return policies
    for device in package.get('devices', []):
        if not isinstance(device, dict) or device.get('enabled') is not True:
            continue
        for field in device.get('fields', []):
            if isinstance(field, dict) and isinstance(field.get('systemName'), str):
                logging = field.get('logging')
                if isinstance(logging, dict):
                    policies[field['systemName']] = dict(logging)
    for calculation in package.get('calculations', []):
        if not isinstance(calculation, dict):
            continue
        outputs = ([calculation.get('output')] if isinstance(calculation.get('output'), dict)
                   else calculation.get('outputs', []))
        for output in outputs:
            if isinstance(output, dict) and isinstance(output.get('systemName'), str):
                logging = output.get('logging')
                if isinstance(logging, dict):
                    policies[output['systemName']] = dict(logging)
    return policies


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


# --- Event V3 pure semantic kernel (not connected to the M6.27 evaluator) ---
# This bounded kernel deliberately selects assignments only.  It does not call
# requests, cloud, queues, flash, HMI, or the reviewed M6.27 STOP executor.


def _v3_number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool) and
            math.isfinite(value))


def _v3_value_matches(value, field):
    field_type = field.get('type') if isinstance(field, dict) else None
    if field_type == 'boolean':
        return isinstance(value, bool)
    if field_type == 'number':
        return _v3_number(value)
    if field_type == 'integer':
        return isinstance(value, int) and not isinstance(value, bool)
    if field_type == 'enum':
        choices = field.get('enumValues')
        return (isinstance(value, str) and isinstance(choices, list) and
                value in choices)
    return False


def _v3_validate_condition(condition, fields, qualified):
    if not isinstance(condition, dict) or condition.get('mode') not in ('all', 'any'):
        raise ValueError('invalid V3 condition')
    clauses = condition.get('clauses')
    if not isinstance(clauses, list) or not clauses or len(clauses) > 16:
        raise ValueError('invalid V3 clauses')
    required = ('observationCount', 'minimumSeconds') if qualified else ()
    for name in required:
        if name not in condition:
            raise ValueError('missing V3 qualification')
    if qualified:
        if (not isinstance(condition['observationCount'], int) or
                isinstance(condition['observationCount'], bool) or
                condition['observationCount'] < 1 or
                not _v3_number(condition['minimumSeconds']) or
                condition['minimumSeconds'] < 0):
            raise ValueError('invalid V3 qualification')
    for clause in clauses:
        if not isinstance(clause, dict):
            raise ValueError('invalid V3 clause')
        name = clause.get('field')
        if not isinstance(name, str) or name not in fields:
            raise ValueError('unknown V3 field')
        if clause.get('operator') not in ('eq', 'neq', 'lt', 'lte', 'gt', 'gte',
                                          'between', 'outside'):
            raise ValueError('unsupported V3 condition operator')


def _v3_condition_value(condition, snapshot):
    """Evaluate one frozen-snapshot V3 condition; None is missing evidence."""
    if not isinstance(condition, dict) or not isinstance(snapshot, dict):
        return None
    clauses = condition.get('clauses')
    if condition.get('mode') not in ('all', 'any') or not isinstance(clauses, list):
        return None
    results = []
    for clause in clauses:
        if not isinstance(clause, dict):
            return None
        current = snapshot.get(clause.get('field'))
        expected = clause.get('value')
        operator = clause.get('operator')
        if current is None:
            return None
        if operator == 'eq':
            result = current == expected
        elif operator == 'neq':
            result = current != expected
        elif not (_v3_number(current) and _v3_number(expected)):
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
                    not _v3_number(expected[0]) or not _v3_number(expected[1])):
                return None
            inside = expected[0] <= current <= expected[1]
            result = inside if operator == 'between' else not inside
        else:
            return None
        results.append(result)
    return all(results) if condition.get('mode') == 'all' else any(results)


def _v3_validate_phase(phase, fields, writable, opening):
    if not isinstance(phase, dict):
        raise ValueError('invalid V3 phase')
    assignments = phase.get('assignments')
    groups = phase.get('guardedGroups')
    if (not isinstance(assignments, list) or not isinstance(groups, list) or
            len(assignments) > 32 or len(groups) > 16):
        raise ValueError('invalid V3 phase')
    all_assignments = list(assignments)
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('assignments'), list):
            raise ValueError('invalid V3 guarded group')
        _v3_validate_condition(group.get('guard'), fields, False)
        if not group['assignments'] or len(group['assignments']) > 16:
            raise ValueError('invalid V3 guarded assignments')
        all_assignments.extend(group['assignments'])
    seen = set()
    for assignment in all_assignments:
        if not isinstance(assignment, dict):
            raise ValueError('invalid V3 assignment')
        target = assignment.get('target')
        if target in seen or target not in writable:
            raise ValueError('invalid V3 assignment target')
        seen.add(target)
        if assignment.get('ownership') not in ('transition', 'whileOpen'):
            raise ValueError('invalid V3 assignment ownership')
        if not opening and assignment.get('ownership') != 'transition':
            raise ValueError('invalid V3 close ownership')
        if not _v3_value_matches(assignment.get('value'), writable[target]):
            raise ValueError('invalid V3 assignment value')


def _v3_validate_event(event, fields, writable):
    if not isinstance(event, dict) or not isinstance(event.get('id'), str) or not event['id']:
        raise ValueError('invalid V3 event')
    if event.get('eventClass') not in ('transient', 'latched', 'monitor'):
        raise ValueError('invalid V3 event class')
    opening = event.get('opening')
    if not isinstance(opening, dict) or not isinstance(opening.get('trigger'), dict):
        raise ValueError('invalid V3 opening')
    trigger = opening['trigger']
    trigger_type = trigger.get('type')
    if trigger_type == 'condition':
        _v3_validate_condition(trigger.get('condition'), fields, True)
    elif trigger_type in ('manual', 'internal'):
        key = 'request' if trigger_type == 'manual' else 'occurrence'
        qualifier = trigger.get('qualification')
        if (not isinstance(trigger.get(key), str) or not trigger[key] or
                not isinstance(qualifier, dict)):
            raise ValueError('invalid V3 opening trigger')
        _v3_validate_condition({'mode': 'all', 'clauses': [
            {'field': next(iter(fields)), 'operator': 'eq',
             'value': None}], 'observationCount': qualifier.get('observationCount'),
            'minimumSeconds': qualifier.get('minimumSeconds')}, fields, True)
    else:
        raise ValueError('invalid V3 opening trigger')
    closing = event.get('closing')
    if not isinstance(closing, dict):
        raise ValueError('invalid V3 closing')
    policy = closing.get('policy')
    if policy == 'condition':
        _v3_validate_condition(closing.get('condition'), fields, True)
    elif policy not in ('clearEvents', 'immediate'):
        raise ValueError('invalid V3 closing policy')
    if event['eventClass'] == 'latched' and policy != 'clearEvents':
        raise ValueError('invalid V3 latch close policy')
    if event['eventClass'] == 'monitor' and policy == 'immediate':
        raise ValueError('invalid V3 monitor close policy')
    _v3_validate_phase(event.get('onOpen'), fields, writable, True)
    _v3_validate_phase(event.get('onClose'), fields, writable, False)


def _v3_validate_program(program):
    if not isinstance(program, list) or len(program) > 128:
        raise ValueError('invalid V3 expression program')
    for item in program:
        if not isinstance(item, list) or len(item) != 2:
            raise ValueError('invalid V3 expression program')
        if item[0] == 'number' and _v3_number(item[1]):
            continue
        if item[0] == 'field' and isinstance(item[1], str):
            continue
        if item[0] == 'operator' and item[1] in ('+', '-', '*', '/', 'neg'):
            continue
        raise ValueError('invalid V3 expression program')


def resolve_v3_package(package):
    """Resolve one adoption-ready V3 body once; V2 is never reinterpreted."""
    if (not isinstance(package, dict) or package.get('schemaVersion') != 3 or
            package.get('kind') != 'well-pump-event-runtime-v3'):
        raise ValueError('unsupported V3 package identity')
    if set(package) != set(('schemaVersion', 'kind', 'releaseId', 'packageVersion',
                            'adoption', 'devices', 'calculatedFields', 'events')):
        raise ValueError('unsupported V3 package property')
    release_id = package.get('releaseId')
    release_prefix = release_id[:14] if isinstance(release_id, str) else ''
    release_suffix = release_id[14:] if isinstance(release_id, str) else ''
    if (not isinstance(release_id, str) or not release_prefix.isdigit() or
            not release_suffix.startswith('-event-v3-v') or
            not release_suffix[11:].isdigit() or int(release_suffix[11:] or 0) < 1):
        raise ValueError('invalid V3 release identity')
    if (not isinstance(package.get('packageVersion'), int) or
            isinstance(package.get('packageVersion'), bool) or
            package['packageVersion'] < 1 or package['packageVersion'] > 2147483647):
        raise ValueError('invalid V3 package version')
    adoption = package.get('adoption')
    if (not isinstance(adoption, dict) or adoption.get('runtimeSchemaVersion') != 3 or
            adoption.get('legacyPackagePolicy') != 'reject'):
        raise ValueError('invalid V3 adoption policy')
    devices = package.get('devices')
    events = package.get('events')
    calculations = package.get('calculatedFields')
    if (not isinstance(devices, list) or not devices or len(devices) > 16 or
            not isinstance(events, list) or len(events) > 64 or
            not isinstance(calculations, list) or len(calculations) > 64):
        raise ValueError('invalid V3 package shape')
    fields, writable, device_fields, device_objects, writable_devices = {}, {}, {}, {}, {}
    device_drivers, device_addresses = {}, {}
    protected_targets = {}
    device_ids = set()
    for device in devices:
        if (not isinstance(device, dict) or not isinstance(device.get('id'), str) or
                not isinstance(device.get('address'), str) or not device['address'] or
                len(device['address']) > 256 or
                device.get('driver') not in RUNTIME_DIRECT_BINDINGS or
                device.get('enabled') not in (True, False) or
                not isinstance(device.get('fields'), list) or not device['fields'] or
                len(device['fields']) > 32):
            raise ValueError('invalid V3 device')
        if device['id'] in device_ids:
            raise ValueError('duplicate V3 device')
        device_ids.add(device['id'])
        device_drivers[device['id']] = device['driver']
        device_addresses[device['id']] = device['address']
        names, object_fields = [], {}
        binding_catalog = RUNTIME_DIRECT_BINDINGS[device['driver']]
        for field in device['fields']:
            if not isinstance(field, dict) or not isinstance(field.get('systemName'), str):
                raise ValueError('invalid V3 field')
            binding = binding_catalog.get(field.get('object'))
            if (binding is None or field.get('type') != binding[0] or
                    field.get('unit') != binding[1] or field.get('access') != binding[2] or
                    field['systemName'] in fields):
                raise ValueError('invalid V3 field binding')
            fields[field['systemName']] = field
            names.append(field['systemName'])
            object_fields[field['object']] = field
            if field.get('access') == 'readWrite':
                write = field.get('write')
                if (not isinstance(write, dict) or write.get('method') != 'Switch.Set' or
                        write.get('parameters') != {'id': 0, 'valueParameter': 'on'} or
                        write.get('normalValue') is not True or
                        not _v3_value_matches(write.get('normalValue'), field)):
                    raise ValueError('invalid V3 writable field')
                writable[field['systemName']] = field
                writable_devices[field['systemName']] = device['id']
        device_fields[device['id']] = names
        device_objects[device['id']] = object_fields
        protected = object_fields.get('RLY(0)')
        if (device['driver'] == 'shelly-gen4-switch' and
                isinstance(protected, dict) and protected.get('access') == 'readWrite'):
            protected_targets[protected['systemName']] = device['id']
    for calculation in calculations:
        if not isinstance(calculation, dict):
            raise ValueError('invalid V3 calculation')
        if calculation.get('kind') == 'expression':
            output = calculation.get('output')
            _v3_validate_program(calculation.get('program'))
            outputs = [output]
        elif calculation.get('kind') == 'function':
            outputs = calculation.get('outputs')
        else:
            raise ValueError('invalid V3 calculation')
        if not isinstance(outputs, list):
            raise ValueError('invalid V3 calculation outputs')
        for output in outputs:
            if (not isinstance(output, dict) or not isinstance(output.get('systemName'), str) or
                    output['systemName'] in fields):
                raise ValueError('invalid V3 calculated field')
            fields[output['systemName']] = output
    resolved_events, event_ids = [], set()
    for event in events:
        _v3_validate_event(event, fields, writable)
        if event['id'] in event_ids:
            raise ValueError('duplicate V3 event')
        event_ids.add(event['id'])
        resolved_events.append(event)
    pump_target, held_values, transition_assignments = None, {}, []
    for event in resolved_events:
        for phase_index, phase in enumerate((event['onOpen'], event['onClose'])):
            phase_assignments = list(phase['assignments'])
            for group in phase['guardedGroups']:
                phase_assignments.extend(group['assignments'])
            for assignment in phase_assignments:
                target = assignment['target']
                if phase_index == 0 and assignment['ownership'] == 'whileOpen':
                    if target in held_values and held_values[target] != assignment['value']:
                        raise ValueError('incompatible V3 while-open ownership')
                    held_values[target] = assignment['value']
                elif assignment['ownership'] == 'transition':
                    transition_assignments.append((target, assignment['value'], phase_index))
                if target in protected_targets:
                    if pump_target is not None and pump_target != target:
                        raise ValueError('multiple protected V3 pump targets')
                    pump_target = target
    for target, value, phase_index in transition_assignments:
        if target in held_values:
            if phase_index == 1:
                raise ValueError('explicit V3 close assignment conflicts with held target')
            if held_values[target] != value:
                raise ValueError('V3 transition assignment conflicts with held target')
    if pump_target is not None:
        target_device = protected_targets[pump_target]
        lock_field = (device_objects.get(target_device, {}).get('UDF(IsLocked)')
                      if target_device is not None else None)
        if (lock_field is None or lock_field.get('type') != 'integer' or
                lock_field.get('access') != 'read'):
            raise ValueError('protected pump target requires same-device UDF(IsLocked) binding')
    return {'resolvedV3': True, 'package': package, 'events': resolved_events,
            'fields': fields, 'writable': writable, 'deviceFields': device_fields,
            'writableDevices': writable_devices, 'deviceObjects': device_objects,
            'deviceDrivers': device_drivers, 'deviceAddresses': device_addresses,
            'protectedTargets': protected_targets,
            'pumpTarget': pump_target}


def v3_accept_device_records(resolved, records):
    """Accept complete configured device records atomically into one snapshot."""
    if not isinstance(resolved, dict) or resolved.get('resolvedV3') is not True:
        raise ValueError('unresolved V3 package')
    records = records if isinstance(records, dict) else {}
    snapshot, accepted, dropped = {}, [], []
    for device_id, names in resolved['deviceFields'].items():
        record = records.get(device_id)
        complete = isinstance(record, dict)
        if complete:
            for name in names:
                if name not in record or not _v3_value_matches(record[name], resolved['fields'][name]):
                    complete = False
                    break
        if not complete:
            dropped.append(device_id)
            continue
        accepted.append(device_id)
        for name in names:
            snapshot[name] = record[name]
    return {'snapshot': snapshot, 'acceptedDevices': accepted, 'droppedDevices': dropped}


def _v3_evaluate_program(program, values):
    stack = []
    for kind, value in program:
        if kind == 'number':
            stack.append(value)
        elif kind == 'field':
            current = values.get(value)
            if not _v3_number(current):
                return None
            stack.append(current)
        elif kind == 'operator':
            if value == 'neg' and stack:
                stack[-1] = -stack[-1]
            elif len(stack) >= 2:
                right, left = stack.pop(), stack.pop()
                if value == '+': stack.append(left + right)
                elif value == '-': stack.append(left - right)
                elif value == '*': stack.append(left * right)
                elif value == '/' and right != 0: stack.append(left / right)
                else: return None
            else:
                return None
        else:
            return None
    return stack[0] if len(stack) == 1 and _v3_number(stack[0]) else None


def _v3_apply_calculations(resolved, snapshot):
    values = dict(snapshot)
    for calculation in resolved['package']['calculatedFields']:
        if calculation.get('kind') == 'expression':
            values[calculation['output']['systemName']] = _v3_evaluate_program(
                calculation['program'], values)
        else:
            for output in calculation.get('outputs', []):
                values[output['systemName']] = None
    return values


def _v3_new_event_state(event_id):
    return {'eventId': event_id, 'active': False, 'openCount': 0,
            'openElapsedMs': 0, 'openLastEvidenceMs': None, 'closeCount': 0,
            'closeElapsedMs': 0, 'closeLastEvidenceMs': None,
            'eventInstanceId': None}


def _v3_advance_qualification(state, prefix, evidence, now_ms):
    count_name, elapsed_name = prefix + 'Count', prefix + 'ElapsedMs'
    last_name = prefix + 'LastEvidenceMs'
    if evidence is None:
        state[last_name] = None
        return
    if evidence is False:
        state[count_name], state[elapsed_name], state[last_name] = 0, 0, None
        return
    if state[count_name] == 0:
        state[count_name], state[elapsed_name] = 1, 0
    else:
        last = state.get(last_name)
        if isinstance(last, int):
            elapsed = time.ticks_diff(now_ms, last)
            if elapsed > 0:
                state[elapsed_name] += elapsed
        state[count_name] += 1
    state[last_name] = now_ms


def _v3_is_qualified(state, prefix, condition):
    return (state[prefix + 'Count'] >= condition['observationCount'] and
            state[prefix + 'ElapsedMs'] >= int(condition['minimumSeconds'] * 1000))


def _v3_phase_assignments(phase, snapshot):
    """Evaluate every guard against one unchanged transition snapshot."""
    guarded = []
    for group in phase['guardedGroups']:
        guarded.append(_v3_condition_value(group['guard'], snapshot))
    selected = list(phase['assignments'])
    for index, group in enumerate(phase['guardedGroups']):
        if guarded[index] is True:
            selected.extend(group['assignments'])
    return selected


def _v3_clone_kernel(kernel):
    return {
        'resolved': kernel['resolved'],
        'board': {key: dict(value) for key, value in kernel['board'].items()},
        'owners': {target: dict(members) for target, members in kernel['owners'].items()},
        'monitorOwners': dict(kernel['monitorOwners']),
        'instanceSequence': kernel.get('instanceSequence', 0),
        'pumpInhibitDesired': kernel.get('pumpInhibitDesired') is True,
        'pumpMonitorSuspended': kernel.get('pumpMonitorSuspended') is True,
    }


def new_v3_kernel(package):
    resolved = package if isinstance(package, dict) and package.get('resolvedV3') else resolve_v3_package(package)
    return {'resolved': resolved, 'board': {}, 'owners': {}, 'monitorOwners': {},
            'instanceSequence': 0,
            # A fresh session has not selected a Tab5 inhibit, so it must never
            # manufacture a blind enable merely because no owner exists.
            'pumpInhibitDesired': False, 'pumpMonitorSuspended': False}


def _v3_add_open_ownership(kernel, event, state, snapshot, selected):
    instance_id = state['eventInstanceId']
    if event['eventClass'] == 'monitor':
        kernel['monitorOwners'][instance_id] = event['id']
    for assignment in _v3_phase_assignments(event['onOpen'], snapshot):
        if assignment['ownership'] == 'whileOpen':
            kernel['owners'].setdefault(assignment['target'], {})[instance_id] = assignment['value']
        else:
            selected.append(dict(assignment))


def _v3_remove_ownership(kernel, event, state, snapshot, selected):
    instance_id = state.get('eventInstanceId')
    kernel['monitorOwners'].pop(instance_id, None)
    for target in list(kernel['owners']):
        kernel['owners'][target].pop(instance_id, None)
        if not kernel['owners'][target]:
            del kernel['owners'][target]
    for assignment in _v3_phase_assignments(event['onClose'], snapshot):
        selected.append(dict(assignment))


def _v3_shelly_enable_allowed(resolved, acceptance, snapshot):
    target = resolved.get('pumpTarget')
    device_id = resolved.get('writableDevices', {}).get(target)
    lock_field = resolved.get('deviceObjects', {}).get(device_id, {}).get('UDF(IsLocked)')
    return (target is not None and device_id in acceptance['acceptedDevices'] and
            isinstance(lock_field, dict) and snapshot.get(lock_field['systemName']) == 0)


def _v3_reconcile_effective_targets(kernel, acceptance, snapshot):
    assignments = []
    monitor = bool(kernel['monitorOwners'])
    pump_target = kernel['resolved'].get('pumpTarget')
    pump_owners = kernel['owners'].get(pump_target, {}) if pump_target else {}
    if monitor:
        if kernel['pumpInhibitDesired'] and _v3_shelly_enable_allowed(
                kernel['resolved'], acceptance, snapshot):
            assignments.append({'target': pump_target, 'value': True,
                                'reason': 'monitor_suspend_safe_release'})
            kernel['pumpInhibitDesired'] = False
            kernel['pumpMonitorSuspended'] = True
        return monitor, assignments
    if pump_owners:
        # Disable is selectable without a current Shelly record.  Repeating it
        # after a Shelly-local timed re-enable is intentional reconciliation.
        assignments.append({'target': pump_target, 'value': False,
                            'reason': 'active_inhibit_owner'})
        kernel['pumpInhibitDesired'] = True
        kernel['pumpMonitorSuspended'] = False
    elif kernel['pumpInhibitDesired']:
        # A release remains pending across a dropped/locked Shelly sample.
        if _v3_shelly_enable_allowed(kernel['resolved'], acceptance, snapshot):
            assignments.append({'target': pump_target, 'value': True,
                                'reason': 'final_inhibit_release'})
            kernel['pumpInhibitDesired'] = False
            kernel['pumpMonitorSuspended'] = False
    for target, owners in kernel['owners'].items():
        if target != pump_target and owners:
            assignments.append({'target': target, 'value': next(iter(owners.values())),
                                'reason': 'active_owner'})
    return monitor, assignments


def v3_kernel_step(kernel, records, now_ms, commands=None):
    """Pure one-cycle V3 selection: no device, network, queue, or HMI calls."""
    if (not isinstance(kernel, dict) or not isinstance(kernel.get('resolved'), dict) or
            not isinstance(now_ms, int) or isinstance(now_ms, bool)):
        raise ValueError('invalid V3 kernel input')
    next_kernel = _v3_clone_kernel(kernel)
    acceptance = v3_accept_device_records(next_kernel['resolved'], records)
    snapshot = _v3_apply_calculations(next_kernel['resolved'], acceptance['snapshot'])
    commands = commands if isinstance(commands, dict) else {}
    manual = commands.get('manualRequests', [])
    internal = commands.get('internalOccurrences', [])
    manual = manual if isinstance(manual, list) else []
    internal = internal if isinstance(internal, list) else []
    clear_events = commands.get('clearEvents') is True
    normal_request = commands.get('normal') is True
    transitions, transition_assignments = [], []
    next_board = {}
    for event in next_kernel['resolved']['events']:
        event_id = event['id']
        state = dict(next_kernel['board'].get(event_id, _v3_new_event_state(event_id)))
        trigger = event['opening']['trigger']
        trigger_type = trigger['type']
        if trigger_type == 'condition':
            opening_evidence = _v3_condition_value(trigger['condition'], snapshot)
            qualifier = trigger['condition']
        elif trigger_type == 'manual':
            opening_evidence = trigger['request'] in manual
            qualifier = trigger['qualification']
        else:
            opening_evidence = trigger['occurrence'] in internal
            qualifier = trigger['qualification']
        if event.get('enabled') is not True:
            if state.get('active'):
                _v3_remove_ownership(next_kernel, event, state, snapshot, transition_assignments)
                transitions.append({'type': 'close', 'reason': 'rules_disabled', 'eventId': event_id,
                                    'eventInstanceId': state['eventInstanceId']})
            next_board[event_id] = _v3_new_event_state(event_id)
            continue
        if not state.get('active'):
            _v3_advance_qualification(state, 'open', opening_evidence, now_ms)
            if opening_evidence is True and _v3_is_qualified(state, 'open', qualifier):
                state['active'] = True
                next_kernel['instanceSequence'] += 1
                state['eventInstanceId'] = 'v3-instance-' + str(next_kernel['instanceSequence'])
                state['closeCount'], state['closeElapsedMs'], state['closeLastEvidenceMs'] = 0, 0, None
                _v3_add_open_ownership(next_kernel, event, state, snapshot, transition_assignments)
                transitions.append({'type': 'open', 'reason': 'opening_qualified', 'eventId': event_id,
                                    'eventInstanceId': state['eventInstanceId']})
                if event['closing']['policy'] == 'immediate':
                    _v3_remove_ownership(next_kernel, event, state, snapshot, transition_assignments)
                    transitions.append({'type': 'close', 'reason': 'immediate_policy', 'eventId': event_id,
                                        'eventInstanceId': state['eventInstanceId']})
                    state = _v3_new_event_state(event_id)
            next_board[event_id] = state
            continue
        close = False
        close_reason = None
        if (normal_request and trigger_type == 'manual' and
                trigger.get('request') == 'operatorMonitor'):
            close, close_reason = True, 'normal_request'
        elif clear_events and event['closing']['policy'] == 'clearEvents':
            close, close_reason = True, 'clear_events'
        elif event['closing']['policy'] == 'condition':
            if trigger_type == 'condition' and opening_evidence is True:
                _v3_advance_qualification(state, 'close', False, now_ms)
            else:
                close_evidence = (None if trigger_type == 'condition' and
                                  opening_evidence is None else
                                  _v3_condition_value(event['closing']['condition'], snapshot))
                _v3_advance_qualification(state, 'close', close_evidence, now_ms)
                if close_evidence is True and _v3_is_qualified(
                        state, 'close', event['closing']['condition']):
                    close, close_reason = True, 'closing_qualified'
        if close:
            _v3_remove_ownership(next_kernel, event, state, snapshot, transition_assignments)
            transitions.append({'type': 'close', 'reason': close_reason, 'eventId': event_id,
                                'eventInstanceId': state['eventInstanceId']})
            state = _v3_new_event_state(event_id)
        next_board[event_id] = state
    next_kernel['board'] = next_board
    monitor, effective_assignments = _v3_reconcile_effective_targets(
        next_kernel, acceptance, snapshot)
    if monitor:
        # Monitor mode suppresses every selected protected pump-disable,
        # including onOpen/onClose transition assignments. Ownership remains.
        pump_target = next_kernel['resolved'].get('pumpTarget')
        transition_assignments = [assignment for assignment in transition_assignments
                                  if not (assignment.get('target') == pump_target and
                                          assignment.get('value') is False)]
    return next_kernel, {
        'snapshot': snapshot, 'acceptedDevices': acceptance['acceptedDevices'],
        'droppedDevices': acceptance['droppedDevices'], 'transitions': transitions,
        'assignments': transition_assignments + effective_assignments,
        'mode': 'Monitor' if monitor else 'Normal',
    }


# --- Event V3 durable transition records and controls (not connected to M6.27) ---
# These functions only create immutable CPU A messages and kernel/maintenance
# selections. CPU B transport and any actual maintenance action remain separate.


def _v3_record_copy(value, depth=0):
    """Copy one bounded JSON-safe value so callers cannot mutate a record."""
    if depth > 16:
        raise ValueError('V3 record value too deep')
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('V3 record value is not finite')
        return value
    if isinstance(value, list):
        if len(value) > 128:
            raise ValueError('V3 record list too large')
        return [_v3_record_copy(item, depth + 1) for item in value]
    if isinstance(value, dict):
        if len(value) > 128:
            raise ValueError('V3 record object too large')
        copied = {}
        for key, item in value.items():
            if not isinstance(key, str) or key in ('__proto__', 'constructor', 'prototype'):
                raise ValueError('invalid V3 record key')
            copied[key] = _v3_record_copy(item, depth + 1)
        return copied
    raise ValueError('invalid V3 record value')


def _v3_record_compact_time(value):
    if (not isinstance(value, str) or len(value) != 20 or value[4] != '-' or
            value[7] != '-' or value[10] != 'T' or value[13] != ':' or
            value[16] != ':' or value[19] != 'Z'):
        raise ValueError('invalid V3 record observed time')
    compact = value[:4] + value[5:7] + value[8:10] + value[11:13] + value[14:16] + value[17:19]
    if not compact.isdigit():
        raise ValueError('invalid V3 record observed time')
    year, month, day = int(value[:4]), int(value[5:7]), int(value[8:10])
    hour, minute, second = int(value[11:13]), int(value[14:16]), int(value[17:19])
    if month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59:
        raise ValueError('invalid V3 record observed time')
    month_days = (31, 29 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 28,
                  31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if day < 1 or day > month_days[month - 1]:
        raise ValueError('invalid V3 record observed time')
    return compact


def _v3_record_name(value, minimum, maximum, lower_only=False, first_alnum=False):
    if not isinstance(value, str) or len(value) < minimum or len(value) > maximum:
        return False
    for char in value:
        if lower_only:
            valid = ('a' <= char <= 'z') or ('0' <= char <= '9') or char == '-'
        else:
            valid = (('a' <= char <= 'z') or ('A' <= char <= 'Z') or
                     ('0' <= char <= '9') or char in '_-')
        if not valid:
            return False
    if first_alnum:
        first = value[0]
        if not (('a' <= first <= 'z') or ('A' <= first <= 'Z') or ('0' <= first <= '9')):
            return False
    return True


def _v3_record_actor(actor):
    if (not isinstance(actor, dict) or set(actor) != set(('type', 'id')) or
            actor.get('type') not in ('device', 'user', 'system') or
            not isinstance(actor.get('id'), str) or not actor['id'] or
            len(actor['id']) > 128):
        raise ValueError('invalid V3 record actor')
    return {'type': actor['type'], 'id': actor['id']}


def _v3_record_command_id(command_id):
    if command_id is None:
        return None
    if (not isinstance(command_id, str) or len(command_id) < 42 or len(command_id) > 98 or
            not command_id[:14].isdigit() or command_id[14:23] != '-command-' or
            command_id[-11] != '-' or not command_id[-10:].isdigit() or
            not _v3_record_name(command_id[23:-11], 8, 64)):
        raise ValueError('invalid V3 record command context')
    return command_id


def _v3_record_rules_reference(reference):
    if (not isinstance(reference, dict) or set(reference) != set(('version', 'contentHash')) or
            not isinstance(reference.get('version'), int) or isinstance(reference['version'], bool) or
            reference['version'] < 1 or not isinstance(reference.get('contentHash'), str) or
            len(reference['contentHash']) != 64 or
            any(char not in '0123456789abcdef' for char in reference['contentHash'])):
        raise ValueError('invalid V3 record rules reference')
    return {'version': reference['version'], 'contentHash': reference['contentHash']}


def _v3_record_event_consequence(event):
    if event.get('eventClass') == 'monitor':
        return 'monitor'
    for assignment in event.get('onOpen', {}).get('assignments', []):
        if isinstance(assignment, dict):
            return 'inhibit'
    for group in event.get('onOpen', {}).get('guardedGroups', []):
        if isinstance(group, dict) and group.get('assignments'):
            return 'inhibit'
    return 'log-only'


def new_v3_record_stream(package, site_id, device_id, session_id, rules_reference):
    """Create a fresh bounded durable-record state for one Tab5 session."""
    resolved = package if isinstance(package, dict) and package.get('resolvedV3') else resolve_v3_package(package)
    if (not _v3_record_name(site_id, 1, 64, True, True) or
            not _v3_record_name(device_id, 1, 64, True, True) or
            not _v3_record_name(session_id, 8, 64)):
        raise ValueError('invalid V3 record stream identity')
    return {'resolved': resolved, 'siteId': site_id, 'deviceId': device_id,
            'sessionId': session_id, 'rulesRelease': _v3_record_rules_reference(rules_reference),
            'nextSequence': 0, 'openInstances': {}}


def _v3_clone_record_stream(stream):
    if (not isinstance(stream, dict) or not isinstance(stream.get('resolved'), dict) or
            not isinstance(stream.get('nextSequence'), int) or isinstance(stream['nextSequence'], bool) or
            stream['nextSequence'] < 0 or stream['nextSequence'] > 9999999999 or
            not isinstance(stream.get('openInstances'), dict)):
        raise ValueError('invalid V3 record stream')
    return {'resolved': stream['resolved'], 'siteId': stream['siteId'],
            'deviceId': stream['deviceId'], 'sessionId': stream['sessionId'],
            'rulesRelease': _v3_record_rules_reference(stream['rulesRelease']),
            'nextSequence': stream['nextSequence'],
            'openInstances': {key: dict(value) for key, value in stream['openInstances'].items()}}


def v3_build_event_records(stream, outcome, observed_at, actor, command_id=None):
    """Convert ordered V3 kernel transitions to immutable CPU A event records."""
    next_stream = _v3_clone_record_stream(stream)
    compact_time = _v3_record_compact_time(observed_at)
    record_actor = _v3_record_actor(actor)
    command_id = _v3_record_command_id(command_id)
    if not isinstance(outcome, dict) or outcome.get('mode') not in ('Normal', 'Monitor'):
        raise ValueError('invalid V3 record outcome')
    transitions = outcome.get('transitions')
    snapshot = outcome.get('snapshot')
    if not isinstance(transitions, list) or len(transitions) > 64 or not isinstance(snapshot, dict):
        raise ValueError('invalid V3 record transitions')
    event_by_id = {event['id']: event for event in next_stream['resolved']['events']}
    records, rejected = [], []
    for transition in transitions:
        if not isinstance(transition, dict):
            raise ValueError('invalid V3 transition')
        transition_type = transition.get('type')
        rule_id = transition.get('eventId')
        instance_id = transition.get('eventInstanceId')
        event = event_by_id.get(rule_id)
        if (transition_type not in ('open', 'close') or event is None or
                not _v3_record_name(rule_id, 2, 64, False, True) or
                not isinstance(instance_id, str) or not instance_id.startswith('v3-instance-') or
                not instance_id[12:].isdigit() or int(instance_id[12:] or 0) < 1):
            raise ValueError('invalid V3 transition identity')
        reason = transition.get('reason')
        if ((transition_type == 'open' and reason != 'opening_qualified') or
                (transition_type == 'close' and reason not in (
                    'closing_qualified', 'clear_events', 'normal_request',
                    'rules_disabled', 'immediate_policy'))):
            raise ValueError('invalid V3 transition reason')
        if next_stream['nextSequence'] > 9999999999:
            raise ValueError('V3 record sequence exhausted')
        if transition_type == 'open':
            if instance_id in next_stream['openInstances']:
                rejected.append({'eventInstanceId': instance_id, 'reason': 'duplicate_open_identity'})
                continue
            sequence = next_stream['nextSequence']
            next_stream['nextSequence'] += 1
            durable_event_id = '{}-{}-{}-{:010d}'.format(
                compact_time, rule_id, next_stream['sessionId'], sequence)
            next_stream['openInstances'][instance_id] = {
                'eventId': durable_event_id, 'ruleId': rule_id}
        else:
            identity = next_stream['openInstances'].get(instance_id)
            if identity is None or identity.get('ruleId') != rule_id:
                rejected.append({'eventInstanceId': instance_id, 'ruleId': rule_id,
                                 'reason': 'missing_open_identity'})
                continue
            sequence = next_stream['nextSequence']
            next_stream['nextSequence'] += 1
            durable_event_id = identity['eventId']
            del next_stream['openInstances'][instance_id]
        record = {
            'schemaVersion': 1, 'runtimeSchemaVersion': 3,
            'recordType': 'event-' + transition_type,
            'recordId': '{}-event-{}-{}-{:010d}'.format(
                compact_time, transition_type, next_stream['sessionId'], sequence),
            'eventId': durable_event_id, 'eventInstanceId': instance_id,
            'siteId': next_stream['siteId'], 'deviceId': next_stream['deviceId'],
            'sessionId': next_stream['sessionId'], 'sequence': sequence,
            'observedAt': observed_at, 'ruleId': rule_id,
            'severity': event['severity'], 'latched': event['eventClass'] == 'latched',
            'eventClass': event['eventClass'],
            'consequence': _v3_record_event_consequence(event),
            'transitionReason': reason, 'mode': outcome['mode'],
            'rulesRelease': _v3_record_rules_reference(next_stream['rulesRelease']),
            'condition': _v3_record_copy(snapshot), 'actor': dict(record_actor),
        }
        if command_id is not None:
            record['commandId'] = command_id
        records.append(record)
    return next_stream, {'records': records, 'rejected': rejected}


def new_v3_session_projection(session_id):
    """A new session replaces the online board without emitting local closes."""
    if not _v3_record_name(session_id, 8, 64):
        raise ValueError('invalid V3 projection session')
    return {'sessionId': session_id, 'mode': 'Normal', 'openEvents': {}}


def v3_apply_event_records_projection(projection, records, mode):
    """Apply this session's immutable records to a pure online-board view."""
    if (not isinstance(projection, dict) or not isinstance(projection.get('openEvents'), dict) or
            projection.get('mode') not in ('Normal', 'Monitor') or mode not in ('Normal', 'Monitor') or
            not isinstance(records, list)):
        raise ValueError('invalid V3 projection input')
    next_projection = {'sessionId': projection['sessionId'], 'mode': mode,
                       'openEvents': {key: dict(value) for key, value in projection['openEvents'].items()}}
    for record in records:
        if (not isinstance(record, dict) or record.get('runtimeSchemaVersion') != 3 or
                record.get('sessionId') != next_projection['sessionId'] or
                record.get('recordType') not in ('event-open', 'event-close')):
            raise ValueError('invalid V3 projection record')
        if record['recordType'] == 'event-open':
            next_projection['openEvents'][record['eventId']] = {
                'eventId': record['eventId'], 'eventInstanceId': record['eventInstanceId'],
                'ruleId': record['ruleId'], 'eventClass': record['eventClass']}
        else:
            next_projection['openEvents'].pop(record['eventId'], None)
    return next_projection


def v3_current_event_projection(projection):
    if (not isinstance(projection, dict) or projection.get('mode') not in ('Normal', 'Monitor') or
            not isinstance(projection.get('openEvents'), dict)):
        raise ValueError('invalid V3 projection')
    return {'sessionId': projection['sessionId'], 'mode': projection['mode'],
            'openEventIds': sorted(projection['openEvents'])}


def v3_interpret_control(control, actor, command_id=None):
    """Translate reviewed controls into pure kernel or maintenance selections."""
    context = {'actor': _v3_record_actor(actor)}
    command_id = _v3_record_command_id(command_id)
    if command_id is not None:
        context['commandId'] = command_id
    result = {'kernelCommands': {}, 'context': context, 'maintenanceSelections': []}
    if control == 'Clear Events':
        result['kernelCommands']['clearEvents'] = True
    elif control == 'Monitor':
        result['kernelCommands']['manualRequests'] = ['operatorMonitor']
    elif control == 'Normal':
        result['kernelCommands']['normal'] = True
    elif control == 'Restart Tab5':
        result['maintenanceSelections'].append({'target': 'tab5', 'action': 'restart'})
    elif control == 'Restart Shelly':
        result['maintenanceSelections'].append({'target': 'shelly1', 'action': 'restart'})
    else:
        raise ValueError('unsupported V3 control')
    return result


# --- Event V3 pending-command adapter (not connected to M6.27) ---
# This validates only the reviewed Unit 4C2 pending envelope and selects pure
# kernel/maintenance intent.  A caller remains responsible for application,
# durable acknowledgement, and advancing any external applied sequence.


def _v3_command_requested_at(value):
    """Validate the bounded RFC3339 date-time accepted by the V3 command contract."""
    if (not isinstance(value, str) or len(value) < 20 or len(value) > 40 or
            value[4] != '-' or value[7] != '-' or value[10] != 'T' or
            value[13] != ':' or value[16] != ':'):
        return False
    date_part = value[:19]
    if not (date_part[:4] + date_part[5:7] + date_part[8:10] +
            date_part[11:13] + date_part[14:16] + date_part[17:19]).isdigit():
        return False
    year, month, day = int(value[:4]), int(value[5:7]), int(value[8:10])
    hour, minute, second = int(value[11:13]), int(value[14:16]), int(value[17:19])
    if month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59:
        return False
    month_days = (31, 29 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 28,
                  31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if day < 1 or day > month_days[month - 1]:
        return False
    suffix = value[19:]
    if suffix.startswith('.'):
        position = 1
        while position < len(suffix) and suffix[position].isdigit():
            position += 1
        if position == 1:
            return False
        suffix = suffix[position:]
    if suffix == 'Z':
        return True
    if (len(suffix) != 6 or suffix[0] not in '+-' or suffix[3] != ':' or
            not (suffix[1:3] + suffix[4:6]).isdigit()):
        return False
    return int(suffix[1:3]) <= 23 and int(suffix[4:6]) <= 59


def _v3_pending_command_sequence(value):
    return (isinstance(value, int) and not isinstance(value, bool) and
            value >= 1 and value <= 9999999999)


def _v3_command_rejection(command, reason):
    """Return a bounded diagnostic without retaining a mutable raw command."""
    rejected = {'reason': reason}
    if isinstance(command, dict):
        if _v3_pending_command_sequence(command.get('commandSequence')):
            rejected['commandSequence'] = command['commandSequence']
        if isinstance(command.get('commandId'), str) and len(command['commandId']) <= 98:
            rejected['commandId'] = command['commandId']
    return rejected


def v3_adapt_pending_command(command):
    """Validate one exact Unit 4C2 V3 pending command and map it to pure intent."""
    expected = set(('schemaVersion', 'runtimeSchemaVersion', 'commandId', 'commandSequence',
                    'siteId', 'targetDeviceId', 'commandType', 'requestedAt', 'requestedBy',
                    'status', 'payload'))
    if not isinstance(command, dict) or set(command) != expected:
        raise ValueError('invalid V3 command envelope')
    if (command.get('schemaVersion') != 1 or command.get('runtimeSchemaVersion') != 3 or
            command.get('siteId') != 'well-main' or
            command.get('targetDeviceId') != 'tab5-well-main' or
            command.get('status') != 'pending' or
            type(command.get('payload')) is not dict or command['payload'] != {} or
            not _v3_pending_command_sequence(command.get('commandSequence')) or
            not _v3_command_requested_at(command.get('requestedAt'))):
        raise ValueError('invalid V3 command envelope')
    try:
        command_id = _v3_record_command_id(command['commandId'])
    except ValueError:
        raise ValueError('invalid V3 command envelope')
    if (command_id[23:-11] != 'web_control' or
            command_id[-10:] != '{:010d}'.format(command['commandSequence'])):
        raise ValueError('invalid V3 command envelope')
    if command.get('requestedBy') != {'type': 'user', 'id': 'pilot-web'}:
        raise ValueError('invalid V3 command envelope')
    controls = {
        'clear-events': 'Clear Events', 'monitor': 'Monitor', 'normal': 'Normal',
        'restart-tab5': 'Restart Tab5', 'restart-shelly1': 'Restart Shelly',
    }
    control = controls.get(command.get('commandType'))
    if control is None:
        raise ValueError('invalid V3 command envelope')
    interpreted = v3_interpret_control(control, command['requestedBy'], command_id)
    return {
        'commandId': command_id, 'commandSequence': command['commandSequence'],
        'commandType': command['commandType'], 'requestedAt': command['requestedAt'],
        'kernelCommands': dict(interpreted['kernelCommands']),
        'context': {'actor': dict(interpreted['context']['actor']), 'commandId': command_id},
        'maintenanceSelections': [dict(item) for item in interpreted['maintenanceSelections']],
    }


def v3_select_pending_commands(last_applied_sequence, commands):
    """Purely select ordered V3 commands; invalid newer entries fail-stop the batch.

    A caller may advance its applied sequence only through candidateHighWater after
    it has actually applied every returned selection.  An invalid/unorderable
    sequence stops the entire batch before selection (failStopSequence is None);
    an invalid/conflicting ordered sequence stops at that sequence.  Neither path
    advances candidateHighWater past a command that must remain retriable.
    """
    if (isinstance(last_applied_sequence, bool) or
            (not _v3_pending_command_sequence(last_applied_sequence) and
             last_applied_sequence != 0)):
        raise ValueError('invalid V3 applied command sequence')
    if not isinstance(commands, list) or len(commands) > 128:
        raise ValueError('invalid V3 command batch')
    selections, rejections, ordered, unorderable = [], [], [], []
    for index, command in enumerate(commands):
        sequence = command.get('commandSequence') if isinstance(command, dict) else None
        if not _v3_pending_command_sequence(sequence):
            unorderable.append((index, command))
        elif sequence <= last_applied_sequence:
            ordered.append((sequence, index, command, True))
        else:
            ordered.append((sequence, index, command, False))
    if unorderable:
        for index, command in unorderable:
            rejections.append(_v3_command_rejection(command, 'invalid_command_sequence'))
        for sequence, index, command, stale in ordered:
            rejections.append(_v3_command_rejection(command, 'blocked_by_unorderable_sequence'))
        return {'selections': [], 'rejections': rejections,
                'candidateHighWater': last_applied_sequence,
                'failStopSequence': None}
    stale = []
    candidates = []
    for sequence, index, command, is_stale in ordered:
        if is_stale:
            stale.append((sequence, index, command))
        else:
            candidates.append((sequence, index, command))
    for sequence, index, command in stale:
        rejections.append(_v3_command_rejection(command, 'stale_sequence'))
    ordered = candidates
    ordered.sort(key=lambda item: (item[0], item[1]))
    by_sequence, by_id = {}, {}
    for sequence, index, command in ordered:
        by_sequence.setdefault(sequence, []).append((index, command))
        command_id = command.get('commandId') if isinstance(command, dict) else None
        if isinstance(command_id, str):
            by_id.setdefault(command_id, []).append((sequence, index, command))
    candidate_high_water = last_applied_sequence
    fail_stop_sequence = None
    processed_sequences = set()
    rejected_indexes = set()
    for sequence, index, command in ordered:
        if sequence in processed_sequences:
            continue
        processed_sequences.add(sequence)
        same_sequence = by_sequence[sequence]
        if len(same_sequence) != 1:
            for ignored_index, ignored in same_sequence:
                rejections.append(_v3_command_rejection(ignored, 'duplicate_sequence_conflict'))
                rejected_indexes.add(ignored_index)
            fail_stop_sequence = sequence
            break
        command_id = command.get('commandId') if isinstance(command, dict) else None
        if isinstance(command_id, str) and len(by_id.get(command_id, ())) != 1:
            for ignored_sequence, ignored_index, ignored in by_id[command_id]:
                rejections.append(_v3_command_rejection(ignored, 'duplicate_command_id_conflict'))
                rejected_indexes.add(ignored_index)
            fail_stop_sequence = sequence
            break
        try:
            selections.append(v3_adapt_pending_command(command))
        except ValueError:
            rejections.append(_v3_command_rejection(command, 'invalid_command_envelope'))
            rejected_indexes.add(index)
            fail_stop_sequence = sequence
            break
        candidate_high_water = sequence
    if fail_stop_sequence is not None:
        for sequence, index, command in ordered:
            if sequence > fail_stop_sequence and index not in rejected_indexes:
                rejections.append(_v3_command_rejection(command, 'blocked_by_fail_stop'))
    return {'selections': selections, 'rejections': rejections,
            'candidateHighWater': candidate_high_water,
            'failStopSequence': fail_stop_sequence}


# --- Event V3 host-only writable-field executor (not connected to M6.27) ---
# Selection/enqueue is pure.  Only the explicitly invoked worker receives a
# transport and may issue one adapter-bound command at a time.


def _v3_executor_clone(executor):
    return {
        'resolved': executor['resolved'],
        'queue': [dict(command) for command in executor['queue']],
        'transitionQueue': [dict(command) for command in executor['transitionQueue']],
        'pendingReadbacks': [dict(command) for command in executor['pendingReadbacks']],
        'desired': {target: dict(value) for target, value in executor['desired'].items()},
        'latestMode': executor['latestMode'],
        'commandSequence': executor['commandSequence'],
        'maxAttempts': executor['maxAttempts'],
        'maxTransitionCommands': executor['maxTransitionCommands'],
    }


def new_v3_executor(package, max_attempts=2):
    """Create a bounded host-only executor; it does not contact a device."""
    resolved = package if isinstance(package, dict) and package.get('resolvedV3') else resolve_v3_package(package)
    if (not isinstance(max_attempts, int) or isinstance(max_attempts, bool) or
            max_attempts < 1 or max_attempts > 3):
        raise ValueError('invalid V3 executor retry bound')
    return {'resolved': resolved, 'queue': [], 'transitionQueue': [], 'pendingReadbacks': [],
            'desired': {}, 'latestMode': 'Normal',
            'commandSequence': 0, 'maxAttempts': max_attempts,
            'maxTransitionCommands': 64}


def _v3_executor_record(command_id, target, value, state, reason=None):
    record = {'commandId': command_id, 'target': target, 'value': value,
              'state': state}
    if reason is not None:
        record['reason'] = reason
    return record


def _v3_protected_enable_reason(resolved, target, value, accepted_devices, snapshot):
    """Return a gate reason for unsafe protected enable, otherwise None."""
    protected = resolved.get('protectedTargets', {}).get(target)
    if protected is None or value is not True:
        return None
    lock_field = resolved.get('deviceObjects', {}).get(protected, {}).get('UDF(IsLocked)')
    if protected not in accepted_devices:
        return 'protected_enable_requires_current_record'
    if not isinstance(lock_field, dict) or snapshot.get(lock_field.get('systemName')) != 0:
        return 'protected_enable_locked'
    return None


def _v3_bound_write_command(resolved, target, value, command_id):
    field = resolved.get('writable', {}).get(target)
    device_id = resolved.get('writableDevices', {}).get(target)
    write = field.get('write') if isinstance(field, dict) else None
    if (not isinstance(write, dict) or not isinstance(write.get('method'), str) or
            not isinstance(write.get('parameters'), dict) or
            not isinstance(write['parameters'].get('valueParameter'), str) or
            device_id is None):
        return None
    parameters = {'id': write['parameters']['id'],
                  write['parameters']['valueParameter']: value}
    return {'commandId': command_id, 'deviceId': device_id,
            'driver': resolved.get('deviceDrivers', {}).get(device_id),
            'address': resolved.get('deviceAddresses', {}).get(device_id),
            'target': target, 'value': value, 'method': write['method'],
            'parameters': parameters, 'attempts': 0}


def _v3_executor_drop_target(executor, target):
    executor['queue'] = [command for command in executor['queue']
                         if command['target'] != target]


def _v3_executor_supersede_transition_enable(executor, target, rejected):
    """Cancel stale protected transition enables when Normal selects disable."""
    remaining = []
    for command in executor['transitionQueue']:
        if (command['target'] == target and command['value'] is True and
                target in executor['resolved'].get('protectedTargets', {})):
            rejected.append(_v3_executor_record(command['commandId'], target, True,
                                                'rejected', 'superseded'))
        else:
            remaining.append(command)
    executor['transitionQueue'] = remaining
    remaining = []
    for command in executor['pendingReadbacks']:
        if (command['target'] == target and command['value'] is True and
                target in executor['resolved'].get('protectedTargets', {})):
            rejected.append(_v3_executor_record(command['commandId'], target, True,
                                                'rejected', 'superseded'))
        else:
            remaining.append(command)
    executor['pendingReadbacks'] = remaining


def _v3_executor_schedule(executor, target, rejected):
    """Coalesce one target's latest desired value without doing I/O."""
    desired = executor['desired'].get(target)
    _v3_executor_drop_target(executor, target)
    if not isinstance(desired, dict) or desired.get('awaitingConfirmation') is True:
        return
    if (target in executor['resolved'].get('protectedTargets', {}) and
            desired.get('mode') == 'Monitor' and desired.get('value') is False):
        rejected.append(_v3_executor_record(desired['commandId'], target, desired['value'],
                                            'rejected', 'monitor_suppressed'))
        del executor['desired'][target]
        return
    reason = _v3_protected_enable_reason(executor['resolved'], target, desired['value'],
                                         desired['acceptedDevices'], desired['snapshot'])
    if reason is not None:
        rejected.append(_v3_executor_record(desired['commandId'], target, desired['value'],
                                            'rejected', reason))
        return
    command = _v3_bound_write_command(executor['resolved'], target, desired['value'],
                                       desired['commandId'])
    if command is None:
        rejected.append(_v3_executor_record(desired['commandId'], target, desired['value'],
                                            'rejected', 'unsupported_write_binding'))
        del executor['desired'][target]
        return
    command['attempts'] = desired.get('attempts', 0)
    executor['queue'].append(command)


def v3_enqueue_selected_assignments(executor, outcome):
    """Purely bind kernel selections to a bounded command queue; no I/O."""
    if (not isinstance(executor, dict) or not isinstance(executor.get('resolved'), dict) or
            not isinstance(outcome, dict)):
        raise ValueError('invalid V3 executor enqueue input')
    next_executor = _v3_executor_clone(executor)
    selected, rejected, assigned_targets = [], [], set()
    assignments = outcome.get('assignments')
    assignments = assignments if isinstance(assignments, list) else []
    accepted_devices = outcome.get('acceptedDevices')
    accepted_devices = accepted_devices if isinstance(accepted_devices, list) else []
    snapshot = outcome.get('snapshot')
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    mode = outcome.get('mode')
    mode = mode if mode in ('Normal', 'Monitor') else next_executor['latestMode']
    next_executor['latestMode'] = mode
    for assignment in assignments:
        target = assignment.get('target') if isinstance(assignment, dict) else None
        value = assignment.get('value') if isinstance(assignment, dict) else None
        field = next_executor['resolved'].get('writable', {}).get(target)
        if not isinstance(field, dict) or not _v3_value_matches(value, field):
            next_executor['commandSequence'] += 1
            command_id = 'v3-command-' + str(next_executor['commandSequence'])
            selected.append(_v3_executor_record(command_id, target, value, 'selected'))
            rejected.append(_v3_executor_record(command_id, target, value, 'rejected',
                                                'assignment_type_or_target'))
            continue
        if assignment.get('ownership') == 'transition':
            next_executor['commandSequence'] += 1
            command_id = 'v3-command-' + str(next_executor['commandSequence'])
            selected.append(_v3_executor_record(command_id, target, value, 'selected'))
            if len(next_executor['transitionQueue']) >= next_executor['maxTransitionCommands']:
                rejected.append(_v3_executor_record(command_id, target, value, 'rejected',
                                                    'transition_queue_full'))
                continue
            command = _v3_bound_write_command(next_executor['resolved'], target, value, command_id)
            if command is None:
                rejected.append(_v3_executor_record(command_id, target, value, 'rejected',
                                                    'unsupported_write_binding'))
                continue
            command['kind'] = 'transition'
            next_executor['transitionQueue'].append(command)
            continue
        existing = next_executor['desired'].get(target)
        if isinstance(existing, dict) and existing.get('value') == value:
            command_id = existing['commandId']
        else:
            next_executor['commandSequence'] += 1
            command_id = 'v3-command-' + str(next_executor['commandSequence'])
        selected.append(_v3_executor_record(command_id, target, value, 'selected'))
        assigned_targets.add(target)
        if (target in next_executor['resolved'].get('protectedTargets', {}) and
                value is False):
            _v3_executor_supersede_transition_enable(next_executor, target, rejected)
        if not isinstance(existing, dict) or existing.get('value') != value:
            next_executor['desired'][target] = {
                'commandId': command_id, 'value': value, 'acceptedDevices': list(accepted_devices),
                'snapshot': dict(snapshot), 'mode': mode, 'awaitingConfirmation': False,
                'attempts': 0,
            }
        else:
            existing['acceptedDevices'], existing['snapshot'], existing['mode'] = (
                list(accepted_devices), dict(snapshot), mode)
    for target, desired in list(next_executor['desired'].items()):
        if target not in assigned_targets:
            desired['acceptedDevices'] = list(accepted_devices)
            desired['snapshot'] = dict(snapshot)
            desired['mode'] = mode
        _v3_executor_schedule(next_executor, target, rejected)
    return next_executor, {'selected': selected, 'rejected': rejected,
                           'issued': [], 'confirmed': []}


def _v3_transport_accepted(result):
    return result is True or (isinstance(result, dict) and result.get('accepted') is True)


def v3_executor_worker(executor, transport, accepted_devices, snapshot, mode='Normal'):
    """Issue at most one queued command through an injected transport."""
    if (not isinstance(executor, dict) or not callable(transport) or
            not isinstance(accepted_devices, list) or not isinstance(snapshot, dict) or
            mode not in ('Normal', 'Monitor')):
        raise ValueError('invalid V3 executor worker input')
    next_executor = _v3_executor_clone(executor)
    outcome = {'selected': [], 'rejected': [], 'issued': [], 'confirmed': []}
    if not next_executor['queue'] and not next_executor['transitionQueue']:
        return next_executor, outcome
    transition = bool(next_executor['transitionQueue'])
    command = (next_executor['transitionQueue'].pop(0) if transition else
               next_executor['queue'].pop(0))
    if transition:
        latest = next_executor['desired'].get(command['target'])
        if (command['value'] is True and isinstance(latest, dict) and
                latest.get('value') is False):
            outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                            command['value'], 'rejected', 'superseded'))
            return next_executor, outcome
        if any(pending['target'] == command['target']
               for pending in next_executor['pendingReadbacks']):
            next_executor['transitionQueue'].insert(0, command)
            return next_executor, outcome
        if (command['target'] in next_executor['resolved'].get('protectedTargets', {}) and
                mode == 'Monitor' and command['value'] is False):
            outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                            command['value'], 'rejected', 'monitor_suppressed'))
            return next_executor, outcome
        gate_reason = _v3_protected_enable_reason(next_executor['resolved'], command['target'],
                                                   command['value'], accepted_devices, snapshot)
        if gate_reason is not None:
            outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                            command['value'], 'rejected', gate_reason))
            return next_executor, outcome
        command['attempts'] += 1
        outcome['issued'].append(_v3_executor_record(command['commandId'], command['target'],
                                                      command['value'], 'issued'))
        try:
            result = transport(dict(command))
            reason = result.get('reason') if isinstance(result, dict) else None
        except Exception:
            result, reason = False, 'transport_exception'
        if _v3_transport_accepted(result):
            next_executor['pendingReadbacks'].append(command)
        elif command['attempts'] < next_executor['maxAttempts']:
            next_executor['transitionQueue'].append(command)
        else:
            outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                            command['value'], 'rejected',
                                                            reason or 'transport_unconfirmed'))
        return next_executor, outcome
    desired = next_executor['desired'].get(command['target'])
    if not isinstance(desired, dict) or desired.get('value') != command['value']:
        outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                        command['value'], 'rejected', 'superseded'))
        return next_executor, outcome
    desired['acceptedDevices'], desired['snapshot'], desired['mode'] = (
        list(accepted_devices), dict(snapshot), mode)
    if (command['target'] in next_executor['resolved'].get('protectedTargets', {}) and
            mode == 'Monitor' and command['value'] is False):
        del next_executor['desired'][command['target']]
        outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                        command['value'], 'rejected', 'monitor_suppressed'))
        return next_executor, outcome
    gate_reason = _v3_protected_enable_reason(next_executor['resolved'], command['target'],
                                               command['value'], accepted_devices, snapshot)
    if gate_reason is not None:
        outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                        command['value'], 'rejected', gate_reason))
        return next_executor, outcome
    command['attempts'] += 1
    desired['attempts'] = command['attempts']
    outcome['issued'].append(_v3_executor_record(command['commandId'], command['target'],
                                                  command['value'], 'issued'))
    try:
        result = transport(dict(command))
        reason = result.get('reason') if isinstance(result, dict) else None
    except Exception:
        result, reason = False, 'transport_exception'
    if _v3_transport_accepted(result):
        desired['awaitingConfirmation'] = True
    elif command['attempts'] < next_executor['maxAttempts']:
        next_executor['queue'].append(command)
    elif (command['target'] in next_executor['resolved'].get('protectedTargets', {}) and
          command['value'] is True):
        command['attempts'] = 0
        next_executor['queue'].append(command)
        outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                        command['value'], 'rejected',
                                                        reason or 'transport_unconfirmed_pending'))
    else:
        next_executor['desired'].pop(command['target'], None)
        outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                        command['value'], 'rejected',
                                                        reason or 'transport_unconfirmed'))
    return next_executor, outcome


def v3_executor_confirm_readback(executor, accepted_devices, snapshot):
    """Confirm issued commands only from a later complete current readback."""
    if (not isinstance(executor, dict) or not isinstance(accepted_devices, list) or
            not isinstance(snapshot, dict)):
        raise ValueError('invalid V3 executor readback input')
    next_executor = _v3_executor_clone(executor)
    outcome = {'selected': [], 'rejected': [], 'issued': [], 'confirmed': []}
    pending = []
    for command in next_executor['pendingReadbacks']:
        if command['deviceId'] not in accepted_devices:
            pending.append(command)
        elif (_v3_protected_enable_reason(next_executor['resolved'], command['target'],
                                           command['value'], accepted_devices, snapshot) is None and
              snapshot.get(command['target']) == command['value']):
            outcome['confirmed'].append(_v3_executor_record(command['commandId'], command['target'],
                                                             command['value'], 'confirmed'))
        else:
            outcome['rejected'].append(_v3_executor_record(command['commandId'], command['target'],
                                                            command['value'], 'rejected',
                                                            'readback_mismatch'))
    next_executor['pendingReadbacks'] = pending
    for target, desired in list(next_executor['desired'].items()):
        if desired.get('awaitingConfirmation') is not True:
            continue
        device_id = next_executor['resolved'].get('writableDevices', {}).get(target)
        if device_id not in accepted_devices:
            continue
        gate_reason = _v3_protected_enable_reason(next_executor['resolved'], target,
                                                   desired['value'], accepted_devices, snapshot)
        if gate_reason is not None:
            desired['awaitingConfirmation'] = False
            desired['acceptedDevices'], desired['snapshot'] = list(accepted_devices), dict(snapshot)
            outcome['rejected'].append(_v3_executor_record(desired['commandId'], target,
                                                            desired['value'], 'rejected', gate_reason))
            _v3_executor_schedule(next_executor, target, outcome['rejected'])
        elif snapshot.get(target) == desired['value']:
            outcome['confirmed'].append(_v3_executor_record(desired['commandId'], target,
                                                             desired['value'], 'confirmed'))
            del next_executor['desired'][target]
        else:
            desired['awaitingConfirmation'] = False
            desired['acceptedDevices'], desired['snapshot'] = list(accepted_devices), dict(snapshot)
            outcome['rejected'].append(_v3_executor_record(desired['commandId'], target,
                                                            desired['value'], 'rejected',
                                                            'readback_mismatch'))
            _v3_executor_schedule(next_executor, target, outcome['rejected'])
    return next_executor, outcome


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


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


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


def pressure_hmi_value(ads_microvolts, commissioned=PRESSURE_SENSOR_COMMISSIONED):
    """Gate displayed PSI on explicit sensor commissioning, not ADC presence."""
    if not commissioned:
        return None, 'NOT COMMISSIONED'
    if not _is_number(ads_microvolts):
        return None, 'UNAVAILABLE'
    pressure_psi = calibrated_psi_from_microvolts(ads_microvolts)
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
    """Reserve the later Shelly flag contract without inventing lock state."""
    if not shelly1_available:
        return 'UNAVAILABLE'
    if reported_lock in ('NORMAL', 'LOCKED'):
        return reported_lock
    return 'NOT REPORTED'


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
        values.get('adc_microvolts'))
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
        'shelly_lock': shelly_local_lock_status(shelly1_available),
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
    }


def build_system_hmi_model(observation, adopted_reference, rules_package,
                           published_reference=None, transport_status=None,
                           current_ticks_ms=None):
    """Create system status; override and rule processing remain unavailable."""
    if not isinstance(observation, dict):
        observation = {}
    values = observation.get('values')
    status = observation.get('status')
    values = values if isinstance(values, dict) else {}
    status = status if isinstance(status, dict) else {}
    if not _is_number(current_ticks_ms):
        current_ticks_ms = observation.get('observedTicksMs')
    adopted_hash = (adopted_reference.get('contentHash')
                    if isinstance(adopted_reference, dict) else None)
    published_hash = (published_reference.get('contentHash')
                      if isinstance(published_reference, dict) else None)
    return {
        'release': SOFTWARE_RELEASE,
        'collection': 'ACTIVE',
        'rule_engine': ('PACKAGE ADOPTION ONLY' if isinstance(adopted_reference, dict)
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
        'battery_percent': (values.get('battery_percent')
                            if _is_number(values.get('battery_percent')) else None),
        'battery_charging': values.get('battery_charging') is True,
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
    """Reserve event and override surfaces without inventing M7 state."""
    if not isinstance(observation, dict):
        observation = {}
    status = observation.get('status')
    status = status if isinstance(status, dict) else {}
    shelly1_available = status.get('shelly1_available') is True
    return {
        'event_engine': 'NOT IMPLEMENTED',
        'active_events': 'UNAVAILABLE',
        'event_override': 'NOT AVAILABLE',
        'system_override': 'NOT AVAILABLE',
        'shelly_lock': shelly_local_lock_status(shelly1_available),
        'shelly_override': 'NOT AVAILABLE',
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
_last_rendered_page = None
_field_cache = {}


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
    draw_label('{}  OBSERVE ONLY'.format(SOFTWARE_RELEASE), 965, 36,
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
    _draw_field('EVENT ENGINE: NOT IMPLEMENTED', 45, 575, 1190, 35,
                M5.Lcd.FONTS.Montserrat24, YELLOW, 'now.event')


def render_system(model):
    draw_label('RUNTIME', 45, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field('COLLECTION: {}'.format(model['collection']), 45, 128, 570, 36,
                M5.Lcd.FONTS.Montserrat24, GREEN, 'system.collection')
    _draw_field('RULE ENGINE: {}'.format(model['rule_engine']), 45, 173, 570, 36,
                M5.Lcd.FONTS.Montserrat24, YELLOW, 'system.rule_engine')
    _draw_field('SYSTEM OVERRIDE: {}'.format(model['system_override']),
                45, 218, 570, 36, M5.Lcd.FONTS.Montserrat24, YELLOW,
                'system.override')

    draw_label('DEVICES', 665, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    device_text = 'WIFI {}  NET {}\nEM {}  S1 {}\nADC {}  PSI {}'.format(
        model['wifi'], model['network'], model['shelly_em'], model['shelly1'],
        model['adc'], model['pressure'])
    device_lines = device_text.split('\n')
    for index, line in enumerate(device_lines):
        _draw_field(line, 665, 128 + (index * 45), 570, 36,
                    M5.Lcd.FONTS.Montserrat24,
                    cache_key='system.device{}'.format(index))
    _draw_field(model['cloud_detail'], 665, 263, 570, 36,
                M5.Lcd.FONTS.Montserrat24,
                _indicator_color(model['cloud_state']), 'system.cloud')

    draw_label('RULES PACKAGE', 45, 315, M5.Lcd.FONTS.Montserrat18, CYAN)
    adopted = 'ADOPTED v{} {}'.format(
        model['adopted_version'] if model['adopted_version'] is not None else '?',
        model['adopted_hash_prefix'] or 'UNKNOWN')
    published = 'PUBLISHED v{} {}'.format(
        model['published_version'] if model['published_version'] is not None else '?',
        model['published_hash_prefix'] or 'UNKNOWN')
    _draw_field(adopted, 45, 348, 570, 36, M5.Lcd.FONTS.Montserrat24,
                cache_key='system.adopted')
    _draw_field(published, 665, 348, 570, 36, M5.Lcd.FONTS.Montserrat24,
                cache_key='system.published')
    rules_color = GREEN if model['rules_status'] == 'ACTIVE' else YELLOW
    _draw_field('STATUS: {}  |  ENABLED: {}'.format(
        model['rules_status'], model['enabled_rules']),
        45, 400, 1190, 40, M5.Lcd.FONTS.Montserrat24, rules_color,
        'system.rules_status')

    draw_label('TAB5', 45, 475, M5.Lcd.FONTS.Montserrat18, CYAN)
    battery = ('BATTERY {}% {}'.format(
        int(model['battery_percent']),
        'CHARGING' if model['battery_charging'] else 'NOT CHARGING')
        if model['battery_percent'] is not None else 'BATTERY UNAVAILABLE')
    _draw_field('{}  |  RELEASE {}'.format(battery, model['release']),
                45, 508, 1190, 42, M5.Lcd.FONTS.Montserrat24,
                cache_key='system.tab5')
    _draw_field('PARAMETERS AND HISTORY ARE MANAGED ON THE WEB APP',
                45, 575, 1190, 35, M5.Lcd.FONTS.Montserrat18, CYAN,
                'system.footer')


def render_events(model):
    draw_label('ACTIVE EVENTS', 45, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field('ENGINE: {}'.format(model['event_engine']),
                45, 128, 570, 42, M5.Lcd.FONTS.Montserrat24, YELLOW,
                'events.engine')
    _draw_field('ACTIVE LIST: {}'.format(model['active_events']),
                45, 180, 570, 42, M5.Lcd.FONTS.Montserrat24, YELLOW,
                'events.active')

    draw_label('EVENT OVERRIDE', 45, 265, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field(model['event_override'], 45, 298, 570, 55,
                M5.Lcd.FONTS.DejaVu40, YELLOW, 'events.event_override')

    draw_label('SYSTEM OVERRIDE', 665, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field(model['system_override'], 665, 128, 570, 55,
                M5.Lcd.FONTS.DejaVu40, YELLOW, 'events.system_override')

    draw_label('SHELLY LOCAL LOCK', 665, 265,
               M5.Lcd.FONTS.Montserrat18, CYAN)
    lock_color = RED if model['shelly_lock'] == 'LOCKED' else YELLOW
    _draw_field(model['shelly_lock'], 665, 298, 570, 55,
                M5.Lcd.FONTS.DejaVu40, lock_color, 'events.shelly_lock')
    _draw_field('REMOTE OVERRIDE: {}'.format(model['shelly_override']),
                665, 370, 570, 42, M5.Lcd.FONTS.Montserrat24, YELLOW,
                'events.shelly_override')

    _draw_field('NO EVENT OR OVERRIDE ACTION IS IMPLEMENTED',
                45, 480, 1190, 42, M5.Lcd.FONTS.Montserrat24, YELLOW,
                'events.boundary')
    _draw_field('HISTORY AND PARAMETERS ARE MANAGED ON THE WEB APP',
                45, 575, 1190, 35, M5.Lcd.FONTS.Montserrat18, CYAN,
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
    global _touch_was_down
    p = read_touch_point()
    if p is None:
        _touch_was_down = False
        return current_page, False
    tx, ty, x, y = p
    selected_page = navigation_page_at(x, y)
    inside = selected_page is not None
    if not _touch_was_down:
        log('touch screen=({},{}) page={}'.format(
            x, y, selected_page if selected_page is not None else 'none'))
    _touch_was_down = True
    if navigation_selection_allowed(
            was_pressed, current_page, selected_page):
        return selected_page, True
    return current_page, inside


def service_navigation():
    """Service touch independently of how much of the 1 s cycle remains."""
    global hmi_page, navigation_pressed
    M5.update()
    previous_page = hmi_page
    hmi_page, navigation_pressed = check_navigation(
        navigation_pressed, hmi_page)
    if hmi_page != previous_page:
        log('HMI page selected: {}'.format(hmi_page))
        return True
    return False


# --- manually selected pressure qualification utility ---
QUAL_CAPTURE_SAMPLES = 5
QUAL_PUMP_START_W = 1000.0
QUAL_PUMP_STOP_W = 100.0
QUAL_CALIBRATION_START_PSI = 60.0
QUAL_CALIBRATION_START_DIRECTION = 'falling'
QUAL_FLOW_WINDOW_DEFAULT_SECONDS = 10
QUAL_FLOW_WINDOW_MIN_SECONDS = 3
QUAL_FLOW_WINDOW_MAX_SECONDS = 30
QUAL_FLOW_MIN_SPAN_MS = 900
QUAL_FLOW_WINDOW_TOLERANCE_MS = 350
PRESSURE_SENSOR_ZERO_UV = 500000.0
PRESSURE_SENSOR_SPAN_UV = 4000000.0
PRESSURE_SENSOR_SPAN_PSI = 100.0
# End-to-end field fit from 22 usable gauge captures over about 40--61 PSIG.
# The count intercept is extrapolated sensor-system output at zero gauge
# pressure; it is not the ADC electrical-zero offset.
PRESSURE_CALIBRATION_COUNT_INTERCEPT = 3732.02
PRESSURE_CALIBRATION_COUNTS_PER_PSI = 211.492
PRESSURE_PSI_PER_COUNT = 1.0 / PRESSURE_CALIBRATION_COUNTS_PER_PSI
TANK_EFFECTIVE_VOLUME_GAL = 79.3
TANK_PRECHARGE_PSIG = 38.0
SITE_ATMOSPHERE_PSI = 13.1


def summarize_adc_samples(samples):
    """Return the median and full range of valid local filtered ADC samples."""
    valid = [value for value in samples
             if isinstance(value, int) and not isinstance(value, bool)]
    if not valid:
        return None
    valid.sort()
    return {
        'count': len(valid),
        'representativeMicrovolts': valid[len(valid) // 2],
        'spreadMicrovolts': valid[-1] - valid[0],
    }


def qualification_pump_running(power_w, previous,
                               start_w=QUAL_PUMP_START_W,
                               stop_w=QUAL_PUMP_STOP_W):
    """Apply the pilot's cloud thresholds locally, retaining hysteresis."""
    if isinstance(power_w, bool) or not isinstance(power_w, (int, float)):
        return previous
    if previous is True:
        return power_w > stop_w
    return power_w >= start_w


def qualification_midpoint_ticks(start_ticks_ms, end_ticks_ms):
    """Return the wrap-safe midpoint of a completed local measurement."""
    return time.ticks_add(
        start_ticks_ms,
        time.ticks_diff(end_ticks_ms, start_ticks_ms) // 2)


def average_raw_adc_counts(samples):
    """Return the arithmetic mean only for a complete signed ADC batch."""
    if not isinstance(samples, list) or len(samples) != QUAL_CAPTURE_SAMPLES:
        return None
    for value in samples:
        if isinstance(value, bool) or not isinstance(value, int):
            return None
    return sum(samples) / QUAL_CAPTURE_SAMPLES


def calibrated_psi_from_raw_count(raw_count):
    """Apply the qualified end-to-end field fit to one raw ADC count."""
    if isinstance(raw_count, bool) or not isinstance(raw_count, (int, float)):
        return None
    return ((raw_count - PRESSURE_CALIBRATION_COUNT_INTERCEPT) /
            PRESSURE_CALIBRATION_COUNTS_PER_PSI)


def calibrated_psi_from_microvolts(microvolts):
    """Apply the count-domain fit while preserving raw microvolts separately."""
    if isinstance(microvolts, bool) or not isinstance(microvolts, (int, float)):
        return None
    return calibrated_psi_from_raw_count(microvolts / ADC_UV_PER_COUNT)


def raw_count_regression_slope(history, reference_ticks_ms, window_seconds,
                               tolerance_ms=0):
    """Least-squares counts/ms over a real tick horizon, handling tick wrap."""
    if (isinstance(window_seconds, bool) or
            not isinstance(window_seconds, (int, float)) or window_seconds <= 0):
        return None
    horizon_ms = int(window_seconds * 1000) + max(0, int(tolerance_ms))
    points = []
    for item in history:
        if not isinstance(item, dict):
            continue
        raw_count = item.get('average_raw_count')
        midpoint = item.get('midpoint_ticks_ms')
        if (isinstance(raw_count, bool) or not isinstance(raw_count, (int, float)) or
                isinstance(midpoint, bool) or not isinstance(midpoint, int)):
            continue
        age_ms = time.ticks_diff(reference_ticks_ms, midpoint)
        if 0 <= age_ms <= horizon_ms:
            points.append((age_ms, raw_count))
    if len(points) < 2:
        return None
    # x increases forward in time, while age decreases.  This avoids trusting
    # a uniform one-second cadence and leaves tick arithmetic wrap-safe.
    points = [(-age_ms, raw_count) for age_ms, raw_count in points]
    mean_x = sum(point[0] for point in points) / len(points)
    mean_y = sum(point[1] for point in points) / len(points)
    denominator = sum((point[0] - mean_x) ** 2 for point in points)
    if denominator <= 0:
        return None
    return (sum((point[0] - mean_x) * (point[1] - mean_y)
                for point in points) / denominator)


def pressure_flow_evidence(history, current_batch, window_seconds):
    """Return distinct calibrated slope and derived flow evidence."""
    if not isinstance(current_batch, dict):
        return None
    current_count = current_batch.get('average_raw_count')
    midpoint = current_batch.get('midpoint_ticks_ms')
    if (isinstance(current_count, bool) or not isinstance(current_count, (int, float)) or
            isinstance(midpoint, bool) or not isinstance(midpoint, int)):
        return None
    pressure_psig = calibrated_psi_from_raw_count(current_count)
    if pressure_psig is None or pressure_psig < 0 or pressure_psig > PRESSURE_SENSOR_SPAN_PSI:
        return None
    horizon_ms = int(window_seconds * 1000) + QUAL_FLOW_WINDOW_TOLERANCE_MS
    valid_points = []
    for item in history:
        if (isinstance(item, dict) and
                isinstance(item.get('midpoint_ticks_ms'), int) and
                isinstance(item.get('average_raw_count'), (int, float)) and
                not isinstance(item.get('average_raw_count'), bool)):
            age_ms = time.ticks_diff(midpoint, item['midpoint_ticks_ms'])
            if 0 <= age_ms <= horizon_ms:
                history_pressure = calibrated_psi_from_raw_count(
                    item['average_raw_count'])
                if (history_pressure is not None and 0 <= history_pressure <=
                        PRESSURE_SENSOR_SPAN_PSI):
                    valid_points.append(item)
    if len(valid_points) < 3:
        return None
    oldest_age_ms = max(time.ticks_diff(midpoint, item['midpoint_ticks_ms'])
                        for item in valid_points)
    required_span_ms = max(
        QUAL_FLOW_MIN_SPAN_MS,
        int(window_seconds * 1000) - QUAL_FLOW_WINDOW_TOLERANCE_MS)
    if oldest_age_ms < required_span_ms:
        return None
    slope_counts_per_ms = raw_count_regression_slope(
        valid_points, midpoint, window_seconds, QUAL_FLOW_WINDOW_TOLERANCE_MS)
    if slope_counts_per_ms is None:
        return None
    pressure_slope_psi_per_min = (slope_counts_per_ms * PRESSURE_PSI_PER_COUNT *
                                  60000.0)
    dvol_dpressure = (TANK_EFFECTIVE_VOLUME_GAL *
                      (TANK_PRECHARGE_PSIG + SITE_ATMOSPHERE_PSI) /
                      ((pressure_psig + SITE_ATMOSPHERE_PSI) ** 2))
    return {
        'pressure_slope_psi_per_min': pressure_slope_psi_per_min,
        'estimated_flow_gpm': dvol_dpressure * pressure_slope_psi_per_min,
    }


def estimated_flow_gpm(history, current_batch, window_seconds):
    """Return signed derived tank flow for a valid real-time window."""
    evidence = pressure_flow_evidence(history, current_batch, window_seconds)
    return None if evidence is None else evidence['estimated_flow_gpm']


def qualification_filename(prefix):
    """Choose a short collision-free root filename without relying on UTC."""
    existing = set(os.listdir())
    for number in range(1, 1000):
        name = '{}-{:03d}.csv'.format(prefix, number)
        if name not in existing:
            return name
    raise OSError('qualification filename range exhausted')


def _qual_button(x, y, w, h, text, color=BLUE, font=None):
    M5.Lcd.fillRoundRect(x, y, w, h, 16, color)
    M5.Lcd.setFont(font or M5.Lcd.FONTS.Montserrat24)
    M5.Lcd.setTextColor(WHITE, color)
    M5.Lcd.drawString(text, x + 24, y + (h // 2) - 14)


def _qual_title(title, subtitle=None):
    M5.Lcd.fillScreen(BG)
    draw_label(title, 45, 30, M5.Lcd.FONTS.DejaVu40, WHITE)
    if subtitle:
        draw_label(subtitle, 48, 90, M5.Lcd.FONTS.Montserrat18, CYAN)


def _qual_tap(was_down):
    """Return one landscape touch-down edge and the current down state."""
    M5.update()
    try:
        down = M5.Touch.getCount() > 0
        if not down:
            return None, False
        if was_down:
            return None, True
        x = M5.Touch.getX()
        y = M5.Touch.getY()
        if x is None or y is None or x < 0 or y < 0:
            return None, True
        return (x, y), True
    except Exception:
        return None, False


def _qual_wait_release():
    while True:
        M5.update()
        try:
            if M5.Touch.getCount() <= 0:
                return
        except Exception:
            return
        time.sleep_ms(30)


def _in_button(point, x, y, w, h):
    return (point is not None and x <= point[0] <= x + w and
            y <= point[1] <= y + h)


def _wait_until(target_ms):
    while time.ticks_diff(target_ms, time.ticks_ms()) > 0:
        M5.update()
        time.sleep_ms(25)


def _qual_service_adc_wait():
    """Keep the HMI alive while the bounded fresh-conversion wait polls ST/DRDY."""
    try:
        M5.update()
    except Exception:
        pass


def _acquire_calibration_batch():
    """Acquire exactly five fresh raw counts and timestamp the real interval."""
    started_ms = time.ticks_ms()
    samples = []
    for unused in range(QUAL_CAPTURE_SAMPLES):
        raw_count = read_ads1110_fresh_raw_count(_qual_service_adc_wait)
        if raw_count is None:
            samples.append(None)
        else:
            samples.append(raw_count)
    ended_ms = time.ticks_ms()
    return {
        'raw_samples': samples,
        'average_raw_count': average_raw_adc_counts(samples),
        'start_ticks_ms': started_ms,
        'end_ticks_ms': ended_ms,
        'midpoint_ticks_ms': qualification_midpoint_ticks(started_ms, ended_ms),
    }


def _calibration_batch_text(batch):
    if not isinstance(batch, dict):
        return ['S1: --', 'S2: --', 'S3: --', 'S4: --', 'S5: --', 'AVG: --']
    samples = batch.get('raw_samples') or []
    fields = []
    for index in range(QUAL_CAPTURE_SAMPLES):
        value = samples[index] if index < len(samples) else None
        fields.append('S{}: {}'.format(index + 1, '--' if value is None else value))
    average = batch.get('average_raw_count')
    fields.append('AVG: {}'.format('--' if average is None else '{:.1f}'.format(average)))
    return fields


def _open_calibration_log(filename):
    """Open the capture-only CSV lazily: idle screen updates never touch flash."""
    handle = open(filename, 'w')
    handle.write('record_type,capture_id,direction,gauge_psi,'
                 's1_raw_count,s2_raw_count,s3_raw_count,s4_raw_count,s5_raw_count,'
                 'average_raw_count,measurement_start_ticks_ms,'
                 'measurement_end_ticks_ms,measurement_midpoint_ticks_ms,'
                 'calibrated_psi,flow_window_seconds,'
                 'pressure_slope_psi_per_min,estimated_flow_gpm\n')
    handle.flush()
    return handle


def _write_calibration_capture(handle, capture_id, batch, direction, gauge_psi,
                               flow_window_seconds, flow_evidence):
    """Persist exactly the batch currently displayed when Capture was tapped."""
    if handle is None or not isinstance(batch, dict):
        return False
    samples = batch.get('raw_samples') or []
    if len(samples) != QUAL_CAPTURE_SAMPLES:
        return False
    average = batch.get('average_raw_count')
    calibrated_psi = calibrated_psi_from_raw_count(average)
    slope_psi_per_min = (flow_evidence.get('pressure_slope_psi_per_min')
                         if isinstance(flow_evidence, dict) else None)
    flow_gpm = (flow_evidence.get('estimated_flow_gpm')
                if isinstance(flow_evidence, dict) else None)
    fields = ['capture', capture_id, direction, '{:.1f}'.format(gauge_psi)]
    fields.extend('' if value is None else value for value in samples)
    fields.extend([
        '' if average is None else '{:.3f}'.format(average),
        batch.get('start_ticks_ms', ''), batch.get('end_ticks_ms', ''),
        batch.get('midpoint_ticks_ms', ''),
        '' if calibrated_psi is None else '{:.5f}'.format(calibrated_psi),
        flow_window_seconds,
        '' if slope_psi_per_min is None else '{:+.5f}'.format(slope_psi_per_min),
        '' if flow_gpm is None else '{:+.5f}'.format(flow_gpm),
    ])
    handle.write(','.join(str(value) for value in fields) + '\n')
    handle.flush()
    return True


def _render_pressure_calibration(batch, direction, gauge_psi, flow_window_seconds,
                                 flow_evidence, filename, capture_id):
    """Render the completed prior batch at the start of the next anchored cycle."""
    _qual_button(40, 92, 225, 72, direction.upper(),
                 GREEN if direction == 'rising' else YELLOW)
    _qual_button(285, 92, 130, 72, '- PSI', BLUE)
    draw_label('{:.1f} PSI      '.format(gauge_psi), 440, 106,
               M5.Lcd.FONTS.DejaVu40, WHITE)
    _qual_button(675, 92, 130, 72, '+ PSI', BLUE)
    _qual_button(835, 92, 130, 72, 'WIN -', BLUE)
    _qual_button(985, 92, 210, 72, 'WIN +', BLUE)
    draw_label('Flow window: {} s       '.format(flow_window_seconds), 835, 172,
               M5.Lcd.FONTS.Montserrat24, CYAN)

    fields = _calibration_batch_text(batch)
    positions = ((45, 225), (430, 225), (815, 225),
                 (45, 305), (430, 305), (815, 305))
    for text, position in zip(fields, positions):
        draw_label(text + '               ', position[0], position[1],
                   M5.Lcd.FONTS.Montserrat24, WHITE if '--' not in text else YELLOW)
    calibrated_psi = (calibrated_psi_from_raw_count(batch.get('average_raw_count'))
                      if isinstance(batch, dict) else None)
    slope_psi_per_min = (flow_evidence.get('pressure_slope_psi_per_min')
                         if isinstance(flow_evidence, dict) else None)
    flow_gpm = (flow_evidence.get('estimated_flow_gpm')
                if isinstance(flow_evidence, dict) else None)
    draw_label('Calibrated: {} PSI | slope: {} PSI/min       '.format(
        '--' if calibrated_psi is None else '{:.3f}'.format(calibrated_psi),
        '--' if slope_psi_per_min is None else
        '{:+.3f}'.format(slope_psi_per_min)),
        45, 385, M5.Lcd.FONTS.Montserrat24, CYAN)
    draw_label('Derived flow: {} GPM       '.format(
        'unavailable' if flow_gpm is None else '{:+.3f}'.format(flow_gpm)),
        580, 385, M5.Lcd.FONTS.Montserrat24,
        YELLOW if flow_gpm is None else (GREEN if flow_gpm >= 0 else BLUE))
    _qual_button(40, 480, 760, 145, 'CAPTURE DISPLAYED BATCH', GREEN)
    _qual_button(870, 480, 325, 145, 'BACK', RED)
    draw_label('Raw counts | measured fresh at 15 SPS | direction is capture metadata only',
               45, 650, M5.Lcd.FONTS.Montserrat18, CYAN)
    draw_label('{} | captures: {}       '.format(filename, capture_id), 45, 685,
               M5.Lcd.FONTS.Montserrat18, CYAN)


def run_pressure_calibration():
    """Continuously show five fresh raw counts; save only an explicit displayed batch."""
    _qual_wait_release()
    filename = qualification_filename('pressure-cal')
    handle = None
    gauge_psi = QUAL_CALIBRATION_START_PSI
    direction = QUAL_CALIBRATION_START_DIRECTION
    flow_window_seconds = QUAL_FLOW_WINDOW_DEFAULT_SECONDS
    capture_id = 0
    history = []
    completed_batch = None
    displayed_batch = None
    displayed_flow_evidence = None
    next_cycle_ms = time.ticks_ms()
    was_down = False
    _qual_title('GAUGE CALIBRATION')

    while True:
        now_ms = time.ticks_ms()
        if time.ticks_diff(now_ms, next_cycle_ms) >= 0:
            # This exact ordering is intentional: draw the fully completed
            # prior batch at the cycle boundary, then measure the next batch.
            displayed_batch = completed_batch
            displayed_flow_evidence = pressure_flow_evidence(
                history, displayed_batch, flow_window_seconds)
            _render_pressure_calibration(
                displayed_batch, direction, gauge_psi, flow_window_seconds,
                displayed_flow_evidence, filename, capture_id)
            completed_batch = _acquire_calibration_batch()
            if completed_batch['average_raw_count'] is not None:
                history.append(completed_batch)
                # 30 seconds is the largest selectable horizon. Keep one
                # older endpoint to make an exact boundary regression possible.
                current_midpoint = completed_batch['midpoint_ticks_ms']
                history = [item for item in history if time.ticks_diff(
                    current_midpoint, item['midpoint_ticks_ms']) <=
                    (QUAL_FLOW_WINDOW_MAX_SECONDS * 1000 + SAMPLE_PERIOD_MS)]
            next_cycle_ms = time.ticks_add(next_cycle_ms, SAMPLE_PERIOD_MS)
            if time.ticks_diff(time.ticks_ms(), next_cycle_ms) >= 0:
                # Processing was slower than the schedule.  Restart the
                # anchor from real time rather than claiming skipped seconds.
                next_cycle_ms = time.ticks_ms()

        point, was_down = _qual_tap(was_down)
        if _in_button(point, 40, 92, 225, 72):
            direction = 'falling' if direction == 'rising' else 'rising'
        elif _in_button(point, 285, 92, 130, 72):
            gauge_psi -= 1.0
        elif _in_button(point, 675, 92, 130, 72):
            gauge_psi += 1.0
        elif _in_button(point, 835, 92, 130, 72):
            flow_window_seconds = max(
                QUAL_FLOW_WINDOW_MIN_SECONDS, flow_window_seconds - 1)
        elif _in_button(point, 985, 92, 210, 72):
            flow_window_seconds = min(
                QUAL_FLOW_WINDOW_MAX_SECONDS, flow_window_seconds + 1)
        elif _in_button(point, 870, 480, 325, 145):
            if handle is not None:
                handle.close()
            _qual_wait_release()
            return
        elif _in_button(point, 40, 480, 760, 145):
            if displayed_batch is not None:
                if handle is None:
                    handle = _open_calibration_log(filename)
                capture_flow_evidence = pressure_flow_evidence(
                    history, displayed_batch, flow_window_seconds)
                if _write_calibration_capture(
                        handle, capture_id + 1, displayed_batch, direction,
                        gauge_psi, flow_window_seconds, capture_flow_evidence):
                    capture_id += 1
                    gauge_psi += 1.0 if direction == 'rising' else -1.0
        time.sleep_ms(20)


def run_pressure_fill():
    """Append an uninterrupted local ADC + Shelly EM fill trace at about 1 Hz."""
    _qual_wait_release()
    filename = qualification_filename('pressure-fill')
    handle = open(filename, 'w')
    handle.write('sample_number,pressure_elapsed_ms,adc_start_ticks_ms,'
                 'adc_end_ticks_ms,adc_midpoint_ticks_ms,'
                 's1_raw_count,s2_raw_count,s3_raw_count,s4_raw_count,'
                 's5_raw_count,average_raw_count,calibrated_psi,'
                 'flow_window_seconds,pressure_slope_psi_per_min,'
                 'estimated_flow_gpm,'
                 'adc_available,shelly_start_ticks_ms,shelly_end_ticks_ms,'
                 'pump_running_derived,power_w,voltage_v,shelly_available,'
                 'shelly_valid\n')
    handle.flush()
    _qual_title('UNINTERRUPTED FILL RUN', 'Local timing and sampling | {}'.format(filename))
    _qual_button(920, 510, 300, 150, 'STOP', RED)
    draw_label('Recording begins now. STOP closes the CSV and returns.',
               48, 115, M5.Lcd.FONTS.Montserrat24, CYAN)
    started_ms = time.ticks_ms()
    next_sample_ms = started_ms
    sample_count = 0
    pump_running = None
    flow_window_seconds = QUAL_FLOW_WINDOW_DEFAULT_SECONDS
    pressure_history = []
    was_down = False

    while True:
        point, was_down = _qual_tap(was_down)
        if _in_button(point, 920, 510, 300, 150):
            handle.close()
            _qual_wait_release()
            return

        now = time.ticks_ms()
        if time.ticks_diff(now, next_sample_ms) >= 0:
            batch = _acquire_calibration_batch()
            adc_start_ticks_ms = batch['start_ticks_ms']
            adc_end_ticks_ms = batch['end_ticks_ms']
            adc_midpoint_ticks_ms = batch['midpoint_ticks_ms']
            average_raw_count = batch['average_raw_count']
            calibrated_psi = calibrated_psi_from_raw_count(average_raw_count)
            if average_raw_count is not None:
                pressure_history.append(batch)
                pressure_history = [item for item in pressure_history
                                    if time.ticks_diff(
                                        adc_midpoint_ticks_ms,
                                        item['midpoint_ticks_ms']) <=
                                    (flow_window_seconds * 1000 +
                                     SAMPLE_PERIOD_MS)]
            flow_evidence = pressure_flow_evidence(
                pressure_history, batch, flow_window_seconds)
            slope_psi_per_min = (flow_evidence.get('pressure_slope_psi_per_min')
                                 if isinstance(flow_evidence, dict) else None)
            flow_gpm = (flow_evidence.get('estimated_flow_gpm')
                        if isinstance(flow_evidence, dict) else None)
            pressure_elapsed_ms = time.ticks_diff(
                adc_midpoint_ticks_ms, started_ms)
            shelly_start_ticks_ms = time.ticks_ms()
            shelly = read_shelly()
            shelly_end_ticks_ms = time.ticks_ms()
            shelly_available = isinstance(shelly, dict)
            power_w = shelly.get('power') if shelly_available else None
            voltage_v = shelly.get('voltage') if shelly_available else None
            is_valid = shelly.get('is_valid') is True if shelly_available else False
            if not is_valid:
                power_w = None
                voltage_v = None
            pump_running = qualification_pump_running(power_w, pump_running)
            reported_pump_running = pump_running if power_w is not None else None
            sample_count += 1
            fields = [
                sample_count, pressure_elapsed_ms,
                adc_start_ticks_ms, adc_end_ticks_ms,
                adc_midpoint_ticks_ms]
            fields.extend('' if value is None else value
                          for value in batch['raw_samples'])
            fields.extend([
                '' if average_raw_count is None else
                '{:.3f}'.format(average_raw_count),
                '' if calibrated_psi is None else '{:.5f}'.format(calibrated_psi),
                flow_window_seconds,
                '' if slope_psi_per_min is None else
                '{:+.5f}'.format(slope_psi_per_min),
                '' if flow_gpm is None else '{:+.5f}'.format(flow_gpm),
                1 if average_raw_count is not None else 0,
                shelly_start_ticks_ms, shelly_end_ticks_ms,
                '' if reported_pump_running is None else (1 if reported_pump_running else 0),
                '' if power_w is None else power_w,
                '' if voltage_v is None else voltage_v,
                1 if shelly_available else 0,
                1 if is_valid else 0])
            handle.write(','.join(str(value) for value in fields) + '\n')
            handle.flush()
            draw_label('Elapsed {:>5.1f} s | samples {}          '.format(
                pressure_elapsed_ms / 1000, sample_count), 48, 205,
                M5.Lcd.FONTS.DejaVu40, WHITE)
            draw_label('ADC AVG: {} counts          '.format(
                'UNAVAILABLE' if average_raw_count is None else
                '{:.1f}'.format(average_raw_count)),
                48, 285, M5.Lcd.FONTS.DejaVu40,
                RED if average_raw_count is None else WHITE)
            draw_label('Calibrated: {} PSI | {} s slope: {} PSI/min          '.format(
                '--' if calibrated_psi is None else '{:.3f}'.format(calibrated_psi),
                flow_window_seconds,
                '--' if slope_psi_per_min is None else
                '{:+.3f}'.format(slope_psi_per_min)),
                48, 355, M5.Lcd.FONTS.Montserrat24,
                RED if calibrated_psi is None else CYAN)
            draw_label('Pump: {} | Power: {} W | Flow est: {} GPM          '.format(
                'UNKNOWN' if reported_pump_running is None else ('RUNNING' if reported_pump_running else 'STOPPED'),
                '--' if power_w is None else round(power_w),
                '--' if flow_gpm is None else '{:+.2f}'.format(flow_gpm)),
                48, 420, M5.Lcd.FONTS.Montserrat24,
                RED if not shelly_available else CYAN)
            next_sample_ms = time.ticks_add(next_sample_ms, SAMPLE_PERIOD_MS)
            completed_ms = time.ticks_ms()
            if time.ticks_diff(completed_ms, next_sample_ms) >= 0:
                # Do not add a fictitious idle second after an overrun. The
                # next local cycle begins promptly; recorded timing remains
                # the authority for later flow analysis.
                next_sample_ms = completed_ms
        time.sleep_ms(30)


def run_pressure_qualification():
    """Run the local-only utility until normal monitoring is explicitly chosen."""
    log('Pressure qualification selected; CPU B remains active for Wi-Fi recovery only')
    _qual_wait_release()
    was_down = False
    while True:
        _qual_title('PRESSURE QUALIFICATION', 'Local timing | CPU B maintains Wi-Fi | no commands')
        _qual_button(45, 170, 550, 240, 'GAUGE CALIBRATION', GREEN)
        _qual_button(685, 170, 550, 240, 'FILL RUN', BLUE)
        _qual_button(400, 505, 480, 130, 'RESTART NORMAL', YELLOW)
        draw_label('CSV files are stored on Tab5 flash and named on each screen.',
                   330, 665, M5.Lcd.FONTS.Montserrat18, CYAN)
        while True:
            point, was_down = _qual_tap(was_down)
            if _in_button(point, 45, 170, 550, 240):
                run_pressure_calibration()
                was_down = False
                break
            if _in_button(point, 685, 170, 550, 240):
                run_pressure_fill()
                was_down = False
                break
            if _in_button(point, 400, 505, 480, 130):
                _qual_title('RESTARTING', 'Leave the screen untouched to enter normal monitoring.')
                time.sleep_ms(800)
                reset()
            time.sleep_ms(35)


# --- boot sequence ---
if _pressure_qualification_selected:
    run_pressure_qualification()

internal_antenna_ready = confirm_internal_antenna()
log('CPU A device loop initialized; CPU B owns Wi-Fi recovery and Netlify')
log('CPU A release M6.19: touch serviced throughout acquisition cycle')

_installed_runtime, _runtime_error = load_runtime_package()
active_rules = None
active_rules_reference = None
rules_runtime_state = 'UNAVAILABLE'
rules_runtime_reason = _runtime_error
if _installed_runtime is not None:
    active_rules = _installed_runtime['package']
    active_rules_reference = _installed_runtime['reference']
    rules_runtime_state = 'ADOPTED'
    rules_runtime_reason = None
    if not cloud.set_applied_rules(active_rules_reference):
        raise RuntimeError('validated runtime reference handoff failed')
    log('Rules runtime loaded: release={}, hash={}'.format(
        active_rules_reference['releaseId'], active_rules_reference['contentHash'][:12]))
else:
    # v1 rules.json is intentionally not a fallback.  CPU A remains
    # observational and cannot evaluate or request consequences until an
    # intact v2 runtime package has been adopted.
    log('Rules runtime unavailable: {}'.format(_runtime_error))

# Assume charging is permitted until the first battery poll below says otherwise -
# M5.Power has no getter for the enable pin itself (only isCharging(), which reflects
# active current flow, not permission), so this is a starting guess that self-corrects
# within BATTERY_POLL_PERIOD_MS regardless of which way it's wrong.
charge_enable = True

last_valid_sample = None
last_valid_sample_ms = None
sample_failure_count = 0
last_valid_adc_ms = None
last_valid_shelly1 = None
last_valid_shelly1_ms = None
shelly1_failure_count = 0
hmi_page = HMI_PAGE_NOW
navigation_pressed = False
last_observation = None
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
shelly1_availability_confirmation = new_shelly_availability_confirmation()
last_durable_observation = None
last_durable_observation_ms = None
next_rules_request_ms = 0
published_rules_reference = None
event_board = {}

log('Operational HMI foundation initialized; no event or control authority')
render_hmi(hmi_page, {}, active_rules_reference, active_rules,
           published_rules_reference)

while True:
    now = time.ticks_ms()
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
    if wifi_connected and not was_connected:
        shelly_resume_confirmation_pending = True
        shelly1_resume_confirmation_pending = True

    # CPU B exposes the RTDB pointer and later an exact downloaded body. CPU A
    # decides whether it is safe to request, validate, and adopt the release;
    # it never waits for either network operation.
    rules_pointer = cloud.take_rules_pointer()
    if rules_pointer is not None:
        metadata = validate_runtime_pointer(rules_pointer)
        if metadata is None:
            rules_runtime_state = 'REJECTED'
            rules_runtime_reason = runtime_pointer_rejection_reason(rules_pointer)
            log('Runtime pointer ignored: {} [keys={}]'.format(
                rules_runtime_reason, runtime_pointer_key_summary(rules_pointer)))
        else:
            published_rules_reference = {
                'releaseId': metadata['releaseId'],
                'packageVersion': metadata['packageVersion'],
                'runtimeSchemaVersion': metadata['runtimeSchemaVersion'],
                'version': metadata['packageVersion'],
                'contentHash': metadata['contentHash'],
            }
        if (metadata is not None and
                (active_rules_reference is None or
                 metadata.get('contentHash') != active_rules_reference.get('contentHash')) and
                time.ticks_diff(now, next_rules_request_ms) >= 0):
            log('Runtime pointer accepted: release={}'.format(metadata['releaseId']))
            if cloud.request_rules_release(metadata):
                next_rules_request_ms = time.ticks_add(now, RULES_FETCH_RETRY_MS)
                log('Runtime release request queued for CPU B')
    release_candidate = cloud.take_rules_release()
    if release_candidate is not None:
        candidate_metadata = validate_runtime_pointer(
            release_candidate.get('metadata') if isinstance(release_candidate, dict) else None)
        adopted, outcome = adopt_runtime_release(
            release_candidate, active_rules_reference)
        if adopted is not None and outcome == 'adopted':
            active_rules = adopted['package']
            active_rules_reference = adopted['reference']
            rules_runtime_state = 'ADOPTED'
            rules_runtime_reason = None
            # A new package begins with no inherited events.  The evaluator is
            # deliberately not enabled in this acceptance release, so there
            # are no events to migrate or consequences to issue.
            event_board, closed_by_sync = clear_runtime_event_board(event_board)
            for transition in closed_by_sync:
                log('Runtime event closed on package sync: {}'.format(
                    transition['eventId']))
            if not cloud.set_applied_rules(active_rules_reference):
                raise RuntimeError('adopted runtime reference handoff failed')
            log('Runtime release adopted: release={}, hash={}'.format(
                active_rules_reference['releaseId'],
                active_rules_reference['contentHash'][:12]))
        elif outcome != 'already-active':
            # The last validated v2 file remains active. A later coordination
            # pass may retry; this field-level reason is visible on the HMI.
            rules_runtime_state = 'REJECTED'
            rules_runtime_reason = outcome
            log('Runtime release rejected: {}'.format(outcome))

    # The five fresh 15-SPS conversions occupy a material portion of every
    # cycle. Service touch inside their DRDY waits instead of limiting touch
    # detection to whatever sleep time happens to remain afterward.
    ads_raw_count = read_ads1110_filtered_raw_count(service_navigation)
    ads_uv = (None if ads_raw_count is None
              else int(ads_raw_count * ADC_UV_PER_COUNT))
    adc_completed_ms = time.ticks_ms()
    if ads_uv is not None:
        last_valid_adc_ms = adc_completed_ms

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
    service_navigation()

    sample = None
    shelly1_sample = None
    shelly_poll_attempted = False
    shelly1_poll_attempted = False
    if wifi_connected and network_traffic_allowed:
        shelly_poll_attempted = True
        service_navigation()
        sample = read_shelly()
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
        shelly1_sample = read_shelly1()
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
        shelly_poll_attempted, last_valid_sample_ms, ads_uv,
        last_valid_adc_ms,
        battery_v, battery_a, battery_level, battery_charging,
        battery_valid, charge_enable, last_battery_poll_ms,
        wifi_connected, network_traffic_allowed, wifi_driver_status,
        wifi_ip, wifi_disconnect_events, sample_failure_count,
        shelly1_sample, shelly1_sample is not None,
        shelly1_poll_attempted, last_valid_shelly1_ms,
        shelly1_failure_count, ads_raw_count=ads_raw_count)
    observation['status']['rules_runtime_state'] = rules_runtime_state
    observation['status']['rules_runtime_reason'] = rules_runtime_reason
    runtime_logging_changes = []
    if active_rules is not None:
        runtime_values = runtime_direct_field_values(active_rules, observation)
        evaluate_runtime_calculations(active_rules, runtime_values)
        # Named values are additive to the complete observation envelope. This
        # is how the published package's ADC-count pressure expression becomes
        # visible without a second voltage conversion or a cloud calculation.
        observation['values'].update(runtime_values)
        event_board, runtime_transitions = evaluate_runtime_events(
            active_rules, event_board, runtime_values, observation_ticks_ms)
        events_by_id = {event.get('id'): event for event in active_rules.get('events', [])
                        if isinstance(event, dict) and isinstance(event.get('id'), str)}
        # Event records remain a later work unit. The only permitted device
        # consequence is one reviewed STOP request on an opening transition.
        for transition in runtime_transitions:
            log('Runtime event {}: {}'.format(
                transition['type'], transition['eventId']))
            event = events_by_id.get(transition['eventId'])
            if transition['type'] == 'open' and runtime_stop_only_action(event):
                outcome = issue_runtime_stop(observation)
                log('Runtime STOP {}: {}'.format(transition['eventId'], outcome))
        if last_durable_observation is not None:
            runtime_logging_changes = runtime_logging_change_details(
                runtime_values, last_durable_observation.get('values', {}),
                runtime_logging_policies(active_rules))
    last_observation = observation
    append_event_history(event_history, observation)
    shelly_availability_pending = shelly_availability_change_pending(
        shelly_availability_confirmation,
        observation['status']['shelly_available'])
    shelly1_availability_pending = shelly_availability_change_pending(
        shelly1_availability_confirmation,
        observation['status']['shelly1_available'])
    cloud.submit_observation(observation)
    elapsed_since_durable_ms = None
    if last_durable_observation_ms is not None:
        elapsed_since_durable_ms = time.ticks_diff(
            now, last_durable_observation_ms)
    durable_reason = durable_observation_reason(
        observation, last_durable_observation,
        elapsed_since_durable_ms,
        confirmed_shelly_availability_change=shelly_availability_pending,
        confirmed_shelly1_availability_change=shelly1_availability_pending)
    if runtime_logging_changes:
        durable_reason = 'material-change'
    if durable_reason is not None and active_rules_reference is not None:
        material_changes = (material_change_details(
            observation, last_durable_observation,
            confirmed_shelly_availability_change=shelly_availability_pending,
            confirmed_shelly1_availability_change=shelly1_availability_pending)
            if durable_reason == 'material-change' else None)
        if material_changes is not None and runtime_logging_changes:
            material_changes.extend(runtime_logging_changes)
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
            if shelly1_availability_pending:
                acknowledge_shelly_availability_change(
                    shelly1_availability_confirmation)
            if durable_reason == 'material-change':
                log('Durable observation selected: sequence={}, reason={}, '
                    'changes={}'.format(
                        observation_sequence, durable_reason,
                        '; '.join(material_changes)))
            else:
                log('Durable observation selected: sequence={}, reason={}'.format(
                    observation_sequence, durable_reason))

    render_hmi(hmi_page, observation, active_rules_reference, active_rules,
               published_rules_reference)

    # Sleep out the rest of the sample period, but poll touch every 50 ms so
    # taps are not missed. Sensor cadence stays at SAMPLE_PERIOD_MS.
    sleep_until = time.ticks_add(now, SAMPLE_PERIOD_MS)
    while time.ticks_diff(sleep_until, time.ticks_ms()) > 0:
        # M5.Touch only refreshes when M5.update() runs. Pumping it once per
        # second in the outer loop left 19 of every 20 touch polls reading a
        # stale snapshot, which is what made taps feel unresponsive. Safe to
        # call at this rate now: no machine.I2C handle exists for it to break.
        if service_navigation():
            render_hmi(hmi_page, observation, active_rules_reference,
                       active_rules, published_rules_reference)
        time.sleep_ms(50)
