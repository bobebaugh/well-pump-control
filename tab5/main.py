# Release: 2026-09-15 M6.41 — launcher owns the ADS1110 and the utility branch.
# CPU A application launcher. The application itself lives in pilot.py.
# Escaped exceptions are printed to serial only. Durable operational records
# belong in cloud storage. Manually selected utilities may write explicit CSVs;
# the normal 24x7 application still adds no routine flash logging.
import M5
import sys
import time
import _thread
import driver.ads1110 as ads1110
from machine import Pin, SoftI2C
import cloud


def log(msg):
    print('[well-main] {}'.format(msg))


# --- board hardware owned by the launcher ---
# This restores the original intent: one-time initialisation that UIFlow needs
# belongs here, in the launcher, not scattered through the application. It had
# drifted into pilot.py over time, which is what made the converter impossible
# to share with a utility that cannot import pilot.
# main.py already owns M5.begin(), so it owns the converter too. Exactly one
# ADS1110 configuration exists on this device, and BOTH applications reach it:
# pilot.py through __main__, and the pressure-qualification utility the same
# way. The utility cannot import pilot - importing pilot IS starting the 24x7
# application - so a second copy of this configuration was the alternative, and
# a copy that drifted would silently record calibration counts on a different
# scale from the ones production reads.
# Three adjacent conversions, not five. The samples are taken back to back, so a
# third one adds little beyond rejecting a single outlier, and each costs ~67ms at
# 15 SPS. The trim below then leaves exactly one value: this is a MEDIAN of three,
# which is what rejects an outlier here - not an average of the survivors.
ADC_FILTER_SAMPLE_COUNT = 3


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


def read_ads1110_filtered_raw_count(service=None):
    """Return the trimmed multi-conversion reading in native ADC counts.

    This is the ONLY ADC acquisition in a cycle. Every pressure consumer - the
    HMI, the observation field, and the package's Boyle tank calculation - reads
    the single value it produces, so none of them costs a further conversion.
    """
    samples = []
    for _index in range(ADC_FILTER_SAMPLE_COUNT):
        value = read_ads1110_fresh_raw_count(service)
        if value is None:
            return None
        samples.append(value)
    samples.sort()
    return sum(samples[1:-1]) // (ADC_FILTER_SAMPLE_COUNT - 2)


# --- the qualified pressure sensor fit ---
# Produced by tab5/pressure_qualification.py, consumed every cycle by pilot.py.
# It lives here, with the converter, because both read it and neither owns it:
# one copy on the device, so a recalibration updates one place. Deleting the
# utility would not lose these numbers.
PRESSURE_SENSOR_SPAN_PSI = 100.0
# End-to-end field fit from 22 usable gauge captures over about 40--61 PSIG.
# The count intercept is extrapolated sensor-system output at zero gauge
# pressure; it is not the ADC electrical-zero offset.
PRESSURE_CALIBRATION_COUNT_INTERCEPT = 3732.02
PRESSURE_CALIBRATION_COUNTS_PER_PSI = 211.492

# The Shelly EM address, shared: pilot.py polls it every cycle and the fill run
# uses it to tell a running pump from a stopped one.
SHELLY_EM_URL = 'http://192.168.50.141/emeter/0'


def calibrated_psi_from_raw_count(raw_count):
    """Apply the qualified end-to-end field fit to one raw ADC count."""
    if isinstance(raw_count, bool) or not isinstance(raw_count, (int, float)):
        return None
    return ((raw_count - PRESSURE_CALIBRATION_COUNT_INTERCEPT) /
            PRESSURE_CALIBRATION_COUNTS_PER_PSI)


