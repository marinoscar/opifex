#!/usr/bin/env node
/**
 * Test harness for check-provenance.spec.ts.
 *
 * Why this exists: apps/api's Jest suite runs under ts-jest, compiling specs
 * to CommonJS. `scripts/check-provenance.mjs` is a native ESM module with no
 * .d.ts. A CJS spec cannot `require()` it (ESM), and a plain `await import()`
 * of it from inside a Jest test gets routed through Jest's own CJS-oriented
 * module registry rather than Node's native ESM loader, which fails with
 * "Cannot use import statement outside a module" — Jest has no transform
 * configured for `.mjs`, and this repo has neither `@babel/preset-env` nor
 * `@babel/plugin-transform-modules-commonjs` installed to give it one, nor is
 * `--experimental-vm-modules` enabled (turning it on globally would change
 * how every other spec in this suite runs, for the sake of one file).
 *
 * So the spec shells out to a real `node` process running this file, which
 * loads the checker the normal way and executes the actual exported
 * functions — not a reimplementation of them — against JSON-serialisable
 * task descriptions piped in on stdin. This keeps the test exercising the
 * real production code while leaving the shared jest.config.js untouched.
 */
import {
  checkCommit,
  parseTrailers,
  loadPatterns,
} from '../../../../scripts/check-provenance.mjs';

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
  const patterns = loadPatterns();

  const results = input.map((task) => {
    if (task.fn === 'checkCommit') {
      return { problems: checkCommit(task.commit, patterns) };
    }
    if (task.fn === 'parseTrailers') {
      return parseTrailers(task.message);
    }
    throw new Error(`run-checker.mjs: unknown task fn "${task.fn}"`);
  });

  process.stdout.write(JSON.stringify(results));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
