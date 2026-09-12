# M6.35 owner rollout and bench checklist

This source unit stops before promotion, deployment, Firebase changes, package
delivery, installation, or hardware operation. After owner sync/review:

1. Fast-forward `pilot` to the reviewed `pilot-working` commit and retain the old
   Pilot tip for rollback.
2. Confirm the existing Pilot branch-deploy environment includes
   `PILOT_INGEST_TOKEN`, `FIREBASE_PROJECT_ID`, `FIRESTORE_DATABASE_ID`,
   `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_WEB_API_KEY`, and
   `FIREBASE_RTDB_URL`. Do not record their values.
3. Deploy Pilot, then publish `firebase/rtdb.rules.json` to project
   `well-pump-control`. No Firestore rules or data migration is required.
4. Exercise `event-board` with the fixed authenticated Tab5 identity and verify an
   empty board produces a Firestore projection plus the RTDB mirror. Verify an
   open board creates one v2 open record and a newer omission creates one v2 close
   with `closeTimeStatus: unknown`.
5. Fast-forward `Tab5` to the reviewed `tab5-working` commit, upload the complete
   tracked `tab5/` set, and restart once. Do not deliver a new runtime package;
   restart-only adoption remains unchanged.
6. On the unloaded bench, confirm M6.34 battery/timing/heap screens remain plausible,
   then confirm session-start and event-boundary observations contain the package's
   fixed logging-enabled fields and explicit unavailable values.
7. During a brief Pilot outage, generate more than 100 small observations or enough
   representative data to exercise the byte high-water. Confirm CPU A event/control
   behavior continues, oldest observations are evicted, and a current board still
   reaches Pilot after recovery.
8. Record actual Tab5 heap high-water with a near-384-KiB FIFO plus one in-flight
   upload and a maximum practical board. The 393,216-byte encoded cap remains
   provisional until this device-only check passes with comfortable headroom.

Rollback is by source revert/fast-forward as separately approved. Source rollback
does not undo published RTDB rules, stored schema-v2 records, or installed files.
