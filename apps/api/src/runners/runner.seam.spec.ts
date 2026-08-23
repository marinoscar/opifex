import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RunEventValidator } from '../run-events/run-event-validator';
import { FakeRunner } from './fake-runner';
import {
  RUNNER_SEAM_METHODS,
  type Runner,
  type WorkOrderSpec,
} from './runner.types';

const SEAM_SOURCE = readFileSync(join(__dirname, 'runner.types.ts'), 'utf8');

function workOrder(overrides: Partial<WorkOrderSpec> = {}): WorkOrderSpec {
  return {
    identity: 'wo_opifex_312_a3f91c2_a1',
    runId: '018f2c31-7a4e-7c3b-9f21-4d5e6a7b8c9d',
    repository: { owner: 'marinoscar', name: 'opifex' },
    baseCommit: 'a3f91c2000000000000000000000000000000000',
    branch: 'factory/312-a3f91c2-a1',
    taskSpec: 'Add the thing',
    acceptanceCriteria: ['The thing exists'],
    pathConstraints: [],
    budgetCeilingUsd: 5,
    wallClockTimeoutMinutes: 30,
    needs: [],
    ...overrides,
  };
}

describe('the runner seam', () => {
  describe('exactly four functions', () => {
    it('declares four and only four', () => {
      // #60: "Exactly four functions; adding a fifth requires an ADR." Only
      // enforceable if something checks, which turns "we agreed not to widen
      // it" into a failing build.
      expect([...RUNNER_SEAM_METHODS].sort()).toEqual(
        ['cancel', 'capabilities', 'poll', 'submit'].sort(),
      );
    });

    it('is implemented by exactly those four and no more', () => {
      const implemented = Object.getOwnPropertyNames(FakeRunner.prototype)
        .filter((name) => name !== 'constructor')
        // The double's steering helpers are not part of the seam; anything
        // private is not either.
        .filter((name) => !STEERING.includes(name) && !name.startsWith('_'));

      expect(implemented.sort()).toEqual([...RUNNER_SEAM_METHODS].sort());
    });

    it('has no resume, so recovery cannot come to depend on one', () => {
      // VISION §3.4: recovery is abandon-and-re-run from the pinned base, and
      // that is what keeps cross-agent session state from ever having to
      // exist. A `resume` here would make it load-bearing within a release.
      expect(RUNNER_SEAM_METHODS).not.toContain('resume');
      expect(SEAM_SOURCE).not.toMatch(/^\s+resume(\?)?\(/m);
    });

    it.each(['getLogs', 'getCost', 'getBranch', 'configure', 'setOptions'])(
      'has no %s — it would be a second source of truth or a config leak',
      (method) => {
        expect(RUNNER_SEAM_METHODS).not.toContain(method);
      },
    );
  });

  describe('no vendor leaks into the signatures', () => {
    it.each([
      'claude',
      'anthropic',
      'openai',
      'gpt',
      'copilot',
      'cursor',
      'aider',
      'devin',
    ])('never names %s outside a comment', (vendor) => {
      // #60's second acceptance criterion. Checked against the source with
      // comments stripped, because the file legitimately DISCUSSES
      // claude-code-local in prose while never typing it.
      const code = SEAM_SOURCE.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(
        /\/\/.*$/gm,
        '',
      );

      expect(code.toLowerCase()).not.toContain(vendor);
    });

    it('expresses vendor resumption as a capability flag, never a method', () => {
      // #60: "Vendor-specific resumption is expressible as a capability flag,
      // never load-bearing." The flag exists so a runner CAN declare it; the
      // absence of a method is what stops anything requiring it.
      expect(SEAM_SOURCE).toContain('resumable: boolean');
    });

    it('never lets a work order name its runner', () => {
      // VISION §6: routing matches needs against advertised capabilities. A
      // work order that names its runner cannot be re-dispatched when that
      // runner is at capacity, which is most of the value of having a seam.
      const spec = SEAM_SOURCE.slice(
        SEAM_SOURCE.indexOf('export interface WorkOrderSpec'),
        SEAM_SOURCE.indexOf('export type RunnerNeed'),
      );

      expect(spec).not.toMatch(/^\s+runner(Key)?(\?)?:/m);
      expect(spec).toContain('needs: RunnerNeed[]');
    });
  });

  describe('a double with no vendor behind it drives the whole path', () => {
    let runner: Runner & FakeRunner;

    beforeEach(() => {
      runner = new FakeRunner();
    });

    it('submits, polls and cancels', async () => {
      const handle = await runner.submit(workOrder());
      const first = await runner.poll(handle);
      await runner.cancel(handle);
      const second = await runner.poll(handle);

      expect(first.status).toBe('running');
      expect(first.events.map((e) => e.type)).toEqual(['run.started']);
      expect(second.status).toBe('failed');
      expect(second.events.map((e) => e.type)).toEqual(['run.failed']);
    });

    it('returns an OPAQUE handle nothing upstream needs to parse', () => {
      // The moment dispatch reads inside externalId, the seam has leaked and
      // swapping runners means touching dispatch — which #60's first exit
      // criterion forbids.
      expect(SEAM_SOURCE).toContain('Opaque to everything else');
    });

    it('is idempotent on identity, rather than starting a second run', async () => {
      // #18: "re-running the same work order is idempotent — the runner checks
      // whether its branch already exists before doing anything."
      const first = await runner.submit(workOrder());
      const second = await runner.submit(workOrder());

      expect(second).toEqual(first);
    });

    it('distinguishes a lost run from a broken runner', async () => {
      // A runner restarted between submit and poll has genuinely lost the run.
      // Throwing would be indistinguishable from the runner being down, and
      // the two call for different responses.
      const result = await runner.poll({
        runnerKey: 'fake-runner',
        externalId: 'gone',
        workOrderIdentity: 'wo_never_submitted',
      });

      expect(result).toEqual({ status: 'unknown', events: [] });
    });

    it('cancels an already-dead run without throwing', async () => {
      // Cancel is what the watchdog reaches for when a run has gone silent.
      // A cancel that throws because the run is already dead turns recovery
      // into an error path at the worst possible moment.
      const handle = await runner.submit(workOrder());
      await runner.cancel(handle);

      await expect(runner.cancel(handle)).resolves.toBeUndefined();
    });

    it('cancels a handle it has never seen without throwing', async () => {
      await expect(
        runner.cancel({
          runnerKey: 'fake-runner',
          externalId: 'x',
          workOrderIdentity: 'nope',
        }),
      ).resolves.toBeUndefined();
    });

    it('hands each event over exactly once', async () => {
      const handle = await runner.submit(workOrder());
      await runner.poll(handle);

      expect((await runner.poll(handle)).events).toEqual([]);
    });

    it('reports starting through the event stream, not the return value', async () => {
      // A real runner says it started by emitting run.started. A dispatch path
      // that assumed submit() implied "running" would break on one.
      const handle = await runner.submit(workOrder());

      expect(runner.delivered(workOrder().identity)).toEqual([]);
      expect((await runner.poll(handle)).events[0].type).toBe('run.started');
    });

    it('surfaces a submit failure rather than a phantom handle', async () => {
      const failing = new FakeRunner({ failSubmit: 'no capacity' });

      await expect(failing.submit(workOrder())).rejects.toThrow('no capacity');
      expect(failing.has(workOrder().identity)).toBe(false);
    });
  });

  describe('poll returns normalized events, never a native format', () => {
    const validator = new RunEventValidator();

    it('emits events the real run-event schema accepts', async () => {
      // #60: "poll returns normalized events (#33), never a runner's native
      // format." Validated against the actual schema file — a double whose
      // events the schema would reject would make every consumer written
      // against it a liar.
      const runner = new FakeRunner();
      const handle = await runner.submit(workOrder());
      runner.block(
        workOrder().identity,
        new Date('2026-08-22T18:00:00Z').toISOString(),
      );
      runner.emit(workOrder().identity, {
        type: 'run.progress',
        tool: { name: 'Bash', signature: 'sha256:abc' },
        cost: { usd: 0.01, tokensInput: 100, tokensOutput: 50 },
      });
      runner.finish(workOrder().identity, 'succeeded', {
        result: { branch: 'factory/312-a3f91c2-a1', headCommit: 'deadbeef' },
      });

      const { events } = await runner.poll(handle);

      expect(events.length).toBeGreaterThan(1);
      for (const event of events) {
        const result = validator.check(event);
        expect(result.valid ? [] : result.failures).toEqual([]);
      }
    });

    it('reports as the runner it is, never as the control plane', async () => {
      // VISION §9: a synthesized event must never masquerade as a report. A
      // double that reported as the control plane would train the code
      // consuming it to accept exactly that.
      const runner = new FakeRunner();
      const handle = await runner.submit(workOrder());

      const { events } = await runner.poll(handle);
      expect(events.every((event) => event.source === 'runner-reported')).toBe(
        true,
      );
    });

    it('stamps the CONTROL PLANE run id, not its own external id', async () => {
      // Found by validating the double's events against the real schema:
      // run-event.schema.json requires `runId` be a UUID, and the handle's
      // externalId is deliberately opaque and runner-chosen. A runner that
      // stamped its own native id would have every event rejected by
      // ingestion, which correlates on exactly this field.
      const runner = new FakeRunner();
      const handle = await runner.submit(workOrder());

      const { events } = await runner.poll(handle);
      expect(events[0].runId).toBe(workOrder().runId);
      expect(events[0].runId).not.toBe(handle.externalId);
    });

    it('carries the stable work-order identity alongside the per-run id', async () => {
      // The identity names the WORK and survives a kill-and-re-run; the runId
      // names one attempt. Both on every event, so a trace can be assembled
      // without joining through the run.
      const runner = new FakeRunner();
      const handle = await runner.submit(workOrder());

      const { events } = await runner.poll(handle);
      expect(events[0].workOrderId).toBe(workOrder().identity);
    });

    it('carries a sender-chosen event id, so redelivery is safe', async () => {
      // Ingestion is idempotent on (runId, eventId) (#53), which is what lets
      // an adapter that cannot track what it has already returned return
      // everything rather than risk dropping an event.
      const runner = new FakeRunner();
      const handle = await runner.submit(workOrder());

      const { events } = await runner.poll(handle);
      expect(events[0].eventId).toMatch(/^evt_/);
    });
  });

  describe('capabilities are declarations, not behaviour', () => {
    it('declares everything the watchdog needs to judge this runner', async () => {
      // streamingFidelity drives the silence thresholds (#54) and gates loop
      // detection (#55). A runner that declared nothing would get the most
      // permissive treatment, which is the safe direction but a real gap.
      const capabilities = await new FakeRunner().capabilities();

      expect(capabilities).toMatchObject({
        streamingFidelity: expect.any(String),
        rateLimitSignal: expect.any(String),
        reportsCost: expect.any(Boolean),
        resumable: expect.any(Boolean),
        maxConcurrency: expect.any(Number),
      });
    });

    it('never claims to be stable', async () => {
      // Routing that would hand real work to a runner that executes nothing
      // should have to opt in loudly.
      expect((await new FakeRunner().capabilities()).stabilityTier).toBe(
        'experimental',
      );
    });

    it('lets a test declare a different runner without touching the seam', async () => {
      // The pressure valve #60 predicts: anything vendor-specific belongs in
      // the manifest as a declaration, not in the seam as a method.
      const partial = new FakeRunner({
        capabilities: {
          streamingFidelity: 'none',
          reportsCost: false,
          resumable: true,
        },
      });

      expect(await partial.capabilities()).toMatchObject({
        streamingFidelity: 'none',
        reportsCost: false,
        resumable: true,
      });
    });

    it('does not depend on a run, so routing can ask before dispatching', async () => {
      const runner = new FakeRunner();

      await expect(runner.capabilities()).resolves.toBeDefined();
    });
  });

  describe('the enums stay in step with the database', () => {
    it.each([
      ['invocationModel', 'RunnerInvocationModel'],
      ['executionLocus', 'RunnerExecutionLocus'],
      ['streamingFidelity', 'RunnerStreamingFidelity'],
      ['rateLimitSignal', 'RunnerSignalQuality'],
      ['stabilityTier', 'RunnerStabilityTier'],
    ])('%s matches the Prisma enum exactly', async (field, prismaEnum) => {
      // The seam restates these rather than importing Prisma, so it stays a
      // pure contract. That is only safe while the two agree — a value added
      // to the schema and missing here would fail to route.
      const prisma = await import('@prisma/client');
      const declared = SEAM_SOURCE.match(new RegExp(`${field}: ([^;]+);`))![1];

      for (const value of Object.values(
        (prisma as unknown as Record<string, Record<string, string>>)[
          prismaEnum
        ],
      )) {
        expect(declared).toContain(`'${value}'`);
      }
    });
  });
});

/** The double's steering helpers, which are deliberately not the seam. */
const STEERING = [
  'emit',
  'finish',
  'block',
  'delivered',
  'has',
  'key',
  'require',
  'event',
];
