"use strict";

// Read-only Firestore browser for troubleshooting.
//
//   node maintenance/firestore-peek.cjs                                  list collections
//   node maintenance/firestore-peek.cjs eventRecords -n 5
//   node maintenance/firestore-peek.cjs eventRecords --where recordType=event-open
//   node maintenance/firestore-peek.cjs eventRecords --fields eventDefinitionId,notification
//   node maintenance/firestore-peek.cjs eventBoardState/tab5-well-main   one document
//   node maintenance/firestore-peek.cjs _system/pilot --root
//
// It exists so a person or an agent can look at a record without copying it out of the
// Firebase console by hand, and without opening a public route to do it. Credentials come
// from the environment the same way the functions get them, so whoever runs it has exactly
// the access their own service account grants and no more. Use a viewer-scoped account:
// this tool cannot write, but the credential it borrows might be able to.
//
// READ ONLY BY CONSTRUCTION. It calls .get() and .listCollections() and nothing else.
// There is no code path here that sets, creates, updates, deletes or runs a transaction.
//
// A bare name is resolved under sites/<site>/. Pass --root for a top-level path.

const { ConfigurationError, getPilotFirestore } = require("../cloud/netlify/lib/firebase");

const SITE_ID = process.env.PEEK_SITE_ID || "well-main";
const argv = process.argv.slice(2);

function optionValue(...names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1];
  }
  return undefined;
}
function optionValues(name) {
  const found = [];
  argv.forEach((token, index) => { if (token === name && argv[index + 1] !== undefined) found.push(argv[index + 1]); });
  return found;
}
const flag = name => argv.includes(name);
const target = argv.find(token => !token.startsWith("-") &&
  !optionValues("--where").includes(token) && token !== optionValue("-n", "--limit") &&
  token !== optionValue("--order") && token !== optionValue("--fields"));

const limit = Number(optionValue("-n", "--limit") || 5);
const asJson = flag("--json");

// Firestore scalars that are not JSON: timestamps, references, byte buffers.
function plainValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (typeof value._latitude === "number") return `geo(${value._latitude},${value._longitude})`;
  if (value.constructor && value.constructor.name === "DocumentReference") return `ref(${value.path})`;
  if (Buffer.isBuffer(value)) return `bytes(${value.length})`;
  if (Array.isArray(value)) return depth > 6 ? "[...]" : value.map(item => plainValue(item, depth + 1));
  if (typeof value === "object") {
    if (depth > 6) return "{...}";
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item, depth + 1)]));
  }
  return value;
}
function typedLiteral(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
}
function project(data, fields) {
  if (!fields) return data;
  return Object.fromEntries(fields.map(field => [field,
    field.split(".").reduce((value, key) => (value === undefined || value === null ? value : value[key]), data)]));
}
function show(id, data, fields) {
  const body = project(plainValue(data), fields);
  if (asJson) { console.log(JSON.stringify({ id, ...body })); return; }
  console.log(`\n— ${id}`);
  for (const [key, value] of Object.entries(body)) {
    const rendered = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    console.log(`    ${key}: ${rendered.length > 300 ? `${rendered.slice(0, 300)}…` : rendered}`);
  }
}

(async () => {
  let db;
  try { ({ db } = getPilotFirestore()); } catch (error) {
    if (error instanceof ConfigurationError || /SERVICE_ACCOUNT/.test(String(error.message))) {
      console.error("No Firestore credentials in this environment.\n");
      console.error("Set these, ideally from a VIEWER-scoped service account:");
      console.error("  FIREBASE_SERVICE_ACCOUNT_JSON   the service account JSON, on one line");
      console.error("  FIREBASE_PROJECT_ID             well-pump-control   (default)");
      console.error("  FIRESTORE_DATABASE_ID           (default)");
      console.error("\nIn a Claude Code session, put them in the environment configuration so");
      console.error("every future session has them. They are read at runtime and never committed.");
      process.exit(2);
    }
    throw error;
  }

  const fields = optionValue("--fields")?.split(",").map(name => name.trim()).filter(Boolean);
  const path = !target ? null : (flag("--root") ? target : `sites/${SITE_ID}/${target}`);

  if (!path) {
    const root = await db.listCollections();
    const site = await db.doc(`sites/${SITE_ID}`).listCollections();
    console.log(`Top level:\n  ${root.map(c => c.id).join("\n  ") || "(none)"}`);
    console.log(`\nUnder sites/${SITE_ID}:\n  ${site.map(c => c.id).join("\n  ") || "(none)"}`);
    console.log("\nPass a collection name to list documents, or a name/id for one document.");
    return;
  }

  if (path.split("/").filter(Boolean).length % 2 === 0) {
    const snapshot = await db.doc(path).get();
    if (!snapshot.exists) { console.log(`No document at ${path}`); process.exitCode = 1; return; }
    console.log(`${path}`);
    show(snapshot.id, snapshot.data(), fields);
    return;
  }

  let query = db.collection(path);
  for (const clause of optionValues("--where")) {
    const split = clause.indexOf("=");
    if (split === -1) { console.error(`--where needs field=value, got "${clause}"`); process.exit(2); }
    query = query.where(clause.slice(0, split), "==", typedLiteral(clause.slice(split + 1)));
  }
  const order = optionValue("--order");
  if (order) query = query.orderBy(order, flag("--desc") ? "desc" : "asc");

  const snapshot = await query.limit(limit).get();
  console.log(`${path} — ${snapshot.size} document(s)${snapshot.size === limit ? ` (limit ${limit})` : ""}`);
  snapshot.forEach(document => show(document.id, document.data(), fields));
})().catch(error => {
  console.error(`Read failed: ${error?.code || ""} ${error?.message || error}`.trim());
  process.exit(1);
});
