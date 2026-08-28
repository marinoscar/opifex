import { Injectable, Logger } from '@nestjs/common';

import {
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
  GitHubRequestError,
  GitHubTransientError,
} from '../github.errors';
import { GitHubHttpService } from '../github-http.service';
import type { RepositoryRef } from '../read/github-read.service';
import { GitHubReadService } from '../read/github-read.service';
import {
  PROVISIONED_LABELS,
  PROVISIONED_LABEL_NAMES,
  type DeclaredLabel,
  type ProvisionedLabelKind,
} from './label-taxonomy';

/**
 * The ONLY component that may create a label on a repository, and it may
 * create exactly the fifteen the taxonomy declares (#415).
 *
 * ## Why this is not a method on `GitHubWriteService`
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * **It follows `GitBranchService`'s precedent.** That service exists because a
 * blanket guard — `reversibility.spec.ts`'s ban on `/git/refs` — was broader
 * than its own intent, and the answer was a narrow capability on its own
 * surface with its own guards rather than a loosened regex in the general
 * write path. The same applies here: "the control plane may create the label
 * taxonomy on a repository an operator just registered" is a much smaller
 * claim than "the control plane may write labels", and it should be revocable
 * by deleting a module.
 *
 * **It must NOT be gated by `github.writesEnabled`.** `scripts/sync-labels.mjs`
 * states the reason and it is right: that flag governs whether the factory
 * ACTS ON ISSUES DURING A TICK. Creating the taxonomy is operator setup, the
 * same category as registering a repository, and it happens before the loop
 * has anything to say. Gating it on the kill switch would mean VISION §12's
 * observation week could not be set up without turning on the very writes the
 * switch exists to withhold — the operator would have to enable dispatch-era
 * writes in order to observe. An operator clicking Register is not the loop
 * acting, and `label-provisioning.service.spec.ts` pins that: provisioning
 * works with `github.writesEnabled` false.
 *
 * Routing every write through `guardedWrite` would also put fifteen setup
 * writes into the diff log the observation week is reviewed from, drowning the
 * one thing that log is for.
 *
 * ## The guards this surface carries instead
 *
 * 1. **Creates and updates only. It NEVER deletes.** Deleting a label strips
 *    it from every issue carrying it, and that is not recoverable from a
 *    declaration that knows names and colours but not which issues had them.
 *    A label present on GitHub and absent from the taxonomy is left alone and
 *    not even reported as a problem — an unrecognised label is far more likely
 *    to be a human's than a mistake. `label-provisioning.reversibility.spec.ts`
 *    asserts this against the source, the way `reversibility.spec.ts` does for
 *    the write service, because the failure being guarded is somebody ADDING
 *    a delete and no behavioural test can see that.
 * 2. **Only the declared taxonomy.** `assertDeclaredLabel` refuses any name
 *    that is not in `PROVISIONED_LABELS`, before a request is made. The whole
 *    justification for this service is that it can only create labels Opifex
 *    itself defined; a caller passing `wontfix` must fail here rather than at
 *    GitHub, where it would succeed.
 * 3. **It reports; it does not throw.** `POST /api/repositories` must still
 *    register a repository whose provisioning was refused. ADR-0001's
 *    fine-grained PAT grants access one repository at a time, and "can read
 *    this repo" does not imply `issues: write` on it — a fine-grained token
 *    emits no `x-oauth-scopes` header, so this is genuinely unknowable before
 *    the attempt. A repository that looks registered and cannot be labelled is
 *    the "configured is not effective" trap epic #332 exists to stop
 *    repeating, so the failure is reported in the response rather than thrown.
 *
 * ## Idempotence
 *
 * Every call reads the repository's labels first and writes only the
 * difference. A second run creates nothing, updates nothing and reports `ok`.
 * A label whose colour or description has drifted IS updated, because the
 * description is the only place the input/mirror distinction is written where
 * an operator will read it, and the palette is the visual half of the `:` vs
 * `/` guarantee.
 */
@Injectable()
export class LabelProvisioningService {
  private readonly logger = new Logger(LabelProvisioningService.name);

  constructor(
    private readonly http: GitHubHttpService,
    private readonly github: GitHubReadService,
  ) {}

