#!/usr/bin/env node
/**
 * Test harness for sync-labels.spec.ts.
 *
 * Same reason as `test/provenance/run-checker.mjs`, and the same shape: this
 * suite compiles specs to CommonJS through ts-jest, and an `await import()` of
 * a native `.mjs` from inside a Jest test is routed through Jest's own CJS
 * registry rather than Node's ESM loader. So the spec shells out to a real node
 * process that imports the script normally and runs its actual exported
 * functions against JSON task descriptions on stdin.
 */
import {
  declaredLabels,
  diffLabels,
  validateLabels,
} from '../../../../scripts/sync-labels.mjs';

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
    if (task.fn === 'declaredLabels') {
      return { labels: declaredLabels(task.source) };
    }
    if (task.fn === 'diffLabels') {
      return diffLabels(task.declared, task.actual);
    }
    if (task.fn === 'validateLabels') {
      return { problems: validateLabels(task.labels) };
    }
    throw new Error(`run-labels.mjs: unknown task fn "${task.fn}"`);
  });

  process.stdout.write(JSON.stringify(results));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
