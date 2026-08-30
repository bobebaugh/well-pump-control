"use strict";

const { after, before, test } = require("node:test");
const { readFileSync } = require("node:fs");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} = require("@firebase/rules-unit-testing");
const { get, ref, serverTimestamp, set } = require("firebase/database");

const PROJECT_ID = "demo-well-pump-control";
const SITE = "v1/sites/well-main";
const DEVICE = `${SITE}/devices/tab5-well-main`;
let environment;
let deviceDatabase;
let anonymousDatabase;
let publisherDatabase;
let v3PublisherDatabase;

function emulatorAddress() {
  const value = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (!value) throw new Error("FIREBASE_DATABASE_EMULATOR_HOST is required");
  const separator = value.lastIndexOf(":");
  return { host: value.slice(0, separator), port: Number(value.slice(separator + 1)) };
}

function currentObservation(changes = {}) {
  return {
    schemaVersion: 1,
    siteId: "well-main",
    deviceId: "tab5-well-main",
    sessionId: "boot_12345678",
    sequence: 7,
    observedAt: "2026-08-24T20:00:00Z",
    receivedAtMs: serverTimestamp(),
    source: "tab5",
    values: { powerW: 1234 },
    status: { valid: true },
    ...changes
  };
}

function presence(changes = {}) {
  return {
    schemaVersion: 1,
    siteId: "well-main",
    deviceId: "tab5-well-main",
    sessionId: "boot_12345678",
    lastSeenAtMs: serverTimestamp(),
    ...changes
  };
}

function syncState(changes = {}) {
  return {
    schemaVersion: 1,
    exchangeId: "20260824200000-sync-boot_12345678-0000000001",
    siteId: "well-main",
    deviceId: "tab5-well-main",
    sessionId: "boot_12345678",
    lastSeenCommandSequence: 12,
    lastAppliedCommandSequence: 11,
    result: "ok",
    lastSyncAtMs: serverTimestamp(),
    ...changes
  };
}

before(async () => {
  const database = {
    ...emulatorAddress(),
    rules: readFileSync("firebase/rtdb.rules.json", "utf8")
  };
  environment = await initializeTestEnvironment({ projectId: PROJECT_ID, database });
  deviceDatabase = environment.authenticatedContext("tab5-well-main").database();
  anonymousDatabase = environment.unauthenticatedContext().database();
  publisherDatabase = environment.authenticatedContext("netlify-rules-publisher", {
    siteId: "well-main", purpose: "rules-publication"
  }).database();
  v3PublisherDatabase = environment.authenticatedContext("netlify-rules-publisher", {
    siteId: "well-main", purpose: "rules-v3-publication"
  }).database();
  await environment.withSecurityRulesDisabled(async context => {
    const admin = context.database();
    await set(ref(admin, `${DEVICE}/commands/cmd-12`), { commandSequence: 12, status: "pending" });
    await set(ref(admin, `${SITE}/control/globalEnable`), false);
    await set(ref(admin, `${SITE}/rules/current`), { packageVersion: 1, contentHash: "0".repeat(64) });
  });
});

after(async () => {
  if (environment) await environment.cleanup();
});

test("fixed device can write only valid transport state and server timestamps resolve", async () => {
  await assertSucceeds(set(ref(deviceDatabase, `${DEVICE}/currentObservation`), currentObservation()));
  await assertSucceeds(set(ref(deviceDatabase, `${DEVICE}/presence`), presence()));
  await assertSucceeds(set(ref(deviceDatabase, `${DEVICE}/syncState`), syncState()));
  await environment.withSecurityRulesDisabled(async context => {
    const stored = await get(ref(context.database(), `${DEVICE}/currentObservation/receivedAtMs`));
    if (!Number.isInteger(stored.val())) throw new Error("server timestamp did not resolve to integer milliseconds");
  });
});

test("fixed device can read only addressed coordination paths", async () => {
  await assertSucceeds(get(ref(deviceDatabase, `${DEVICE}/commands`)));
  await assertSucceeds(get(ref(deviceDatabase, `${SITE}/control/globalEnable`)));
  await assertSucceeds(get(ref(deviceDatabase, `${SITE}/rules/current`)));
  for (const path of [`${DEVICE}/currentObservation`, `${DEVICE}/presence`, `${DEVICE}/syncState`]) {
    await assertFails(get(ref(deviceDatabase, path)));
  }
});

