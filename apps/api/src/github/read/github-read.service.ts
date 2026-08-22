import { Injectable, Logger } from '@nestjs/common';

import { GitHubHttpService } from '../github-http.service';
import {
  isInputLabel,
  isMirrorLabel,
  isUnknownInputLabel,
  type InputLabel,
} from '../labels/factory-labels';
import type {
  NormalizedCheck,
  NormalizedComment,
  NormalizedCommit,
  NormalizedIssue,
  NormalizedLabel,
  NormalizedLabelEvent,
  NormalizedPullRequest,
} from './github-read.types';

export interface RepositoryRef {
  owner: string;
  name: string;
}

export interface ListIssuesOptions {
  state?: 'open' | 'closed' | 'all';
  /** Only issues updated since this instant — the reconciler's cheap sweep. */
  since?: Date;
  labels?: string[];
  maxPages?: number;
}

/**
 * Read-only access to GitHub, returning normalized DTOs.
 *
 * ## This class has no write methods, and that is the point
 *
 * VISION §12 requires the reconciler to run read-only for a week before it is
 * given the ability to write. "We promise not to call the write method" is a
 * convention that one refactor breaks; a class with no write method is a
 * boundary. `GitHubReadModule` exports this and nothing else, so a module that
 * imports read capability cannot reach write capability by accident — the
 * write adapters live in their own module and are not exported to this one.
 *
 * ## Mirror labels are stripped here
 *
 * Every issue this service returns has already had its `factory/*` labels
 * removed (VISION §3.3: mirror labels are written by Opifex and never read as
 * truth). Doing it at the boundary rather than in each consumer is what makes
 * it a rule instead of a convention — see `toNormalizedIssue`.
 */
@Injectable()
export class GitHubReadService {
  private readonly logger = new Logger(GitHubReadService.name);

  constructor(private readonly http: GitHubHttpService) {}

  /**
   * Confirm a repository exists and this token can see it.
   *
   * Used by registration (#43), which must not accept a repository Opifex
   * cannot actually reach — a registry full of unreachable entries turns every
   * subsequent tick into a series of 404s.
   */
  async getRepository(repo: RepositoryRef): Promise<{
    owner: string;
    name: string;
    defaultBranch: string;
    private: boolean;
    archived: boolean;
  }> {
    const { data } = await this.http.request<RawRepository>(
      `/repos/${repo.owner}/${repo.name}`,
    );

    return {
      owner: data.owner?.login ?? repo.owner,
      name: data.name,
      defaultBranch: data.default_branch,
      private: data.private,
      archived: data.archived,
    };
  }

  /**
   * Issues in a repository, pull requests excluded.
   *
   * GitHub's issues endpoint returns PRs as issues — a quirk that has bitten
   * every integration ever written against it. They are filtered here so no
   * consumer has to know, and `listPullRequests` is the way to ask for them
   * deliberately.
   */
  async listIssues(
    repo: RepositoryRef,
    options: ListIssuesOptions = {},
  ): Promise<{ issues: NormalizedIssue[]; truncated: boolean; allFromCache: boolean }> {
    const { items, truncated, allFromCache } = await this.http.paginate<RawIssue>(
      `/repos/${repo.owner}/${repo.name}/issues`,
      {
        query: {
          state: options.state ?? 'open',
          since: options.since?.toISOString(),
          labels: options.labels?.length ? options.labels.join(',') : undefined,
          // Newest activity first, so a truncated sweep drops the STALEST
          // issues rather than an arbitrary slice.
          sort: 'updated',
          direction: 'desc',
        },
        maxPages: options.maxPages,
      },
    );

    const issues = items.map(toNormalizedIssue).filter((issue) => !issue.isPullRequest);

    if (truncated) {
      this.logger.warn(
        `Issue sweep of ${repo.owner}/${repo.name} hit its page cap; older issues were not read`,
      );
    }

    return { issues, truncated, allFromCache };
  }

