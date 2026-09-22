# Rules package records

Authoring backups of the V3 rules package, kept as evidence of what was published
and when. Design and reasoning live in the GitHub design issues, not here.

## What these files are

Complete **authoring backup** JSON (`kind: well-pump-rules-authoring-backup`), as
exported by Load/Backup on the Rules Engine screen. This is the recovery and editing
format: it is what an owner loads back into the editor to reproduce or amend a
package.

## What these files are not

- **Not the staged runtime package.** The device adopts a validated runtime package
  obtained through the publication/delivery path, with a server-minted release ID and
  an exact byte hash. See `tab5/PROVISIONING.md`.
- **Not a device flash file.** Nothing here belongs on the Tab5 flash root.
- **Not `tab5/rules.json`.** That is the V1 (`well-pump-rules-release`) compatibility
  file and is a different schema for a different path. It is unrelated to these.

Never substitute a file from this directory for the real running rules package.

## Records

| file | events | published |
| --- | --- | --- |
| `rules-authoring-2026-09-22-freeze.json` | 20 | 22 September 2026 |
