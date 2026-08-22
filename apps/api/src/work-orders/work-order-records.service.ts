import { Injectable, Logger } from '@nestjs/common';

import { GitBranchService } from '../github/git/git-branch.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { GitHubWriteService, type WriteResult } from '../github/write/github-write.service';
import {
  EXECUTION_RECORD_PATH,
  executionRecordCommitMessage,
  serializeWorkOrder,
} from './work-order-document';
import type { GeneratedWorkOrder } from './work-order-generator';

/**
 * The marker that identifies an authorization record among a thousand comments.
 *
 * Matched on the HTML comment rather than on the JSON body, because the body
 * changes if a field is ever reordered and the marker does not. VISION §5
 * warns that issue-comment volume is how agent-driven traceability inverts
 * into noise — a second authorization comment on every tick would be exactly
 * that, so this string is what stands between the design and the failure.
 */
export const AUTHORIZATION_MARKER = '<!-- opifex:authorization-record -->';

export interface RecordsResult {
  /** The one serialization both records carry. */
  document: string;
  authorization: WriteResult;
  execution: WriteResult;
  /** The execution record's commit SHA, or null if writes are disabled. */
  executionCommitSha: string | null;
  /** True when both records already existed and nothing was written. */
  alreadyRecorded: boolean;
}

/**
 * Writes the two records VISION §4 requires, once each.
 *
 * > The work order is posted to the issue as a fenced JSON comment (the
 * > *authorization record*) and committed to the branch as its first commit
 * > (the *execution record*).
 *
 * The authorization record proves what was approved; the execution record
 * proves what the runner was actually given. #63: keeping both is what makes
 * *"the agent did something I did not ask for"* a checkable claim rather than
 * an argument.
 *
 * Both writes are idempotent, and that is not a nicety. A reconciler
 * re-derives its conclusions every tick, so a re-dispatch of the same work
 * order is ordinary rather than exceptional — and a version of this that
 * posted on each pass would bury the issue.
 */
@Injectable()
export class WorkOrderRecordsService {
  private readonly logger = new Logger(WorkOrderRecordsService.name);

  constructor(
    private readonly reads: GitHubReadService,
    private readonly writes: GitHubWriteService,
    private readonly branches: GitBranchService,
  ) {}

  async write(input: WriteRecordsInput): Promise<RecordsResult> {
    const { workOrder } = input;
    const repo = { owner: workOrder.repositoryOwner, name: workOrder.repositoryName };

    // ONE serialization. Both records carry these exact bytes, which is what
    // makes "verifiably identical" structural rather than a property somebody
    // has to keep testing.
    const document = serializeWorkOrder(workOrder);

    const authorization = await this.writeAuthorization(repo, workOrder, document);

    const execution = await this.branches.createFactoryBranch({
      repo,
      branch: workOrder.branch,
      baseCommit: workOrder.baseCommit,
      path: EXECUTION_RECORD_PATH,
      content: document,
      commitMessage: executionRecordCommitMessage({
        workOrder,
        runnerKey: input.runnerKey,
        runnerVersion: input.runnerVersion,
        runId: input.runId,
      }),
    });

    return {
      document,
      authorization,
      execution: execution.write,
      executionCommitSha: execution.commitSha,
      alreadyRecorded: authorization.noop && execution.write.noop,
    };
  }

  /**
   * Post the authorization record, unless this work order already has one.
   *
   * Scoped to the IDENTITY rather than to the issue: an issue re-dispatched at
   * a new base commit is a different work order and deserves its own
   * authorization, while the same work order re-reaching this code must not
   * post twice. Matching on the marker alone would suppress the first case;
   * matching on the whole body would fail the second the moment formatting
   * changed.
   */
  private async writeAuthorization(
    repo: { owner: string; name: string },
    workOrder: GeneratedWorkOrder,
    document: string,
  ): Promise<WriteResult> {
    const existing = await this.findAuthorization(repo, workOrder);

    if (existing) {
      this.logger.log(
        `Authorization record for ${workOrder.identity} already on ` +
          `${repo.owner}/${repo.name}#${workOrder.issueNumber}`,
      );
      return this.writes.guardedWrite(
        // Reported as a no-op rather than skipped silently: the diff log is
        // the deliverable of the observation week, and a write that did not
        // happen because it was already true is a different fact from one
        // that was never attempted.
        existing.action,
        `post the authorization record for ${workOrder.identity}`,
        async () => ({ url: existing.url, noop: true }),
      );
    }

    return this.writes.postAuthorizationRecord(
      repo,
      workOrder.issueNumber,
      JSON.parse(document) as unknown,
    );
  }

  /** The existing authorization comment for THIS work order, if any. */
  private async findAuthorization(
    repo: { owner: string; name: string },
    workOrder: GeneratedWorkOrder,
  ): Promise<{ url: string; action: WriteResult['action'] } | null> {
    const comments = await this.reads.listIssueComments(repo, workOrder.issueNumber);

    const match = comments.find(
      (comment) =>
        comment.body.includes(AUTHORIZATION_MARKER) &&
        // The identity appears inside the fenced JSON. Substring rather than a
        // parse: a comment somebody edited into invalid JSON should still
        // count as "already posted", because posting a second one would not
        // fix it.
        comment.body.includes(workOrder.identity),
    );

    if (!match) return null;
    return { url: match.url, action: 'comment.authorization-record' as WriteResult['action'] };
  }
}

export interface WriteRecordsInput {
  workOrder: GeneratedWorkOrder;
  /** Known by dispatch time: routing chooses a runner before submitting. */
  runnerKey: string;
  runnerVersion: string;
  /** The `Run` row's id, created before dispatch (#60, #63). */
  runId: string;
}
