# Release: 2026-08-26 M6.11 — add a bounded touch startup selector for local utilities.
# CPU A application launcher. The application itself lives in pilot.py.
# Escaped exceptions are printed to serial only. Durable operational records
# belong in cloud storage. Manually selected utilities may write explicit CSVs;
# the normal 24x7 application still adds no routine flash logging.
import M5
import sys
import time
import _thread
import cloud


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
STARTUP_MODE = select_startup_mode()
PRESSURE_QUALIFICATION_SELECTED = STARTUP_MODE == 'pressure-qualification'
print('[well-main] Release M6.11 launcher; startup mode:', STARTUP_MODE)


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

