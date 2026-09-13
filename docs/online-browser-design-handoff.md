# Online event and durable-record browser — design handoff

Date: 2026-09-13 UTC (owner bench work evening of September 12, US Eastern).
Purpose: start a fresh, bounded design session, then produce one coordinated coding prompt. This handoff does not authorize browser implementation.

## Start here

Read AGENTS.md, CURRENT.md and DESIGN.md on both working branches, then relevant interfaces/. Inspect existing Pilot home-page code and read endpoints before proposing additions. Inspect Tab5 producer code only to resolve an actual contract question. Do not reconstruct history or read Google Drive.

This handoff supersedes older NEXT-UNIT.md/editor-review suggestions about what comes next. The next unit is online browsing; modes and script health remain separate. The corrected KISS design is implemented, not an invitation to redesign transport.

GitHub is the portable source of truth across the owner's workstations. Verify all four live refs before work. The owner authorized promotion and this handoff on September 13; final promotion tips include documentation commits after these reviewed source bases:
- Pilot: ed7a757b686e8360dfaa652369587b64290dfa84.
- Tab5: bd62df69a4f21ca2822c93dfc5bab7e05b086728 (M6.35).
- Prior operating Tab5 before this closeout: 56f089d53b9d48adb06477005de2506bbf74abf0 (M6.34).
Working/operating pairs are intended to match after closeout. Source promotion does not install hardware or publish Firebase rules.

## What is implemented and evidenced

CPU A remains sole local event/control authority. Rules packages adopt only on restart with a fresh event board. CPU B independently transports a replaceable complete current-event board and a bounded, lossy RAM observation FIFO.

M6.35 observations have a small header and the running package's logging-selected Device, Calculated and System fields. None excludes; Include (JSON always) includes without triggering; Change and Delta trigger. Delta compares with the last admitted available value. Explicit unavailable values preserve comparison baselines. Session start, event boundaries and the ten-minute interval also trigger. All reasons in one cycle produce at most one pre-dispatch observation. Baselines advance at RAM admission, not cloud ACK.

FIFO limits: 100 records and provisional 393,216 encoded bytes, oldest-first eviction. No routine flash/SD logging, persistent outbox, mandatory observation/event pairing or delivery guarantee.

Pilot accepts observation v2 and retains v1 ingestion. Authenticated complete boards update Firestore projection/history and a revision-ordered RTDB mirror. Newer same-session omissions close immediately. Same-key new occurrences replace predecessors. Silence leaves stale information, never closes an event. Restarts reconcile prior occurrences as ended-by-restart. Inferred closing time is unknown.

Relevant implemented paths:
- sites/well-main/observations: durable observations.
- sites/well-main/eventRecords: new v2 event history plus older record types; filter appropriately.
- sites/well-main/eventBoardState/tab5-well-main: online event projection.
- v1/sites/well-main/devices/tab5-well-main/currentEventBoard: RTDB mirror.
- Legacy events collection contains pump classifier activity, not the new V3 event-history authority.
Verify exact fields against the checked-in contracts and implementation.

Evidence:
- Reviewer reran 168 Tab5 and 134 Pilot host tests successfully.
- Corrected RTDB rules at f97f909a137f9faf2c369614178f72d5a75f7869 passed 10/10 emulator tests locally: Java 21.0.12.1, Node 22.22.2, npm 10.9.7. Evidence committed in ed7a757.
- Owner installed matching M6.35 pilot.py/cloud.py. Logs show accepted boards, session changes, heartbeats and durable observations, S020 startup opening/closure, and opening/closure after temporary Shelly loss.
- Latest supplied startup: V17, release 20260913010057-event-v3-v17, hash prefix 207cca64ea14.
- Firestore screenshots show schema-v2 observations with two availability changes coalesced into one record; available numeric/Boolean/System/calculated values and explicit unavailable pressure values.
- Screenshots show stored open and inferred-close history with release/session/occurrence identities. The two displayed records were from different V16/V17 occurrences; do not describe them as a verified matching pair.
- Successful board acknowledgements and Firestore screenshots establish a functioning backend path after rollout. Exact live Firebase configuration and Netlify deploy metadata were not independently audited.

