# Tab5 beta installation and recovery

Platform: M5Stack Tab5, stock UIFlow 2.5.0, interpreted MicroPython. No replacement
boot.py or ESP-IDF build is part of the beta. Hardware installation requires owner
direction and a known compatible source/package set.

## Files

The device flash root needs main.py, pilot.py, cloud.py, webrepl.py and
pressure_qualification.py from the accepted Tab5 source. Retain rules.json where
used by the compatibility path. The normal V3 runtime requires its validated staged
rules file, obtained through the publication/delivery path; rules.json is not a
replacement for that package. Preserve exact staged bytes/hash during recovery.
Keep device_secrets.py local and use device_secrets.example.py for names only.
The owner's password manager is the separate human secret-recovery store.

For incremental repairs transfer only changed files. For recovery, restore all
compatible runtime/support files, configuration and secrets before starting main.py.
Never substitute a test fixture for the real running rules package. Record exact
file hashes and package ID/hash after acceptance. File release stamps may differ.

## Restart from Thonny/WebREPL

1. At the WebREPL prompt execute import machine; machine.reset().
2. Immediately switch Thonny to Local Python so it cannot reconnect during boot.
3. Wait for reboot, Wi-Fi association and complete application startup.
4. Switch back to ESP32/WebREPL and reconnect.

Premature automatic reconnection can prevent startup; the verified fallback is
physical access to the Tab5 power button. Keep WebREPL LAN-only. An online restart
request is processed by CPU A and is not a recovery method if that worker is dead.

Restart clears volatile events/owners/calculation history and may adopt a different
staged package. It does not clear Shelly-owned locks. Inspect pending package state
before deliberate reset. Keep the owner's independent local equipment recovery
procedure available if the cloud or Tab5 cannot be used.

## Utility mode

Pressure qualification is manually selected at startup and runs instead of both
normal workers. It exits by reset. Capture-path follow-ups in FUTURE must be addressed
before relying on another recalibration. The normal M6.42 pressure commissioning
flag is already enabled; no commissioning change is part of routine installation.
