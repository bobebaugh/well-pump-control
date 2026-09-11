# Editor review — next design session

## Purpose and authority

Personal project: one owner, one active coding agent. This is a review brief,
not authorization to implement every item. The owner wants a complete editor
review for simplicity while retaining useful capability. Discuss the proposal
before allocating small coding units. Start with both branches' Project Context;
CURRENT.md records source bases, evidence, outstanding gaps and promotion state.

## Read only what is relevant

Pilot: web/rules-engine.html, web/rules-engine.js, associated styles;
cloud/netlify/functions/rules-engine.js and rules-engine-release.js;
cloud/netlify/lib/rules-engine-v3-*.js; relevant contracts and focused tests.
Tab5: tab5/AGENTS.md, tab5/pilot.py and tab5/cloud.py only where needed to verify
adoption, supported declarations, logging or shared-record meanings.
Use interfaces/ for exchanged records. Issue #5 is the named deferred script-health
source. Do not read Google Drive, reconstruct history or explore old agent branches.
Do not access live Firebase or operate hardware to conduct this review.

## Owner goals

1. Simplify Validate / Publish / Deliver. Proposed single Publish and Deliver
   automatically validates; retain optional Validate for unfinished edits. Preserve
   immutable publication and distinguish published, delivery failed, staged and
   running outcomes. A delivery retry should not unnecessarily publish another
   version. Restart-only adoption is intentional and remains.
2. Make errors actionable: event ID/name, field, precise message and navigation
   to the affected control. Review save errors separately from validation errors.
   A count alone is insufficient. System-name whitespace and duplicate duration
   names caused actual confusion. Do not label valid owner logic incorrect merely
   because another closing policy seems more natural.
3. Import JSON for either wholesale draft restoration from backup or adding
   definitions (often AI-generated) to the current draft. Proposed preview and
   conflict/dependency review before applying; import changes the draft, not the
   running package. Decide collision handling explicitly; no silent overwrite.
4. Restore a prior ruleset. Existing release-history/restore UI and backend must
   be reviewed first. Proposed result is a restored draft published as a new
   immutable version; history and restart adoption remain intact.
5. Review all screens, terminology, defaults, optional sections, state indicators
   and confirmations. Simplify presentation without removing valuable functions.
6. Build a repository user guide incrementally with each accepted UI unit. It must
   enable the owner to return in three years and safely remember how to edit,
   validate, publish/deliver, confirm running identity and restore a version.

## Import and backup design questions

Distinguish editable authoring backup, compiled runtime JSON and any partial-import
format. Inventory what existing exports/releases preserve; do not promise round-trip
editing of a compiled package if authoring expressions/metadata are absent. Define
schema/version identity, replace versus add, reference dependencies, duplicate
IDs/system names, changed types, validation atomicity, disabled definitions and
legacy V2 input policy. V3 is the target; do not reintroduce V2 execution.

Provide a small documented AI-generation format and examples when implemented.
Agent access to GitHub does not imply direct access to the live authoring database.
Do not hard-code site secrets into backup/import artifacts.

## Runtime compatibility and duration

Online validation currently accepts some declarations rejected by Tab5. Review the
whole supported subset, not only summaries. Surface unsupported functionality before
publication/delivery while preserving already-saved authoring information.

Tab5 rejects all duration outputs and summary aggregates. In V9 S010 retained an
end-of-event PumpWatts aggregate named EventSummaryValue; removing only it allowed
Tab5 resolution. Duplicate EventDurationSeconds names also failed web validation.
The proposed future design is a standard per-event-instance close-record duration,
not a user-named global output for every event. Decide this with retained event
record work; do not bundle summary execution into a UI cleanup.

## Suggested units, subject to discussion

- Publication workflow and validation/error presentation, including runtime support
  disclosure and tests of success, invalid drafts, publication failure and delivery
  retry. Document the resulting owner workflow.
- Authoring backup/import (replace and additive) with preview, collisions and
  dependency validation; verify no partial draft mutation on rejection.
- Existing historical restoration improvements plus guide/examples; confirm exact
  authoring contents and no silent live adoption.
- Operating-mode controls/occurrences/Clear Events are a separate functional unit.
- AntiFastCycle running-state configuration and field (issue #5) is deferred until
  online changes, but still needs its own bounded design and acceptance. Do not
  implicitly include it in the first editor unit.

## Required review output

Explain actual current workflows with precise source references; distinguish
implemented behavior, tests and proposed design. Give a concise screen/workflow
proposal, compatibility gaps, unresolved owner choices, and the smallest coherent
first coding unit with acceptance criteria. Stop for discussion, without file or
branch changes. Only after owner agreement prepare the coding-agent assignment.

## Fresh-session prompt

Act as design reviewer for bobebaugh/well-pump-control, a one-owner, one-active-AI
personal project. Verify advertised pilot, pilot-working, Tab5 and tab5-working
refs. Read AGENTS.md, CURRENT.md and DESIGN.md on both working branches, interfaces/
where relevant, tab5/AGENTS.md for Tab5, and this EDITOR-REVIEW.md. The working
branches contain the current documentation handoff; do not assume operating refs
already contain it. The latest accepted Tab5 runtime baseline is M6.33; CURRENT.md
records its evidence and pending promotion. Conduct the read-only editor review
specified here. Assess existing import/export/history/restore behavior before
proposing additions. Discuss a simpler publication flow, actionable validation,
JSON replacement/additive import, prior-version restoration and an incremental
user guide. Keep mode integration and script-running health distinct. Propose small
work units and stop for owner discussion before implementation. Do not promote,
deploy, change Firebase, deliver packages, operate hardware, read Google Drive or
reconstruct history. GitHub is the durable source; cloud connector writes are the
established route for later authorized coding work.
