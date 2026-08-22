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