  /**
   * What the repository has, without writing anything.
   *
   * The observation the ladder renders: "N of M labels present", as of
   * `checkedAt`. Per-label, not just a count, so the UI can name what is
   * missing rather than leaving an operator to work it out.
   */
  async inspect(repo: RepositoryRef): Promise<LabelProvisioningReport> {
    return this.run(repo, false);
  }

  /**
   * Create what is missing and update what has drifted. Never delete.
   *
   * Safe to call on an already-correct repository: it reads first, so a second
   * run performs no writes at all and answers `ok` with `created: 0`.
   */
  async provision(repo: RepositoryRef): Promise<LabelProvisioningReport> {
    return this.run(repo, true);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async run(
    repo: RepositoryRef,
    apply: boolean,
  ): Promise<LabelProvisioningReport> {
    const fullName = `${repo.owner}/${repo.name}`;

    // Checked before anything is asked of GitHub, so "nothing is configured
    // yet" never arrives dressed as a rejected credential — two findings with
    // nothing in common but their HTTP status.
    if (!this.github.credentialConfigured) {
      return this.answer(
        fullName,
        apply,
        'no_credential',
        [],
        [
          'No GitHub credential is configured, so the factory labels could not',
          'be checked or created. Set `github.token` to a fine-grained personal',
          'access token with Issues write access to this repository, then repair',
          'the labels.',
        ],
      );
    }

    let existing: Map<string, { color: string; description: string }>;
    try {
      const labels = await this.github.listRepositoryLabels(repo);
      existing = new Map(
        labels.map((label) => [
          label.name,
          {
            color: (label.color ?? '').toLowerCase(),
            description: label.description ?? '',
          },
        ]),
      );
    } catch (error) {
      return this.describeFailure(fullName, apply, [], error, 'read');
    }

    const states = PROVISIONED_LABELS.map((declared) =>
      compare(declared, existing.get(declared.name)),
    );

    if (!apply) {
      return this.summarise(fullName, false, states);
    }

    for (const state of states) {
      if (state.state === 'present') continue;

      const declared = byName(state.name);
      try {
        if (state.state === 'missing') {
          await this.createLabel(repo, declared);
          state.action = 'created';
        } else {
          await this.updateLabel(repo, declared);
          state.action = 'updated';
        }
      } catch (error) {
        // A 4xx GitHub raised about THIS LABEL — an over-long description, a
        // name it will not accept — is a per-label failure, and the run
        // continues. Stopping on the first one is what produced the
        // half-applied taxonomy in #197, and it leaves the remainder
        // unapplied with nothing but the next drift report to say so.
        if (error instanceof GitHubRequestError) {
          state.action = 'failed';
          state.detail = error.message;
          continue;
        }
        // Everything else — a refused credential, a repository that is gone,
        // an exhausted budget, a network that is down — is about the
        // REPOSITORY, not this label. The next fourteen attempts would spend
        // fourteen requests to be told the same thing.
        return this.describeFailure(fullName, apply, states, error, 'write');
      }
    }

    const report = this.summarise(fullName, true, states);
    this.logger.log(
      `Provisioned factory labels on ${fullName}: ` +
        `${report.created} created, ${report.updated} updated, ` +
        `${report.unchanged} already correct, ${report.failed} failed`,
    );
    return report;
  }

  /**
   * `POST /repos/{owner}/{name}/labels`.
   *
   * The ONE creating request this service makes. Guarded by name, before the
   * request, so the URL can never carry something outside the taxonomy.
   */
  private async createLabel(
    repo: RepositoryRef,
    label: DeclaredLabel,
  ): Promise<void> {
    assertDeclaredLabel(label.name);

    await this.http.request(`/repos/${repo.owner}/${repo.name}/labels`, {
      method: 'POST',
      body: {
        name: label.name,
        color: label.color,
        description: label.description,
      },
    });
  }

  /**
   * `PATCH /repos/{owner}/{name}/labels/{name}`.
   *
   * Colour and description only. `new_name` is deliberately not sent: renaming
   * a label is a different operation with different consequences — it moves
   * every issue's label with it — and this service has no reason to want it.
   */
  private async updateLabel(
    repo: RepositoryRef,
    label: DeclaredLabel,
  ): Promise<void> {
    assertDeclaredLabel(label.name);

    await this.http.request(
      `/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
      {
        method: 'PATCH',
        body: { color: label.color, description: label.description },
      },
    );
  }

  // -------------------------------------------------------------------------
  // Failure, told apart
  // -------------------------------------------------------------------------

  /**
   * Why it failed, in words naming a remedy.
   *
   * The same arms `AvailableRepositoriesService` uses, and for the same test:
   * each one is a DIFFERENT remedy. `refused` is separated from
   * `invalid_credential` because the fix is the token's permissions, not the
   * token — and that is the single most likely failure here, since ADR-0001's
   * fine-grained PAT can perfectly well read a repository it cannot write
   * labels to.
   */
  private describeFailure(
    fullName: string,
    apply: boolean,
    states: LabelState[],
    error: unknown,
    phase: 'read' | 'write',
  ): LabelProvisioningReport {
    // Already redacted: `GitHubHttpService` takes the configured token out of
    // every error message it builds, which ADR-0001 makes the only layer that
    // can. This line logs and the sentence below is rendered.
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Label ${phase} on ${fullName} failed: ${message}`);

    const doing =
      phase === 'read'
        ? 'The repository labels could not be read'
        : 'The factory labels could not be created';

    if (error instanceof GitHubRateLimitError) {
      return this.answer(fullName, apply, 'rate_limited', states, [
        `${doing}: GitHub's rate limit is exhausted until`,
        `${error.resetAt.toISOString()}. The credential is fine — ADR-0001`,
        "notes that Opifex shares the operator's own hourly budget, so this",
        'can equally be caused by something other than Opifex. Repair the',
        'labels again after the reset.',
      ]);
    }

    if (error instanceof GitHubAuthError) {
      // `status === null` is the "no credential configured" throw. Reachable
      // despite the check at the top, because `github.token` is resolved per
      // request and can be cleared between the two.
      if (error.status === null) {
        return this.answer(fullName, apply, 'no_credential', states, [
          'No GitHub credential is configured, so the factory labels could',
          'not be checked or created.',
        ]);
      }

      if (error.status === 403) {
        return this.answer(fullName, apply, 'refused', states, [
          `${doing}: GitHub accepted the credential and refused the request`,
          `(403). ${message} The token authenticates; it is not permitted to`,
          `do this on ${fullName}. ADR-0001 uses a FINE-GRAINED personal`,
          'access token, which grants access one repository at a time and',
          'per permission — read access does not imply Issues write access.',
          'Grant this repository Issues: Read and write, then repair the',
          'labels. The repository stays registered meanwhile; it simply',
          'cannot be steered until `factory:ready` exists on it.',
        ]);
      }

      return this.answer(fullName, apply, 'invalid_credential', states, [
        `${doing}: GitHub rejected the credential (${error.status}).`,
        `${message} The token is wrong, revoked, or expired — ADR-0001 notes`,
        'that a fine-grained token expires on a fixed date and then fails',
        'exactly like this.',
      ]);
    }

    if (error instanceof GitHubNotFoundError) {
      return this.answer(fullName, apply, 'not_found', states, [
        `${doing}: GitHub answered 404 for ${fullName}. It does not exist, it`,
        'was renamed, or the configured token can no longer see it — GitHub',
        'gives the same answer for all three.',
      ]);
    }

    if (error instanceof GitHubTransientError) {
      return this.answer(fullName, apply, 'unreachable', states, [
        `${doing}: GitHub could not be reached. ${message} The request never`,
        'got a usable answer, so this says nothing about the credential —',
        'check the network, the proxy, and `github.apiBaseUrl`.',
      ]);
    }

    return this.answer(fullName, apply, 'failed', states, [
      `${doing}: ${message}`,
    ]);
  }

  // -------------------------------------------------------------------------
  // Assembly
  // -------------------------------------------------------------------------

  /** Overridable seam, so `checkedAt` is assertable. */
  protected now(): number {
    return Date.now();
  }

  /** The success and partial-success answers, counted from the states. */
  private summarise(
    fullName: string,
    applied: boolean,
    states: LabelState[],
  ): LabelProvisioningReport {
    const missing = states.filter((s) => s.state === 'missing');
    const drifted = states.filter((s) => s.state === 'drifted');
    const failed = states.filter((s) => s.action === 'failed');

    if (missing.length === 0 && drifted.length === 0) {
      return this.answer(fullName, applied, 'ok', states, [
        `All ${states.length} factory labels are present on ${fullName} and`,
        'match the declared taxonomy.',
      ]);
    }

    if (!applied) {
      return this.answer(fullName, applied, 'incomplete', states, [
        `${states.length - missing.length} of ${states.length} factory labels`,
        `exist on ${fullName}: ${missing.length} missing,`,
        `${drifted.length} out of date. An issue cannot be marked ready with a`,
        'label that does not exist, so repair them before steering this',
        'repository.',
      ]);
    }

    if (failed.length === 0) {
      // Every outstanding label was written. `state` still records what was
      // found BEFORE the call — that is the observation, and overwriting it
      // would erase the only record that anything was done — so this branch
      // reads `action` rather than re-deriving from `state`.
      return this.answer(fullName, applied, 'ok', states, [
        `All ${states.length} factory labels are present on ${fullName} and`,
        'match the declared taxonomy.',
      ]);
    }

    return this.answer(fullName, applied, 'incomplete', states, [
      `${failed.length} of ${states.length} factory labels could not be`,
      `written on ${fullName}: ${failed.map((s) => s.name).join(', ')}.`,
      `First reason: ${failed[0].detail ?? 'unknown'}`,
    ]);
  }

  private answer(
    repository: string,
    applied: boolean,
    status: LabelProvisioningStatus,
    states: LabelState[],
    detail: readonly string[],
  ): LabelProvisioningReport {
    const created = states.filter((s) => s.action === 'created').length;
    const updated = states.filter((s) => s.action === 'updated').length;
    const failed = states.filter((s) => s.action === 'failed').length;
    // Present on GitHub right now: everything that was already there, plus
    // everything this call just created.
    const present = states.filter(
      (s) => s.state !== 'missing' || s.action === 'created',
    ).length;

    return {
      repository,
      ok: status === 'ok',
      status,
      applied,
      detail: detail.join(' '),
      checkedAt: new Date(this.now()).toISOString(),
      declared: PROVISIONED_LABELS.length,
      present,
      missing: PROVISIONED_LABELS.length - present,
      created,
      updated,
      unchanged: states.filter((s) => s.state === 'present').length,
      failed,
      labels: states,
    };
  }
}

// ---------------------------------------------------------------------------
// Guards and pure helpers
// ---------------------------------------------------------------------------

/**
 * Refuse anything outside the declared taxonomy, before a request is made.
 *
 * The whole justification for this service existing is that it can only create
 * labels Opifex itself defined. A caller passing `wontfix` must fail HERE
 * rather than at GitHub, where it would quietly succeed and leave a label in
 * somebody's repository that nothing in this codebase can account for.
 */
export function assertDeclaredLabel(name: string): void {
  if (!PROVISIONED_LABEL_NAMES.has(name)) {
    throw new Error(
      `Refusing to touch ${JSON.stringify(name)}: LabelProvisioningService may only create ` +
        'labels declared in PROVISIONED_LABELS',
    );
  }
}

/** What was found on GitHub, and what this call did about it. */
function compare(
  declared: DeclaredLabel,
  actual: { color: string; description: string } | undefined,
): LabelState {
  if (!actual) {
    return {
      name: declared.name,
      kind: declared.kind,
      state: 'missing',
      action: 'none',
      differences: [],
      detail: null,
    };
  }

  const differences: string[] = [];
  if (actual.color !== declared.color) {
    differences.push(`color ${actual.color} -> ${declared.color}`);
  }
  if (actual.description !== declared.description) {
    // A description that has moved is a label whose MEANING has moved, which
    // matters more here than colour: it is the only place the input/mirror
    // distinction is written down where an operator will read it.
    differences.push('description');
  }

  return {
    name: declared.name,
    kind: declared.kind,
    state: differences.length === 0 ? 'present' : 'drifted',
    action: 'none',
    differences,
    detail: null,
  };
}

function byName(name: string): DeclaredLabel {
  const declared = PROVISIONED_LABELS.find((label) => label.name === name);
  if (!declared) {
    // Unreachable: every state is built from `PROVISIONED_LABELS`. Thrown
    // rather than defaulted, because a silent fallback here would be a label
    // written with somebody else's colour.
    throw new Error(`${name} is not a declared label`);
  }
  return declared;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Why the report says what it says.
 *
 * Each arm names a different remedy, which is the test for whether it earns
 * its place — the rule `AVAILABLE_REPOSITORY_STATUSES` already states.
 */
export const LABEL_PROVISIONING_STATUSES = [
  /** Every declared label is present and matches. Nothing to do. */
  'ok',
  /** Read succeeded; labels are missing or out of date, or a write failed. */
  'incomplete',
  /** No `github.token` is configured. Nothing was attempted. */
  'no_credential',
  /** GitHub rejected the credential (401). Remedy: a different token. */
  'invalid_credential',
  /**
   * Authenticated and refused (403). Remedy: the token's PERMISSIONS, not the
   * token. The likeliest failure here, and the one #415 exists to report:
   * a fine-grained PAT that can read a repository need not be able to write
   * its labels, and there is no way to know before trying.
   */
  'refused',
  /** GitHub answered 404: gone, renamed, or no longer visible to this token. */
  'not_found',
  /** The hourly budget is spent. Remedy: wait; `detail` says until when. */
  'rate_limited',
  /** Nothing answered, or GitHub answered 5xx. Says NOTHING about the token. */
  'unreachable',
  /** Anything else, with GitHub's own words in `detail`. */
  'failed',
] as const;

export type LabelProvisioningStatus =
  (typeof LABEL_PROVISIONING_STATUSES)[number];

/** What was found on GitHub for one declared label, before this call. */
export const LABEL_STATES = ['present', 'missing', 'drifted'] as const;

export type LabelStateName = (typeof LABEL_STATES)[number];

/**
 * What this call did about one declared label.
 *
 * There is no `deleted`, and there never will be — see the service header.
 */
export const LABEL_ACTIONS = ['none', 'created', 'updated', 'failed'] as const;

export type LabelActionName = (typeof LABEL_ACTIONS)[number];

/** One declared label, as found and as acted on. */
export interface LabelState {
  readonly name: string;
  readonly kind: ProvisionedLabelKind;
  /** What GitHub had before this call. */
  state: LabelStateName;
  /** `none` for an inspection, and for a label that needed nothing. */
  action: LabelActionName;
  /** For `drifted`: what differs, in the drift report's wording. */
  readonly differences: string[];
  /** Why the write failed, when `action` is `failed`. Else null. */
  detail: string | null;
}

/**
 * The whole answer. One shape, whatever happened.
 *
 * A failure is carried HERE rather than thrown, because "the request failed"
 * and "the request found a failure" are the two things a registration must
 * tell apart: a repository whose labels were refused is still registered, and
 * the operator needs to be told which of the two happened.
 */
export interface LabelProvisioningReport {
  /** `owner/name`, so a consumer never has to reassemble it. */
  readonly repository: string;
  /** True only when every declared label is present and matches. */
  readonly ok: boolean;
  readonly status: LabelProvisioningStatus;
  /** True when this call attempted writes; false for an inspection. */
  readonly applied: boolean;
  /** One human sentence, safe to render. Never contains the token. */
  readonly detail: string;
  readonly checkedAt: string;
  /** How many labels the taxonomy declares — the M in "N of M". */
  readonly declared: number;
  /** How many exist on GitHub as of now — the N. */
  readonly present: number;
  readonly missing: number;
  readonly created: number;
  readonly updated: number;
  /** Already present and already correct. A no-op, reported as one. */
  readonly unchanged: number;
  readonly failed: number;
  /**
   * Per-label state, so the UI can NAME what is missing rather than showing a
   * count and leaving the operator to work it out. Empty when the repository's
   * labels could not be read at all.
   */
  readonly labels: readonly LabelState[];
}
