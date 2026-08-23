#!/usr/bin/env node
/**
 * Generate TypeScript for the three contracts (#35).
 *
 * ## Why generated at all
 *
 * A hand-written interface next to a schema is two definitions of one contract,
 * and the drift between them is silent until a runner sends something the
 * schema allows and the control plane mis-parses. `run-event.types.ts` said so
 * about itself: it was written as an interim, pinned to the schema by a test,
 * with a note that #35 would delete rather than reconcile it.
 *
 * ## Why it writes into both apps instead of a shared package
 *
 * #35 requires the cockpit consume the same types. The obvious answer is a
 * `packages/contracts` workspace, and it was not taken: the workspace glob is
 * `apps/*`, both Dockerfiles copy specific paths, and the API builds with
 * `tsc -p tsconfig.build.json` rooted at its own src. Introducing a fourth
 * package means touching all of that, and a build-system change is a poor thing
 * to bundle with a contract change.
 *
 * Two copies of a GENERATED file are not two sources of truth — they are two
 * outputs of one source, and `npm run contracts:check` fails the build if either
 * drifts from the schema. That check is what makes the duplication safe, so it
 * runs in CI rather than being a convention.
 *
 * ## unevaluatedProperties
 *
 * All three schemas use `unevaluatedProperties: false`, which json-schema-to-
 * typescript does not understand — it looks for `additionalProperties` and,
 * finding none, emits `{ [k: string]: unknown }`, an index signature that makes
 * every generated type accept anything. The schemas are rewritten in memory to
 * say `additionalProperties: false` before compiling. Nothing on disk changes;
 * Ajv still sees the original, and `unevaluatedProperties` is what it needs to
 * evaluate the `allOf` branches correctly.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'json-schema-to-typescript';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(REPO_ROOT, 'schemas');

/** Contract file stem -> exported type name. */
const CONTRACTS = {
  'work-order': 'WorkOrder',
  'runner-capability': 'RunnerCapability',
  'run-event': 'RunEvent',
};

/** Every app that needs the types, and where they go inside it. */
const OUTPUT_DIRS = [
  'apps/api/src/contracts/generated',
  'apps/web/src/contracts/generated',
];

const BANNER = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written by \`npm run contracts:generate\` from the schema named below, which
 * is the contract. Edit that, re-run the generator, and commit both.
 * \`npm run contracts:check\` fails CI when this file and the schema disagree.
 */`;

/** `unevaluatedProperties: false` is invisible to the generator; this is not. */
function closeObjects(node) {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (node === null || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = closeObjects(value);
  }
  if (
    out.unevaluatedProperties === false &&
    out.additionalProperties === undefined
  ) {
    // Only at the root of a composition: setting it inside an `allOf` branch
    // would forbid the properties the sibling branches contribute.
    delete out.unevaluatedProperties;
    out.additionalProperties = false;
  }
  return out;
}

/**
 * Remove the index signature the generator adds at the root of a composed type.
 *
 * Schemas with an `allOf` compile to `{ [k: string]: unknown } & { ...fields }`,
 * because the branches are open objects even after the root is closed. That
 * first member makes the type accept any property, which is the opposite of
 * what the schema says — Ajv rejects unknown properties via
 * `unevaluatedProperties`, so the accurate type has no index signature.
 *
 * Anchored on `= {` so it only touches the root of an exported type. Nested
 * index signatures are left alone, and at least one of them is deliberate:
 * `runner-capability`'s `vendor` is documented as free-form metadata "kept
 * verbatim for the record", so an index signature there is the correct type.
 */
function dropRootIndexSignature(source) {
  return source.replace(/= \{\n\s*\[k: string\]: unknown;\n\} & \{/g, '= {');
}

const SCREAMING = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toUpperCase();

/**
 * Runtime constants the type alone cannot provide.
 *
 * A union type vanishes at runtime, so anything that iterates the six event
 * types — a switch's exhaustiveness test, a dropdown in the cockpit — needs a
 * real array. Emitting it here keeps it derived from the schema; the previous
 * hand-written array was correct only because a test compared it back.
 */
function runtimeConstants(stem, schema) {
  const lines = [];
  const prefix = SCREAMING(stem);

  const version = schema.properties?.schemaVersion?.default;
  if (version) {
    lines.push(
      `/** The version a producer should write, from the schema's \`default\`. */`,
      `export const ${prefix}_SCHEMA_VERSION = '${version}';`,
      '',
    );
  }

  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (!Array.isArray(property.enum) || name === 'schemaVersion') continue;
    const values = property.enum.map((v) => `'${v}'`).join(', ');
    lines.push(
      `/** Every value \`${name}\` may take. Closed — adding one is a major bump (ADR-0010). */`,
      `export const ${prefix}_${SCREAMING(name)} = [${values}] as const;`,
      '',
    );
  }
  return lines.join('\n');
}

async function main() {
  const files = {};

  for (const [stem, typeName] of Object.entries(CONTRACTS)) {
    const schema = JSON.parse(
      readFileSync(join(SCHEMA_DIR, `${stem}.schema.json`), 'utf8'),
    );

    const compiled = await compile(closeObjects(schema), typeName, {
      bannerComment: '',
      declareExternallyReferenced: true,
      enableConstEnums: false,
      style: { singleQuote: true },
    });

    const types = dropRootIndexSignature(compiled);

    files[`${stem}.ts`] = [
      BANNER,
      ``,
      `// Source: schemas/${stem}.schema.json`,
      ``,
      types.trim(),
      ``,
      runtimeConstants(stem, schema),
    ].join('\n');
  }

  files['index.ts'] = [
    BANNER,
    ``,
    ...Object.keys(CONTRACTS).map((stem) => `export * from './${stem}';`),
    ``,
  ].join('\n');

  for (const dir of OUTPUT_DIRS) {
    const absolute = join(REPO_ROOT, dir);
    mkdirSync(absolute, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(absolute, name), contents);
    }
    console.log(`${dir}: ${Object.keys(files).length} files`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
