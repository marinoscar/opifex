import { Logger } from '@nestjs/common';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FakeOperatorSettingsPrisma,
  makeOperatorSettings,
} from '../../../../test/fixtures/operator-settings.fixture';
import { SupervisorModelError } from '../../../supervisor/invocation/supervisor-model.config';
import type { SupervisorModel } from '../../../supervisor/invocation/supervisor-model.port';
import type { OperatorSettingsService } from '../operator-settings.service';
import {
  OperatorProbesService,
  describeGitHubFailure,
  readPushPermission,
  readRateLimitCore,
  type GitHubProbeResponse,
} from './operator-probes.service';

/**
 * Every probe, in both shapes: it found the thing working, and it found the
 * thing broken.
 *
 * ## What is real here and what is not
 *
 * `claude-cli`, `git` and `claude-credential` run REAL child processes against
 * shell-script fixtures, because the properties under test — a missing binary
 * is reported rather than thrown, a non-zero exit is a failure, the configured
 * credential reaches the child's environment — are properties of spawning, and
 * a mocked `spawn` would only assert that we believe our own arguments.
 *
 * `github-token`, `github-repo` and `supervisor-model` stub one seam each
 * (`githubGet`, `createModel`), because the alternative is a live credential
 * and a live bill inside a unit suite. What is NOT stubbed is anything that
 * decides an outcome: the status-to-sentence mapping, the rate limiter, and
 * the "nothing configured" branches are the production ones.
 */

/** The real service with the two network seams and the clock replaced. */
class TestProbes extends OperatorProbesService {
  githubResponses: GitHubProbeResponse[] = [];
  readonly githubCalls: Array<{
    baseUrl: string;
    path: string;
    token: string;
  }> = [];
  model: SupervisorModel = {
    name: 'claude-test',
    ask: () =>
      Promise.resolve({
        text: 'ok',
        costUsd: 0.0002,
        tokensInput: 12,
        tokensOutput: 1,
      }),
  };
  clock = Date.parse('2026-08-26T12:00:00.000Z');

  protected override async githubGet(
    baseUrl: string,
    path: string,
    token: string,
  ): Promise<GitHubProbeResponse> {
    this.githubCalls.push({ baseUrl, path, token });
    const next = this.githubResponses.shift();
    if (!next) throw new Error(`no stubbed GitHub response for ${path}`);
    return Promise.resolve(next);
  }

  protected override createModel(): SupervisorModel {
    return this.model;
  }

  protected override now(): number {
    return this.clock;
  }
}

function githubOk(body: unknown): GitHubProbeResponse {
  return { ok: true, status: 200, body, problem: null };
}

function githubFail(status: number): GitHubProbeResponse {
  return { ok: false, status, body: null, problem: null };
}

