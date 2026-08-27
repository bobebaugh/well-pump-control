# Release: 2026-08-27 M6.18 — add the observational NOW/SYSTEM HMI foundation.
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
import __main__
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
SAMPLE_PERIOD_MS = 1000
SHELLY_TIMEOUT_S = 1  # requests has whole-second granularity; C++ used 750ms
STALE_AFTER_MS = 3000
PUMP_RUNNING_THRESHOLD_W = 1000.0
# The transducer remains at the well while the Tab5 is being bench-developed.
# ADS1110 communication alone must not turn a disconnected input into apparent
# pressure. Field commissioning will replace this bounded release constant with
# the reviewed parameter lifecycle.
PRESSURE_SENSOR_COMMISSIONED = False
SOFTWARE_RELEASE = 'M6.18'

# M5 selection parameters live on CPU A. M6 supplies a validated rules
# reference while CPU B remains a byte-preserving transport only.
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


def _read_ads1110_microvolts_once():
    """Return one fresh ADS1110 terminal-voltage conversion in microvolts."""
    raw = read_ads1110_fresh_raw_count()
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


def read_ads1110_microvolts():
    """Use five fresh 15-SPS conversions to reject one high and one low outlier."""
    samples = []
    for index in range(ADC_FILTER_SAMPLE_COUNT):
        value = _read_ads1110_microvolts_once()
        if value is None:
            return None
        samples.append(value)
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


def build_observation(sequence, observed_ticks_ms, clock_is_synced, shelly,
                      shelly_is_available, shelly_poll_was_attempted,
                      shelly_last_valid_ticks_ms,
                      ads_microvolts, battery_voltage, battery_current,
                      battery_percent, battery_is_charging, battery_is_valid,
                      battery_charge_is_enabled, battery_sample_ticks_ms,
                      wifi_is_connected, traffic_is_allowed, wifi_status,
                      wifi_address, wifi_disconnect_count, shelly_failures,
                      shelly1=None, shelly1_is_available=False,
                      shelly1_poll_was_attempted=False,
                      shelly1_last_valid_ticks_ms=None,
                      shelly1_failures=0):
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
            'shelly_age_ms': (time.ticks_diff(
                observed_ticks_ms, shelly_last_valid_ticks_ms)
                if shelly_last_valid_ticks_ms is not None else None),
            'adc_available': ads_microvolts is not None,
            'pressure_sensor_commissioned': PRESSURE_SENSOR_COMMISSIONED,
            'pressure_valid': (PRESSURE_SENSOR_COMMISSIONED and
                               ads_microvolts is not None),
            'battery_available': battery_is_valid,
            'battery_sample_ticks_ms': battery_sample_ticks_ms,
            'shelly_failure_count': shelly_failures,
            'shelly1_available': shelly1_is_available,
            'shelly1_poll_attempted': shelly1_poll_was_attempted,
            'shelly1_last_valid_ticks_ms': shelly1_last_valid_ticks_ms,
            'shelly1_age_ms': (time.ticks_diff(
                observed_ticks_ms, shelly1_last_valid_ticks_ms)
                if shelly1_last_valid_ticks_ms is not None else None),
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


def _check_rules_metadata(metadata):
    """Return normalized metadata plus a nonsecret rejection reason when invalid."""
    if not isinstance(metadata, dict):
        return None, 'not-an-object'
    required = (
        'schemaVersion', 'siteId', 'releaseId', 'rulesVersion',
        'rulesSchemaVersion', 'contentHash', 'hashAlgorithm',
        'publishedAtMs', 'downloadPath',
    )
    for field in required:
        if field not in metadata:
            return None, 'missing-{}'.format(field)
    if metadata.get('schemaVersion') != 1 or metadata.get('siteId') != SITE_ID:
        return None, 'schema-or-site'
    if metadata.get('rulesSchemaVersion') != 1 or metadata.get('hashAlgorithm') != 'sha256':
        return None, 'schema-or-hash-algorithm'
    published_at_ms = metadata.get('publishedAtMs')
    published_at_is_integral = (
        isinstance(published_at_ms, int) and not isinstance(published_at_ms, bool) or
        isinstance(published_at_ms, float) and published_at_ms >= 0 and
        published_at_ms == int(published_at_ms)
    )
    if (not isinstance(metadata.get('rulesVersion'), int) or
            isinstance(metadata.get('rulesVersion'), bool) or
            metadata.get('rulesVersion') < 1):
        return None, 'rulesVersion'
    if not published_at_is_integral or published_at_ms < 0:
        return None, 'publishedAtMs'
    if not _valid_rules_hash(metadata.get('contentHash')):
        return None, 'contentHash'
    if not _valid_rules_release_id(metadata.get('releaseId'), metadata.get('rulesVersion')):
        return None, 'releaseId'
    path = metadata.get('downloadPath')
    prefix = '/.netlify/functions/rules-release/'
    if not isinstance(path, str) or not path.startswith(prefix) or not path.endswith('.json'):
        return None, 'downloadPath-shape'
    suffix = path[len(prefix):-5]
    if not suffix or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for char in suffix):
        return None, 'downloadPath-characters'
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
    }, None


