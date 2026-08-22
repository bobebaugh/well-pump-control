# Release: 2026-08-22 — test documented credential-free WLAN activation and connect.
# Crash-capturing wrapper. The pilot itself lives in pilot.py.
# Any exception that escapes the main loop is written to /flash/crash.log
# (with a timestamp if the RTC was set) as well as printed to serial, so a
# failure that happens while nobody is watching is still recoverable.
import sys
import time
import network


wlan_sta = None
try:
    wlan_sta = network.WLAN(network.STA_IF)
    wlan_sta.active(True)
    wlan_sta.connect()
    print('[well-main] credential-free Wi-Fi connect issued')
except Exception as wifi_err:
    print('[well-main] credential-free Wi-Fi connect failed:', wifi_err)


def _stamp():
    try:
        t = time.localtime()
        return '{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z'.format(
            t[0], t[1], t[2], t[3], t[4], t[5])
    except Exception:
        return 'unknown-time'


try:
    import pilot
except Exception as e:
    try:
        f = open('/flash/crash.log', 'a')
        f.write('\n--- crash at {} (ticks_ms={}) ---\n'.format(_stamp(), time.ticks_ms()))
        sys.print_exception(e, f)
        f.close()
    except Exception as log_err:
        print('[well-pilot] could not write crash.log:', log_err)
    print('[well-pilot] PILOT CRASHED:')
    sys.print_exception(e)
    raise

