import { Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  SupervisorModelError,
  resolveSupervisorModelConfig,
} from '../../../supervisor/invocation/supervisor-model.config';
import { createSupervisorModel } from '../../../supervisor/invocation/supervisor-model.factory';
import type { SupervisorModel } from '../../../supervisor/invocation/supervisor-model.port';
import { buildChildEnvironment } from '../../../runners/process/child-environment';
import { ChildProcessSupervisor } from '../../../runners/process/child-process-supervisor';
import { probeBinaryVersion } from '../../../runners/process/probe-version';
import {
  describeFailure,
  runCommand,
} from '../../../runners/process/run-command';
import { OperatorSettingsService } from '../operator-settings.service';
import type { ProbeName, ProbeResult } from '../dto/operator-probe.dto';
import {
  ProbeRateLimiter,
  type ProbeRateLimitState,
} from './probe-rate-limiter';

/**
 * The Test buttons: does the thing you configured actually work? (#338)
 *
 * ## The rule every method here follows
 *
 * A probe REPORTS. It never throws, and it never returns a non-2xx. A rejected
 * token, a missing binary and an unauthenticated CLI are facts about a
 * deployment that the operator pressed a button to go and discover — turning
 * one into an exception would put "the probe failed" and "the probe found a
 * failure" behind the same HTTP status, which are the two things this endpoint
 * exists to tell apart. The only thing that produces a 5xx here is a bug.
 *
 * ## Why these read `OperatorSettingsService` and not the injected clients
 *
 * `GitHubHttpService` freezes the token, the base URL, the timeout and the
 * retry count in its constructor from `ConfigService` — which reads
 * `process.env` once at boot and never sees the database overlay at all.
 * Probing through it would test the value that was in the environment when the
 * container started, which is precisely the value the operator has just
 * stopped using. #341 is the issue that makes `GitHubHttpService` resolve per
 * request; until it lands, a probe that answered from the frozen copy would be
 * confidently wrong about the only question being asked. So the HTTP here is a
 * bare `fetch` against the values `OperatorSettingsService` resolves right now,
 * and that is a deliberate, temporary second call path with a stated end date
 * rather than an oversight.
 *
 * ## The seams
 *
 * `fetchJson`, `supervisor`, `createModel` and `now` are `protected` so the
 * spec is a variation on this service rather than a reimplementation of it —
 * the same reason `OperatorSettingsService` exposes `environment()`.
 */
@Injectable()
export class OperatorProbesService {
  private readonly logger = new Logger(OperatorProbesService.name);

  /**
   * One limiter, keyed by probe name, so the two paid probes have independent
   * allowances. Testing the Claude credential must not use up the budget for
   * confirming the supervisor key — they are different credentials and an
   * operator setting up a deployment will want both.
   */
  private readonly rateLimiter = new ProbeRateLimiter();

