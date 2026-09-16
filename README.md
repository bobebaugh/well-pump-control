# Well Pump beta

Private well monitoring and supplemental inhibition, maintained for one owner.
Mechanical, hardwired and Shelly-local protection remain authoritative. The
software never creates ordinary pump demand.

## Start here

- [CURRENT.md](CURRENT.md): current source, installed evidence, and pending release decisions.
- [DESIGN.md](DESIGN.md): what the beta implements.
- [BETA.md](BETA.md): quick fixes, deployment, shared databases, password and recovery.
- [FUTURE.md](FUTURE.md): deferred work; nothing there is an implementation instruction.
- [interfaces/](interfaces/): exact records shared by the web/cloud and device applications.

## Five branches

| Branch | Purpose |
| --- | --- |
| `pilot-working` | Small web/cloud fixes |
| `pilot` | Accepted web/cloud test deployment; uses live data |
| `tab5-working` | Small Tab5/Shelly fixes |
| `Tab5` | Accepted device source for installation/recovery |
| `main` | Intended public beta web/cloud release; activation is pending |

The two applications have different source trees. Main will receive the web/cloud
application; the complete device upload source stays on Tab5. Do not merge the
device tree wholesale into Main. Branch names are case-sensitive.

Routine maintenance needs one working branch, one focused fix, relevant checks,
and a short commit. No new feature branch, design dossier, or PR is required unless
the owner asks. See BETA for the few actions that still need owner direction.

Old milestones and branch tips are recoverable from Git tags, not current operating
instructions. [The archive inventory](maintenance/branch-archive-2026-09-16.csv)
records exact tips, including unmerged work. The compiled ESP-IDF tree, where
present, is retained legacy source and is not the Tab5 beta platform.
