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
