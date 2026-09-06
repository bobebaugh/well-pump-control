# Tab5 subtree instructions

This file supplements the root Project Context. Before working under tab5/, read:

1. the repository-root AGENTS.md;
2. the branch CURRENT.md;
3. the branch DESIGN.md; and
4. interfaces/ when the task crosses the Pilot–Tab5 boundary.

If this file conflicts with the root Project Context, the root Project Context wins.

## Scope

- tab5/ is the interpreted MicroPython application and its complete version-managed upload set.
- Work on tab5-working; do not promote anything into Tab5 without explicit owner approval.
- Preserve all tracked upload files when preparing a future device release.
- firmware/tab5/, the ESP-IDF runbook, compiled build machinery, and older agent branches are historical evidence. Do not read or use them unless the active task specifically names them.

## Safety and evidence

- Tab5 must never create ordinary pump demand or weaken mechanical, hardwired, or Shelly-local protection.
- Never treat missing values or missing lock evidence as a safe value.
- Do not upload/adopt a package, flash/erase a board, or test connected equipment unless the owner explicitly authorizes that activity.
- Keep current source facts separate from unverified installed-device behavior.