  constructor(
    private readonly settings: OperatorSettingsService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /**
   * Run one probe.
   *
   * The dispatch is a `switch` over a closed union rather than a lookup table,
   * so adding a probe name without implementing it is a compile error.
   */
  async run(
    probe: ProbeName,
    options: { repositoryId?: string } = {},
  ): Promise<ProbeResult> {
    try {
      switch (probe) {
        case 'github-token':
          return await this.githubToken();
        case 'github-repo':
          return await this.githubRepo(options.repositoryId);
        case 'claude-cli':
          return await this.binaryProbe(
            probe,
            this.settings.get('runners.claudeCodeLocal.binary'),
          );
        case 'git':
          return await this.binaryProbe(
            probe,
            this.settings.get('runners.claudeCodeLocal.gitBinary'),
          );
        case 'claude-credential':
          return await this.claudeCredential();
        case 'supervisor-model':
          return await this.supervisorModel();
      }
    } catch (error) {
      // The backstop for the rule in this class's header. Anything that gets
      // here is a bug in a probe, and the operator is still owed an answer
      // about their credential rather than a 500 that says nothing about it.
      this.logger.error(
        `The ${probe} probe threw instead of reporting: ${message(error)}`,
      );
      return this.result(probe, {
        ok: false,
        detail: `The probe itself failed: ${message(error)}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // GitHub
  // -------------------------------------------------------------------------

  /**
   * `GET /rate_limit`, which every valid token can reach.
   *
   * Chosen over `GET /user` because a fine-grained PAT need not carry any user
   * scope, and over `GET /repos/...` because that answers a different question
   * (`github-repo` asks it). It also costs nothing: GitHub documents
   * `/rate_limit` as not counting against the budget it reports, so the probe
   * for "am I near my limit" cannot itself push you over it.
   */
  private async githubToken(): Promise<ProbeResult> {
    const token = this.settings.get('github.token');
    const baseUrl = this.settings.get('github.apiBaseUrl');

    if (token === '') {
      return this.result('github-token', {
        ok: false,
        skipped: true,
        detail:
          'No GitHub token is configured, so there is nothing to test. Set ' +
          'one above and save before testing.',
      });
    }

    const response = await this.githubGet(baseUrl, '/rate_limit', token);

    if (!response.ok) {
      return this.result('github-token', {
        ok: false,
        detail: describeGitHubFailure(response, 'The token'),
      });
    }

    const core = readRateLimitCore(response.body);
    const where = hostOf(baseUrl);

    return this.result('github-token', {
      ok: true,
      detail:
        core === null
          ? `The token is accepted by ${where}.`
          : `The token is accepted by ${where}. ${core.remaining} of ` +
            `${core.limit} core API requests remain this hour.`,
    });
  }

  /**
   * `GET /repos/{owner}/{name}` for a repository Opifex actually watches.
   *
   * A separate probe from the token, because a fine-grained PAT can be
   * perfectly valid and still not cover THIS repository — and the failure
   * shows up as a 404 rather than a 403, which is GitHub deliberately not
   * confirming a repository exists to a caller who cannot see it. That is
   * indistinguishable from a typo in the owner or name, so the detail says so
   * rather than guessing.
   */
  private async githubRepo(repositoryId?: string): Promise<ProbeResult> {
    const token = this.settings.get('github.token');
    const baseUrl = this.settings.get('github.apiBaseUrl');

    if (token === '') {
      return this.result('github-repo', {
        ok: false,
        skipped: true,
        detail: 'No GitHub token is configured, so there is nothing to test.',
      });
    }

    const repository = await this.pickRepository(repositoryId);

    if (repository === null) {
      return this.result('github-repo', {
        ok: false,
        skipped: true,
        detail:
          repositoryId === undefined
            ? 'No repository is registered yet, so there is nothing to check ' +
              'the token against. Register one under Projects first.'
            : `No registered repository has the id ${repositoryId}.`,
      });
    }

    const slug = `${repository.owner}/${repository.name}`;
    const response = await this.githubGet(
      baseUrl,
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
      token,
    );

    if (response.status === 404) {
      return this.result('github-repo', {
        ok: false,
        detail:
          `${slug} came back 404. GitHub answers 404 rather than 403 for a ` +
          `repository the token cannot see, so this is either a token that ` +
          `does not cover ${slug} or a typo in the owner or name.`,
      });
    }

    if (!response.ok) {
      return this.result('github-repo', {
        ok: false,
        detail: describeGitHubFailure(response, `Reading ${slug}`),
      });
    }

    const permissions = readPushPermission(response.body);

    return this.result('github-repo', {
      ok: true,
      detail:
        permissions === null
          ? `${slug} is readable with this token.`
          : `${slug} is readable with this token, and it ${
              permissions ? 'can' : 'cannot'
            } push.`,
    });
  }

  /** The repository the probe should ask about, or null if there is none. */
  private async pickRepository(
    repositoryId?: string,
  ): Promise<{ owner: string; name: string } | null> {
    if (!this.prisma) return null;

    if (repositoryId !== undefined) {
      return this.prisma.repository.findUnique({
        where: { id: repositoryId },
        select: { owner: true, name: true },
      });
    }

    // The oldest observed repository: whatever the operator registered first
    // is the one they are most likely to be thinking about, and preferring an
    // observed one avoids testing against something deliberately parked.
    return this.prisma.repository.findFirst({
      where: { observeEnabled: true },
      orderBy: { createdAt: 'asc' },
      select: { owner: true, name: true },
    });
  }

  // -------------------------------------------------------------------------
  // Binaries
  // -------------------------------------------------------------------------

  /**
   * `<binary> --version`, and nothing more.
   *
   * What this CANNOT tell you is stated in the detail on success, because it
   * is the whole reason `claude-credential` exists: the CLI answers
   * `--version` happily with no credential at all, so a green tick here says
   * the binary is installed and says nothing whatever about whether a run
   * would authenticate.
   */
  private async binaryProbe(
    probe: ProbeName,
    binary: string,
  ): Promise<ProbeResult> {
    const outcome = await probeBinaryVersion(this.supervisor, binary);

    if (!outcome.ok) {
      return this.result(probe, { ok: false, detail: outcome.detail });
    }

    return this.result(probe, {
      ok: true,
      detail:
        probe === 'claude-cli'
          ? `${outcome.detail}. This says the binary runs; it says nothing ` +
            `about credentials — use Test credential for that.`
          : outcome.detail,
    });
  }

  // -------------------------------------------------------------------------
  // The two that spend
  // -------------------------------------------------------------------------

  /**
   * A minimal non-interactive `claude -p`.
   *
   * THE probe this endpoint exists for. `--version` succeeds without
   * credentials, so an unauthenticated CLI registers as an available runner and
   * fails every dispatch at auth — a deployment that looks configured, reports
   * healthy, and cannot do any work. Nothing short of a real invocation
   * distinguishes the two.
   *
   * The prompt is the shortest thing that still requires the model to answer,
   * and `--print` with `CI=true`/`TERM=dumb` is the same belt-and-braces the
   * runner uses: a CLI that thinks it has a terminal is a CLI that can decide
   * to ask a question, and a question with nobody to answer it is a hang.
   *
   * The credential comes from `OperatorSettingsService`, merged over the
   * allowlisted child environment (#334) — so this tests the token the
   * operator just saved rather than whatever was in the container's
   * environment at boot.
   */
  private async claudeCredential(): Promise<ProbeResult> {
    const gate = this.rateLimiter.consume('claude-credential', this.now());

    if (!gate.allowed) {
      return this.rateLimited('claude-credential', gate.state);
    }

    const binary = this.settings.get('runners.claudeCodeLocal.binary');
    const token = this.settings.get('runners.claudeCodeLocal.oauthToken');

    const result = await runCommand(this.supervisor, {
      command: binary,
      args: ['--print', 'Reply with the single word: ok'],
      cwd: process.cwd(),
      // Generous: a cold CLI start plus one model round trip. Short enough
      // that a wedged probe does not hold a request open indefinitely.
      timeoutMs: 60_000,
      env: buildChildEnvironment({
        // Only when configured. Handing the child an empty string would
        // OVERRIDE an inherited token with nothing and report a working
        // deployment as broken.
        ...(token === '' ? {} : { CLAUDE_CODE_OAUTH_TOKEN: token }),
        CI: 'true',
        TERM: 'dumb',
      }),
    });

    if (!result.ok) {
      return this.result(
        'claude-credential',
        {
          ok: false,
          detail:
            `${binary} --print failed: ${describeFailure(result)}. ` +
            `If this mentions authentication, the CLI has no usable ` +
            `credential — note that it would still answer --version.`,
        },
        gate.state,
      );
    }

    return this.result(
      'claude-credential',
      {
        ok: true,
        detail:
          'The CLI completed a real non-interactive invocation, so its ' +
          'credential works and a dispatched run will authenticate.',
      },
      gate.state,
    );
  }

  /**
   * One minimal Anthropic call through the supervisor's own adapter.
   *
   * Catches the case #338 names: a key that is set while
   * `SUPERVISOR_MODEL_NAME` is not, which leaves the supervisor recording a
   * failure once an hour forever with nobody looking. `AnthropicSupervisorModel
   * .ask()` refuses that combination by name, so the probe reports it in the
   * adapter's own words rather than inventing a second opinion about it.
   *
   * `maxOutputTokens: 4` because the answer is not read for content — the fact
   * that the call was authorised and billed is the entire finding, and one
   * token costs less than the operator's next click.
   */
  private async supervisorModel(): Promise<ProbeResult> {
    // Through `resolveSupervisorModelConfig` rather than a settings key named
    // here (#422). The credential slot is now a function of the provider, and
    // this file sits outside `invocation/` — the one directory allowed to know
    // which vendors exist. Reading it this way also guarantees the probe skips
    // on exactly the key the adapter would have refused on.
    const { apiKey } = resolveSupervisorModelConfig(this.settings);

    if (apiKey === '') {
      return this.result('supervisor-model', {
        ok: false,
        skipped: true,
        detail:
          'No supervisor model API key is configured, so there is nothing ' +
          'to test.',
      });
    }

    const gate = this.rateLimiter.consume('supervisor-model', this.now());

    if (!gate.allowed) {
      return this.rateLimited('supervisor-model', gate.state);
    }

    const model = this.createModel();

    try {
      const answer = await model.ask({
        snapshot: '',
        instruction: 'Reply with the single word: ok.',
        maxOutputTokens: 4,
      });

      const cost =
        answer.costUsd === null
          ? ''
          : ` The call cost $${answer.costUsd.toFixed(4)}.`;

      return this.result(
        'supervisor-model',
        {
          ok: true,
          detail: `${model.name} answered.${cost}`,
        },
        gate.state,
      );
    } catch (error) {
      const status =
        error instanceof SupervisorModelError && error.status !== null
          ? ` (HTTP ${error.status})`
          : '';

      return this.result(
        'supervisor-model',
        { ok: false, detail: `${message(error)}${status}` },
        gate.state,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Seams
  // -------------------------------------------------------------------------

  /** One per service. Spawning is stateless here; the runner's is not. */
  protected readonly supervisor = new ChildProcessSupervisor();

  protected now(): number {
    return Date.now();
  }

  /**
   * The adapter, reading the LIVE settings.
   *
   * Since #344 the adapter takes the resolver itself rather than a snapshot of
   * config values, and resolves each of them per call -- which is what makes a
   * key an operator just typed reachable without a restart. Handing it the
   * same `OperatorSettingsService` the rest of this class reads from is
   * therefore the whole of the wiring: the probe and the supervisor's own
   * invocations cannot disagree about which key is in force, because there is
   * only one place either can read it from.
   *
   * Since #392 it goes through the same factory `SupervisorModule` binds,
   * rather than naming an adapter. That is not tidiness: a probe hard-wired to
   * one vendor would answer "your key works" against a provider the operator
   * did not select, which is a Test button that tests something else.
   */
  protected createModel(): SupervisorModel {
    // The SUPERVISOR's consumer, named explicitly since #425 threaded the
    // consumer through the factory. This probe is reached from the
    // supervisor-model Test button and reports on `supervisor.model.*`; a
    // probe for the chat's four keys is a separate button that does not exist
    // yet, and defaulting the argument would have let it appear to exist while
    // testing the wrong consumer's model name.
    return createSupervisorModel(this.settings, 'supervisor');
  }

  /**
   * One GET against GitHub, reported rather than thrown.
   *
   * `status: 0` marks "never reached the server", which the caller renders as
   * a connectivity problem rather than as a rejected credential — telling an
   * operator their token is bad when the real problem is DNS is the kind of
   * wrong answer that costs an hour.
   */
  protected async githubGet(
    baseUrl: string,
    path: string,
    token: string,
  ): Promise<GitHubProbeResponse> {
    const url = `${baseUrl.replace(/\/$/, '')}${path}`;
    const timeoutMs = this.settings.get('github.requestTimeoutMs');

    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': this.settings.get('github.userAgent'),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A non-JSON body is not itself a failure — the status is the answer.
        body = null;
      }

      return { ok: response.ok, status: response.status, body, problem: null };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: null,
        problem: isAbort(error)
          ? `no answer within ${timeoutMs}ms`
          : message(error),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Result assembly
  // -------------------------------------------------------------------------

  private rateLimited(
    probe: ProbeName,
    state: ProbeRateLimitState,
  ): ProbeResult {
    const minutes = Math.ceil(state.resetSeconds / 60);
    return this.result(
      probe,
      {
        ok: false,
        skipped: true,
        detail:
          `This test spends real quota, so it is limited to ${state.limit} ` +
          `runs per hour. The allowance resets in ${minutes} minute` +
          `${minutes === 1 ? '' : 's'}.`,
      },
      state,
    );
  }

  private result(
    probe: ProbeName,
    outcome: { ok: boolean; detail: string; skipped?: boolean },
    rateLimit?: ProbeRateLimitState,
  ): ProbeResult {
    return {
      probe,
      ok: outcome.ok,
      detail: outcome.detail,
      skipped: outcome.skipped ?? false,
      checkedAt: new Date(this.now()).toISOString(),
      ...(rateLimit ? { rateLimit } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface GitHubProbeResponse {
  readonly ok: boolean;
  /** 0 when the request never reached a server. */
  readonly status: number;
  readonly body: unknown;
  /** The transport failure, when `status` is 0. */
  readonly problem: string | null;
}

/**
 * Why a GitHub call failed, in words an operator can act on.
 *
 * The statuses are separated because the remedies are completely different: a
 * 401 is a bad token, a 403 is a token that is fine but not allowed to do
 * this, and a 429 means the thing works and is simply out of budget — which is
 * emphatically not a failed credential.
 */
export function describeGitHubFailure(
  response: GitHubProbeResponse,
  subject: string,
): string {
  if (response.status === 0) {
    return `${subject} could not be checked: ${response.problem ?? 'the request failed'}.`;
  }

  switch (response.status) {
    case 401:
      return `${subject} was rejected (401). It is wrong, expired, or revoked.`;
    case 403:
      return (
        `${subject} was refused (403). It authenticated, but is not permitted ` +
        `to do this — most often a fine-grained token missing a scope.`
      );
    case 429:
      return (
        `${subject} is rate limited (429). The credential itself is fine; the ` +
        `budget for this hour is spent.`
      );
    default:
      return `${subject} came back ${response.status}.`;
  }
}

/** `{ resources: { core: { limit, remaining } } }`, or null if unrecognised. */
export function readRateLimitCore(
  body: unknown,
): { limit: number; remaining: number } | null {
  const resources = record(body)?.resources;
  const core = record(resources)?.core;
  const limit = record(core)?.limit;
  const remaining = record(core)?.remaining;

  if (typeof limit !== 'number' || typeof remaining !== 'number') return null;

  return { limit, remaining };
}

/** `{ permissions: { push } }`, or null when GitHub did not say. */
export function readPushPermission(body: unknown): boolean | null {
  const push = record(record(body)?.permissions)?.push;
  return typeof push === 'boolean' ? push : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
