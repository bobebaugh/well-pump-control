# KISS current-board fixture notes

These are compact proposal fixtures, not active contracts or production records.

- `board-reconciliation.json` defines the minimum reducer cases for complete-board admission and Pilot projection/history decisions.
- `durable-observation-selection.json` illustrates Rules Engine field selection, triggers, unavailable values, coalescing, FIFO-baseline timing, and independent board/observation loss.
- `observation-fifo.json` defines the minimum bounded individual-record FIFO cases and proves board transport is independent.

Fields named `serverReceivedAt` or `detectedAt` are Pilot server times. Fields named `producedAt` or `observedAt` are device time evidence. An inferred close never treats server receipt/detection time as the exact local close or, by itself, as a bound on it.

The board reducer merges `requestDefaults` into each `input`. Some entries use `openEventKeys`, `sameSemanticContentAsPrevious`, or compact `startingProjection.openEvents` maps as reducer-fixture shorthand. They mean fully populated envelope, slot, or projection entries copied from the prior case; they are not proposed wire or Firestore fields.

The accepted-loss cases are documentary: a short event absent from every delivered complete board is unobservable to Pilot, and a successfully delivered event board does not guarantee delivery of its independently queued observation.
