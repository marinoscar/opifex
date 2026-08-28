import { Injectable, Logger } from '@nestjs/common';

import { GitHubNotFoundError } from '../github.errors';
import { parseEpicBodyChildren } from './epic-body-children';
import {
  MAX_EPIC_DEPTH,
  issueRef,
  type EpicChild,
  type EpicChildSource,
  type EpicResolution,
  type IssueRef,
  type ResolveEpicChildrenOptions,
  type SkippedRef,
} from './epic-children.types';
import { GitHubReadService, type RepositoryRef } from './github-read.service';
import type { NormalizedIssue } from './github-read.types';

/** One node waiting to be expanded, with its body already in hand. */
interface Frontier {
  repo: RepositoryRef;
  number: number;
  ref: IssueRef;
  body: string | null;
}

/**
 * Resolve a GitHub issue to the set of its child issues (#424).
 *
 * ## Why this exists
 *
 * Opifex does not model epics. There is no parent/child relationship in
 * `schema.prisma` and no epic resolution anywhere in `apps/api/src` — every
 * occurrence of the word is a comment citing an issue number. The feature
 * template has a *Parent epic* field and the epic template has a *Child work*
 * checklist, and until this service nothing read either. So "only work on
 * this epic" had nothing to resolve against.
 *
 * ## Two sources, and why both are needed
 *
 * GitHub's native sub-issues relationship is authoritative and structured, and
 * it WAS verified against this deployment's fine-grained PAT rather than
 * assumed available: the endpoint answers 200 with an ETag for a real issue
 * and 404 for a nonexistent one. It is also, today, completely empty —
 * `sub_issues_summary.total` is 0 on every epic in this repository, because
 * epics here are written as markdown task lists.
 *
 * That finding is what shapes the policy below, and it is the one thing to
 * understand before changing this class:
 *
 *   **An empty native result is not an authoritative empty set.**
 *
 * Treating it as one would resolve every real epic to nothing while looking
 * perfectly correct. So the native source wins when it says ANYTHING, and
 * silence — empty, or a failed call — falls through to the body. Every result
 * records which source answered and, when the native one did not, why; that
 * record is the condition under which a prose fallback is defensible at all,
 * because it is what lets a surprising membership be explained afterwards
 * instead of argued about.
 *
 * As native sub-issues get adopted, epics migrate one at a time with no change
 * here: the first epic given real sub-issues starts answering from the native
 * source on its next resolution.
 *
 * ## What this service deliberately does not do
 *
 * It does not persist anything, and there is no Prisma model behind it. The
 * membership of an epic lives in GitHub and changes there; a stored copy would
 * be a second source of truth that the factory would eventually believe over
 * the first — the mirror-label mistake VISION §3.3 warns about, rebuilt
 * somewhere new. Every result carries `checkedAt` so a caller holds a dated
 * observation rather than a fact.
 */
@Injectable()
export class EpicChildrenService {
  private readonly logger = new Logger(EpicChildrenService.name);

  constructor(private readonly read: GitHubReadService) {}

  /**
   * The child issues of `issueNumber`, from the best source that answers.
   *
   * Throws only if the EPIC itself cannot be read — a caller that names a
   * nonexistent issue has made a mistake worth reporting. Everything below
   * that is degraded honestly: an unreachable child is reported as
   * unreadable, an unusable body yields an empty set, and an issue that is
   * not an epic at all resolves to no children rather than to an error.
   */
  async resolve(
    repo: RepositoryRef,
    issueNumber: number,
    options: ResolveEpicChildrenOptions = {},
  ): Promise<EpicResolution> {
    const checkedAt = new Date();
    const maxDepth = clamp(options.maxDepth ?? 1, 1, MAX_EPIC_DEPTH);

    const epic = await this.read.getIssue(repo, issueNumber);
    const rootRef = issueRef(repo.owner, repo.name, issueNumber);

    const children: EpicChild[] = [];
    const skipped: SkippedRef[] = [];
    const unparsed: { namedBy: IssueRef; item: string }[] = [];

    // Seeded with the epic, which is what makes a self-reference terminate on
    // the first hop instead of on the depth ceiling.
    const seen = new Set<IssueRef>([rootRef]);

    let rootSource: EpicChildSource | 'none' = 'none';
    let nativeUnavailable: string | null = null;

    let frontier: Frontier[] = [
      { repo, number: issueNumber, ref: rootRef, body: epic.body },
    ];

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const next: Frontier[] = [];

      for (const node of frontier) {
        const named = await this.childrenOf(node);

        if (node.ref === rootRef) {
          rootSource = named.refs.length > 0 ? named.source : 'none';
          nativeUnavailable = named.nativeUnavailable;
        }
        for (const item of named.unparsed) {
          unparsed.push({ namedBy: node.ref, item });
        }

        for (const ref of named.refs) {
          if (seen.has(ref.ref)) {
            skipped.push({
              ref: ref.ref,
              namedBy: node.ref,
              reason:
                ref.ref === node.ref
                  ? 'self'
                  : ref.ref === rootRef
                    ? 'cycle'
                    : 'duplicate',
            });
            continue;
          }
          seen.add(ref.ref);

          // Already fetched by the native source; only the body path pays for
          // a hydration request.
          const issue =
            ref.issue ?? (await this.tryGetIssue(ref.repo, ref.number));

          children.push({
            owner: ref.repo.owner,
            name: ref.repo.name,
            number: ref.number,
            ref: ref.ref,
            title: issue?.title ?? null,
            state: issue?.state ?? 'unknown',
            isPullRequest: issue?.isPullRequest ?? false,
            source: named.source,
            depth,
            namedBy: node.ref,
            unreadable: issue === null,
          });

          // A pull request has no child work, and an unreadable issue has no
          // body to read, so neither can be expanded.
          if (depth < maxDepth && issue && !issue.isPullRequest) {
            next.push({
              repo: ref.repo,
              number: ref.number,
              ref: ref.ref,
              body: issue.body,
            });
          }
        }
      }

      frontier = next;
    }

