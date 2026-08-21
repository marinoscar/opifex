import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GitHubHttpService } from '../github-http.service';
import { GitHubNotFoundError } from '../github.errors';
import type { RepositoryRef } from '../read/github-read.service';
import {
  ApprovalRequirement,
  Reversibility,
  WRITE_ACTIONS,
  WriteAction,
  type WriteActionDescriptor,
} from './reversibility';

/** What a write did, or would have done. */
export interface WriteResult {
  action: WriteAction;
  reversibility: Reversibility;
  approval: ApprovalRequirement;
  /** False when the kill switch suppressed it. */
  performed: boolean;
  /** True when the write was already true — a label already present. */
  noop: boolean;
  /** URL of what was created, when the write created something. */
  url: string | null;
  /** One line for the diff log and the VISION §8 digest. */
  description: string;
}

/**
 * Every write Opifex can make to GitHub, and nothing else.
 *
 * ## What is NOT here, and why that is the enforcement
 *
 * VISION §8 hardcodes a never-trustable list: force-push, writes to protected
 * branches, deleting branches or issues or pull requests, merging, credential
 * access, editing CI workflows or the policy table. None of them have an
 * adapter, and that absence IS the guarantee — a check that could be
 * configured wrongly is worse than a method that does not exist, because it
 * has the appearance of a guardrail. VISION §8 says exactly this about the
 * last item on the list.
 *
 * ## The kill switch
 *
 * `GITHUB_WRITES_ENABLED` defaults to **false**. VISION §12 requires the
 * reconciler to observe for a week and record what it *would* have done, and
 * that diff log is the deliverable of the phase, not a debugging aid. With
 * writes off, every method here returns a fully-formed `WriteResult` with
 * `performed: false` — so the calling code path is the real one, exercised for
 * a week, rather than a branch that has never run.
 *
 * ## Reversibility
 *
 * Every result carries its classification (VISION §3.5) so the approval engine
 * in epic #22 consumes a decision made here rather than one guessed later.
 */
@Injectable()
export class GitHubWriteService {
  private readonly logger = new Logger(GitHubWriteService.name);
  private readonly writesEnabled: boolean;

  constructor(
    private readonly http: GitHubHttpService,
    private readonly config: ConfigService,
  ) {
    this.writesEnabled = this.config.get<boolean>('github.writesEnabled') ?? false;

    if (!this.writesEnabled) {
      this.logger.log(
        'GitHub writes are DISABLED (GITHUB_WRITES_ENABLED=false) - writes will be recorded, not performed',
      );
    }
  }

  get enabled(): boolean {
    return this.writesEnabled;
  }

  /**
   * Apply a label to an issue.
   *
   * Idempotent by GitHub's own semantics: the add-labels endpoint accepts a
   * label already present and returns 200. Checking first would cost a request
   * per tick to avoid an error that does not occur.
   */
  async addLabel(
    repo: RepositoryRef,
    issueNumber: number,
    label: string,
  ): Promise<WriteResult> {
    return this.perform(
      WriteAction.AddLabel,
      `Add '${label}' to ${repo.owner}/${repo.name}#${issueNumber}`,
      async () => {
        await this.http.request(`/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/labels`, {
          method: 'POST',
          body: { labels: [label] },
        });
        return { url: null, noop: false };
      },
    );
  }

