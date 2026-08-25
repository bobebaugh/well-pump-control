# Release: 2026-08-25 M6.9 — rules adoption is the sole runtime flash write.
# CPU A application launcher. The application itself lives in pilot.py.
# Escaped exceptions are printed to serial only. Durable operational records
# belong in cloud storage; the only application write to flash is the validated
# atomic rules-package replacement in pilot.py.
import sys
import time
import _thread
import cloud

print('[well-main] Release M6.9 launcher')


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

