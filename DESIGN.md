# Operating design — proposed for owner review

This is a plain-language pilot design. It becomes the current design authority only
after the owner approves it. Until then, it is a proposal and does not authorize code,
deployment, package adoption, wiring, or hardware activity.

## System boundary

Existing mechanical controls and hardwired protection remain authoritative. Tab5
observes the system and may eventually remove permission through its enable relay; it
never creates ordinary pump demand or bypasses higher protection. Cloud services
author rules, deliver packages, retain records, and display information; they are not
required for immediate protection.

## Evidence and rules

Each observation must distinguish current valid evidence from unavailable evidence.
Missing, malformed, or incomplete data stays unavailable; it is never turned into a
safe reading or an unlocked relay state. Rules evaluate one frozen observation so rule
order cannot change its meaning. The rule language remains bounded and does not add
scripts, loops, delays, or direct event-to-event actions.

## Events and ownership

Events may be informational, transient protective, latched protective, or Monitor
events. Event ownership is generic: several events may request the same value, and a
target is released only when its final owner releases it. Qualification uses current
evidence; missing evidence freezes qualification and valid contrary evidence resets it.

## Monitor, restart, and Shelly

Normal permits Tab5's approved protective behavior. Monitor keeps observing,
calculating, logging, and evaluating events while suppressing the ordinary app control
consequences specified by the accepted rule behavior.

A restart begins with an empty Tab5 event board. If current evidence still warrants an
event, it can open again. Restart does not clear a Shelly lockout.

Shelly owns its anti-short-cycle/lockout behavior. Tab5 must observe that state and
must not recalculate chatter, clear a Shelly lock, override it, or treat missing lock
evidence as unlocked.

## Transition to V3

V2 remains in service only for the working generic functions V3 has not yet absorbed.
A staged V3 package is not an adopted program. V2 retirement occurs only after V3 has
a trustworthy input/snapshot, calculation/logging, action, and record path verified by
the approved work units.

## Records and review

Durable records must identify the applicable rules release. The owner reviews each
bounded work unit in operational terms: expected behavior, safety effect, evidence,
limits, and the next decision. The plan remains limited to Now, Next, and Later in
`CURRENT.md`.
