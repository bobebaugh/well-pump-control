"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { verifiedRulesV3State } = require("../cloud/netlify/lib/rules-engine-v3-state-contract");

function state(changes = {}) {
  return { schemaVersion: 3, kind: "well-pump-event-v3-staging-state", packageVersion: 1, releaseId: "20260830123456-event-v3-v1", contentHash: "a".repeat(64), publishedAtMs: 1788266096000, deliveryEnabled: false, executionEnabled: false, ...changes };
}
function metadata() { return { schemaVersion: 3, kind: "well-pump-event-runtime-release-pointer-v3", siteId: "well-main", releaseId: "20260830123456-event-v3-v1", packageVersion: 1, runtimeSchemaVersion: 3, contentHash: "a".repeat(64), hashAlgorithm: "sha256", byteLength: 1234, publishedAtMs: 1788266096000, executionEnabled: false, downloadPath: "/.netlify/functions/rules-engine-release?version=3&releaseId=20260830123456-event-v3-v1" }; }

test("Rules V3 state is closed, bounded, and always execution-disabled", () => {
  assert.deepEqual(verifiedRulesV3State(state()), state());
  const delivered = state({ deliveryEnabled: true, deliveredAtMs: 1788266097000, delivery: metadata() });
  assert.deepEqual(verifiedRulesV3State(delivered), delivered);
  for (const invalid of [state({ executionEnabled: true }), state({ unreviewed: true }), state({ deliveryEnabled: true }), state({ contentHash: "a".repeat(63) }), state({ packageVersion: 0 })]) {
    assert.throws(() => verifiedRulesV3State(invalid), { code: "rules_v3_state_invalid" });
  }
  assert.throws(() => verifiedRulesV3State(state({ deliveryEnabled: true, deliveredAtMs: 1, delivery: { ...metadata(), packageVersion: 2 } })), { code: "rules_v3_state_identity_mismatch" });
});
