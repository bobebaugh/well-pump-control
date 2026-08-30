"use strict";

const { createHash } = require("node:crypto");
const runtimeSchema = require("../../../contracts/rules-runtime-package-v3.schema.json");
const { MAX_RUNTIME_BYTES, V3_KIND, V3_SCHEMA_VERSION } = require("./rules-engine-v3-contract");

const SITE_ID = "well-main";
const POINTER_SCHEMA_VERSION = 3;
const RELEASE_ID_PATTERN = /^[0-9]{14}-event-v3-v[1-9][0-9]*$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class RulesEngineV3ReleaseError extends Error {
  constructor(code) { super(code); this.name = "RulesEngineV3ReleaseError"; this.code = code; }
}

function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function resolvePointer(document, pointer) {
  return pointer.split("/").slice(1).reduce((value, token) => value?.[token.replace(/~1/g, "/").replace(/~0/g, "~")], document);
}

// A small closed-schema verifier keeps release serving independent of an
// authoring draft.  It deliberately implements every JSON-Schema feature used
// by the checked-in V3 runtime schema, including bounds and oneOf branches.
function schemaErrors(schema, value, root = schema) {
  if (schema === true) return [];
  if (schema === false) return ["disallowed"];
  if (schema.$ref) {
    const target = schema.$ref.startsWith("#") ? resolvePointer(root, schema.$ref.slice(1)) : null;
    return target ? schemaErrors(target, value, root) : ["unresolved_ref"];
  }
  const errors = [];
  if (schema.allOf) schema.allOf.forEach(branch => errors.push(...schemaErrors(branch, value, root)));
  if (schema.anyOf && schema.anyOf.every(branch => schemaErrors(branch, value, root).length !== 0)) errors.push("anyOf");
  if (schema.not && schemaErrors(schema.not, value, root).length === 0) errors.push("not");
  if (schema.if && schemaErrors(schema.if, value, root).length === 0 && schema.then) errors.push(...schemaErrors(schema.then, value, root));
  const object = isObject(value);
  const types = { object, array: Array.isArray(value), string: typeof value === "string", null: value === null, boolean: typeof value === "boolean", number: typeof value === "number" && Number.isFinite(value), integer: Number.isInteger(value) };
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => types[type])) return ["type"];
  if (schema.const !== undefined && !same(value, schema.const)) errors.push("const");
  if (schema.enum && !schema.enum.some(candidate => same(value, candidate))) errors.push("enum");
  if (schema.oneOf && schema.oneOf.filter(branch => schemaErrors(branch, value, root).length === 0).length !== 1) errors.push("oneOf");
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push("minimum");
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push("exclusiveMinimum");
    if (schema.maximum !== undefined && value > schema.maximum) errors.push("maximum");
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push("minLength");
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push("maxLength");
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push("pattern");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push("minItems");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push("maxItems");
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push("uniqueItems");
    if (schema.prefixItems) schema.prefixItems.forEach((itemSchema, index) => { if (index < value.length) errors.push(...schemaErrors(itemSchema, value[index], root)); });
    if (schema.items === false && schema.prefixItems && value.length > schema.prefixItems.length) errors.push("tupleLength");
    else if (schema.items && !Array.isArray(schema.items)) value.forEach((item, index) => { if (!schema.prefixItems || index >= schema.prefixItems.length) errors.push(...schemaErrors(schema.items, item, root)); });
  }
  if (object) {
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) errors.push("required");
    for (const [key, childSchema] of Object.entries(schema.properties || {})) if (Object.hasOwn(value, key)) errors.push(...schemaErrors(childSchema, value[key], root));
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push("additionalProperties");
    }
  }
  return errors;
}

function releaseDownloadPath(releaseId) {
  return `/.netlify/functions/rules-engine-release?version=3&releaseId=${releaseId}`;
}

function verifiedRuntimeV3Release(release, expectedReleaseId) {
  if (!isObject(release) || !RELEASE_ID_PATTERN.test(release.releaseId || "") ||
      (expectedReleaseId && release.releaseId !== expectedReleaseId) ||
      release.schemaVersion !== V3_SCHEMA_VERSION ||
      !Number.isInteger(release.packageVersion) || release.packageVersion < 1 ||
      !Number.isInteger(release.publishedAtMs) || release.publishedAtMs < 0 ||
      typeof release.runtimeBody !== "string" ||
      Buffer.byteLength(release.runtimeBody, "utf8") < 1 ||
      Buffer.byteLength(release.runtimeBody, "utf8") > MAX_RUNTIME_BYTES ||
      !HASH_PATTERN.test(release.contentHash || "")) throw new RulesEngineV3ReleaseError("release_invalid");

  const contentHash = createHash("sha256").update(release.runtimeBody, "utf8").digest("hex");
  if (contentHash !== release.contentHash) throw new RulesEngineV3ReleaseError("release_hash_mismatch");
  let runtimePackage;
  try { runtimePackage = JSON.parse(release.runtimeBody); }
  catch { throw new RulesEngineV3ReleaseError("release_json_invalid"); }
  if (schemaErrors(runtimeSchema, runtimePackage).length !== 0) throw new RulesEngineV3ReleaseError("release_schema_invalid");
  if (runtimePackage.schemaVersion !== V3_SCHEMA_VERSION || runtimePackage.kind !== V3_KIND ||
      runtimePackage.releaseId !== release.releaseId || runtimePackage.packageVersion !== release.packageVersion) {
    throw new RulesEngineV3ReleaseError("release_identity_mismatch");
  }
  return {
    runtimeBody: release.runtimeBody,
    metadata: {
      schemaVersion: POINTER_SCHEMA_VERSION,
      kind: "well-pump-event-runtime-release-pointer-v3",
      siteId: SITE_ID,
      releaseId: release.releaseId,
      packageVersion: release.packageVersion,
      runtimeSchemaVersion: V3_SCHEMA_VERSION,
      contentHash,
      hashAlgorithm: "sha256",
      byteLength: Buffer.byteLength(release.runtimeBody, "utf8"),
      publishedAtMs: release.publishedAtMs,
      executionEnabled: false,
      downloadPath: releaseDownloadPath(release.releaseId)
    }
  };
}

module.exports = { HASH_PATTERN, POINTER_SCHEMA_VERSION, RELEASE_ID_PATTERN, RulesEngineV3ReleaseError, releaseDownloadPath, schemaErrors, verifiedRuntimeV3Release };
