# Tab5 baseline provisioning

This directory contains the interpreted UIFlow 2.5.0 baseline. It does not
contain a replacement `boot.py`.

Install these files at the Tab5 flash root, with `device_secrets.py` installed
before `main.py` starts:

- `device_secrets.py` — local values; never upload to GitHub
- `pilot.py` — current pilot application
- `main.py` — crash-capturing launcher

The included `device_secrets.py` was reconstructed locally from the last
hardware-working version. Google Password Manager remains the human recovery
store. `device_secrets.example.py` documents the required names without real
values.

This baseline deliberately retains the application's existing Wi-Fi connect and
reconnect behavior. Moving association entirely to UIFlow's flashed
configuration requires a separate physical reconnect test.

Only the owner installs files or flashes UIFlow. A host-side syntax check does
not establish hardware behavior.


## Hardware-verified remote reset from Thonny

The only currently reliable way to reset the Tab5 and regain remote control
without touching the device is:

1. At the WebREPL prompt, run `import machine; machine.reset()`.
2. Immediately switch Thonny's interpreter to **Local Python** so Thonny does
   not attempt to reconnect while the Tab5 is booting.
3. Wait for the Tab5 reboot, Wi-Fi association, and application startup to
   finish.
4. Switch Thonny back to the ESP32/WebREPL interpreter and reconnect.

Do not leave Thonny attached to the ESP32/WebREPL backend during the reboot.
Physical testing found that an automatic or premature reconnect can prevent the
application from loading. Once that occurs, the only presently verified
recovery is physical access to the Tab5 power button.

This behavior was physically observed with UIFlow 2.5.0 and Thonny 5.0.0 on
2026-08-22. Treat the sequence as an operating requirement until a later
hardware test deliberately replaces it.

