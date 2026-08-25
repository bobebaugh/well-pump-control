# M6 web rules editor candidate

This non-deploying feature branch adds a protected editor for the 59-row v1 rules package. It loads the actual RTDB current pointer and exact immutable release, lets the operator edit the existing contract fields, validates the ordered workbook completeness, and publishes a new monotonically versioned immutable package.

Publication is ordered deliberately:

1. reject an unauthorized, malformed, unchanged, or stale draft;
2. validate all 59 rules on the server;
3. store the exact release bytes and SHA-256 in `sites/well-main/rulesReleases/{releaseId}`;
4. replace `v1/sites/well-main/rules/current` using the pointer ETag as a compare-and-set guard.

If the pointer write fails, the unused immutable release is harmless and the old pointer remains active. A concurrent publisher receives `stale_draft` instead of silently overwriting a newer pointer.

The browser never receives a Firebase credential or a stored pilot secret. The operator enters the existing pilot key, which remains in session storage and is sent only to the Netlify function. Netlify mints a short-lived fixed `netlify-rules-publisher` Firebase identity. RTDB Security Rules allow that identity to read and write only the complete `well-main/rules/current` pointer. The existing Tab5 identity remains read-only at that path.

Current M6 Tab5 firmware validates, atomically stores, adopts, and reports the package. It does not yet evaluate rules or apply their responses. Deployment of this candidate, including the matching RTDB Security Rules, remains an explicit approval gate.