def select_startup_mode(timeout_ms=10000):
    """Return a fixed local utility choice, or normal after the timeout."""
    bg = 0x07152e
    white = 0xFFFFFF
    cyan = 0x9EB4D8
    blue = 0x2457c5
    M5.Lcd.setRotation(1)
    M5.Lcd.fillScreen(bg)
    M5.Lcd.setFont(M5.Lcd.FONTS.DejaVu40)
    M5.Lcd.setTextColor(white, bg)
    M5.Lcd.drawString('WELL PUMP PILOT', 390, 90)
    M5.Lcd.setFont(M5.Lcd.FONTS.Montserrat24)
    M5.Lcd.setTextColor(cyan, bg)
    M5.Lcd.drawString('Select a local utility or wait for normal monitoring', 300, 190)
    M5.Lcd.fillRoundRect(250, 330, 780, 190, 20, blue)
    M5.Lcd.setFont(M5.Lcd.FONTS.DejaVu40)
    M5.Lcd.setTextColor(white, blue)
    M5.Lcd.drawString('PRESSURE QUALIFICATION', 350, 395)
    deadline = time.ticks_add(time.ticks_ms(), timeout_ms)
    last_second = None
    while time.ticks_diff(deadline, time.ticks_ms()) > 0:
        M5.update()
        remaining = max(0, (time.ticks_diff(deadline, time.ticks_ms()) + 999) // 1000)
        if remaining != last_second:
            M5.Lcd.setFont(M5.Lcd.FONTS.Montserrat24)
            M5.Lcd.setTextColor(cyan, bg)
            M5.Lcd.drawString('Normal monitoring starts in {} seconds   '.format(remaining), 430, 580)
            last_second = remaining
        try:
            if M5.Touch.getCount() > 0:
                x = M5.Touch.getX()
                y = M5.Touch.getY()
                if 250 <= x <= 1030 and 330 <= y <= 520:
                    while M5.Touch.getCount() > 0:
                        M5.update()
                        time.sleep_ms(30)
                    return 'pressure-qualification'
        except Exception:
            pass
        time.sleep_ms(40)
    return 'normal'


try:
    import webrepl
    import device_secrets
    webrepl_password = getattr(
        device_secrets, 'WEBREPL_PASSWORD', device_secrets.WIFI_PASSWORD)
    webrepl.start(password=webrepl_password)
    webrepl_password = None
    print('[well-main] WebREPL service started on LAN port 8266')
except Exception as webrepl_err:
    print('[well-main] WebREPL startup failed:', webrepl_err)


M5.begin()
init_adc()   # after M5.begin(): it reinitialises the buses this sits beside
STARTUP_MODE = select_startup_mode()
PRESSURE_QUALIFICATION_SELECTED = STARTUP_MODE == 'pressure-qualification'
print('[well-main] Release M6.41 launcher; startup mode:', STARTUP_MODE)


# The utility runs INSTEAD of the application, and never returns: every one of
# its exits reboots. CPU B is therefore never started while a capture is running,
# so nothing publishes, polls RTDB, or holds the radio against the timed reads.
# Before M6.41 cloud.start() ran unconditionally and did all three.
if PRESSURE_QUALIFICATION_SELECTED:
    print('[well-main] pressure qualification selected; CPU A and CPU B stay down')
    try:
        import pressure_qualification   # noqa: F401  - runs on import, then reboots
    except Exception as qual_err:
        print('[well-main] pressure qualification failed:')
        sys.print_exception(qual_err)
    # Only reached if the utility raised before its own reset.
    while True:
        time.sleep(1)


try:
    if cloud.start():
        print('[well-main] CPU B communications worker started')
    else:
        print('[well-main] CPU B communications worker was already running')
except Exception as cloud_err:
    print('[well-main] CPU B startup failed:', cloud_err)


def _pilot_worker():
    try:
        import pilot
    except Exception as pilot_err:
        print('[well-pilot] CPU A CRASHED:')
        sys.print_exception(pilot_err)


try:
    _thread.start_new_thread(_pilot_worker, ())
    print('[well-main] CPU A device worker started')
except Exception as pilot_start_err:
    print('[well-main] CPU A startup failed:', pilot_start_err)


try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    # Thonny/WebREPL sends Ctrl-C to the foreground. UIFlow normally resumes
    # its launcher when main.py returns, which tears down WebREPL. This flag is
    # part of the stock UIFlow boot namespace; clear it before releasing the
    # native MicroPython prompt. CPU A and CPU B remain worker threads.
    _uiflow_run_main = False
    print('[well-main] foreground released; UIFlow relaunch disabled; CPU A and CPU B remain active')

