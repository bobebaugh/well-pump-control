# Release: 2026-08-22 — run device work on CPU A and hand telemetry to CPU B.
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
import time
import requests
import driver.ads1110 as ads1110
from machine import I2C, Pin, SoftI2C
import cloud

# --- config (values from firmware/tab5/main/pilot_config.h) ---
SHELLY_URL = 'http://192.168.50.141/emeter/0'
SAMPLE_PERIOD_MS = 1000
SHELLY_TIMEOUT_S = 1  # requests has whole-second granularity; C++ used 750ms
STALE_AFTER_MS = 3000

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


def read_ads1110_microvolts():
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
battery_level = None
battery_charging = None
battery_valid = False
last_battery_poll_ms = -BATTERY_POLL_PERIOD_MS

log('Platform validation harness initialized')

while True:
    now = time.ticks_ms()
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

    ads_uv = read_ads1110_microvolts()

    if time.ticks_diff(now, last_battery_poll_ms) >= BATTERY_POLL_PERIOD_MS:
        last_battery_poll_ms = now
        v, a, level, charging = read_battery()
        battery_valid = v is not None
        if battery_valid:
            battery_v, battery_level, battery_charging = v, level, charging
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
    if wifi_connected and network_traffic_allowed:
        sample = read_shelly()
        if sample is None:
            sample_failure_count += 1
        else:
            last_valid_sample = sample
            last_valid_sample_ms = now
            cloud.submit_telemetry(sample)
            if shelly_resume_confirmation_pending:
                log('Shelly polling confirmed after connection: ticks_ms={}, connected={}, status={}, IP={}'.format(
                    now, wifi_connected, wifi_driver_status, wifi_ip))
                shelly_resume_confirmation_pending = False

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
    sleep_until = time.ticks_add(time.ticks_ms(), SAMPLE_PERIOD_MS)
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

