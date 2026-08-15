# Tab5 firmware instructions

- Read `docs/tab5-platform-runbook.md` before firmware work. ESP-IDF is exactly 5.4.2.
- Physical build, flash, and monitor sessions use Local mode in the canonical Windows checkout, never an automatically created Codex worktree.
- Use only `tools/verify-session.ps1`, `tools/build.ps1`, `tools/flash.ps1`, and `tools/monitor.ps1` for normal operations. Do not install, repair, replace, or upgrade ESP-IDF or Python; stop and report environment failure.
- Preserve the verified 200 MHz PSRAM requirement. Verify the expected COM3 port before flashing.
- Never erase NVS, erase the chip, run destructive recovery, or format SD media without explicit authorization. Firmware is observational only: no pump-control output.
- Stop at required physical-confirmation gates. One SD owner alone may access the filesystem.
- `main/secrets.local.h` stays ignored and must never be opened, printed, staged, or committed.
