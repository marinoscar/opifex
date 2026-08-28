import { Injectable, Logger } from '@nestjs/common';

import { GitHubHttpService } from '../github-http.service';
import {
  isInputLabel,
  isMirrorLabel,
  isUnknownInputLabel,
  type InputLabel,
} from '../labels/factory-labels';
import { classifyIgnoredLabels } from '../labels/ignored-labels';
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

/**
 * One repository the configured credential can reach, as offered for
 * registration (#401).
 *
 * Deliberately NOT `NormalizedIssue`-shaped: this is a picker row, so it
 * carries what an operator needs to recognise a repository (the description,
 * when it was last pushed) and what registration will refuse it for
 * (`archived`), and nothing else.
 */
export interface AccessibleRepository {
  owner: string;
  name: string;
  /** `owner/name`, as GitHub itself spells it. */
  fullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  /** `POST /api/repositories` refuses these. Never a reason to omit one. */
  archived: boolean;
  /** Last push, ISO-8601, or null when GitHub did not say. */
  pushedAt: string | null;
}

export interface ListAccessibleRepositoriesOptions {
  /** Page cap, passed straight to `GitHubHttpService.paginate`. */
  maxPages?: number;
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
   * Every repository the configured credential can reach (#401).
   *
   * ## This is the token's scope, not the operator's account
   *
   * ADR-0001 chose a FINE-GRAINED personal access token precisely so that the
   * reachable set is a list somebody chose, rather than every repository the
   * human can see. `GET /user/repos` under such a token returns exactly the
   * repositories it was granted, which makes this both the useful list to pick
   * from and an honest picture of what Opifex could touch. A short list is the
   * scope showing, and an EMPTY one is a successful answer — the caller is
   * expected to say so rather than report a failure.
   *
   * `/installation/repositories` is deliberately not consulted: that is the
   * GitHub App endpoint, and ADR-0001 records that Opifex does not use an App.
   * Asking it under a PAT would answer 403 and turn a working configuration
   * into a reported fault.
   *
   * ## Sorted by name at the source, on purpose
   *
   * `sort=full_name` gives a total order that does not move while the pages
   * are being fetched. `sort=pushed` — the order a picker actually wants — is
   * mutable by definition: a push between page 1 and page 2 shifts a
   * repository across the boundary, so one is fetched twice and another not at
   * all. Presentation order is applied afterwards, over the whole set.
   */
  async listAccessibleRepositories(
    options: ListAccessibleRepositoriesOptions = {},
  ): Promise<{
    repositories: AccessibleRepository[];
    truncated: boolean;
    allFromCache: boolean;
  }> {
    const { items, truncated, allFromCache } =
      await this.http.paginate<RawRepository>('/user/repos', {
        query: {
          // GitHub's own default, stated rather than inherited: this is the
          // set the token was scoped to, and a later change to the default
          // must not silently change what Opifex offers.
          affiliation: 'owner,collaborator,organization_member',
          visibility: 'all',
          sort: 'full_name',
          direction: 'asc',
        },
        maxPages: options.maxPages,
      });

    if (truncated) {
      this.logger.warn(
        `Listing reachable repositories hit its page cap; the list is incomplete`,
      );
    }

    return {
      repositories: items.map(toAccessibleRepository),
      truncated,
      allFromCache,
    };
  }

  /** Whether a GitHub credential is configured at all, as of right now. */
  get credentialConfigured(): boolean {
    return this.http.configured;
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
  ): Promise<{
    issues: NormalizedIssue[];
    truncated: boolean;
    allFromCache: boolean;
  }> {
    const { items, truncated, allFromCache } =
      await this.http.paginate<RawIssue>(
        `/repos/${repo.owner}/${repo.name}/issues`,
        {
          query: {
            state: options.state ?? 'open',
            since: options.since?.toISOString(),
            labels: options.labels?.length
              ? options.labels.join(',')
              : undefined,
            // Newest activity first, so a truncated sweep drops the STALEST
            // issues rather than an arbitrary slice.
            sort: 'updated',
            direction: 'desc',
          },
          maxPages: options.maxPages,
        },
      );

    const issues = items
      .map(toNormalizedIssue)
      .filter((issue) => !issue.isPullRequest);

    if (truncated) {
      this.logger.warn(
        `Issue sweep of ${repo.owner}/${repo.name} hit its page cap; older issues were not read`,
      );
    }

    return { issues, truncated, allFromCache };
  }

  async getIssue(
    repo: RepositoryRef,
    issueNumber: number,
  ): Promise<NormalizedIssue> {
    const { data } = await this.http.request<RawIssue>(
      `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    );
    return toNormalizedIssue(data);
  }

  /**
   * The children GitHub itself records for an issue — the NATIVE relationship.
   *
   * ## Verified available to this deployment's credential (#424)
   *
   * `GET /repos/{owner}/{repo}/issues/{n}/sub_issues` is a newer surface, so
   * it was probed with the configured fine-grained PAT rather than assumed:
   * it answers 200 for a real issue, 404 for a nonexistent one, and returns
   * an `etag` and the usual `x-ratelimit-*` headers, so the conditional-request
   * and budget machinery above applies to it unchanged.
   *
   * ## An empty answer here is NOT "no children"
   *
   * The same probe found `sub_issues_summary.total: 0` on every epic in this
   * repository — the relationship is available and entirely unused, because
   * epics are written as markdown task lists. `EpicChildrenService` therefore
   * treats an empty result as "the native source has nothing to say" and
   * consults the body, rather than as an authoritative empty set. That
   * distinction is the difference between a working resolver and one that
   * answers nothing for every epic that exists.
   *
   * Pull requests are NOT filtered out, unlike `listIssues`: a PR linked as a
   * sub-issue is a deliberate act by a human, and the caller is told what it
   * is (`isPullRequest`) rather than having it silently removed.
   */
  async listSubIssues(
    repo: RepositoryRef,
    issueNumber: number,
  ): Promise<NormalizedIssue[]> {
    const { items } = await this.http.paginate<RawIssue>(
      `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/sub_issues`,
    );
    return items.map(toNormalizedIssue);
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
  async listChecks(
    repo: RepositoryRef,
    sha: string,
  ): Promise<NormalizedCheck[]> {
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
  return {
    name: raw.name,
    color: raw.color,
    description: raw.description ?? null,
  };
}

/**
 * One `/user/repos` row, as the picker sees it.
 *
 * `owner` is read from the nested object rather than split out of
 * `full_name`, because an owner login may itself contain a hyphen but never a
 * slash — splitting is safe, and reading the field GitHub actually sent is
 * safer. `full_name` is only a fallback for the owner, and the composed value
 * is preferred so `fullName` and `owner`/`name` can never disagree.
 */
export function toAccessibleRepository(
  raw: RawRepository,
): AccessibleRepository {
  const owner = raw.owner?.login ?? (raw.full_name ?? '').split('/')[0] ?? '';

  return {
    owner,
    name: raw.name,
    fullName: `${owner}/${raw.name}`,
    description: raw.description ?? null,
    defaultBranch: raw.default_branch,
    private: raw.private,
    archived: raw.archived,
    pushedAt: raw.pushed_at ?? null,
  };
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
    inputLabels: visible
      .map((l) => l.name)
      .filter((name): name is InputLabel => isInputLabel(name)),
    unknownInputLabels: visible.map((l) => l.name).filter(isUnknownInputLabel),
    // Classified from the VISIBLE labels only. Passing `all` would let a
    // `factory/` label Opifex wrote be classified as human input, which is
    // the feedback loop VISION §3.3 exists to prevent.
    ignoredLabels: classifyIgnoredLabels(visible.map((l) => l.name)),
    // Kept OUT of `labels` and surfaced separately: the diff engine needs to
    // know what is currently written in order to avoid redundant writes and
    // to remove stale labels, while the projection must never see them. See
    // the field's doc comment for why those are different things.
    observedMirrorLabels: all
      .filter((label) => isMirrorLabel(label.name))
      .map((l) => l.name),
    // GitHub's issues endpoint returns pull requests as issues, distinguished
    // only by the presence of this key.
    isPullRequest: raw.pull_request !== undefined,
    url: raw.html_url,
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
  };
}

export function toNormalizedPullRequest(
  raw: RawPullRequest,
): NormalizedPullRequest {
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
    actorIsBot:
      raw.actor?.type === 'Bot' || (login?.endsWith('[bot]') ?? false),
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
  full_name?: string;
  owner?: RawUser;
  description?: string | null;
  default_branch: string;
  private: boolean;
  archived: boolean;
  pushed_at?: string | null;
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