    return {
      epic: {
        owner: repo.owner,
        name: repo.name,
        number: issueNumber,
        ref: rootRef,
        title: epic.title,
      },
      children,
      source: rootSource,
      checkedAt,
      maxDepth,
      skipped,
      nativeUnavailable,
      unparsed,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The references one issue names, native first.
   *
   * The fallback is triggered by SILENCE, not only by failure: an empty native
   * result means the relationship was never populated, which is the state of
   * every epic in this repository. See the class doc.
   */
  private async childrenOf(node: Frontier): Promise<{
    refs: {
      repo: RepositoryRef;
      number: number;
      ref: IssueRef;
      issue?: NormalizedIssue;
    }[];
    source: EpicChildSource;
    nativeUnavailable: string | null;
    unparsed: string[];
  }> {
    let nativeUnavailable: string | null;

    try {
      const subIssues = await this.read.listSubIssues(node.repo, node.number);

      if (subIssues.length > 0) {
        return {
          refs: subIssues.map((issue) => {
            const repo = repoFromIssueUrl(issue.url) ?? node.repo;
            return {
              repo,
              number: issue.number,
              ref: issueRef(repo.owner, repo.name, issue.number),
              issue,
            };
          }),
          source: 'sub-issues-api',
          nativeUnavailable: null,
          unparsed: [],
        };
      }

      nativeUnavailable = 'GitHub records no sub-issues for this issue';
    } catch (error) {
      // A 404 here is the shape a GitHub Enterprise Server or an older tier
      // without the sub-issues endpoint would take, and is indistinguishable
      // from the issue having been deleted between two calls. Either way the
      // body is still readable and still the better answer, so this degrades
      // rather than fails. Anything else — auth, rate limit — propagates,
      // because a resolution built while the budget is exhausted would be
      // quietly incomplete.
      if (!(error instanceof GitHubNotFoundError)) throw error;

      nativeUnavailable = `sub-issues lookup answered 404: ${error.message}`;
      this.logger.warn(
        `Native sub-issues unavailable for ${node.ref}; reading the body instead`,
      );
    }

    const parsed = parseEpicBodyChildren(node.body);

    if (!parsed.sectionFound) {
      nativeUnavailable = `${nativeUnavailable}; the body has no child-work section`;
    }

    return {
      refs: parsed.refs.map((ref) => {
        // A bare `#123` means the epic's own repository — the only thing that
        // knows that is this layer, which is why the parser leaves it null.
        const repo =
          ref.owner && ref.name
            ? { owner: ref.owner, name: ref.name }
            : node.repo;
        return {
          repo,
          number: ref.number,
          ref: issueRef(repo.owner, repo.name, ref.number),
        };
      }),
      source: 'issue-body',
      nativeUnavailable,
      unparsed: parsed.unparsed,
    };
  }

  /**
   * An issue, or null when GitHub says it is not there.
   *
   * Deleted, transferred out of the repository, and private-to-this-token all
   * answer 404 and GitHub does not distinguish them, so neither does this.
   * Null becomes `unreadable: true` on the child rather than removing it from
   * the set — a broken reference is a fact about the epic worth reporting.
   */
  private async tryGetIssue(
    repo: RepositoryRef,
    number: number,
  ): Promise<NormalizedIssue | null> {
    try {
      return await this.read.getIssue(repo, number);
    } catch (error) {
      if (error instanceof GitHubNotFoundError) {
        this.logger.warn(
          `${issueRef(repo.owner, repo.name, number)} could not be read; keeping it in the set as unreadable`,
        );
        return null;
      }
      throw error;
    }
  }
}

/** `https://github.com/owner/name/issues/1` → `{ owner, name }`. */
export function repoFromIssueUrl(url: string): RepositoryRef | null {
  const match = url.match(
    /^https?:\/\/[^/]+\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/\d+/,
  );
  return match ? { owner: match[1], name: match[2] } : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
