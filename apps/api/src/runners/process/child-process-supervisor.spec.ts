import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  ChildProcessSupervisor,
  DEFAULT_KILL_GRACE_MS,
  KILL_VERIFY_DELAY_MS,
  STDERR_TAIL_BYTES,
  SupervisedProcess,
} from './child-process-supervisor';

/**
 * Against real processes, deliberately.
 *
 * Every property this file asserts — that a group dies with its leader, that a
 * chunk boundary mid-line is survivable, that a SIGTERM-ignoring child is
 * still killed — is a property of the operating system, not of this code. A
 * mocked `spawn` would assert that we call it with the arguments we believe
 * are correct, which is the belief actually in question.
 *
 * The processes are `node -e` one-liners so the suite has no dependency
 * beyond the interpreter already running it.
 */
const NODE = process.execPath;

/** Poll rather than sleep-and-hope: keeps the suite fast and non-flaky. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isRunning(pid: number): boolean {
  try {
    // Signal 0 checks existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('ChildProcessSupervisor', () => {
  const supervisor = new ChildProcessSupervisor();
  let cwd: string;
  const started: SupervisedProcess[] = [];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'opifex-proc-'));
  });

  afterEach(async () => {
    for (const proc of started.splice(0)) proc.kill();
    await rm(cwd, { recursive: true, force: true });
  });

  function start(...args: Parameters<ChildProcessSupervisor['start']>) {
    const proc = supervisor.start(...args);
    started.push(proc);
    return proc;
  }

  describe('stdout as lines', () => {
    it('emits one call per line, with the newline stripped', async () => {
      const lines: string[] = [];
      const proc = start({
        command: NODE,
        args: ['-e', 'process.stdout.write("one\\ntwo\\nthree\\n")'],
        cwd,
        onLine: (line) => lines.push(line),
      });

      await proc.waitForExit();
      expect(lines).toEqual(['one', 'two', 'three']);
    });

    it('re-assembles a line split across chunk boundaries', async () => {
      // A 300 KB line is far larger than a pipe read, so it is guaranteed to
      // arrive in several `data` events. Without buffering this is where a
      // JSON event would silently become two unparseable halves.
      const lines: string[] = [];
      const proc = start({
        command: NODE,
        args: ['-e', 'process.stdout.write("x".repeat(300000) + "\\n")'],
        cwd,
        onLine: (line) => lines.push(line),
      });

      await proc.waitForExit();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toHaveLength(300_000);
    });

    it('emits a final line that has no trailing newline', async () => {
      // The common shape for a CLI that prints its result and exits. Dropping
      // it would lose the most valuable event of the run.
      const lines: string[] = [];
      const proc = start({
        command: NODE,
        args: ['-e', 'process.stdout.write("done\\nlast-without-newline")'],
        cwd,
        onLine: (line) => lines.push(line),
      });

      await proc.waitForExit();
      expect(lines).toEqual(['done', 'last-without-newline']);
    });

    it('skips blank lines rather than reporting them as events', async () => {
      const lines: string[] = [];
      const proc = start({
        command: NODE,
        args: ['-e', 'process.stdout.write("a\\n\\n\\nb\\n")'],
        cwd,
        onLine: (line) => lines.push(line),
      });

      await proc.waitForExit();
      expect(lines).toEqual(['a', 'b']);
    });

    it('survives a line handler that throws, and reports it', async () => {
      // The supervised thing must not be able to take the supervisor down,
      // and a handler throwing inside a stream `data` event is the shortest
      // route from a parse bug to an unhandled rejection.
      const errors: Error[] = [];
      const seen: string[] = [];
      const proc = start({
        command: NODE,
        args: ['-e', 'process.stdout.write("boom\\nsurvived\\n")'],
        cwd,
        onLine: (line) => {
          seen.push(line);
          if (line === 'boom') throw new Error('handler exploded');
        },
        onError: (error) => errors.push(error),
      });

      const outcome = await proc.waitForExit();
      expect(seen).toEqual(['boom', 'survived']);
      expect(errors.map((e) => e.message)).toEqual(['handler exploded']);
      expect(outcome).toMatchObject({ kind: 'exited', exitCode: 0 });
    });
  });

  describe('outcomes', () => {
    it('reports a non-zero exit code', async () => {
      const proc = start({
        command: NODE,
        args: ['-e', 'process.exit(3)'],
        cwd,
      });
      await expect(proc.waitForExit()).resolves.toEqual({
        kind: 'exited',
        exitCode: 3,
        signal: null,
      });
      expect(proc.isAlive()).toBe(false);
      expect(proc.endedAt()).toBeInstanceOf(Date);
    });

    it('reports a spawn failure rather than throwing out of start()', async () => {
      // A missing binary is the single likeliest misconfiguration of this
      // runner, and it must arrive as an outcome the runner can turn into a
      // `run.failed` event — not as an exception from a constructor.
      const proc = start({
        command: join(cwd, 'definitely-not-a-binary'),
        args: [],
        cwd,
      });

      const outcome = await proc.waitForExit();
      expect(outcome.kind).toBe('spawn-failed');
      expect(outcome).toHaveProperty('error');
    });

    it('is alive until it is not', async () => {
      const proc = start({
        command: NODE,
        args: ['-e', 'setTimeout(() => {}, 200)'],
        cwd,
      });

      expect(proc.isAlive()).toBe(true);
      expect(proc.result()).toBeNull();
      await proc.waitForExit();
      expect(proc.isAlive()).toBe(false);
      expect(proc.result()).toMatchObject({ kind: 'exited' });
    });
  });

  describe('stdin and cwd', () => {
    it('writes stdin and closes it', async () => {
      const lines: string[] = [];
      const proc = start({
        command: NODE,
        args: [
          '-e',
          // Reads to EOF: if stdin were left open this never resolves, which
          // is exactly how a runner looks stalled when it is only waiting.
          'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()+"\\n"))',
        ],
        cwd,
        stdin: 'the task spec',
        onLine: (line) => lines.push(line),
      });

      await proc.waitForExit();
      expect(lines).toEqual(['THE TASK SPEC']);
    });

    it('closes stdin even when nothing is written', async () => {
      const proc = start({
        command: NODE,
        args: [
          '-e',
          'process.stdin.on("data",()=>{}).on("end",()=>process.exit(0))',
        ],
        cwd,
      });

      await expect(proc.waitForExit()).resolves.toMatchObject({ exitCode: 0 });
    });

    /**
     * #249: an early-exiting child must not take the API with it.
     *
     * The prompt is unbounded prose, so it does not always fit the ~64KB pipe
     * buffer. When it does not, the write is still in flight after the child
     * has gone, and without an `error` listener Node re-emits the `EPIPE` as
     * an UNCAUGHT EXCEPTION — which in this process means the supervisor, the
     * watchdog and the escalation path die together.
     *
     * Both existing fixtures for this runner drain stdin (`cat > …`), which is
     * why the suite never caught it. This one deliberately does not.
     */
    it('survives a child that exits without ever reading its stdin', async () => {
      // Ours goes first so an unhandled EPIPE is recorded here rather than
      // only killing the run. Listening also suppresses the crash, so the
      // assertion below is what makes the regression visible.
      const uncaught: Error[] = [];
      const capture = (error: Error) => uncaught.push(error);
      process.prependListener('uncaughtException', capture);

      try {
        const lines: string[] = [];
        const reported: Error[] = [];
        const proc = start({
          command: NODE,
          // `node -e` never reads stdin, and this one exits at once: the
          // shape of a CLI rejecting a flag or failing to authenticate.
          args: ['-e', 'process.stdout.write("{\\"type\\":\\"result\\"}\\n")'],
          cwd,
          // Comfortably over the pipe buffer, so the write cannot be
          // swallowed whole and the race is deterministic rather than lucky.
          stdin: 'x'.repeat(1024 * 1024),
          onLine: (line) => lines.push(line),
          onError: (error) => reported.push(error),
        });

        // The exit code is the fact. EPIPE is a symptom of it, so the outcome
        // is the child's own, not a synthetic stdin failure.
        await expect(proc.waitForExit()).resolves.toEqual({
          kind: 'exited',
          exitCode: 0,
          signal: null,
        });
        // And the run keeps its output: settling on the EPIPE would have won
        // the race against `close`, where the final line is flushed.
        expect(lines).toEqual(['{"type":"result"}']);
        // An ordinary early exit, so nothing to warn an operator about.
        expect(reported).toEqual([]);

        // The EPIPE can land a tick after the child is reaped.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(uncaught).toEqual([]);
      } finally {
        process.removeListener('uncaughtException', capture);
      }
    });

    it('survives stdin dying under a child that is still running', async () => {
      // The other half of #249, and the reason EPIPE must not settle: a child
      // may close its stdin and work for hours. Treating the failed write as
      // the end of the run would declare a healthy run over.
      const uncaught: Error[] = [];
      const capture = (error: Error) => uncaught.push(error);
      process.prependListener('uncaughtException', capture);

      try {
        const lines: string[] = [];
        const proc = start({
          command: NODE,
          args: [
            '-e',
            'process.stdin.destroy();' +
              'setTimeout(()=>{process.stdout.write("still here\\n")},150)',
          ],
          cwd,
          stdin: 'x'.repeat(1024 * 1024),
          onLine: (line) => lines.push(line),
        });

        await expect(proc.waitForExit()).resolves.toMatchObject({
          kind: 'exited',
          exitCode: 0,
        });
        expect(lines).toEqual(['still here']);
        expect(uncaught).toEqual([]);
      } finally {
        process.removeListener('uncaughtException', capture);
      }
    });

    it('reports a stdin error that is not the ordinary EPIPE race', () => {
      // EPIPE has a story — the child stopped reading — and its own outcome
      // arriving right behind it. Anything else on this stream has neither,
      // so it must not vanish. Driven through a fake child because a real
      // EIO on a pipe cannot be provoked from a test.
      const stdin = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdin,
        stdout: null,
        stderr: null,
      }) as unknown as ChildProcess;

      const reported: Error[] = [];
      new SupervisedProcess(child, {
        command: NODE,
        args: [],
        cwd,
        onError: (error) => reported.push(error),
      });

      const failure: NodeJS.ErrnoException = new Error('read EIO');
      failure.code = 'EIO';
      stdin.emit('error', failure);

      expect(reported).toEqual([failure]);
    });

    it('runs in the requested cwd', async () => {
      const lines: string[] = [];
      const proc = start({
        command: NODE,
        args: ['-e', 'process.stdout.write(process.cwd() + "\\n")'],
        cwd,
        onLine: (line) => lines.push(line),
      });

      await proc.waitForExit();
      // macOS reports /private/var for /var, so compare the leaf.
      expect(lines[0]).toContain(cwd.split('/').pop());
    });

    it('merges env over the parent environment', async () => {
      const lines: string[] = [];
      const proc = start({
        command: NODE,
        args: [
          '-e',
          'process.stdout.write(process.env.OPIFEX_TEST_VAR + "\\n")',
        ],
        cwd,
        env: { OPIFEX_TEST_VAR: 'set-by-supervisor' },
        onLine: (line) => lines.push(line),
      });

      await proc.waitForExit();
      expect(lines).toEqual(['set-by-supervisor']);
    });
  });

  describe('stderr', () => {
    it('keeps stderr for a failure reason', async () => {
      const proc = start({
        command: NODE,
        args: [
          '-e',
          'process.stderr.write("something went wrong\\n");process.exit(1)',
        ],
        cwd,
      });

      await proc.waitForExit();
      expect(proc.stderr()).toContain('something went wrong');
    });

    it('keeps only the tail, so a runaway child cannot exhaust memory', async () => {
      // The bound is the point: ADR 0006 chose the subprocess boundary so the
      // supervised thing cannot kill the supervisor, and unbounded capture
      // would hand that ability straight back.
      const proc = start({
        command: NODE,
        args: [
          '-e',
          `process.stderr.write("A".repeat(${STDERR_TAIL_BYTES * 2}));process.stderr.write("TAIL")`,
        ],
        cwd,
      });

      await proc.waitForExit();
      expect(proc.stderr().length).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
      expect(proc.stderr().endsWith('TAIL')).toBe(true);
    });

    it('reports a read failure on an output stream rather than dying of it', () => {
      // #249 again, in the direction it was not filed for: `stdout` and
      // `stderr` carry data handlers and no error handler, so a read failure
      // on either pipe reaches the process by the identical route. Reported
      // rather than settled — `close` still brings the real exit status, and
      // truncated output is a note on the run, not its outcome.
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: 4243,
        stdin: new PassThrough(),
        stdout,
        stderr,
      }) as unknown as ChildProcess;

      const reported: Error[] = [];
      const proc = new SupervisedProcess(child, {
        command: NODE,
        args: [],
        cwd,
        onError: (error) => reported.push(error),
      });

      stdout.emit('error', new Error('read EIO'));
      stderr.emit('error', new Error('connection reset'));

      expect(reported.map((error) => error.message)).toEqual([
        'stdout failed: read EIO',
        'stderr failed: connection reset',
      ]);
      // Still running, as far as the supervisor is concerned: only the child
      // itself ends the run.
      expect(proc.isAlive()).toBe(true);
    });
  });

  describe('kill', () => {
    it('terminates the whole process group, not just the leader', async () => {
      // The property #61 actually asks for: "cancellation actually terminates
      // work, and does not leave orphaned processes". A coding agent spawns a
      // git, a test runner, a language server — signalling only the leader
      // reparents those to init, where nothing knows to stop them and they
      // keep spending the quota the cancel was meant to reclaim.
      const lines: string[] = [];
      const proc = start({
        command: '/bin/sh',
        args: ['-c', `${NODE} -e 'setInterval(()=>{},1000)' & echo $!; wait`],
        cwd,
        onLine: (line) => lines.push(line),
      });

      await waitUntil(() => lines.length > 0);
      const grandchild = Number(lines[0]);
      expect(Number.isInteger(grandchild)).toBe(true);
      expect(isRunning(grandchild)).toBe(true);

      proc.kill();
      await proc.waitForExit();
      await waitUntil(() => !isRunning(grandchild));

      expect(isRunning(grandchild)).toBe(false);
    });

    it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
      const ready: string[] = [];
      const proc = start({
        command: NODE,
        // Installs a SIGTERM handler that does nothing — the shape of a child
        // stuck in cleanup, and the reason a grace period alone is not enough.
        // It announces itself on stdout because signalling before the handler
        // is installed would test the default disposition instead.
        args: [
          '-e',
          'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stdout.write("armed\\n")',
        ],
        cwd,
        killGraceMs: 250,
        onLine: (line) => ready.push(line),
      });

      await waitUntil(() => ready.includes('armed'));
      proc.kill();

      const outcome = await proc.waitForExit();
      expect(outcome).toMatchObject({ kind: 'signalled', signal: 'SIGKILL' });
    });

    it('is idempotent and does not throw for an already-dead process', async () => {
      // `Runner.cancel` promises exactly this, and so does the situation:
      // cancel is what the watchdog reaches for once a run has gone wrong, so
      // an already-dead process must be a no-op rather than an error path at
      // the worst possible moment.
      const proc = start({
        command: NODE,
        args: ['-e', 'process.exit(0)'],
        cwd,
      });
      await proc.waitForExit();

      expect(() => {
        proc.kill();
        proc.kill();
      }).not.toThrow();
    });

    it('does not re-signal a group it has already asked to stop', async () => {
      const proc = start({
        command: NODE,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd,
        killGraceMs: 60_000,
      });

      await waitUntil(() => proc.pid !== undefined);
      proc.kill();
      proc.kill();

      await expect(proc.waitForExit()).resolves.toMatchObject({
        kind: 'signalled',
        signal: 'SIGTERM',
      });
    });
  });

  describe('post-kill verification', () => {
    it('stays quiet when SIGKILL worked, which is the normal case', async () => {
      // #61's criterion is that cancellation "actually terminates work". The
      // check exists to catch the rare case it does not — a process wedged in
      // uninterruptible sleep, or a pid we no longer own — so it must not
      // report anything when the ordinary path works, or the signal is noise.
      const errors: Error[] = [];
      const ready: string[] = [];
      const proc = start({
        command: NODE,
        // Ignores SIGTERM, so the SIGKILL escalation — and therefore the
        // verification — is definitely reached.
        args: [
          '-e',
          'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stdout.write("armed\\n")',
        ],
        cwd,
        killGraceMs: 100,
        onError: (error) => errors.push(error),
        onLine: (line) => ready.push(line),
      });

      await waitUntil(() => ready.includes('armed'));
      proc.kill();
      await expect(proc.waitForExit()).resolves.toMatchObject({
        signal: 'SIGKILL',
      });

      // Past the verification delay, so a false report would have landed.
      await new Promise((resolve) =>
        setTimeout(resolve, KILL_VERIFY_DELAY_MS + 500),
      );

      expect(
        errors.filter((error) => error.message.includes('survived SIGKILL')),
      ).toHaveLength(0);
    }, 30_000);

    it('waits before checking, since the kernel reaps asynchronously', () => {
      // Checking in the same tick would report a process already on its way
      // out, which is the fastest way to make a real warning ignorable.
      expect(KILL_VERIFY_DELAY_MS).toBeGreaterThan(0);
    });
  });

  it('defaults the kill grace to something a CLI can flush within', () => {
    // Asserted rather than assumed: too short and a run loses its final
    // result line, too long and the watchdog's kill lands a tick late.
    expect(DEFAULT_KILL_GRACE_MS).toBeGreaterThanOrEqual(5_000);
    expect(DEFAULT_KILL_GRACE_MS).toBeLessThanOrEqual(30_000);
  });
});