def validate_rules_metadata(metadata):
    """Validate the M2 rules pointer without interpreting rule conditions."""
    normalized, _reason = _check_rules_metadata(metadata)
    return normalized


def rules_metadata_rejection_reason(metadata):
    """Return only a field-level validation reason; never return pointer data."""
    _normalized, reason = _check_rules_metadata(metadata)
    return reason


def rules_metadata_key_summary(metadata):
    """Return a short field-name-only description for a rejected pointer."""
    if not isinstance(metadata, dict):
        return 'not-an-object'
    keys = list(metadata.keys())
    keys.sort()
    if not keys:
        return 'empty-object'
    # RTDB field names identify the record shape but reveal no pointer values.
    return ','.join(keys[:12])

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
    """Count only explicit boolean-enabled rows in the adopted package."""
    if not isinstance(rules_package, dict):
        return 0
    rules = rules_package.get('rules')
    if not isinstance(rules, list):
        return 0
    return sum(1 for rule in rules
               if isinstance(rule, dict) and rule.get('enabled') is True)


def rules_alignment_status(adopted_reference, published_reference):
    """Never report ACTIVE without matching version and complete SHA-256 hash."""
    if not isinstance(adopted_reference, dict):
        return 'ADOPTED UNKNOWN'
    if not isinstance(published_reference, dict):
        return 'PUBLISHED UNKNOWN'
    adopted_hash = adopted_reference.get('contentHash')
    published_hash = published_reference.get('contentHash')
    if (adopted_reference.get('version') == published_reference.get('version') and
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


def build_now_hmi_model(observation):
    """Create the small current-state view without retaining mutable input."""
    if not isinstance(observation, dict):
        observation = {}
    values = observation.get('values')
    status = observation.get('status')
    values = values if isinstance(values, dict) else {}
    status = status if isinstance(status, dict) else {}
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
            status.get('shelly_age_ms')),
        'power_w': values.get('power') if _is_number(values.get('power')) else None,
        'voltage_v': values.get('voltage') if _is_number(values.get('voltage')) else None,
        'pressure_psi': pressure_psi,
        'pressure_status': pressure_status,
        'shelly1': shelly1_text,
        'shelly_lock': shelly_local_lock_status(shelly1_available),
        'shelly_age_ms': (status.get('shelly_age_ms')
                          if _is_number(status.get('shelly_age_ms')) else None),
        'wifi_connected': status.get('wifi_connected') is True,
        'network_ready': status.get('network_traffic_allowed') is True,
    }