  /**
   * Remove a label from an issue.
   *
   * GitHub answers 404 when the label is not on the issue. That is the
   * desired end state already holding, not a failure — a reconciler that
   * computes "this label should not be present" and errors because it already
   * is not present would fail every tick after the first.
   */
  async removeLabel(
    repo: RepositoryRef,
    issueNumber: number,
    label: string,
  ): Promise<WriteResult> {
    return this.perform(
      WriteAction.RemoveLabel,
      `Remove '${label}' from ${repo.owner}/${repo.name}#${issueNumber}`,
      async () => {
        try {
          await this.http.request(
            `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
            { method: 'DELETE' },
          );
          return { url: null, noop: false };
        } catch (error) {
          if (isLabelNotPresent(error)) {
            return { url: null, noop: true };
          }
          throw error;
        }
      },
    );
  }

  /**
   * The VISION §4 authorization record: the work order posted to its issue as
   * a fenced JSON comment.
   *
   * Pre-authorized record-writing. Dispatch is required to post this
   * unattended, so gating it behind an approval would make VISION §4 and
   * §3.5 contradict each other — see `ApprovalRequirement`.
   */
  async postAuthorizationRecord(
    repo: RepositoryRef,
    issueNumber: number,
    workOrder: unknown,
  ): Promise<WriteResult> {
    // Fenced with an explicit language tag so the record is machine-extractable
    // from the issue later: VISION §5's whole premise is that the GitHub graph
    // can be traversed, and an unfenced blob of JSON in prose cannot be.
    const body = [
      '<!-- opifex:authorization-record -->',
      '**Work order authorized.**',
      '',
      '```json',
      JSON.stringify(workOrder, null, 2),
      '```',
    ].join('\n');

    return this.postComment(
      WriteAction.PostAuthorizationRecord,
      repo,
      issueNumber,
      body,
      `Authorization record on ${repo.owner}/${repo.name}#${issueNumber}`,
    );
  }

  /**
   * The VISION §5 run summary, posted to the pull request.
   *
   * "Commits and PRs land in GitHub naturally. What the agent did and why it
   * stopped does not — unless deliberately written there." This is the write
   * that closes that gap, which is why it is pre-authorized rather than gated.
   */
  async postRunSummary(
    repo: RepositoryRef,
    pullNumber: number,
    markdown: string,
  ): Promise<WriteResult> {
    // GitHub's issue-comments endpoint is what posts a PR-level (not
    // review-level) comment; a PR is an issue for this purpose.
    return this.postComment(
      WriteAction.PostRunSummary,
      repo,
      pullNumber,
      `<!-- opifex:run-summary -->\n${markdown}`,
      `Run summary on ${repo.owner}/${repo.name}#${pullNumber}`,
    );
  }

  /** Record on the issue that an escalation was raised. */
  async postEscalationNote(
    repo: RepositoryRef,
    issueNumber: number,
    markdown: string,
  ): Promise<WriteResult> {
    return this.postComment(
      WriteAction.PostEscalationNote,
      repo,
      issueNumber,
      `<!-- opifex:escalation -->\n${markdown}`,
      `Escalation note on ${repo.owner}/${repo.name}#${issueNumber}`,
    );
  }

  /**
   * Any other comment.
   *
   * Gated, unlike the three above. A supervisor arguing for a decomposition is
   * an ordinary irreversible action; the carve-out covers the records VISION
   * mandates, not comments in general.
   */
  async postGeneralComment(
    repo: RepositoryRef,
    issueNumber: number,
    markdown: string,
  ): Promise<WriteResult> {
    return this.postComment(
      WriteAction.PostComment,
      repo,
      issueNumber,
      markdown,
      `Comment on ${repo.owner}/${repo.name}#${issueNumber}`,
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private postComment(
    action: WriteAction,
    repo: RepositoryRef,
    issueNumber: number,
    body: string,
    description: string,
  ): Promise<WriteResult> {
    return this.perform(action, description, async () => {
      const { data } = await this.http.request<{ html_url?: string }>(
        `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments`,
        { method: 'POST', body: { body } },
      );
      return { url: data?.html_url ?? null, noop: false };
    });
  }

  /**
   * The one place the kill switch is checked.
   *
   * Every adapter routes through here, so "writes are off" cannot be true for
   * some of them and false for others — and the descriptor is attached in one
   * place rather than by each method remembering to.
   */
  private async perform(
    action: WriteAction,
    description: string,
    execute: () => Promise<{ url: string | null; noop: boolean }>,
  ): Promise<WriteResult> {
    const descriptor: WriteActionDescriptor = WRITE_ACTIONS[action];

    if (!this.writesEnabled) {
      // Not an error and not silence: the diff log IS the deliverable of the
      // observation week (VISION §12), so a suppressed write must produce a
      // record as complete as a performed one.
      this.logger.log(`[writes disabled] would ${description}`);
      return {
        action,
        reversibility: descriptor.reversibility,
        approval: descriptor.approval,
        performed: false,
        noop: false,
        url: null,
        description,
      };
    }

    const { url, noop } = await execute();
    this.logger.log(noop ? `${description} (already true)` : description);

    return {
      action,
      reversibility: descriptor.reversibility,
      approval: descriptor.approval,
      performed: true,
      noop,
      url,
      description,
    };
  }
}

/**
 * GitHub answers a label removal with 404 both when the ISSUE does not exist
 * and when the LABEL is simply not on it, distinguished only by the message:
 * "Label does not exist" versus "Not Found".
 *
 * Treating every 404 here as "already absent" would swallow a wrong issue
 * number in silence, which is exactly the kind of bug a reconciler hides for
 * weeks — so the message is checked, not the status alone.
 */
function isLabelNotPresent(error: unknown): boolean {
  return error instanceof GitHubNotFoundError && /label does not exist/i.test(error.message);
}
