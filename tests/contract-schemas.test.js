"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = relative => JSON.parse(readFileSync(path.join(root, relative), "utf8"));

const schemas = [
  "contracts/current-observation-v1.schema.json",
  "contracts/durable-observation-v1.schema.json",
  "contracts/event-record-v1.schema.json",
  "contracts/device-command-v1.schema.json",
  "contracts/device-sync-v1.schema.json",
  "contracts/rules-release-metadata-v1.schema.json",
  "contracts/rules-package-v1.schema.json",
  "contracts/rules-runtime-release-metadata-v2.schema.json",
  "contracts/rules-runtime-package-v3.schema.json"
];

const examples = [
  ["contracts/current-observation-v1.schema.json", "contracts/examples/v1/current-observation.json"],
  ["contracts/durable-observation-v1.schema.json", "contracts/examples/v1/durable-observation.json"],
  ["contracts/event-record-v1.schema.json", "contracts/examples/v1/event-open.json"],
  ["contracts/event-record-v1.schema.json", "contracts/examples/v1/event-close.json"],
  ["contracts/device-command-v1.schema.json", "contracts/examples/v1/device-command.json"],
  ["contracts/device-sync-v1.schema.json", "contracts/examples/v1/device-sync-request.json"],
  ["contracts/device-sync-v1.schema.json", "contracts/examples/v1/device-sync-response.json"],
  ["contracts/rules-release-metadata-v1.schema.json", "contracts/examples/v1/rules-release-metadata.json"],
  ["contracts/rules-package-v1.schema.json", "contracts/examples/v1/rules-package.json"]
  ,["contracts/rules-runtime-release-metadata-v2.schema.json", "contracts/examples/v2/rules-runtime-release-metadata.json"]
  ,["contracts/rules-runtime-package-v3.schema.json", "contracts/examples/v3/rules-runtime-package.json"]
];

const schemaRegistry = new Map(schemas.flatMap(relative => {
  const schema = readJson(relative);
  return [[relative.replace("contracts/", ""), schema], [schema.$id, schema]];
}));

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolvePointer(document, pointer) {
  return pointer.split("/").slice(1).reduce(
    (value, token) => value[token.replace(/~1/g, "/").replace(/~0/g, "~")],
    document
  );
}

function validate(schema, value, rootSchema = schema, location = "$") {
  if (schema === true) return [];
  if (schema === false) return [`${location} is disallowed`];

  if (schema.$ref) {
    if (schema.$ref.startsWith("#")) {
      return validate(resolvePointer(rootSchema, schema.$ref.slice(1)), value, rootSchema, location);
    }
    const target = schemaRegistry.get(schema.$ref);
    return target ? validate(target, value, target, location) : [`${location} has unresolved ref ${schema.$ref}`];
  }

  const errors = [];
  if (schema.allOf) {
    for (const part of schema.allOf) errors.push(...validate(part, value, rootSchema, location));
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(part => validate(part, value, rootSchema, location).length === 0);
    if (matches.length !== 1) errors.push(`${location} matched ${matches.length} oneOf branches`);
  }
  if (schema.if && validate(schema.if, value, rootSchema, location).length === 0 && schema.then) {
    errors.push(...validate(schema.then, value, rootSchema, location));
  }

  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const types = {
    object: isObject,
    array: Array.isArray(value),
    string: typeof value === "string",
    null: value === null,
    boolean: typeof value === "boolean",
    number: typeof value === "number" && Number.isFinite(value),
    integer: Number.isInteger(value)
  };
  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expectedTypes.some(type => types[type])) return [...errors, `${location} is not ${expectedTypes.join(" or ")}`];
  }
  if (schema.const !== undefined && !same(value, schema.const)) errors.push(`${location} is not the required constant`);
  if (schema.enum && !schema.enum.some(candidate => same(value, candidate))) errors.push(`${location} is not in enum`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${location} is below minimum`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${location} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${location} is too long`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${location} does not match pattern`);
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) errors.push(`${location} is not date-time`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${location} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${location} has too many items`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${location} has duplicate items`);
    if (schema.prefixItems) schema.prefixItems.forEach((itemSchema, index) => {
      if (index < value.length) errors.push(...validate(itemSchema, value[index], rootSchema, `${location}[${index}]`));
    });
    if (schema.items === false && schema.prefixItems && value.length > schema.prefixItems.length) errors.push(`${location} has too many tuple items`);
    else if (schema.items && !Array.isArray(schema.items)) value.forEach((item, index) => {
      if (!schema.prefixItems || index >= schema.prefixItems.length) errors.push(...validate(schema.items, item, rootSchema, `${location}[${index}]`));
    });
  }
  if (isObject) {
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${location}.${required} is required`);
    }
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...validate(propertySchema, value[key], rootSchema, `${location}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${location}.${key} is not allowed`);
    }
  }
  return errors;
}

test("all M2 examples validate against their versioned schemas", () => {
  for (const [schemaPath, examplePath] of examples) {
    const schema = readJson(schemaPath);
    const example = readJson(examplePath);
    assert.deepEqual(validate(schema, example), [], examplePath);
  }
});

