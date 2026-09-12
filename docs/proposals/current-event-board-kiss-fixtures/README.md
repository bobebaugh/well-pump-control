# KISS current-board fixture notes

These are compact proposal fixtures, not active contracts or production records.

- `board-reconciliation.json` defines the minimum reducer cases for complete-board admission and Pilot projection/history decisions.
- `observation-fifo.json` defines the minimum bounded individual-record FIFO cases and proves board transport is independent.

Times ending in `Z` are server receipt times unless a field explicitly says `observedAt`. Expected inferred closes preserve intervals or unknown time; they never treat receipt time as an exact device close.

The board reducer merges `requestDefaults` into each `input`. Some entries use `openEventKeys`, `sameSemanticContentAsPrevious`, or compact `startingProjection.openEvents` maps as reducer-fixture shorthand. They mean fully populated envelope, slot, or projection entries copied from the prior case; they are not proposed wire or Firestore fields.

The accepted-loss case is documentary: a short event absent from every delivered complete board is unobservable to Pilot, so the expected result is intentionally no record.