def build_system_hmi_model(observation, adopted_reference, rules_package,
                           published_reference=None):
    """Create system status; override and rule processing remain unavailable."""
    if not isinstance(observation, dict):
        observation = {}
    values = observation.get('values')
    status = observation.get('status')
    values = values if isinstance(values, dict) else {}
    status = status if isinstance(status, dict) else {}
    adopted_hash = (adopted_reference.get('contentHash')
                    if isinstance(adopted_reference, dict) else None)
    published_hash = (published_reference.get('contentHash')
                      if isinstance(published_reference, dict) else None)
    return {
        'release': SOFTWARE_RELEASE,
        'collection': 'ACTIVE',
        'rule_engine': 'NOT IMPLEMENTED',
        'system_override': 'NOT AVAILABLE',
        'wifi': 'UP' if status.get('wifi_connected') is True else 'DOWN',
        'network': ('READY' if status.get('network_traffic_allowed') is True
                    else 'QUIET'),
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


# --- display --- (main.py already ran M5.begin() before starting CPU A)
M5.Lcd.setRotation(1)
M5.Lcd.fillScreen(BG)


def draw_label(text, x, y, font, color, bg=BG):
    M5.Lcd.setFont(font)
    M5.Lcd.setTextColor(color, bg)
    M5.Lcd.drawString(text, x, y)


HMI_PAGE_NOW = 'now'
HMI_PAGE_SYSTEM = 'system'
NAV_Y, NAV_H = 630, 70
NAV_NOW_X, NAV_SYSTEM_X, NAV_W = 35, 655, 590
_last_rendered_page = None


def navigation_page_at(x, y):
    """Return the selected implemented page, or None outside navigation."""
    if not (_is_number(x) and _is_number(y) and NAV_Y <= y <= NAV_Y + NAV_H):
        return None
    if NAV_NOW_X <= x <= NAV_NOW_X + NAV_W:
        return HMI_PAGE_NOW
    if NAV_SYSTEM_X <= x <= NAV_SYSTEM_X + NAV_W:
        return HMI_PAGE_SYSTEM
    return None


def _draw_field(text, x, y, width, height, font, color=WHITE):
    M5.Lcd.fillRect(x, y, width, height, BG)
    draw_label(text, x, y, font, color)


def _draw_navigation(page):
    now_color = GREEN if page == HMI_PAGE_NOW else BLUE
    system_color = GREEN if page == HMI_PAGE_SYSTEM else BLUE
    M5.Lcd.fillRoundRect(NAV_NOW_X, NAV_Y, NAV_W, NAV_H, 14, now_color)
    M5.Lcd.fillRoundRect(NAV_SYSTEM_X, NAV_Y, NAV_W, NAV_H, 14, system_color)
    draw_label('NOW', NAV_NOW_X + 245, NAV_Y + 20,
               M5.Lcd.FONTS.Montserrat24, WHITE, bg=now_color)
    draw_label('SYSTEM', NAV_SYSTEM_X + 220, NAV_Y + 20,
               M5.Lcd.FONTS.Montserrat24, WHITE, bg=system_color)


def _draw_page_frame(page):
    M5.Lcd.fillScreen(BG)
    title = 'WELL PUMP - NOW' if page == HMI_PAGE_NOW else 'WELL PUMP - SYSTEM'
    draw_label(title, 40, 22, M5.Lcd.FONTS.DejaVu40, WHITE)
    draw_label('{}  OBSERVE ONLY'.format(SOFTWARE_RELEASE), 965, 36,
               M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_navigation(page)


def render_now(model):
    pump_color = (GREEN if model['pump_state'] == 'RUNNING'
                  else WHITE if model['pump_state'] == 'STOPPED' else YELLOW)
    draw_label('PUMP', 45, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field(model['pump_state'], 45, 128, 560, 55,
                M5.Lcd.FONTS.DejaVu40, pump_color)

    draw_label('PRESSURE', 665, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    pressure_text = ('{:.2f} PSI'.format(model['pressure_psi'])
                     if model['pressure_psi'] is not None
                     else model['pressure_status'])
    pressure_color = WHITE if model['pressure_psi'] is not None else YELLOW
    _draw_field(pressure_text, 665, 128, 570, 55,
                M5.Lcd.FONTS.DejaVu40, pressure_color)

    draw_label('POWER', 45, 215, M5.Lcd.FONTS.Montserrat18, CYAN)
    power_text = ('{:.0f} W'.format(model['power_w'])
                  if model['power_w'] is not None else 'UNAVAILABLE')
    _draw_field(power_text, 45, 248, 560, 55, M5.Lcd.FONTS.DejaVu40)
    draw_label('VOLTAGE', 665, 215, M5.Lcd.FONTS.Montserrat18, CYAN)
    voltage_text = ('{:.1f} V'.format(model['voltage_v'])
                    if model['voltage_v'] is not None else 'UNAVAILABLE')
    _draw_field(voltage_text, 665, 248, 570, 55, M5.Lcd.FONTS.DejaVu40)

    draw_label('SHELLY 1', 45, 340, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field(model['shelly1'], 45, 373, 560, 42,
                M5.Lcd.FONTS.Montserrat24)
    draw_label('SHELLY LOCAL LOCK', 665, 340, M5.Lcd.FONTS.Montserrat18, CYAN)
    lock_color = RED if model['shelly_lock'] == 'LOCKED' else YELLOW
    _draw_field(model['shelly_lock'], 665, 373, 570, 42,
                M5.Lcd.FONTS.Montserrat24, lock_color)

    age_text = ('{} ms'.format(int(model['shelly_age_ms']))
                if model['shelly_age_ms'] is not None else 'UNAVAILABLE')
    draw_label('ELECTRICAL DATA AGE', 45, 465, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field(age_text, 45, 498, 560, 42, M5.Lcd.FONTS.Montserrat24)
    draw_label('COMMUNICATIONS', 665, 465, M5.Lcd.FONTS.Montserrat18, CYAN)
    comms = 'WIFI {}  NETWORK {}'.format(
        'UP' if model['wifi_connected'] else 'DOWN',
        'READY' if model['network_ready'] else 'QUIET')
    _draw_field(comms, 665, 498, 570, 42, M5.Lcd.FONTS.Montserrat24)
    _draw_field('NO EVENT ENGINE - NO CONTROL AUTHORITY', 45, 575, 1190, 35,
                M5.Lcd.FONTS.Montserrat18, CYAN)


def render_system(model):
    draw_label('RUNTIME', 45, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    _draw_field('COLLECTION: {}'.format(model['collection']), 45, 128, 570, 36,
                M5.Lcd.FONTS.Montserrat24, GREEN)
    _draw_field('RULE ENGINE: {}'.format(model['rule_engine']), 45, 173, 570, 36,
                M5.Lcd.FONTS.Montserrat24, YELLOW)
    _draw_field('SYSTEM OVERRIDE: {}'.format(model['system_override']),
                45, 218, 570, 36, M5.Lcd.FONTS.Montserrat24, YELLOW)

    draw_label('DEVICES', 665, 95, M5.Lcd.FONTS.Montserrat18, CYAN)
    device_text = 'WIFI {}  NET {}\nEM {}  S1 {}\nADC {}  PSI {}'.format(
        model['wifi'], model['network'], model['shelly_em'], model['shelly1'],
        model['adc'], model['pressure'])
    device_lines = device_text.split('\n')
    for index, line in enumerate(device_lines):
        _draw_field(line, 665, 128 + (index * 45), 570, 36,
                    M5.Lcd.FONTS.Montserrat24)

    draw_label('RULES PACKAGE', 45, 315, M5.Lcd.FONTS.Montserrat18, CYAN)
    adopted = 'ADOPTED v{} {}'.format(
        model['adopted_version'] if model['adopted_version'] is not None else '?',
        model['adopted_hash_prefix'] or 'UNKNOWN')
    published = 'PUBLISHED v{} {}'.format(
        model['published_version'] if model['published_version'] is not None else '?',
        model['published_hash_prefix'] or 'UNKNOWN')
    _draw_field(adopted, 45, 348, 570, 36, M5.Lcd.FONTS.Montserrat24)
    _draw_field(published, 665, 348, 570, 36, M5.Lcd.FONTS.Montserrat24)
    rules_color = GREEN if model['rules_status'] == 'ACTIVE' else YELLOW
    _draw_field('STATUS: {}  |  ENABLED: {}'.format(
        model['rules_status'], model['enabled_rules']),
        45, 400, 1190, 40, M5.Lcd.FONTS.Montserrat24, rules_color)

    draw_label('TAB5', 45, 475, M5.Lcd.FONTS.Montserrat18, CYAN)
    battery = ('BATTERY {}% {}'.format(
        int(model['battery_percent']),
        'CHARGING' if model['battery_charging'] else 'NOT CHARGING')
        if model['battery_percent'] is not None else 'BATTERY UNAVAILABLE')
    _draw_field('{}  |  RELEASE {}'.format(battery, model['release']),
                45, 508, 1190, 42, M5.Lcd.FONTS.Montserrat24)
    _draw_field('PARAMETERS AND HISTORY ARE MANAGED ON THE WEB APP',
                45, 575, 1190, 35, M5.Lcd.FONTS.Montserrat18, CYAN)


def render_hmi(page, observation, adopted_reference, rules_package,
               published_reference=None):
    global _last_rendered_page
    if page not in (HMI_PAGE_NOW, HMI_PAGE_SYSTEM):
        page = HMI_PAGE_NOW
    if page != _last_rendered_page:
        _draw_page_frame(page)
        _last_rendered_page = page
    if page == HMI_PAGE_SYSTEM:
        render_system(build_system_hmi_model(
            observation, adopted_reference, rules_package,
            published_reference))
    else:
        render_now(build_now_hmi_model(observation))


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


def check_navigation(was_pressed, current_page):
    """Return a page change only on a fresh touch inside navigation.

    was_pressed tracks whether the finger was inside either navigation button
    on the previous poll. Logging remains keyed on the separate finger edge."""
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
    if inside and not was_pressed:
        return selected_page, True
    return current_page, inside


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
log('CPU A release M6.18: observational NOW/SYSTEM HMI foundation')

_installed_rules, _rules_error = load_packaged_rules()
if _installed_rules is None:
    # A corrupt or missing shipped baseline is a release-build error. Do not
    # pretend a rule package exists; M7 must never receive an unknown policy.
    raise RuntimeError('validated rules baseline unavailable: {}'.format(_rules_error))
active_rules = _installed_rules['package']
active_rules_reference = _installed_rules['reference']
if not cloud.set_applied_rules(active_rules_reference):
    raise RuntimeError('validated rules baseline handoff failed')
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
    M5.update()
    previous_page = hmi_page
    hmi_page, navigation_pressed = check_navigation(
        navigation_pressed, hmi_page)
    if hmi_page != previous_page:
        log('HMI page selected: {}'.format(hmi_page))
        if last_observation is not None:
            render_hmi(hmi_page, last_observation, active_rules_reference,
                       active_rules, published_rules_reference)

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
        metadata = validate_rules_metadata(rules_pointer)
        if metadata is None:
            log('Rules pointer ignored: {} [M6.7 keys={}]'.format(
                rules_metadata_rejection_reason(rules_pointer),
                rules_metadata_key_summary(rules_pointer)))
        else:
            published_rules_reference = {
                'version': metadata['rulesVersion'],
                'contentHash': metadata['contentHash'],
            }
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
            if not cloud.set_applied_rules(active_rules_reference):
                raise RuntimeError('adopted rules reference handoff failed')
            log('Rules release adopted: version={}, hash={}'.format(
                active_rules_reference['version'],
                active_rules_reference['contentHash'][:12]))
            rules_audit = build_rules_audit_record(
                'rule-adoption', format_observed_at(clock_synced),
                device_session_id, observation_sequence, active_rules_reference,
                candidate_metadata['releaseId'] if candidate_metadata is not None else None)
            if rules_audit is not None:
                if cloud.submit_durable_record(rules_audit):
                    log('Rules adoption audit queued: sequence={}'.format(
                        observation_sequence))
                else:
                    log('Rules adoption audit queue unavailable: sequence={}'.format(
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
                if rules_audit is not None:
                    if cloud.submit_durable_record(rules_audit):
                        log('Rules rejection audit queued: sequence={}'.format(
                            observation_sequence))
                    else:
                        log('Rules rejection audit queue unavailable: sequence={}'.format(
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
    shelly1_sample = None
    shelly_poll_attempted = False
    shelly1_poll_attempted = False
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
        shelly1_poll_attempted = True
        shelly1_sample = read_shelly1()
        if shelly1_sample is None:
            shelly1_failure_count += 1
        else:
            last_valid_shelly1 = shelly1_sample
            last_valid_shelly1_ms = now
            if shelly1_resume_confirmation_pending:
                log('Shelly 1 polling confirmed: SW0={}, RLY0={}'.format(
                    'ON' if shelly1_sample['sw0'] else 'OFF',
                    'ON' if shelly1_sample['rly0'] else 'OFF'))
                shelly1_resume_confirmation_pending = False

    observation = build_observation(
        observation_sequence, now, clock_synced,
        sample if sample is not None else {}, sample is not None,
        shelly_poll_attempted, last_valid_sample_ms, ads_uv,
        battery_v, battery_a, battery_level, battery_charging,
        battery_valid, charge_enable, last_battery_poll_ms,
        wifi_connected, network_traffic_allowed, wifi_driver_status,
        wifi_ip, wifi_disconnect_events, sample_failure_count,
        shelly1_sample, shelly1_sample is not None,
        shelly1_poll_attempted, last_valid_shelly1_ms,
        shelly1_failure_count)
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
    if durable_reason is not None:
        material_changes = (material_change_details(
            observation, last_durable_observation,
            confirmed_shelly_availability_change=shelly_availability_pending,
            confirmed_shelly1_availability_change=shelly1_availability_pending)
            if durable_reason == 'material-change' else None)
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
        M5.update()
        previous_page = hmi_page
        hmi_page, navigation_pressed = check_navigation(
            navigation_pressed, hmi_page)
        if hmi_page != previous_page:
            log('HMI page selected: {}'.format(hmi_page))
            render_hmi(hmi_page, observation, active_rules_reference,
                       active_rules, published_rules_reference)
        time.sleep_ms(50)