test("observation contracts preserve unknown future fields", () => {
  const current = readJson("contracts/examples/v1/current-observation.json");
  const durable = readJson("contracts/examples/v1/durable-observation.json");

  current.values.newSensor = { value: 12.3, unit: "example" };
  current.status.newStatus = "available";
  current.futureEnvelope = true;
  durable.values.newCalculation = [1, 2, 3];
  durable.status.newStatus = { valid: true };
  durable.futureEnvelope = true;

  assert.deepEqual(validate(readJson("contracts/current-observation-v1.schema.json"), current), []);
  assert.deepEqual(validate(readJson("contracts/durable-observation-v1.schema.json"), durable), []);
});

test("durable ingest contracts allow cloud-owned receipt time to be omitted", () => {
  for (const [schemaPath, examplePath] of [
    ["contracts/durable-observation-v1.schema.json", "contracts/examples/v1/durable-observation.json"],
    ["contracts/event-record-v1.schema.json", "contracts/examples/v1/event-open.json"],
    ["contracts/event-record-v1.schema.json", "contracts/examples/v1/event-close.json"]
  ]) {
    const example = readJson(examplePath);
    delete example.receivedAt;
    assert.deepEqual(validate(readJson(schemaPath), example), [], examplePath);
  }
});

test("coordination contracts reject unsupported schema versions", () => {
  for (const [schemaPath, examplePath] of examples) {
    const schema = readJson(schemaPath);
    const expectedVersion = schema.properties?.schemaVersion?.const;
    if (!Number.isInteger(expectedVersion)) continue;
    const example = { ...readJson(examplePath), schemaVersion: expectedVersion + 1 };
    assert.notDeepEqual(validate(schema, example), [], `${examplePath} accepted schemaVersion 2`);
  }
});

test("V3 runtime schema closes nested compiler output and excludes authoring notification policy", () => {
  const schema = readJson("contracts/rules-runtime-package-v3.schema.json");
  const runtime = readJson("contracts/examples/v3/rules-runtime-package.json");
  const unexpectedWeb = structuredClone(runtime);
  unexpectedWeb.events[0].web = { notifyOnOpen: false };
  assert.notDeepEqual(validate(schema, unexpectedWeb), []);
  const unexpectedField = structuredClone(runtime);
  unexpectedField.devices[0].fields[0].unexpected = true;
  assert.notDeepEqual(validate(schema, unexpectedField), []);
  const malformedProgram = structuredClone(runtime);
  malformedProgram.calculations[0].program[0] = ["script", "bad"];
  assert.notDeepEqual(validate(schema, malformedProgram), []);
  const boundedComparison = structuredClone(runtime);
  boundedComparison.events[0].opening.trigger.condition.clauses[0] = { field: "SupplyVoltage", operator: "between", value: [240, 265] };
  assert.deepEqual(validate(schema, boundedComparison), []);
});

test("protected pilot functions and telemetry contract match the reviewed baselines", () => {
  const expected = {
    "cloud/netlify/functions/ingest-power.js": "70986d473b9ede3d3589193a5d38b20c80af54a0655bbf46f80da074141a362e",
    // M6.10 extends only this read response with status already stored inside
    // the complete observation. Ingest behavior and the legacy values remain.
    "cloud/netlify/functions/current-power.js": "f2c1f1a5e42a672cdce7de5c0493fe9078b09f76fbcf493c862c6157427e64be",
    "cloud/netlify/functions/monitor-session.js": "14b7b478a92872e2276d7b359212aa56c5324b0b3ebccd08762a16843553e177",
    "cloud/netlify/functions/firebase-status.js": "056590d9bd3b034cb8edba81822685bfee71ad24f0dc37d71d94f1cae36c0fe0",
    "cloud/netlify/functions/health.js": "59b3b43001d439108faee31fe566f2ae4f79346887692c2a75b44d2d23d73421",
    "cloud/netlify/lib/power-contract.js": "78eeed600c71cb1da373e12f3e677889b1b6894d27a7c0fdc5be296f60cb258f",
    "contracts/power-telemetry-v1.schema.json": "4fd6f6a5ccac0f488efc14cec8cf8bf568dbcbb428fc3144462b1d0cdd2ec012"
  };

  for (const [relative, digest] of Object.entries(expected)) {
    const actual = createHash("sha256").update(readFileSync(path.join(root, relative))).digest("hex");
    assert.equal(actual, digest, `${relative} changed from its reviewed pilot baseline`);
  }
});


test("authentication bootstrap example agrees with the versioned schema", () => { const response = readJson("contracts/examples/v1/device-sync-response.json"); assert.deepEqual(validate(readJson("contracts/device-sync-v1.schema.json"), response), []); assert.equal(response.authenticationBootstrap.firebaseCustomToken, "EXAMPLE_ONLY_CUSTOM_TOKEN_DO_NOT_USE"); });

test("committed examples contain no real-looking credentials", () => { for (const name of readdirSync(path.join(root, "contracts/examples/v1")).filter(name => name.endsWith(".json"))) { const text = readFileSync(path.join(root, "contracts/examples/v1", name), "utf8"); assert.doesNotMatch(text, /-----BEGIN (?:RSA )?PRIVATE KEY-----|AIza[\\w-]{20,}|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\./); } });
