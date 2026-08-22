import { Injectable, Logger } from '@nestjs/common';

import { GitHubHttpService } from '../github-http.service';
import { GitHubNotFoundError } from '../github.errors';
import type { RepositoryRef } from '../read/github-read.service';
import { GitHubWriteService, type WriteResult } from '../write/github-write.service';
import { WriteAction } from '../write/reversibility';

/**
 * The ONLY component that may create a git ref, and it may create exactly one
 * kind.
 *
 * ## Why this is not a method on `GitHubWriteService`
 *
 * `reversibility.spec.ts` asserts that the write service's source contains no
 * `/git/refs`, `/branches`, `/actions/`, `/merge` or `/secrets` — backing
 * VISION §8's never-trustable list. ADR-0005 then decided the control plane
 * creates the factory branch, which needs `POST /git/refs`. The two collide.
 *
 * The blanket ban is broader than its own intent. `/git/refs` covers two
 * unlike operations:
 *
 * | Operation | Reversible? |
 * |---|---|
 * | `POST /git/refs` creating `factory/312-a3f91c2-a1` | Yes — delete it, nothing that existed changed |
 * | `PATCH /git/refs/heads/main` with `force` | No — that IS a force-push, and is never-trustable |
 *
 * Rather than loosen a deliberate guard in place, the narrow capability lives
 * here, on its own surface, with its own guards (`git-branch.service.spec.ts`):
 * create-only, `factory/*` only, never `PATCH`, never `force`, never a
 * protected branch. The write service's guarantee stays literally true and its
 * spec keeps passing unchanged — and "which component can create a branch?"
 * has a one-file answer. Revoking the capability later means deleting a
 * module, not untangling a widened regex.
 *
 * It reuses `GitHubWriteService.guardedWrite` deliberately: that is the
 * `GITHUB_WRITES_ENABLED` kill switch and the reversibility classification,
 * and a second write path that bypassed the kill switch would be far worse
 * than sharing this one. What stays out of the write service is the URL, not
 * the accounting.
 */
@Injectable()
export class GitBranchService {
  private readonly logger = new Logger(GitBranchService.name);

  constructor(
    private readonly http: GitHubHttpService,
    private readonly writes: GitHubWriteService,
  ) {}

  /**
   * Create a factory branch whose first and only commit carries one file.
   *
   * Idempotent. If the ref already exists this performs no write and reports
   * the commit already at its tip — which is what makes a re-dispatch safe,
   * and what lets a runner tell "dispatched, nothing done" from "already
   * worked" by comparing that SHA against HEAD (ADR-0005).
   */
  async createFactoryBranch(input: CreateFactoryBranchInput): Promise<CreateFactoryBranchResult> {
    assertFactoryBranch(input.branch);

    const existing = await this.findRef(input.repo, input.branch);
    if (existing) {
      // Reported through `guardedWrite` rather than returned bare, so a
      // no-op branch appears in the diff log exactly like a no-op label.
      const result = await this.writes.guardedWrite(
        WriteAction.CreateFactoryBranch,
        `create ${input.branch} on ${input.repo.owner}/${input.repo.name}`,
        async () => ({ url: null, noop: true }),
      );
      return { write: result, commitSha: existing, created: false };
    }

    let commitSha: string | null = null;

    const write = await this.writes.guardedWrite(
      WriteAction.CreateFactoryBranch,
      `create ${input.branch} on ${input.repo.owner}/${input.repo.name} carrying ${input.path}`,
      async () => {
        commitSha = await this.commitAndPoint(input);
        return {
          url: `https://github.com/${input.repo.owner}/${input.repo.name}/tree/${input.branch}`,
          noop: false,
        };
      },
    );

    return { write, commitSha, created: write.performed };
  }

