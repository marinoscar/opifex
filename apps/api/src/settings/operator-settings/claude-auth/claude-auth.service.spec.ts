import { Logger } from '@nestjs/common';

import {
  FakeOperatorSettingsPrisma,
  TEST_ENCRYPTION_KEY,
  makeOperatorSettings,
} from '../../../../test/fixtures/operator-settings.fixture';
import {
  FAKE_AUTHORIZE_URL,
  FAKE_OAUTH_TOKEN,
  PASTE_CHUNK_THRESHOLD,
  REALISTIC_AUTHORIZATION_CODE,
  makeFakeClaudeCli,
  type FakeClaudeBehaviour,
  type FakeClaudeCli,
} from '../../../../test/fixtures/fake-claude-cli';
import { ENCRYPTION_KEY_ENV_VAR } from '../../../common/crypto/secret-box';
import {
  ChildProcessSupervisor,
  type SpawnRequest,
  type SupervisedProcess,
} from '../../../runners/process/child-process-supervisor';
import type { OperatorSettingsService } from '../operator-settings.service';
import { ClaudeAuthService } from './claude-auth.service';

/**
 * The sign-in flow, against a real pty and a real process group (#386).
 *
 * ## What these prove, and what only a live run can
 *
 * PROVEN HERE: that the CLI is handed a terminal (the fake refuses without
 * one, exactly as the real binary does); that the authorize URL is recovered
 * from a real OSC 8 hyperlink over a real pipe; that a code written to stdin
 * minutes after spawn reaches a child that is still listening; that the token
 * it prints is sealed through `OperatorSettingsService.set()`; that the four
 * failure causes are told apart; that a session is single-use, expires, and
 * takes its process group with it every time it ends.
 *
 * NOT PROVEN HERE, and not provable without an operator's own Claude account:
 * that `claude` 2.1.246's real success screen matches what the extractor
 * expects. The fake reproduces it from strings read out of the shipped binary
 * ("Authentication token created successfully!", "Your OAuth token (valid
 * for …", "Store this token securely."), and the URL and rejected-code
 * screens ARE real captures — but a live `setup-token` completing is the one
 * step nobody but the account holder can run.
 *
 * ## Real `script(1)`, deliberately
 *
 * Not stubbed. Whether a pty gets allocated, whether `kill(-pgid)` reaches a
 * CLI two forks down, and whether stdin survives the gap between spawn and
 * paste are all properties of the operating system. A stubbed spawn would
 * assert that we pass the arguments we believe are right, which is the belief
 * under test. `script` is in `util-linux`, which the API image installs and
 * every CI runner already has.
 */

/** Enough to make the suite quick without making the assertions untrue. */
class TestClaudeAuthService extends ClaudeAuthService {
  /** Every child this service started, so a spec can look for its corpse. */
  readonly spawned: SupervisedProcess[] = [];
  readonly requests: SpawnRequest[] = [];

  protected override readonly supervisor =
    new (class extends ChildProcessSupervisor {
      constructor(private readonly owner: TestClaudeAuthService) {
        super();
      }
      override start(request: SpawnRequest): SupervisedProcess {
        const proc = super.start(request);
        this.owner.requests.push(request);
        this.owner.spawned.push(proc);
        return proc;
      }
    })(this);

  protected override readonly pollIntervalMs: number = 20;
  protected override readonly startupTimeoutMs: number;
  protected override readonly exchangeTimeoutMs: number;
  protected override readonly sessionTtlMs: number;
  protected override readonly ptyCommand: string;

  constructor(
    settings: OperatorSettingsService,
    timings: {
      startupTimeoutMs?: number;
      exchangeTimeoutMs?: number;
      sessionTtlMs?: number;
      ptyCommand?: string;
    } = {},
  ) {
    super(settings);
    this.startupTimeoutMs = timings.startupTimeoutMs ?? 15_000;
    this.exchangeTimeoutMs = timings.exchangeTimeoutMs ?? 15_000;
    this.sessionTtlMs = timings.sessionTtlMs ?? 60_000;
    this.ptyCommand = timings.ptyCommand ?? 'script';
  }
}

function groupIsGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    // Signal 0 tests existence without delivering anything.
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('ClaudeAuthService (#386)', () => {
  let settings: OperatorSettingsService;
  let prisma: FakeOperatorSettingsPrisma;
  let service: TestClaudeAuthService;
  const cleanups: Array<() => Promise<void>> = [];

  jest.setTimeout(60_000);

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    process.env[ENCRYPTION_KEY_ENV_VAR] = TEST_ENCRYPTION_KEY;

    ({ settings, prisma } = await makeOperatorSettings({ env: {} }));
  });

  afterEach(async () => {
    service?.onModuleDestroy();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    jest.restoreAllMocks();
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  });

  /** A service wired to a fake `claude` of the given behaviour. */
  async function given(
    behaviour: FakeClaudeBehaviour,
    timings: ConstructorParameters<typeof TestClaudeAuthService>[1] = {},
  ): Promise<FakeClaudeCli> {
    const cli = await makeFakeClaudeCli(behaviour);
    cleanups.push(cli.cleanup);
    await settings.set('runners.claudeCodeLocal.binary', cli.binary, null);
    service = new TestClaudeAuthService(settings, timings);
    return cli;
  }

  describe('start', () => {
    it('gives the CLI a real terminal', async () => {
      // The fake refuses on a pipe with the real binary's own words. If the
      // pty were not allocated this would come back `failed`, which is
      // exactly what happened to every attempt before `script(1)`.
      await given('success');

      const session = await service.start('user-1');

      expect(session.status).toBe('awaiting_code');
      expect(service.spawned[0]?.stderr()).not.toContain('not a TTY');
    });

    it('recovers the authorize URL from the OSC 8 hyperlink', async () => {
      await given('success');

      const session = await service.start('user-1');

      expect(session.url).toBe(FAKE_AUTHORIZE_URL);
      // The percent-encoding survived the shell, the pty and the parser. It
      // is the part most likely to be mangled and the part a browser needs.
      expect(session.url).toContain('redirect_uri=https%3A%2F%2Fplatform');
    });

    it('widens the pty before the CLI draws anything', async () => {
      // Not cosmetic. At 80 columns the token wraps and there is no hyperlink
      // to recover it from, so the success path silently stops working.
      await given('success');

      await service.start('user-1');

      expect(service.requests[0]?.args[1]).toMatch(/^stty cols 400 rows 200/);
    });

    it('reports a missing pty allocator as its own cause', async () => {
      await given('success', { ptyCommand: 'opifex-no-such-pty-binary' });

      const session = await service.start('user-1');

      expect(session.status).toBe('failed');
      expect(session.error?.reason).toBe('pty_unavailable');
      expect(session.error?.message).toContain('util-linux');
    });

    it('reports a missing CLI as a missing CLI, not as a pty problem', async () => {
      // Two different remedies — rebuild the image versus fix the configured
      // binary — so answering "authentication failed" for both would leave an
      // operator with nothing to act on.
      service = new TestClaudeAuthService(settings, {
        startupTimeoutMs: 10_000,
      });
      await settings.set(
        'runners.claudeCodeLocal.binary',
        '/nonexistent/opifex-claude',
        null,
      );

      const session = await service.start('user-1');

      expect(session.status).toBe('failed');
      expect(session.error?.reason).toBe('cli_missing');
    });

    it('gives up on a CLI that never prints a URL', async () => {
      await given('die-at-startup', { startupTimeoutMs: 3_000 });

      const session = await service.start('user-1');

      expect(session.status).toBe('failed');
      expect(session.url).toBeNull();
    });

    it('refuses a second sign-in while one is live, and names it', async () => {
      // Enforced rather than assumed: two concurrent flows would each mint a
      // real token against the account, and one would be discarded.
      await given('success');
      const first = await service.start('user-1');

      await expect(service.start('user-1')).rejects.toThrow(
        new RegExp(first.sessionId),
      );
      expect(service.spawned).toHaveLength(1);
    });

    it('allows a new sign-in once the previous one has ended', async () => {
      await given('success');
      const first = await service.start('user-1');
      service.cancel(first.sessionId);

      const second = await service.start('user-1');

      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.status).toBe('awaiting_code');
    });

    it('does not hand the child the credential it is about to replace', async () => {
      // `CLAUDE_CODE_OAUTH_TOKEN` is on the #334 inheritance allowlist for the
      // runner's benefit. Here it would only make the CLI open on a notice
      // about the credential already configured.
      await given('success');

      await service.start('user-1');

      expect(service.requests[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(
        'CLAUDE_CODE_OAUTH_TOKEN' in (service.requests[0]?.env ?? {}),
      ).toBe(true);
    });
  });

  describe('submitCode', () => {
    it('seals the token through the same path a manual entry takes', async () => {
      await given('success');
      const started = await service.start('user-1');

      const done = await service.submitCode(
        started.sessionId,
        'the-pasted-code',
        'user-1',
      );

      expect(done.status).toBe('completed');
      expect(done.configured).toBe(true);
      expect(done.error).toBeNull();

      // The sealed row, not a plaintext one: `value` is null and the
      // ciphertext columns are populated, which is what the registry's
      // `value XOR secret` CHECK requires and what makes History say `set`.
      const row = prisma.rows.get('runners.claudeCodeLocal.oauthToken');
      expect(row).toBeDefined();
      expect(row?.value).toBeNull();
      expect(row?.secretCiphertext).not.toBeNull();
      expect(row?.secretAuthTag).not.toBeNull();

      // And it is the right token: the resolver decrypts to what the CLI
      // printed.
      expect(settings.get('runners.claudeCodeLocal.oauthToken')).toBe(
        FAKE_OAUTH_TOKEN,
      );
    });

    it('submits a code of the length real ones actually are', async () => {
      // THE #389 test. Every other spec in this file pastes four characters,
      // which is why they all passed for as long as the service sent the code
      // and its Enter as ONE write: the vendor's input layer reads a chunk
      // that size as pasted text, a paste carries no Enter, and the 92-
      // character code an operator really pastes was echoed at the prompt and
      // then sat there until the exchange ceiling fired.
      //
      // `fake-claude-cli.spec.ts` pins the other half — that the fake would
      // refuse the old one-write form — so this cannot pass vacuously.
      await given('success', { exchangeTimeoutMs: 10_000 });
      const started = await service.start('user-1');
      expect(REALISTIC_AUTHORIZATION_CODE.length).toBeGreaterThan(
        PASTE_CHUNK_THRESHOLD,
      );

      const done = await service.submitCode(
        started.sessionId,
        REALISTIC_AUTHORIZATION_CODE,
        'user-1',
      );

      expect(done.status).toBe('completed');
      expect(done.error).toBeNull();
      expect(settings.get('runners.claudeCodeLocal.oauthToken')).toBe(
        FAKE_OAUTH_TOKEN,
      );
    });

    it('does not splice the line after the token onto it', async () => {
      // The success fake prints "Store this token securely." immediately
      // after the token, exactly as the real CLI does. A newline-stripping
      // extractor would seal `…1234567Store`, which seals cleanly and then
      // fails every dispatch at auth with nothing to see.
      await given('success');
      const started = await service.start('user-1');

      await service.submitCode(started.sessionId, 'code', 'user-1');

      expect(settings.get('runners.claudeCodeLocal.oauthToken')).not.toMatch(
        /Store/,
      );
    });

    it('calls a rejected code rejected, from the CLI that keeps running', async () => {
      // The real CLI answers a bad code with "Press Enter to retry." and does
      // NOT exit, so a service waiting on an exit code would wait forever.
      await given('invalid-code', { exchangeTimeoutMs: 10_000 });
      const started = await service.start('user-1');

      const done = await service.submitCode(started.sessionId, 'wrong', null);

      expect(done.status).toBe('failed');
      expect(done.error?.reason).toBe('invalid_code');
      expect(done.configured).toBe(false);
    });

    it('calls an account-level refusal what it is', async () => {
      // The CLI emits "OAuth error … status code 400" here too. Reporting
      // that would send the operator back to re-copy a code that was never
      // the problem.
      await given('account-on-hold', { exchangeTimeoutMs: 10_000 });
      const started = await service.start('user-1');

      const done = await service.submitCode(started.sessionId, 'code', null);

      expect(done.error?.reason).toBe('no_subscription');
      expect(done.error?.message).toContain('Pro, Max, Team');
    });

    it('is not fooled by the banner every run prints', async () => {
      // "Claude subscription required." is in the fake's banner, as it is in
      // the real one's, on the SUCCESS path. Nothing the CLI said before the
      // code is evidence about the code.
      await given('success');
      const started = await service.start('user-1');

      const done = await service.submitCode(started.sessionId, 'code', 'u');

      expect(done.status).toBe('completed');
    });

    it('does not blame the code for a failure printed before it was sent', async () => {
      // THE test for the code-offset slice, and the one that fails if it is
      // removed. This fake prints `OAuth error … status code 400` while
      // starting up, recovers, and then goes quiet after the code — which the
      // real CLI's retry path can genuinely do. Classifying the whole
      // transcript would report `invalid_code` for a code the operator never
      // had a chance to get wrong, and send them off to re-copy it forever.
      await given('noisy-startup', { exchangeTimeoutMs: 1_500 });
      const started = await service.start('user-1');
      expect(started.status).toBe('awaiting_code');

      const done = await service.submitCode(started.sessionId, 'code', null);

      expect(done.error?.reason).toBe('timed_out');
      expect(done.error?.reason).not.toBe('invalid_code');
    });

    it('gives up on a CLI that goes quiet after the code', async () => {
      await given('hang-after-code', { exchangeTimeoutMs: 1_500 });
      const started = await service.start('user-1');

      const done = await service.submitCode(started.sessionId, 'code', null);

      expect(done.status).toBe('failed');
      expect(done.error?.reason).toBe('timed_out');
    });

    it('accepts exactly one code per sign-in', async () => {
      await given('success');
      const started = await service.start('user-1');
      await service.submitCode(started.sessionId, 'code', 'user-1');

      await expect(
        service.submitCode(started.sessionId, 'code', 'user-1'),
      ).rejects.toThrow(/not waiting for a code/);
    });

    it('404s for a session it has never heard of', async () => {
      await given('success');
      await service.start('user-1');

      await expect(
        service.submitCode('11111111-2222-3333-4444-555555555555', 'c', null),
      ).rejects.toThrow(/No Claude sign-in/);
    });
  });

  describe('nothing is left running', () => {
    it('kills the process GROUP on cancel, not just the leader', async () => {
      // `script` forks `sh`, which execs the CLI. Signalling only the leader
      // reparents a live `claude` to init, still holding a pty.
      await given('invalid-code');
      const started = await service.start('user-1');
      const pid = service.spawned[0]?.pid;
      expect(pid).toBeDefined();
      expect(groupIsGone(pid)).toBe(false);

      service.cancel(started.sessionId);

      await waitUntil(() => groupIsGone(pid));
    });

    it('kills the child on completion too', async () => {
      await given('success');
      const started = await service.start('user-1');
      const pid = service.spawned[0]?.pid;

      await service.submitCode(started.sessionId, 'code', 'user-1');

      await waitUntil(() => groupIsGone(pid));
    });

    it('kills the child when the session expires unanswered', async () => {
      await given('success', { sessionTtlMs: 500 });
      const started = await service.start('user-1');
      const pid = service.spawned[0]?.pid;

      await waitUntil(() => groupIsGone(pid), 10_000);

      expect(service.get(started.sessionId).status).toBe('expired');
      expect(service.get(started.sessionId).error?.reason).toBe('timed_out');
    });

    it('kills the child on shutdown', async () => {
      await given('invalid-code');
      await service.start('user-1');
      const pid = service.spawned[0]?.pid;

      service.onModuleDestroy();

      await waitUntil(() => groupIsGone(pid));
    });

    it('refuses a code for a session that expired while nobody looked', async () => {
      await given('success', { sessionTtlMs: 300 });
      const started = await service.start('user-1');

      await new Promise((resolve) => setTimeout(resolve, 500));

      await expect(
        service.submitCode(started.sessionId, 'code', 'user-1'),
      ).rejects.toThrow(/not waiting for a code/);
      expect(settings.get('runners.claudeCodeLocal.oauthToken')).toBe('');
    });
  });

  describe('cancel', () => {
    it('reports the cancellation as its own cause, not as a failure', async () => {
      await given('invalid-code');
      const started = await service.start('user-1');

      const done = service.cancel(started.sessionId);

      expect(done.status).toBe('cancelled');
      expect(done.error?.reason).toBe('cancelled');
      expect(done.url).toBeNull();
    });

    it('is safe on a sign-in that has already ended', async () => {
      await given('invalid-code');
      const started = await service.start('user-1');
      service.cancel(started.sessionId);

      expect(() => service.cancel(started.sessionId)).not.toThrow();
    });
  });

  describe('get', () => {
    it('drops the URL once the sign-in is over', async () => {
      // Single-use and now spent. Showing it invites a second doomed attempt.
      await given('success');
      const started = await service.start('user-1');
      expect(started.url).not.toBeNull();

      await service.submitCode(started.sessionId, 'code', 'user-1');

      expect(service.get(started.sessionId).url).toBeNull();
    });

    it('404s for an id it does not hold', async () => {
      await given('success');
      await service.start('user-1');

      expect(() => service.get('11111111-2222-3333-4444-555555555555')).toThrow(
        /No Claude sign-in/,
      );
    });
  });
});
