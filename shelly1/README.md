# Shelly 1 beta operation

anti-chatter.js is the installed protection script and sole writer of RLY0. The
owner confirms its real-hardware unit testing is complete. Tab5 writes only its own
Tab5IsLocked contribution; its separate deliberate operator reboot uses Shelly.Reboot.
See [DESIGN](../DESIGN.md) and [BETA](../BETA.md) for authority and recovery boundaries.

## Required device configuration

Input mode is Switch; output is Detached; RLY0 power-on default is OFF/open. The
protection script must be enabled at boot. With output starting open, failure to
start the script can leave automatic water service inhibited until local recovery.
No other script or schedule may compete for RLY0. Installation/configuration changes
need owner direction; documentation maintenance does not operate the device.

## Interface and settings

| Component name | Type | Meaning/writer |
| --- | --- | --- |
| IsLocked | number | Shelly-owned: 0 clear, positive seconds remaining, -1 permanent |
| loCntr | number | Shelly-owned short-cycle strike count, 0–3 |
| Tab5IsLocked | boolean | Tab5 inhibition; script seeds false at initialization |

All are non-persisted. Discover by name, never assume a component ID. Only one
script may declare these names; duplicates or missing required components invalidate
Tab5's acquisition. Keep the @meta declaration on the first script line.

Tuning values are constants at the top of anti-chatter.js, not virtual components:

| Setting | Source default |
| --- | --- |
| MinRuntime | 60 seconds |
| InitLockTime | 90 seconds |
| MaxLOcntr | 3 strikes |
| TimeToResetLOcntr | 3600 seconds |
| InitDelay | 5 seconds |

Record actual installed overrides with the release receipt. A normal observed run
below MinRuntime scores a strike. Temporary lock counts down; the configured strike
limit becomes permanent until deliberate recovery. A clean interval clears strikes.
The script applies RLY0 only on an observed mismatch with its two-flag policy.
Stops caused by applied Tab5 inhibition do not score strikes. A genuine short cycle
coinciding with an unapplied intent still counts.

The input status handler and once-per-second level poll feed one edge detector, so
the same edge counts once. Unknown input is not an edge. An already-high startup
level does not invent a run start. Polling alone can miss an entire subsecond run;
the faster handler supplements it. Existing hardwired protection remains in place.

## Recovery limits

Script initialization seeds Tab5IsLocked false and holds RLY0 open for InitDelay
before normal processing. This does not establish Tab5 liveness. A true flag can
remain true if Tab5 later disappears. A stopped script may leave the relay in its
last state. Never infer automatic recovery from a reboot default or reset a device
merely because an RPC outcome is uncertain. Script-health/abandoned-inhibit policy
and the reboot-result reporting repair are recorded in [FUTURE](../FUTURE.md).

The owner has independent local recovery and HAND authority. Do not use the test
harness or raw setters as an unattended operational recovery system; they can remove
the protection script from service. Deliberate Shelly reboot can interrupt a running
pump and clears volatile local lock/strike state.

## Bench tools — only during authorized maintenance

test-harness-attaching.js declares nothing and uses the components provisioned by
the installed protection script. Stop the protection script only for an authorized
bench test, and restore it afterward. While the harness runs, it does not manage
RLY0 or input:0. test-harness-standalone.js is an older incompatible tool retained
as source; do not install it alongside the current script.

[The local proxy/page](tools/shelly-cors-proxy/README.md) is bench apparatus, not a
web beta endpoint. It can issue device writes when buttons are pressed. Keep it
local and do not publish or expose it through the ebaugh.net site. Its executable
embeds its page and must be rebuilt if the page changes.

node --test tests/shelly1-anti-chatter.test.js runs the 31 host decision cases from
the repository root. Hardware unit testing is completed owner evidence; the test
harness does not itself prove a physical relay/contact state.
