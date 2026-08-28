"use strict";

const { createHash } = require("node:crypto");

const MAX_RUNTIME_BYTES = 65536;
const SITE_ID = "well-main";
const RUNTIME_SCHEMA_VERSION = 2;
const POINTER_SCHEMA_VERSION = 2;
const RELEASE_ID_PATTERN = /^[0-9]{14}-parameters-v[1-9][0-9]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class RulesEngineReleaseError extends Error {
  constructor(code) { super(code); this.name = "RulesEngineReleaseError"; this.code = code; }
}

function releaseDownloadPath(releaseId) {
  return `/.netlify/functions/rules-engine-release?releaseId=${releaseId}`;
}

function verifiedRuntimeRelease(release, expectedReleaseId) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new RulesEngineReleaseError("release_not_found");
  }
  if (!RELEASE_ID_PATTERN.test(release.releaseId || "") ||
      (expectedReleaseId && release.releaseId !== expectedReleaseId) ||
      release.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
      !Number.isInteger(release.packageVersion) || release.packageVersion < 1 ||
      !Number.isInteger(release.publishedAtMs) || release.publishedAtMs < 0 ||
      typeof release.runtimeBody !== "string" ||
      Buffer.byteLength(release.runtimeBody, "utf8") < 1 ||
      Buffer.byteLength(release.runtimeBody, "utf8") > MAX_RUNTIME_BYTES ||
      !HASH_PATTERN.test(release.contentHash || "")) {
    throw new RulesEngineReleaseError("release_invalid");
  }
  const contentHash = createHash("sha256").update(release.runtimeBody, "utf8").digest("hex");
  if (contentHash !== release.contentHash) throw new RulesEngineReleaseError("release_hash_mismatch");
  let runtimePackage;
  try { runtimePackage = JSON.parse(release.runtimeBody); }
  catch { throw new RulesEngineReleaseError("release_json_invalid"); }
  if (!runtimePackage || typeof runtimePackage !== "object" || Array.isArray(runtimePackage) ||
      runtimePackage.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
      runtimePackage.kind !== "well-pump-parameter-runtime" ||
      runtimePackage.releaseId !== release.releaseId ||
      runtimePackage.packageVersion !== release.packageVersion) {
    throw new RulesEngineReleaseError("release_identity_mismatch");
  }
  return {
    runtimeBody: release.runtimeBody,
    metadata: {
      schemaVersion: POINTER_SCHEMA_VERSION,
      kind: "well-pump-runtime-release-pointer",
      siteId: SITE_ID,
      releaseId: release.releaseId,
      packageVersion: release.packageVersion,
      runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
      contentHash,
      hashAlgorithm: "sha256",
      byteLength: Buffer.byteLength(release.runtimeBody, "utf8"),
      publishedAtMs: release.publishedAtMs,
      downloadPath: releaseDownloadPath(release.releaseId)
    }
  };
}

module.exports = {
  HASH_PATTERN,
  MAX_RUNTIME_BYTES,
  POINTER_SCHEMA_VERSION,
  RELEASE_ID_PATTERN,
  RUNTIME_SCHEMA_VERSION,
  RulesEngineReleaseError,
  releaseDownloadPath,
  verifiedRuntimeRelease
};
