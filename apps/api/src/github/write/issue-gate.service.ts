import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { GitHubHttpService } from '../github-http.service';
import { GitHubReadService, type RepositoryRef } from '../read/github-read.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubWriteService, type WriteResult } from './github-write.service';
import { checkConformance, type ConformanceFailure } from './issue-conformance';
import {
  DUPLICATE_THRESHOLD,
  similarity,
} from './issue-similarity';
import { ISSUE_TEMPLATES, type IssueKind } from './issue-templates';
import { WriteAction } from './reversibility';

export interface IssueCandidate {
  kind: IssueKind;
  title: string;
  /** Markdown, with the template's section headings. */
  body: string;
  /** Extra labels beyond the template's own. */
  labels?: string[];
  /** What proposed this — a supervisor class, a decomposition. For the record. */
  proposedBy: string;
}

export type GateRefusal =
  | { reason: 'template'; failures: ConformanceFailure[] }
  | { reason: 'duplicate'; issueNumber: number; score: number; title: string };

export type GateOutcome =
  | { accepted: true; result: WriteResult; issueNumber: number | null }
  | { accepted: false; refusal: GateRefusal };

/**
 * The ONLY path by which any Opifex-driven process opens a GitHub issue.
 *
 * VISION §5, "issue creation is gated":
 *
 * > The failure mode that destroys agent-driven traceability is volume: every
 * > run opens issues, four hundred accumulate, and traceability inverts into
 * > noise. Agents comment freely. Creating an issue requires passing a dedupe
 * > check against open issues and conforming to a template. Cheap to enforce;
 * > saves the entire premise.
 *
 * ## Why this exists before anything needs it
 *
 * #24's templates gate the GitHub web UI — humans — not API-created issues.
 * #42's write adapters deliberately include no issue-creation adapter, which
 * is correct but means the first feature that needs one (a supervisor
 * decomposition proposal, #110) would bolt it on without the gate. The gate
 * existing first is what makes that impossible rather than merely discouraged:
 * there is no ungated path to add to.
 *
 * ## Refusals are recorded, not just returned
 *
 * #108: "an agent repeatedly proposing duplicate issues is itself a signal."
 * A refusal that only travels back to the caller is invisible to the operator,
 * and a proposer stuck in a loop is exactly what the digest (VISION §8) should
 * surface. Both outcomes land in `audit_events`.
 */
@Injectable()
export class GitHubIssueGateService {
  private readonly logger = new Logger(GitHubIssueGateService.name);

  constructor(
    private readonly http: GitHubHttpService,
    private readonly read: GitHubReadService,
    private readonly writes: GitHubWriteService,
    private readonly prisma: PrismaService,
  ) {}

  async createIssue(repo: RepositoryRef, candidate: IssueCandidate): Promise<GateOutcome> {
    const template = ISSUE_TEMPLATES[candidate.kind];

    // Conformance first: it costs nothing, while the dedupe check reads every
    // open issue in the repository. Refusing a malformed candidate before
    // spending that budget is the difference between a cheap gate and one an
    // operator turns off.
    const failures = checkConformance(candidate.kind, candidate.body, template);
    if (failures.length > 0) {
      const refusal: GateRefusal = { reason: 'template', failures };
      await this.record(repo, candidate, refusal);
      return { accepted: false, refusal };
    }

    const duplicate = await this.findDuplicate(repo, candidate);
    if (duplicate) {
      await this.record(repo, candidate, duplicate);
      return { accepted: false, refusal: duplicate };
    }

    const labels = [...new Set([...template.labels, ...(candidate.labels ?? [])])];

    // The single POST to an issues endpoint in the entire codebase. Routed
    // through `guardedWrite` so the VISION §12 kill switch applies here too:
    // during the observation week a passing candidate is recorded as "would
    // have opened", not opened.
    let issueNumber: number | null = null;
    const result = await this.writes.guardedWrite(
      WriteAction.CreateIssue,
      `Open a ${candidate.kind} issue in ${repo.owner}/${repo.name}: ${candidate.title}`,
      async () => {
        const { data } = await this.http.request<{ number?: number; html_url?: string }>(
          `/repos/${repo.owner}/${repo.name}/issues`,
          {
            method: 'POST',
            body: { title: candidate.title, body: candidate.body, labels },
          },
        );
        issueNumber = data?.number ?? null;
        return { url: data?.html_url ?? null, noop: false };
      },
    );

    await this.record(repo, candidate, null, issueNumber);
    return { accepted: true, result, issueNumber };
  }

  /**
   * The nearest open issue, if it is near enough to refuse.
   *
   * Only OPEN issues. A closed duplicate is not noise — reopening the
   * conversation on something already decided is a different problem, and
   * refusing against closed issues would make a genuinely recurring bug
   * unreportable.
   */
  private async findDuplicate(
    repo: RepositoryRef,
    candidate: IssueCandidate,
  ): Promise<Extract<GateRefusal, { reason: 'duplicate' }> | null> {
    const { issues } = await this.read.listIssues(repo, { state: 'open' });

    let best: { issueNumber: number; score: number; title: string } | null = null;
    for (const issue of issues) {
      const score = similarity(candidate, { title: issue.title, body: issue.body ?? '' });
      if (!best || score > best.score) {
        best = { issueNumber: issue.number, score, title: issue.title };
      }
    }

    if (best && best.score >= DUPLICATE_THRESHOLD) {
      return { reason: 'duplicate', ...best };
    }
    return null;
  }

  /**
   * Record the outcome.
   *
   * `audit_events` rather than a table of its own: the row this needs is
   * exactly what that table models (actor, action, target, JSON detail), it is
   * already indexed by target and time, and a new table would need a migration
   * to store nothing the existing one cannot.
   *
   * `actorUserId` is null on purpose — the actor is a control-plane process,
   * not a user, and inventing a service user to satisfy the column would make
   * an automated refusal indistinguishable from one a human caused.
   */
  private async record(
    repo: RepositoryRef,
    candidate: IssueCandidate,
    refusal: GateRefusal | null,
    issueNumber?: number | null,
  ): Promise<void> {
    const action = refusal ? 'issue_creation.refused' : 'issue_creation.accepted';

    if (refusal) {
      this.logger.warn(
        `Refused a ${candidate.kind} issue for ${repo.owner}/${repo.name} from ${candidate.proposedBy}: ` +
          (refusal.reason === 'duplicate'
            ? `near-duplicate of #${refusal.issueNumber} (${refusal.score.toFixed(2)})`
            : refusal.failures.map((f) => `${f.reason}:${f.section}`).join(', ')),
      );
    }

    // Round-tripped through JSON rather than cast: `GateRefusal` is a
    // discriminated union of object types, which Prisma's `InputJsonValue`
    // cannot accept structurally even though every value in it is valid JSON.
    // Serialising is what makes the column's contract — "this is JSON" — true
    // at the boundary instead of asserted past the type system.
    const meta: Prisma.InputJsonValue = JSON.parse(
      JSON.stringify({
        kind: candidate.kind,
        title: candidate.title,
        proposedBy: candidate.proposedBy,
        ...(refusal ? { refusal } : {}),
        ...(issueNumber !== undefined ? { issueNumber } : {}),
      }),
    ) as Prisma.InputJsonValue;

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: null,
        action,
        targetType: 'repository',
        targetId: `${repo.owner}/${repo.name}`,
        meta,
      },
    });
  }
}