test("unauthenticated, broad, cross-device, cross-site, and unrelated access is denied", async () => {
  await assertFails(get(ref(anonymousDatabase, `${DEVICE}/commands`)));
  await assertFails(set(ref(anonymousDatabase, `${DEVICE}/presence`), presence()));
  for (const path of [SITE, "v1/sites", "v1", `${SITE}/unrelated`, "unrelated"]) {
    await assertFails(get(ref(deviceDatabase, path)));
  }
  await assertFails(get(ref(deviceDatabase, `${SITE}/devices/other-device/commands`)));
  await assertFails(set(ref(deviceDatabase, `${SITE}/devices/other-device/presence`), presence({ deviceId: "other-device" })));
  await assertFails(get(ref(deviceDatabase, "v1/sites/other-site/control/globalEnable")));
  await assertFails(set(ref(deviceDatabase, "v1/sites/other-site/devices/tab5-well-main/presence"), presence({ siteId: "other-site" })));
});

test("device cannot write commands, control, rules, parents, or unrelated paths", async () => {
  for (const [path, value] of [
    [`${DEVICE}/commands/new`, { commandSequence: 13 }],
    [`${SITE}/control/globalEnable`, true],
    [`${SITE}/rules/current`, { packageVersion: 2 }],
    [DEVICE, { presence: presence() }],
    [`${SITE}/unrelated`, true]
  ]) await assertFails(set(ref(deviceDatabase, path), value));
});

test("fixed publisher can replace only a complete rules pointer", async () => {
  const current = {
    schemaVersion: 2, kind: "well-pump-runtime-release-pointer", siteId: "well-main",
    releaseId: "20260825143045-parameters-v2", packageVersion: 2,
    runtimeSchemaVersion: 2, contentHash: "a".repeat(64), hashAlgorithm: "sha256",
    byteLength: 1234, publishedAtMs: 1787668245000,
    downloadPath: "/.netlify/functions/rules-engine-release?releaseId=20260825143045-parameters-v2"
  };
  await assertSucceeds(set(ref(publisherDatabase, `${SITE}/rules/current`), current));
  await assertSucceeds(get(ref(publisherDatabase, `${SITE}/rules/current`)));
  await assertFails(set(ref(publisherDatabase, `${SITE}/rules/current`), { packageVersion: 3 }));
  await assertFails(set(ref(publisherDatabase, `${SITE}/control/globalEnable`), true));
});

test("separate V3 staging publisher can replace only a closed execution-disabled V3 pointer", async () => {
  const current = {
    schemaVersion: 3, kind: "well-pump-event-runtime-release-pointer-v3", siteId: "well-main",
    releaseId: "20260830123456-event-v3-v1", packageVersion: 1,
    runtimeSchemaVersion: 3, contentHash: "a".repeat(64), hashAlgorithm: "sha256",
    byteLength: 1234, publishedAtMs: 1788266096000, executionEnabled: false,
    downloadPath: "/.netlify/functions/rules-engine-release?version=3&releaseId=20260830123456-event-v3-v1"
  };
  const path = `${SITE}/rules/v3/current`;
  await assertSucceeds(set(ref(v3PublisherDatabase, path), current));
  await assertSucceeds(get(ref(v3PublisherDatabase, path)));
  await assertSucceeds(get(ref(deviceDatabase, path)));
  await assertFails(set(ref(publisherDatabase, path), current));
  for (const invalid of [
    { ...current, executionEnabled: true },
    { ...current, releaseId: "20260830123456-parameters-v1" },
    { ...current, byteLength: 65537 },
    { ...current, downloadPath: "/.netlify/functions/rules-engine-release?releaseId=20260830123456-event-v3-v1" },
    { ...current, unreviewed: true }
  ]) await assertFails(set(ref(v3PublisherDatabase, path), invalid));
  await assertFails(set(ref(v3PublisherDatabase, `${SITE}/rules/current`), { packageVersion: 2 }));
});

test("malformed and misaddressed current observations are denied", async () => {
  const path = ref(deviceDatabase, `${DEVICE}/currentObservation`);
  for (const value of [
    currentObservation({ schemaVersion: 2 }),
    currentObservation({ siteId: "other-site" }),
    currentObservation({ deviceId: "other-device" }),
    currentObservation({ sequence: -1 }),
    currentObservation({ receivedAtMs: "not-a-timestamp" }),
    { schemaVersion: 1 }
  ]) await assertFails(set(path, value));
});

test("malformed presence and sync state are denied", async () => {
  for (const value of [
    presence({ schemaVersion: 2 }),
    presence({ siteId: "other-site" }),
    presence({ deviceId: "other-device" }),
    presence({ sessionId: 7 }),
    presence({ lastSeenAtMs: "not-a-timestamp" })
  ]) await assertFails(set(ref(deviceDatabase, `${DEVICE}/presence`), value));
  for (const value of [
    syncState({ schemaVersion: 2 }),
    syncState({ siteId: "other-site" }),
    syncState({ deviceId: "other-device" }),
    syncState({ exchangeId: 7 }),
    syncState({ lastAppliedCommandSequence: -1 }),
    syncState({ lastSyncAtMs: "not-a-timestamp" })
  ]) await assertFails(set(ref(deviceDatabase, `${DEVICE}/syncState`), value));
});
