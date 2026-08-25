"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { _createHandler } = require("../cloud/netlify/functions/rules-release");

const root = path.resolve(__dirname, "..");
const releaseId = "20260825000000-rules-v1.json";
const releaseBody = readFileSync(path.join(root, "cloud/netlify/rules-releases", releaseId), "utf8");

function request(release = releaseId, token = "test-ingest-token") {
  return {
    httpMethod: "GET",
    headers: { "X-Pilot-Key": token },
    queryStringParameters: { releaseId: release }
  };
}

test("serves the reviewed immutable release bytes only to the device transport", async () => {
  const handler = _createHandler({ env: { PILOT_INGEST_TOKEN: "test-ingest-token" } });
  const result = await handler(request());
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, releaseBody);
  assert.equal(
    createHash("sha256").update(result.body, "utf8").digest("hex"),
    "ee0220eebdd0fa9b3b9751435180c17a16d3c93cb5f7325f1ab74d8d132e410a"
  );
});

test("rejects unauthorized, malformed, absent, and non-GET release requests", async () => {
  const handler = _createHandler({ env: { PILOT_INGEST_TOKEN: "test-ingest-token" } });
  assert.equal((await handler(request(releaseId, "wrong"))).statusCode, 401);
  assert.equal((await handler(request("../../secrets.json"))).statusCode, 404);
  assert.equal((await handler(request("20260825000000-rules-v99.json"))).statusCode, 404);
  assert.equal((await handler({ httpMethod: "POST", headers: {}, queryStringParameters: {} })).statusCode, 405);
});