  async getIssue(repo: RepositoryRef, issueNumber: number): Promise<NormalizedIssue> {
    const { data } = await this.http.request<RawIssue>(
      `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    );
    return toNormalizedIssue(data);
  }

  /**
   * Every comment on an issue.
   *
   * Added for #63's idempotency: the authorization record must not be posted
   * twice, and the only way to know whether it already exists is to look. The
   * marker comment `<!-- opifex:authorization-record -->` is what identifies
   * it — searching for the JSON body instead would break the moment a field
   * is reordered.
   *
   * VISION §5 warns that issue-comment volume is how agent-driven
   * traceability inverts into noise, which is why this read exists at all: a
   * second authorization comment on every tick would be exactly that.
   */
  async listIssueComments(
    repo: RepositoryRef,
    issueNumber: number,
  ): Promise<NormalizedComment[]> {
    const { items } = await this.http.paginate<RawComment>(
      `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments`,
    );

    return items.map((comment) => ({
      id: comment.id,
      body: comment.body ?? '',
      url: comment.html_url,
      author: comment.user?.login ?? null,
      createdAt: comment.created_at,
    }));
  }

  /** Every label defined on the repository, mirror labels included. */
  async listRepositoryLabels(repo: RepositoryRef): Promise<NormalizedLabel[]> {
    // NOT filtered, unlike an issue's labels: this answers "does the mirror
    // label exist in this repository yet", which #42 needs before it can
    // apply one. The filtering rule is about reading an issue's STATE, not
    // about the repository's label catalogue.
    const { items } = await this.http.paginate<RawLabel>(
      `/repos/${repo.owner}/${repo.name}/labels`,
    );
    return items.map(toNormalizedLabel);
  }

  async listPullRequests(
    repo: RepositoryRef,
    options: { state?: 'open' | 'closed' | 'all'; head?: string } = {},
  ): Promise<NormalizedPullRequest[]> {
    const { items } = await this.http.paginate<RawPullRequest>(
      `/repos/${repo.owner}/${repo.name}/pulls`,
      {
        query: {
          state: options.state ?? 'open',
          head: options.head,
          sort: 'updated',
          direction: 'desc',
        },
      },
    );
    return items.map(toNormalizedPullRequest);
  }

  async getPullRequest(
    repo: RepositoryRef,
    pullNumber: number,
  ): Promise<NormalizedPullRequest> {
    const { data } = await this.http.request<RawPullRequest>(
      `/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}`,
    );
    return toNormalizedPullRequest(data);
  }

  /**
   * CI verdicts on a commit, from BOTH of GitHub's systems.
   *
   * A repository may use check runs (Actions), commit statuses (most
   * third-party CI), or both, and asking only one is how "CI is green" turns
   * out to mean "the system I happened to query had nothing to say". #107
   * gates PR surfacing on this answer, so a false green is expensive.
   */
  async listChecks(repo: RepositoryRef, sha: string): Promise<NormalizedCheck[]> {
    const [checkRuns, statuses] = await Promise.all([
      this.http.paginate<RawCheckRun>(
        `/repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs`,
        {
          // `filter: latest` asks GitHub for only the most recent run of each
          // check name, so a re-run does not leave the previous failure in the
          // result set alongside the new pass.
          query: { filter: 'latest' },
          // This endpoint wraps its array in an envelope rather than
          // returning one. Without the extractor the page body is not an
          // array, nothing is collected, and an empty result reads as "CI has
          // nothing to say".
          extract: (page) => (page as RawCheckRunsPage)?.check_runs ?? [],
        },
      ),
      this.http.paginate<RawCommitStatus>(
        `/repos/${repo.owner}/${repo.name}/commits/${sha}/statuses`,
      ),
    ]);

    const runs = checkRuns.items;

    // The statuses endpoint returns EVERY status ever posted for a context,
    // newest first. Only the newest per context is the current verdict.
    const latestByContext = new Map<string, RawCommitStatus>();
    for (const status of statuses.items) {
      if (!latestByContext.has(status.context)) {
        latestByContext.set(status.context, status);
      }
    }

    return [
      ...runs.map(toNormalizedCheckRun),
      ...[...latestByContext.values()].map(toNormalizedCommitStatus),
    ];
  }

  /** Commits on a branch, newest first. The git-derived liveness source. */
  async listCommits(
    repo: RepositoryRef,
    options: { branch?: string; since?: Date; maxPages?: number } = {},
  ): Promise<NormalizedCommit[]> {
    const { items } = await this.http.paginate<RawCommit>(
      `/repos/${repo.owner}/${repo.name}/commits`,
      {
        query: { sha: options.branch, since: options.since?.toISOString() },
        maxPages: options.maxPages ?? 3,
      },
    );
    return items.map(toNormalizedCommit);
  }

  /**
   * Label applications and removals on an issue, with the actor.
   *
   * The one read that is not derivable from a plain resource fetch, and the
   * easiest to forget: VISION §8's rule that only a human may apply
   * `factory:clear-quarantine` can only be checked against this. The issue's
   * label list says the label is present; nothing else says who put it there.
   *
   * Non-label timeline entries are dropped — the timeline carries dozens of
   * event types and Opifex reads exactly one.
   */
  async listLabelEvents(
    repo: RepositoryRef,
    issueNumber: number,
  ): Promise<NormalizedLabelEvent[]> {
    const { items } = await this.http.paginate<RawTimelineEvent>(
      `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/timeline`,
      { maxPages: 5 },
    );

    return items
      .filter(
        (event): event is RawLabelEvent =>
          (event.event === 'labeled' || event.event === 'unlabeled') &&
          typeof event.label?.name === 'string',
      )
      .map(toNormalizedLabelEvent);
  }

  /**
   * Whether a HUMAN applied a label, and it has not since been removed.
   *
   * Answers the quarantine-clearing question directly rather than making each
   * caller re-derive it from a timeline: walk the events in order and keep the
   * last one for this label, so a bot that re-applies a label a human removed
   * cannot resurrect the human's authority.
   */
  async wasLabelAppliedByHuman(
    repo: RepositoryRef,
    issueNumber: number,
    label: string,
  ): Promise<boolean> {
    const events = await this.listLabelEvents(repo, issueNumber);

    let last: NormalizedLabelEvent | undefined;
    for (const event of events) {
      if (event.label === label) last = event;
    }

    return last?.event === 'labeled' && !last.actorIsBot;
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function toNormalizedLabel(raw: RawLabel): NormalizedLabel {
  return { name: raw.name, color: raw.color, description: raw.description ?? null };
}

export function toNormalizedIssue(raw: RawIssue): NormalizedIssue {
  const all = raw.labels ?? [];

  // The mirror-label filter, applied ONCE, here. VISION §3.3: Opifex writes
  // `factory/*` and must never read it back as truth, because its computed
  // desired state would then depend on its own previous output.
  const visible = all.filter((label) => !isMirrorLabel(label.name));

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? null,
    state: raw.state === 'closed' ? 'closed' : 'open',
    author: raw.user?.login ?? null,
    labels: visible.map(toNormalizedLabel),
    inputLabels: visible.map((l) => l.name).filter((name): name is InputLabel => isInputLabel(name)),
    unknownInputLabels: visible.map((l) => l.name).filter(isUnknownInputLabel),
    // Kept OUT of `labels` and surfaced separately: the diff engine needs to
    // know what is currently written in order to avoid redundant writes and
    // to remove stale labels, while the projection must never see them. See
    // the field's doc comment for why those are different things.
    observedMirrorLabels: all.filter((label) => isMirrorLabel(label.name)).map((l) => l.name),
    // GitHub's issues endpoint returns pull requests as issues, distinguished
    // only by the presence of this key.
    isPullRequest: raw.pull_request !== undefined,
    url: raw.html_url,
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
  };
}

export function toNormalizedPullRequest(raw: RawPullRequest): NormalizedPullRequest {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? null,
    state: raw.state === 'closed' ? 'closed' : 'open',
    // GitHub reports a merged PR as `state: closed`, so "was it merged" has to
    // come from `merged_at`. The list endpoint omits `merged` entirely, which
    // makes reading that boolean a silent false for every merged PR.
    merged: raw.merged_at !== null && raw.merged_at !== undefined,
    draft: raw.draft ?? false,
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    baseRef: raw.base.ref,
    author: raw.user?.login ?? null,
    url: raw.html_url,
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
    mergedAt: raw.merged_at ? new Date(raw.merged_at) : null,
  };
}

function toNormalizedCheckRun(raw: RawCheckRun): NormalizedCheck {
  return {
    name: raw.name,
    system: 'check-run',
    status: raw.status,
    conclusion: raw.conclusion ?? null,
    url: raw.html_url ?? null,
    completedAt: raw.completed_at ? new Date(raw.completed_at) : null,
  };
}

function toNormalizedCommitStatus(raw: RawCommitStatus): NormalizedCheck {
  // The Status API's vocabulary predates the Checks API and does not match it:
  // it has no notion of "queued vs in progress", and its `error` has no
  // equivalent conclusion. Mapping both into one shape is the point of
  // normalizing — a consumer asking "did CI pass" should not have to know
  // which API answered.
  const status = raw.state === 'pending' ? 'in_progress' : 'completed';
  const conclusion =
    raw.state === 'success'
      ? ('success' as const)
      : raw.state === 'failure' || raw.state === 'error'
        ? ('failure' as const)
        : null;

  return {
    name: raw.context,
    system: 'commit-status',
    status,
    conclusion,
    url: raw.target_url ?? null,
    completedAt: status === 'completed' ? new Date(raw.updated_at) : null,
  };
}

function toNormalizedCommit(raw: RawCommit): NormalizedCommit {
  return {
    sha: raw.sha,
    message: raw.commit.message,
    author: raw.author?.login ?? null,
    authoredAt: new Date(raw.commit.author.date),
    url: raw.html_url,
  };
}

function toNormalizedLabelEvent(raw: RawLabelEvent): NormalizedLabelEvent {
  const login = raw.actor?.login ?? null;

  return {
    event: raw.event,
    label: raw.label.name,
    actor: login,
    // Two checks, because they catch different things: `type: 'Bot'` covers
    // GitHub Apps, and the `[bot]` suffix catches an App acting through a
    // token where GitHub reports the type as `User`. A human check that either
    // one can fool is not a check.
    actorIsBot: raw.actor?.type === 'Bot' || (login?.endsWith('[bot]') ?? false),
    occurredAt: new Date(raw.created_at),
  };
}

// ---------------------------------------------------------------------------
// GitHub's own shapes — the ONLY place in the codebase that names them
// ---------------------------------------------------------------------------
//
// Hand-written and partial rather than generated: these describe the handful
// of fields Opifex reads, so an unexpected extra field in a payload is not an
// error, and a field that disappears is a compile-time question here rather
// than an `undefined` in a reconciler.

interface RawLabel {
  name: string;
  color: string;
  description?: string | null;
}

interface RawUser {
  login: string;
  type?: string;
}

interface RawRepository {
  name: string;
  owner?: RawUser;
  default_branch: string;
  private: boolean;
  archived: boolean;
}

interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  user?: RawUser | null;
  labels?: RawLabel[];
  /** Present if and only if this "issue" is a pull request. */
  pull_request?: unknown;
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface RawPullRequest {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  user?: RawUser | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface RawCheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: NormalizedCheck['conclusion'];
  html_url?: string | null;
  completed_at?: string | null;
}

interface RawCheckRunsPage {
  check_runs?: RawCheckRun[];
}

interface RawCommitStatus {
  context: string;
  state: 'error' | 'failure' | 'pending' | 'success';
  target_url?: string | null;
  updated_at: string;
}

interface RawCommit {
  sha: string;
  commit: { message: string; author: { date: string } };
  author?: RawUser | null;
  html_url: string;
}

interface RawTimelineEvent {
  event: string;
  label?: { name: string };
  actor?: RawUser | null;
  created_at: string;
}

interface RawLabelEvent extends RawTimelineEvent {
  event: 'labeled' | 'unlabeled';
  label: { name: string };
  created_at: string;
}

interface RawComment {
  id: number;
  body?: string | null;
  html_url: string;
  user?: RawUser | null;
  created_at: string;
}
