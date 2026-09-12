# Netlify cloud layer

This directory will contain the authenticated ingestion function and deployment configuration.

Pilot responsibilities:

- authenticate the Tab5 request;
- validate request type, schema version, fields, and ranges;
- use server-side timestamps where authoritative receipt time is required;
- write current remote state, events, and completed-cycle summaries to Firestore;
- reject malformed or unauthorized traffic;
- never participate in immediate pump protection.

The `pilot` branch is the Netlify branch-deploy source. Secrets belong in Netlify environment variables for the branch-deploy context and must not be committed.

M4 adds `ingest-record` on a nondeploying feature branch. It appends authenticated,
versioned durable observations and event transitions idempotently while the legacy
pilot functions and current record remain in service.

M6.35 extends `ingest-record` with durable observation schema v2 while retaining
schema v1. The authenticated `event-board` endpoint validates complete sparse
boards, transactionally replaces `eventBoardState/tab5-well-main`, creates
deterministic event-record-v2 history, and conditionally mirrors only the newest
accepted revision to RTDB. It does not interpret relay consequences or influence
Tab5 lifecycle/control state.