describe('OperatorProbesService (#338)', () => {
  let dir: string;
  let prisma: FakeOperatorSettingsPrisma;
  let settings: OperatorSettingsService;
  let probes: TestProbes;

  async function build(env: NodeJS.ProcessEnv = {}): Promise<void> {
    prisma = new FakeOperatorSettingsPrisma();
    ({ settings } = await makeOperatorSettings({ prisma, env }));
    probes = new TestProbes(settings, prisma.asPrisma());
  }

  async function script(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(path, 0o755);
    return path;
  }

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    dir = await mkdtemp(join(tmpdir(), 'opifex-probes-'));
    await build();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // github-token
  // -------------------------------------------------------------------------

  describe('github-token', () => {
    it('reports the remaining budget when the token is accepted', async () => {
      await build({ GITHUB_TOKEN: 'ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs' });
      probes.githubResponses = [
        githubOk({ resources: { core: { limit: 5000, remaining: 4987 } } }),
      ];

      const result = await probes.run('github-token');

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('api.github.com');
      expect(result.detail).toContain('4987 of 5000');
      expect(result.checkedAt).toBe('2026-08-26T12:00:00.000Z');
    });

    it('asks /rate_limit on the CONFIGURED base URL with the CONFIGURED token', async () => {
      // Not the one frozen into `GitHubHttpService` at boot. The whole point
      // of the button is "does the value I just saved work".
      prisma.put('github.token', 'ghp_JustSaved00Zq7Vn3Mb8Kd5Rt2Wc');
      prisma.put('github.apiBaseUrl', 'https://ghe.example.com/api/v3');
      await settings.refresh();
      probes.githubResponses = [githubOk({})];

      await probes.run('github-token');

      expect(probes.githubCalls[0]).toEqual({
        baseUrl: 'https://ghe.example.com/api/v3',
        path: '/rate_limit',
        token: 'ghp_JustSaved00Zq7Vn3Mb8Kd5Rt2Wc',
      });
    });

    it('reports a rejected token as ok: false, not as an exception', async () => {
      await build({ GITHUB_TOKEN: 'ghp_expired0Zq7Vn3Mb8Kd5Rt2Wc4X' });
      probes.githubResponses = [githubFail(401)];

      const result = await probes.run('github-token');

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('401');
      expect(result.detail).toMatch(/wrong, expired, or revoked/);
    });

    it('skips rather than failing when no token is configured at all', async () => {
      const result = await probes.run('github-token');

      expect(result).toMatchObject({ ok: false, skipped: true });
      expect(result.detail).toContain('No GitHub token is configured');
      expect(probes.githubCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // github-repo
  // -------------------------------------------------------------------------

  describe('github-repo', () => {
    function withRepository(owner: string, name: string) {
      (
        prisma as unknown as { repository: Record<string, unknown> }
      ).repository = {
        findFirst: () => Promise.resolve({ owner, name }),
        findUnique: () => Promise.resolve({ owner, name }),
      };
    }

    it('reads the repository and reports whether the token can push', async () => {
      await build({ GITHUB_TOKEN: 'ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs' });
      withRepository('marinoscar', 'opifex');
      probes.githubResponses = [githubOk({ permissions: { push: true } })];

      const result = await probes.run('github-repo');

      expect(result.ok).toBe(true);
      expect(probes.githubCalls[0].path).toBe('/repos/marinoscar/opifex');
      expect(result.detail).toContain('can push');
    });

    it('explains that a 404 is a token that cannot see the repository', async () => {
      // The finding this probe exists for, and the one an operator would
      // otherwise misread: GitHub answers 404 rather than 403 for a repository
      // a fine-grained PAT does not cover.
      await build({ GITHUB_TOKEN: 'ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs' });
      withRepository('marinoscar', 'opifex');
      probes.githubResponses = [githubFail(404)];

      const result = await probes.run('github-repo');

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('marinoscar/opifex');
      expect(result.detail).toContain('404 rather than 403');
    });

    it('skips when no repository is registered yet', async () => {
      await build({ GITHUB_TOKEN: 'ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs' });

      const result = await probes.run('github-repo');

      expect(result).toMatchObject({ ok: false, skipped: true });
      expect(result.detail).toContain('No repository is registered');
    });
  });

  // -------------------------------------------------------------------------
  // claude-cli and git
  // -------------------------------------------------------------------------

  describe('claude-cli and git', () => {
    it('reports the installed version of the configured claude binary', async () => {
      const binary = await script('claude', 'echo "2.1.240 (Claude Code)"');
      await build({ CLAUDE_CODE_BINARY: binary });

      const result = await probes.run('claude-cli');

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('2.1.240');
    });

    it('says out loud that a passing --version proves nothing about credentials', async () => {
      // The deceptive failure, named in the response itself so an operator
      // reading a green tick is not misled by it.
      const binary = await script('claude', 'echo "2.1.240"');
      await build({ CLAUDE_CODE_BINARY: binary });

      const result = await probes.run('claude-cli');

      expect(result.detail).toContain('says nothing about credentials');
    });

    it('reports a missing binary as ok: false rather than throwing', async () => {
      await build({ CLAUDE_CODE_BINARY: join(dir, 'not-installed') });

      const result = await probes.run('claude-cli');

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('could not start');
    });

    it('probes the configured git binary for the git probe', async () => {
      const binary = await script('git', 'echo "git version 2.43.0"');
      await build({ GIT_BINARY: binary });

      const result = await probes.run('git');

      expect(result).toMatchObject({ ok: true, probe: 'git' });
      expect(result.detail).toContain('2.43.0');
    });
  });

  // -------------------------------------------------------------------------
  // claude-credential — the one that matters
  // -------------------------------------------------------------------------

  describe('claude-credential', () => {
    it('makes a real non-interactive invocation, not a --version call', async () => {
      // The binary itself is the assertion: it succeeds only for `--print`
      // with a prompt after it, and fails for `--version`. A probe that
      // quietly reused the cheap version check would report a failure here,
      // which is the point — `--version` succeeding is exactly what makes an
      // unauthenticated CLI look healthy.
      const binary = await script(
        'claude',
        [
          'if [ "$1" != "--print" ]; then echo "wrong argv: $*" >&2; exit 2; fi',
          'if [ -z "$2" ]; then echo "no prompt" >&2; exit 3; fi',
          'echo ok',
        ].join('\n'),
      );
      await build({ CLAUDE_CODE_BINARY: binary });

      const result = await probes.run('claude-credential');

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('real non-interactive invocation');
    });

    it('runs the CLI with no terminal, so it cannot stop to ask a question', async () => {
      // Belt and braces with `--print`, and the same pair the runner sets: a
      // CLI that believes it has a terminal can decide to prompt, and a prompt
      // with nobody to answer it is a request that never returns.
      const binary = await script(
        'claude',
        [
          'if [ "$CI" != "true" ]; then echo "CI unset" >&2; exit 4; fi',
          'if [ "$TERM" != "dumb" ]; then echo "TERM=$TERM" >&2; exit 5; fi',
          'echo ok',
        ].join('\n'),
      );
      await build({ CLAUDE_CODE_BINARY: binary });

      await expect(probes.run('claude-credential')).resolves.toMatchObject({
        ok: true,
      });
    });

    it('hands the child the OAuth token the operator configured', async () => {
      // The binary refuses unless it sees the token, which is what an
      // unauthenticated CLI does. A probe that did not pass the configured
      // credential through would report every fresh deployment as broken.
      const binary = await script(
        'claude',
        'if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo "Invalid API key" >&2; exit 1; fi; echo ok',
      );
      await build({
        CLAUDE_CODE_BINARY: binary,
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-Vq7Kd2Nx8Zb5Mr3Wt6Jc',
      });

      const result = await probes.run('claude-credential');

      expect(result.ok).toBe(true);
    });

    it('reports an unauthenticated CLI as a failure, with the reason', async () => {
      const binary = await script(
        'claude',
        'echo "Invalid API key · Please run /login" >&2; exit 1',
      );
      await build({ CLAUDE_CODE_BINARY: binary });

      const result = await probes.run('claude-credential');

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('Invalid API key');
      expect(result.detail).toContain('would still answer --version');
    });

    it('states its allowance on every call, not only when it runs out', async () => {
      const binary = await script('claude', 'echo ok');
      await build({ CLAUDE_CODE_BINARY: binary });

      const result = await probes.run('claude-credential');

      expect(result.rateLimit).toMatchObject({
        limit: 5,
        windowSeconds: 3600,
        remaining: 4,
      });
    });

    it('refuses past the limit, and says when the allowance comes back', async () => {
      const binary = await script('claude', 'echo ok');
      await build({ CLAUDE_CODE_BINARY: binary });

      for (let i = 0; i < 5; i += 1) await probes.run('claude-credential');
      const sixth = await probes.run('claude-credential');

      expect(sixth).toMatchObject({ ok: false, skipped: true });
      expect(sixth.detail).toContain('5 runs per hour');
      expect(sixth.detail).toContain('60 minutes');
      expect(sixth.rateLimit?.remaining).toBe(0);
    });

    it('lets the allowance back after the window', async () => {
      const binary = await script('claude', 'echo ok');
      await build({ CLAUDE_CODE_BINARY: binary });

      for (let i = 0; i < 5; i += 1) await probes.run('claude-credential');
      probes.clock += 60 * 60 * 1000;

      await expect(probes.run('claude-credential')).resolves.toMatchObject({
        ok: true,
      });
    });

    it('does not spend the supervisor probe’s allowance', async () => {
      // Two credentials, two budgets. An operator setting up a deployment
      // needs to test both, and a shared bucket would make the second
      // impossible after five attempts at the first.
      const binary = await script('claude', 'echo ok');
      await build({
        CLAUDE_CODE_BINARY: binary,
        SUPERVISOR_MODEL_API_KEY: 'k',
      });

      for (let i = 0; i < 5; i += 1) await probes.run('claude-credential');
      const supervisor = await probes.run('supervisor-model');

      expect(supervisor.skipped).toBe(false);
      expect(supervisor.rateLimit?.remaining).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // supervisor-model
  // -------------------------------------------------------------------------

  describe('supervisor-model', () => {
    it('makes a call and reports what it cost', async () => {
      await build({ SUPERVISOR_MODEL_API_KEY: 'sk-ant-api03-Kx7Vd2Nq9Zb4M' });

      const result = await probes.run('supervisor-model');

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('claude-test answered');
      expect(result.detail).toContain('$0.0002');
    });

    it('reports the adapter’s own refusal when the model name is missing', async () => {
      // The exact case #338 names: a key set with no `SUPERVISOR_MODEL_NAME`
      // leaves the supervisor recording a failure once an hour with nobody
      // watching. It is reported in the adapter's words, not a second opinion.
      await build({ SUPERVISOR_MODEL_API_KEY: 'sk-ant-api03-Kx7Vd2Nq9Zb4M' });
      probes.model = {
        name: 'unconfigured',
        ask: () =>
          Promise.reject(
            new SupervisorModelError(
              'SUPERVISOR_MODEL_API_KEY is set but SUPERVISOR_MODEL_NAME is not, ' +
                'so there is no model to ask.',
            ),
          ),
      };

      const result = await probes.run('supervisor-model');

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('SUPERVISOR_MODEL_NAME is not');
    });

    it('reports an HTTP status when the vendor gave one', async () => {
      await build({ SUPERVISOR_MODEL_API_KEY: 'sk-ant-api03-Kx7Vd2Nq9Zb4M' });
      probes.model = {
        name: 'claude-test',
        ask: () =>
          Promise.reject(
            new SupervisorModelError(
              'The supervisor model returned 401: invalid x-api-key',
              401,
            ),
          ),
      };

      const result = await probes.run('supervisor-model');

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('HTTP 401');
    });

    it('skips without spending an allowance when no key is configured', async () => {
      const result = await probes.run('supervisor-model');

      expect(result).toMatchObject({ ok: false, skipped: true });
      expect(result.rateLimit).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // The rule that holds for all of them
  // -------------------------------------------------------------------------

  it('reports rather than throws when a probe itself blows up', async () => {
    await build({ GITHUB_TOKEN: 'ghp_Kx7Vd2Nq9Zb4Mr6Wt3Jc8Ly5Hs' });
    // No stubbed response, so the seam throws — standing in for a bug.
    const result = await probes.run('github-token');

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('The probe itself failed');
  });

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------

  describe('describeGitHubFailure', () => {
    it('separates a bad credential from one that is merely out of budget', () => {
      expect(describeGitHubFailure(githubFail(401), 'The token')).toContain(
        'expired',
      );
      expect(describeGitHubFailure(githubFail(429), 'The token')).toContain(
        'credential itself is fine',
      );
    });

    it('says a transport failure is not a credential failure', () => {
      const detail = describeGitHubFailure(
        { ok: false, status: 0, body: null, problem: 'getaddrinfo ENOTFOUND' },
        'The token',
      );

      expect(detail).toContain('ENOTFOUND');
      expect(detail).not.toContain('rejected');
    });
  });

  describe('response readers', () => {
    it('reads the core budget, and returns null for a shape it does not know', () => {
      expect(
        readRateLimitCore({ resources: { core: { limit: 5, remaining: 1 } } }),
      ).toEqual({ limit: 5, remaining: 1 });
      expect(readRateLimitCore({ nope: true })).toBeNull();
      expect(readRateLimitCore(null)).toBeNull();
    });

    it('reads push permission, and distinguishes false from absent', () => {
      expect(readPushPermission({ permissions: { push: false } })).toBe(false);
      expect(readPushPermission({ permissions: {} })).toBeNull();
    });
  });
});
