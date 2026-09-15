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

## The Release header

Every uploadable file in this directory carries a `# Release:` line as line 1, and
`pilot.py` additionally carries `SOFTWARE_RELEASE`, which reaches the cloud payload
and is painted on the HMI.

**The stamp is per file, not per bundle.** A file carries the release in which *that
file* last changed, so the three files legitimately sit at different numbers. The
owner uploads only the files that changed, so bumping an unchanged file's stamp is
worse than leaving it alone: the repository would claim a release the device never
received.

So, when making a device change:

- Bump the stamp on **each file you actually modified**, and no others.
- Leave an untouched file at its existing release, however stale it looks beside
  the file you changed.
- In `pilot.py`, `SOFTWARE_RELEASE` and the CPU A startup `log(...)` line carry the
  release too. All three move together, and two tests assert the value - grep for
  the old number before assuming the header is the only occurrence.
- Historical references in `CURRENT.md` and `tests/README.md` describe what a past
  release did. They are not stamps and must not be bumped.

This was written down after an agent aligned all three files onto one number on the
reasoning that they ship as a set. They do not ship as a set; only changed files are
uploaded.
