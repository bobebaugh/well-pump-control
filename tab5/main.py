# Release: 2026-08-22 — run CPU A and CPU B as workers while main holds the maintenance REPL.
# Crash-capturing launcher. The CPU A application itself lives in pilot.py.
# Any exception that escapes CPU A is written to /flash/crash.log
# (with a timestamp if the RTC was set) as well as printed to serial, so a
# failure that happens while nobody is watching is still recoverable.
import sys
import time
import _thread
import cloud


try:
    if cloud.start():
        print('[well-main] CPU B communications worker started')
    else:
        print('[well-main] CPU B communications worker was already running')
except Exception as cloud_err:
    print('[well-main] CPU B startup failed:', cloud_err)


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


def _stamp():
    try:
        t = time.localtime()
        return '{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z'.format(
            t[0], t[1], t[2], t[3], t[4], t[5])
    except Exception:
        return 'unknown-time'


def _pilot_worker():
    try:
        import pilot
    except Exception as pilot_err:
        try:
            f = open('/flash/crash.log', 'a')
            f.write('\n--- CPU A crash at {} (ticks_ms={}) ---\n'.format(
                _stamp(), time.ticks_ms()))
            sys.print_exception(pilot_err, f)
            f.close()
        except Exception as log_err:
            print('[well-pilot] could not write crash.log:', log_err)
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
    # Thonny/WebREPL sends Ctrl-C to the foreground. Returning from main.py
    # releases the prompt while the CPU A and CPU B workers continue. Ctrl-D
    # or machine.reset() remains the path back to a clean application start.
    print('[well-main] foreground released; CPU A and CPU B remain active')

