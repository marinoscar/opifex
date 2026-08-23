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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'json-schema-to-typescript';
import * as prettier from 'prettier';

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

/**
 * Fold `allOf[*].then.properties` into the root as optional properties.
 *
 * JSON Schema's `if`/`then` has no static TypeScript equivalent — the honest
 * translation is a discriminated union, and deriving one from arbitrary `if`
 * conditions is a different project. Without this, the generated `RunEvent`
 * silently lacks `tool`, `blocked`, `result` and `failure` entirely, because
 * they are only ever introduced inside a conditional branch.
 *
 * So the type describes the SUPERSET: every conditionally-required property,
 * present and optional. That is deliberately weaker than the schema, and the
 * gap is covered where it belongs — Ajv validates the real conditions at the
 * boundary, so a `run.blocked` event with no `blocked` object is rejected at
 * ingestion even though the type would have allowed it. The type is the shape;
 * the validator is the contract.
 *
 * `required` from the branches is deliberately not merged: doing so would make
 * every event need every conditional field.
 */
function foldConditionalBranches(schema) {
  const branches = Array.isArray(schema.allOf) ? schema.allOf : [];
  const folded = { ...schema.properties };
  for (const branch of branches) {
    for (const [name, definition] of Object.entries(
      branch?.then?.properties ?? {},
    )) {
      if (!(name in folded)) folded[name] = definition;
    }
  }
  return { ...schema, properties: folded };
}

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

  // Walked, not just read off the top level: `blocked.reason` lives inside an
  // `allOf`/`then` branch, and a closed set is exactly as closed there as it is
  // at the root. The property NAME keys the constant, so the same enum reached
  // by two paths emits once.
  const enums = new Map();
  const walk = (node, propertyName) => {
    if (Array.isArray(node))
      return node.forEach((item) => walk(item, propertyName));
    if (node === null || typeof node !== 'object') return;
    if (
      Array.isArray(node.enum) &&
      propertyName &&
      propertyName !== 'schemaVersion'
    ) {
      enums.set(propertyName, node.enum);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const [name, sub] of Object.entries(value)) walk(sub, name);
      } else {
        walk(value, propertyName);
      }
    }
  };
  walk(schema, null);

  for (const [name, values] of [...enums].sort()) {
    const literals = values.map((v) => `'${v}'`).join(', ');
    lines.push(
      `/** Every value \`${name}\` may take. Closed — adding one is a major bump (ADR-0010). */`,
      `export const ${prefix}_${SCREAMING(name)} = [${literals}] as const;`,
      '',
    );
  }
  return lines.join('\n');
}

async function main() {
  const check = process.argv.includes('--check');
  const prettierConfig = await prettier.resolveConfig(
    join(REPO_ROOT, 'apps/api/src/contracts/generated/index.ts'),
  );
  const files = {};

  for (const [stem, typeName] of Object.entries(CONTRACTS)) {
    const schema = JSON.parse(
      readFileSync(join(SCHEMA_DIR, `${stem}.schema.json`), 'utf8'),
    );

    const compiled = await compile(
      closeObjects(foldConditionalBranches(schema)),
      typeName,
      {
        bannerComment: '',
        declareExternallyReferenced: true,
        enableConstEnums: false,
        style: { singleQuote: true },
      },
    );

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

  // Formatted here rather than by a separate `prettier --write` step, so
  // --check compares the same bytes that --write would produce. A check that
  // formatted differently from the generator would fail on formatting alone.
  for (const [name, contents] of Object.entries(files)) {
    files[name] = await prettier.format(contents, {
      ...prettierConfig,
      parser: 'typescript',
    });
  }

  const stale = [];
  for (const dir of OUTPUT_DIRS) {
    const absolute = join(REPO_ROOT, dir);
    if (!check) mkdirSync(absolute, { recursive: true });

    for (const [name, contents] of Object.entries(files)) {
      const path = join(absolute, name);
      if (check) {
        // Compared against what is on disk rather than against `git diff`:
        // a git-based check cannot tell "stale" from "not committed yet", so
        // it fails during ordinary local work and teaches people to ignore it.
        const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (current !== contents) stale.push(join(dir, name));
      } else {
        writeFileSync(path, contents);
      }
    }
    if (!check) console.log(`${dir}: ${Object.keys(files).length} files`);
  }

  if (check) {
    if (stale.length > 0) {
      console.error(
        'Generated contract types are out of date with schemas/:\n' +
          stale.map((file) => `  ${file}`).join('\n') +
          '\n\nRun `npm run contracts:generate` and commit the result.',
      );
      process.exit(1);
    }
    console.log('Generated contract types are current.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
