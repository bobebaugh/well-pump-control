# Tests

Initial automated coverage will include:

- accepted and rejected Shelly EM source responses;
- start/stop hysteresis state transitions;
- completed-cycle aggregation;
- stale and communications-fault behavior;
- Netlify authentication and request validation;
- Firestore write-shape tests;
- web formatting of unavailable future measurements.
- CPU A durable-observation selection thresholds and maximum interval;
- bounded CPU B durable-record transport and exact retry behavior.
- M6 rules-package schema, ordered workbook completeness, SHA-256 pointer
  matching, last-known-good atomic-adoption behavior, and CPU B opaque
  rules-release transport.

Physical pump observation, Tab5 display behavior, and network-loss recovery remain field acceptance tests.
