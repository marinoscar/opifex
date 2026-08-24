import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SupervisorModule } from './supervisor.module';

/**
 * "A test asserts that no code path allows a proposal to execute" (#90).
 *
 * VISION §3.6: "a system whose safety depends on a model being right has no
 * safety property at all." #90 applies the same reasoning one level out — a
 * system whose safety depends on nobody wiring up an executor later has no
 * safety property either. So the assertion is over the SOURCE, not over
 * behaviour: behaviour tests prove the executor was not called on the paths
 * someone thought to test, and this proves there is no executor to call.
 *
 * It is deliberately blunt. A blunt test that fires on the PR adding a GitHub
 * client to the supervisor is worth more than a subtle one that reasons about
 * whether the client is used, because the failure this guards against arrives
 * as a convenient afternoon, not as a decision.
 *
 * When this test fails, the question to ask is not "how do I satisfy it" but
 * "is the supervisor still observe-only". If the answer has genuinely changed
 * — VISION §7 rung 3, on evidence, per action class — the promotion is an ADR
 * and this file changes with it.
 */
const SUPERVISOR_DIR = join(__dirname);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Modules that can change the world outside the control plane.
 *
 * Each entry is something that, imported into the supervisor, would give a
 * proposal a way to become an action. `GitHubWriteModule` writes labels and
 * comments; the dispatcher starts runs; the runner registry hands work to a
 * process. `GitHubReadModule` is absent from this list on purpose — reading is
 * how a proposer learns what it is proposing about.
 */
const EXECUTION_CAPABLE = [
  'github/write',
  'GitHubWriteModule',
  'GitHubWriteService',
  'dispatch/',
  'DispatchModule',
  'DispatchService',
  'RunnersModule',
  'RunnerRegistry',
  'runners/',
  'reconciler/',
  'ReconcilerModule',
];

describe('supervisor isolation (#90)', () => {
  const files = sourceFiles(SUPERVISOR_DIR);

  it('finds supervisor sources at all', () => {
    // Guards every assertion below from passing vacuously over an empty list,
    // which is how a structural test quietly stops testing anything.
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(EXECUTION_CAPABLE)(
    'imports nothing that could execute a proposal: %s',
    (needle) => {
      const offenders = files.filter((file) => {
        const source = readFileSync(file, 'utf8');
        // Import statements only. A word appearing in a comment — and these
        // files discuss the dispatcher at length — is not a capability.
        return [...source.matchAll(/^\s*import\s[^;]+;/gm)].some((match) =>
          match[0].includes(needle),
        );
      });

      expect(offenders).toEqual([]);
    },
  );

  /**
   * Modules the supervisor may import, each with the reason it is safe.
   *
   * An ALLOWLIST rather than a blocklist, because the failure this guards
   * against is an import nobody thought to forbid. Adding a module here is a
   * deliberate act that shows up in review with this comment attached.
   *
   * - `PrismaModule` — the decision log is two tables, and writing them is the
   *   whole capability the supervisor needs.
   * - `NotificationsModule` — the daily brief (#93, ADR-0012) is delivered
   *   through the same transports escalations use. Sending a summary is not
   *   executing a proposal: nothing in that module can re-dispatch a work
   *   order, create or edit an issue, or clear a quarantine.
   */
  const ALLOWED_MODULE_IMPORTS = ['PrismaModule', 'NotificationsModule'];

  it('imports only modules on the allowlist', () => {
    const source = readFileSync(
      join(SUPERVISOR_DIR, 'supervisor.module.ts'),
      'utf8',
    );
    const imports = /imports:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';

    const declared = imports
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

    expect(declared.length).toBeGreaterThan(0);
    for (const module of declared) {
      expect(ALLOWED_MODULE_IMPORTS).toContain(module);
    }
  });

  it('registers no provider whose name suggests it acts', () => {
    const source = readFileSync(
      join(SUPERVISOR_DIR, 'supervisor.module.ts'),
      'utf8',
    );
    const providers = /providers:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';

    for (const word of [
      'Executor',
      'Dispatcher',
      'Applier',
      'Runner',
      'Writer',
    ]) {
      expect(providers).not.toContain(word);
    }
  });

  it('exposes no endpoint that applies a proposal', () => {
    const controllers = files.filter((file) => file.endsWith('.controller.ts'));
    expect(controllers.length).toBeGreaterThan(0);

    for (const file of controllers) {
      const source = readFileSync(file, 'utf8');
      const routes = [
        ...source.matchAll(/@(Get|Post|Patch|Put|Delete)\(\s*'([^']*)'/g),
      ];
      for (const [, , path] of routes) {
        // Recording a verdict is not applying one. The distinction is the
        // whole of rung 1.
        expect(path).not.toMatch(/execute|apply|dispatch|promote/i);
      }
    }
  });

  it('constructs the module class without a Nest container', () => {
    // Cheap smoke check that the decorator metadata is well-formed; the DI
    // graph itself is covered by app.module.spec.ts.
    expect(SupervisorModule).toBeDefined();
    expect(SupervisorModule.name).toBe('SupervisorModule');
  });
});