  /**
   * The four writes, in the only order that works.
   *
   * Read the base commit's tree, add one file to it, commit that tree with the
   * base as parent, then point the new ref at the commit. The ref is created
   * LAST on purpose: until it exists nothing is reachable, so a failure part
   * way through leaves unreferenced objects that git garbage-collects rather
   * than a branch in a half-built state.
   */
  private async commitAndPoint(input: CreateFactoryBranchInput): Promise<string> {
    const base = `/repos/${input.repo.owner}/${input.repo.name}`;

    // The base commit's tree, so the branch carries the repository as it was
    // at the pinned commit plus one file — rather than a branch containing
    // only the record.
    const { data: baseCommit } = await this.http.request<{ tree: { sha: string } }>(
      `${base}/git/commits/${input.baseCommit}`,
    );

    const { data: blob } = await this.http.request<{ sha: string }>(`${base}/git/blobs`, {
      method: 'POST',
      body: { content: input.content, encoding: 'utf-8' },
    });

    const { data: tree } = await this.http.request<{ sha: string }>(`${base}/git/trees`, {
      method: 'POST',
      body: {
        base_tree: baseCommit.tree.sha,
        tree: [{ path: input.path, mode: '100644', type: 'blob', sha: blob.sha }],
      },
    });

    const { data: commit } = await this.http.request<{ sha: string }>(`${base}/git/commits`, {
      method: 'POST',
      body: {
        message: input.commitMessage,
        tree: tree.sha,
        parents: [input.baseCommit],
      },
    });

    await this.http.request(`${base}/git/refs`, {
      method: 'POST',
      // `refs/heads/` spelled here rather than accepted from the caller: a
      // caller that could choose the namespace could write `refs/tags/` or
      // reach outside heads entirely.
      body: { ref: `refs/heads/${input.branch}`, sha: commit.sha },
    });

    this.logger.log(`Created ${input.branch} at ${commit.sha.slice(0, 7)}`);
    return commit.sha;
  }

  /** The commit a branch points at, or null when the branch does not exist. */
  async findRef(repo: RepositoryRef, branch: string): Promise<string | null> {
    assertFactoryBranch(branch);

    try {
      const { data } = await this.http.request<{ object: { sha: string } }>(
        `/repos/${repo.owner}/${repo.name}/git/ref/heads/${branch}`,
      );
      return data.object.sha;
    } catch (error) {
      // A missing branch is the expected case on a first dispatch, not a
      // failure. Anything else propagates.
      if (error instanceof GitHubNotFoundError) return null;
      throw error;
    }
  }
}

export interface CreateFactoryBranchInput {
  repo: RepositoryRef;
  /** Must match `factory/…`. Anything else throws before a request is made. */
  branch: string;
  /** The full 40-character SHA the branch starts from. */
  baseCommit: string;
  /** Path of the single file in the first commit. */
  path: string;
  content: string;
  /** Including the provenance trailers — see `docs/PROVENANCE.md`. */
  commitMessage: string;
}

export interface CreateFactoryBranchResult {
  write: WriteResult;
  /**
   * The first commit's SHA — newly created, or the one already at the tip.
   *
   * Null only when the kill switch suppressed the write, in which case no
   * commit exists to name and reporting one would be a lie.
   */
  commitSha: string | null;
  created: boolean;
}

/** The `factory/` prefix every runner declares in `branchPatterns`. */
export const FACTORY_BRANCH_PREFIX = 'factory/';

/**
 * Refuse anything outside `factory/*`, before a request is made.
 *
 * The whole justification for this service existing is that it can only touch
 * branches Opifex created. A caller passing `main` must fail here rather than
 * at GitHub, where the answer would depend on whether branch protection
 * happened to be configured.
 */
export function assertFactoryBranch(branch: string): void {
  if (!branch.startsWith(FACTORY_BRANCH_PREFIX)) {
    throw new Error(
      `Refusing to touch ${JSON.stringify(branch)}: GitBranchService may only create branches ` +
        `under ${FACTORY_BRANCH_PREFIX}`,
    );
  }
  if (branch.includes('..') || branch.includes(' ')) {
    throw new Error(`Refusing to touch ${JSON.stringify(branch)}: not a valid branch name`);
  }
}
