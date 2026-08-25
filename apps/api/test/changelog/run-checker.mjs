#!/usr/bin/env node
/**
 * Test harness for check-changelog.spec.ts's unit-level tests.
 *
 * Same constraint as apps/api/test/provenance/run-checker.mjs (see that
 * file's header for the full explanation): apps/api's Jest suite runs specs
 * through ts-jest, compiled to CommonJS, and `scripts/check-changelog.mjs` is
 * native ESM with no .d.ts. A plain `import(...)` of it from inside a Jest
 * test gets routed through Jest's CJS-oriented module registry rather than
 * Node's native ESM loader and fails with "Cannot use import statement
 * outside a module" — there is no `.mjs` transform configured, and adding one
 * (or `--experimental-vm-modules`) would change how every spec in this suite
 * runs for the sake of one file.
 *
 * So the spec shells out to a real `node` process running this file, which
 * imports the checker's exported pure functions (`commitType`,
 * `gatedCommits`) the normal way and runs them — not a reimplementation —
 * against JSON task descriptions piped in on stdin.
 *
 * This harness is for the two *pure* functions only. The end-to-end exit-code
 * behaviour (main(), reading a real git range) is exercised differently, by
 * spawning `node scripts/check-changelog.mjs ...` directly against a
 * temporary git repository — that needs no ESM-import workaround, because
 * spawning a subprocess is not `import()`-ing an ESM module into Jest.
 */
import {
  commitType,
  gatedCommits,
} from '../../../../scripts/check-changelog.mjs';

function readStdin() {
  const chunks = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () =>
      resolve(Buffer.concat(chunks).toString('utf8')),
    );
    process.stdin.on('error', reject);
  });
}

async function main() {
  const input = JSON.parse(await readStdin());

  const results = input.map((task) => {
    if (task.fn === 'commitType') {
      return { type: commitType(task.subject) };
    }
    if (task.fn === 'gatedCommits') {
      return { commits: gatedCommits(task.commits) };
    }
    throw new Error(`run-checker.mjs: unknown task fn "${task.fn}"`);
  });

  process.stdout.write(JSON.stringify(results));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