## Agreed browser requirements

Fill out the existing web home screen:
- All open events first; never truncate open events to ten.
- Highlight severity: red/yellow for problems and a suitable informational color with text, not color alone.
- Roughly ten recent closed events below; access to broader event history.
- No durable-record table on home. Provide a button to most recent durable records.
- Each event links to durable observations beginning a few records before its opening.
- Durable browser navigates backward and forward through time, with time selection and latest access.
- Selectable columns from the saved current working rules in Firestore, limited to logging-enabled fields. Unsaved browser edits do not define the catalog.
- Useful initial columns derived from current event conditions/assignments/guards where feasible; no new per-event column configuration in the Rules Engine.
- Older records may lack current fields. Show unavailable/missing honestly; never invent values.
- Use local time. Keep inferred detection time distinct from actual device event time; allow startup events without synchronized opening time.
- No mandatory ID pairing is needed for event-to-observation navigation; records may legitimately be missing.
- Earlier owner request: whole-day date-range raw CSV export including historical fields. Retain this requirement and decide its bounded placement in the coding unit.
- A separate event detail screen is optional; add it only if it improves navigation or interpretation.

Assess existing UI/API capabilities first. Settle a simple query/pagination approach, default columns, open/closed presentation, stale/error/empty states, and event-time fallback. Do not create another generic database administration tool. Ask only questions that materially change scope. Aim for one coding unit and one focused owner test cycle.

## Open items — keep separate

Battery charging remains unresolved. Existing 75% enable / 80% disable thresholds are not accepted as the final policy. Owner expects higher limits but has not chosen values.
- Displayed 50% appears to provide only roughly 10–20% usable remaining charge; this is an owner estimate still being narrowed, not calibrated capacity evidence.
- Owner reports about 1 A maximum charge rate, while external input stays near 5 V, 2 A / 10 W, apparently unchanged during charging or with battery removed.
- Battery does charge; the input-power discrepancy remains unexplained.
- Percentage is an estimate; do not assume linear remaining runtime or use these observations to reverse current sign conventions.
- Stay within supported UIFlow/M5 interfaces. No direct-register/alternate-driver work.
- Do not change battery policy in the browser unit.

Other outstanding items:
- Extended outage, near-capacity queue/heap and maximum practical board bench checks. Initial evidence is sufficient to start browser design, not full hardware acceptance.
- Brief Cloud-yellow can mean even one pending observation in the existing HMI; not necessarily network failure.
- Two Wi-Fi hops and a powerline segment affect Shelly latency. Two-second polling was discussed, not implemented/approved as part of this unit.
- Normal/Monitor operator integration, required-source health qualification, Clear Events and Shelly script-health monitoring are separate work.
- Rules editor Tab5 status-read failure was explicitly parked.
- S020 startup sensitivity remains a separate rule/design question; do not silently alter it.

## Workflow and next deliverable

Produce a compact browser design and a self-contained coding prompt after owner discussion. Preserve existing rules authoring, publication and device control.

Do not promote, deploy, publish Firebase rules, send packages or operate hardware without the relevant owner authorization. Use current source and supplied evidence; no repeated history collection.

Environment setup should be bounded. Cloud scratch tools may disappear. Reuse the Windows emulator setup when needed; do not spend a session repeatedly downloading Java. Local command: npm ci, then npm run test:rtdb-rules against demo-well-pump-control. An empty local XDG config resolved a CLI shared-config EPERM on the tested Windows machine.

At coding-unit completion, synchronize with the owner before promotion and provide concise real-data testing steps.

## Browser-unit deployment prerequisite

The browser unit adds `firestore.indexes.json` for bounded V1/V2 observation,
session/cycle, and V3 occurrence reads. The source change does not publish those
indexes. Before the owner uses the hosted browser, deploy the checked-in Firestore
indexes through the established owner-controlled Firebase workflow and wait for them
to become ready. No rules, package, hardware, or device-control deployment is part of
that prerequisite.
