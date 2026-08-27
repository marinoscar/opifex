import { Injectable, Logger } from '@nestjs/common';

import {
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubTransientError,
} from '../github/github.errors';
import {
  GitHubReadService,
  type AccessibleRepository,
} from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ListAvailableRepositoriesQueryDto } from './dto/available-repository.dto';

/**
 * What the configured GitHub credential can actually reach (#401).
 *
 * ## Why this exists
 *
 * `POST /api/repositories` verifies reachability, refuses archived
 * repositories and answers 409 for one already registered — but nothing
 * listed what could be registered, so the only way in was to type `owner/name`
 * from memory into a curl. A typo became a 400 several seconds later instead
 * of an impossible input now. This asks GitHub instead, exactly as
 * `SupervisorModelCatalogService` asks the model provider; the two screens are
 * deliberately the same shape.
 *
 * ## The list is the token's scope, and that is the point
 *
 * ADR-0001 chose a FINE-GRAINED personal access token over a classic one whose
 * account-wide `repo` scope would reach repositories "Opifex was never meant
 * to touch". So this is not everything the operator owns; it is precisely what
 * somebody granted. A short list is the scope showing rather than a fault, and
 * an EMPTY list is a successful answer — `status: 'ok'` with a `detail` that
 * says so. Reporting that as an error would send an operator to reissue a
 * credential that works.
 *
 * ## It reports; it does not throw
 *
 * The rule `SupervisorModelCatalogService` and `OperatorProbesService` both
 * state: "the request failed" and "the request found a failure" are the two
 * things this endpoint exists to tell apart, and one HTTP status destroys the
 * distinction before a client can see it. A missing credential, a rejected
 * one, an unreachable GitHub and an exhausted budget are all 200 with a
 * `status` naming which. Only a bug produces a 5xx.
 */

/**
 * Why the list is what it is.
 *
 * Each arm names a DIFFERENT REMEDY, which is the test for whether it earns
 * its place. `refused` and `rate_limited` are separate from
 * `invalid_credential` because all three are credential-adjacent and only one
 * of them means "get another token": a 403 is a scope to widen, and an
 * exhausted budget is a clock to wait on.
 */
export const AVAILABLE_REPOSITORY_STATUSES = [
  /** GitHub answered with a list. It may be empty — see the header. */
  'ok',
  /** No `github.token` is configured. Nothing to list yet, not an error. */
  'no_credential',
  /** GitHub rejected the credential (401). Remedy: a different token. */
  'invalid_credential',
  /** Authenticated and refused (403). Remedy: the token's scope, not the token. */
  'refused',
  /** The hourly budget is spent. Remedy: wait; `detail` says until when. */
  'rate_limited',
  /** Nothing answered, or GitHub answered 5xx. Says NOTHING about the token. */
  'unreachable',
  /** Anything else, with GitHub's own words in `detail`. */
  'failed',
] as const;

export type AvailableRepositoryStatus =
  (typeof AVAILABLE_REPOSITORY_STATUSES)[number];

/**
 * Whether this repository could be registered, and if not, why not.
 *
 * A repository is never omitted for its admission. Hiding the archived ones
 * would leave an operator hunting for a repository that is right there in
 * GitHub, and hiding the registered ones would make the list disagree with the
 * Repositories table beside it.
 */
export const REPOSITORY_ADMISSIONS = [
  /** Registrable right now. */
  'available',
  /** Already in the `repositories` table — the 409 this list exists to spare. */
  'registered',
  /** Archived. `POST /api/repositories` refuses it, so offering it would lie. */
  'archived',
] as const;

export type RepositoryAdmission = (typeof REPOSITORY_ADMISSIONS)[number];

/** One repository, as offered to the operator. */
export interface AvailableRepositoryEntry extends AccessibleRepository {
  readonly admission: RepositoryAdmission;
  /**
   * The existing registration's id when `admission` is `registered`, else
   * null. Present so a client can link to the repository the operator was
   * about to add again, rather than only refusing them.
   */
  readonly repositoryId: string | null;
}

/** The whole answer. One object, whatever happened. */
export interface AvailableRepositories {
  readonly status: AvailableRepositoryStatus;
  /** One human sentence. Never contains the token. */
  readonly detail: string;
  /** The requested page of the filtered, sorted list. Empty on any failure. */
  readonly repositories: readonly AvailableRepositoryEntry[];
  readonly page: number;
  readonly pageSize: number;
  /** Rows matching `search`, across all pages. */
  readonly total: number;
  readonly totalPages: number;
  /** Rows the credential reaches, BEFORE `search`. A lower bound if truncated. */
  readonly reachable: number;
  /** The search applied, echoed so a client never has to assume. */
  readonly search: string | null;
  /** True when GitHub's listing hit its page cap and `reachable` is partial. */
  readonly truncated: boolean;
  readonly checkedAt: string;
}

/**
 * 10 pages of 100 — the cap `GitHubHttpService.paginate` defaults to, stated
 * here rather than inherited because the response PUBLISHES whether it was
 * hit. An account reaching more than 1000 repositories through one
 * fine-grained token has a scoping problem this endpoint should not paper
 * over, and `truncated` says plainly that the list is not the whole set.
 */
const MAX_PAGES = 10;

@Injectable()
export class AvailableRepositoriesService {
  private readonly logger = new Logger(AvailableRepositoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubReadService,
  ) {}

  async list(
    query: ListAvailableRepositoriesQueryDto,
  ): Promise<AvailableRepositories> {
    const search = query.search ?? null;

    // Checked before anything is asked of GitHub, so "nothing is configured
    // yet" never arrives dressed as a rejected credential — two findings with
    // nothing in common but their HTTP status.
    if (!this.github.credentialConfigured) {
      return this.answer(query, search, 'no_credential', [
        'No GitHub credential is configured, so there is nothing to list yet.',
        'Set `github.token` to a fine-grained personal access token granted',
        'access to the repositories Opifex should watch, then list again.',
      ]);
    }

    let listing: Awaited<
      ReturnType<GitHubReadService['listAccessibleRepositories']>
    >;
    try {
      listing = await this.github.listAccessibleRepositories({
        maxPages: MAX_PAGES,
      });
    } catch (error) {
      return this.describeFailure(query, search, error);
    }

    const registered = await this.registrations();

    const all = sortForSelection(
      listing.repositories.map((repository) =>
        describe(repository, registered),
      ),
    );

    const matched = search === null ? all : all.filter(matches(search));
    const start = (query.page - 1) * query.pageSize;

    return this.answer(
      query,
      search,
      'ok',
      [summarise(all, matched, search, listing.truncated)],
      {
        repositories: matched.slice(start, start + query.pageSize),
        total: matched.length,
        reachable: all.length,
        truncated: listing.truncated,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Failure, told apart
  // -------------------------------------------------------------------------

  private describeFailure(
    query: ListAvailableRepositoriesQueryDto,
    search: string | null,
    error: unknown,
  ): AvailableRepositories {
    // Already redacted: `GitHubHttpService` takes the configured token out of
    // every error message it builds, which is the only layer ADR-0001 allows
    // to hold it. This line logs and the sentence below is rendered.
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Listing reachable repositories failed: ${message}`);

    if (error instanceof GitHubRateLimitError) {
      return this.answer(query, search, 'rate_limited', [
        `GitHub's rate limit is exhausted until`,
        `${error.resetAt.toISOString()}, so the list could not be read.`,
        'The credential is fine — ADR-0001 notes that Opifex shares the',
        "operator's own hourly budget, so this can equally be caused by",
        'something other than Opifex.',
      ]);
    }

    if (error instanceof GitHubAuthError) {
      // `status === null` is the "no credential configured" throw. Reachable
      // despite the check above, because `github.token` is resolved per
      // request and can be cleared between the two.
      if (error.status === null) {
        return this.answer(query, search, 'no_credential', [
          'No GitHub credential is configured, so there is nothing to list',
          'yet.',
        ]);
      }

      if (error.status === 403) {
        return this.answer(query, search, 'refused', [
          `GitHub accepted the credential and refused the request (403):`,
          `${message} The token authenticates; it is not permitted to list`,
          'repositories. A fine-grained token needs read access to at least',
          'one repository, and its metadata permission, for this to answer.',
        ]);
      }

      return this.answer(query, search, 'invalid_credential', [
        `GitHub rejected the credential (${error.status}): ${message} The`,
        'token is wrong, revoked, or expired — ADR-0001 notes that a',
        'fine-grained token expires on a fixed date and then fails exactly',
        'like this.',
      ]);
    }

    if (error instanceof GitHubTransientError) {
      return this.answer(query, search, 'unreachable', [
        `GitHub could not be reached: ${message} The request never got a`,
        'usable answer, so this says nothing about the credential — check the',
        'network, the proxy, and `github.apiBaseUrl`.',
      ]);
    }

    return this.answer(query, search, 'failed', [
      `Listing repositories failed: ${message}`,
    ]);
  }

  // -------------------------------------------------------------------------
  // Seams and assembly
  // -------------------------------------------------------------------------

  protected now(): number {
    return Date.now();
  }

  /** `owner/name` (lower-cased) to the registration's id. */
  private async registrations(): Promise<Map<string, string>> {
    const rows = await this.prisma.repository.findMany({
      select: { id: true, owner: true, name: true },
    });

    // Lower-cased because GitHub treats `Acme/App` and `acme/app` as one
    // repository while preserving the case it was created with. A case-exact
    // key would offer an already-registered repository as addable and walk the
    // operator into the 409 this endpoint exists to prevent.
    return new Map(
      rows.map((row) => [`${row.owner}/${row.name}`.toLowerCase(), row.id]),
    );
  }

  private answer(
    query: ListAvailableRepositoriesQueryDto,
    search: string | null,
    status: AvailableRepositoryStatus,
    detail: readonly string[],
    found: {
      repositories: readonly AvailableRepositoryEntry[];
      total: number;
      reachable: number;
      truncated: boolean;
    } = { repositories: [], total: 0, reachable: 0, truncated: false },
  ): AvailableRepositories {
    return {
      status,
      detail: detail.join(' '),
      repositories: found.repositories,
      page: query.page,
      pageSize: query.pageSize,
      total: found.total,
      totalPages: Math.ceil(found.total / query.pageSize),
      reachable: found.reachable,
      search,
      truncated: found.truncated,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Classification, filtering, ordering
// ---------------------------------------------------------------------------

/** Attach the two facts registration will judge this repository by. */
function describe(
  repository: AccessibleRepository,
  registered: ReadonlyMap<string, string>,
): AvailableRepositoryEntry {
  const repositoryId =
    registered.get(repository.fullName.toLowerCase()) ?? null;

  return {
    ...repository,
    // `registered` OUTRANKS `archived` deliberately. Both make the row
    // unaddable, but only one of them has somewhere to send the operator: an
    // existing row they can open. An archived repository that is already
    // registered is a policy question, not an add-repository question.
    admission:
      repositoryId !== null
        ? 'registered'
        : repository.archived
          ? 'archived'
          : 'available',
    repositoryId,
  };
}

/**
 * Case-insensitive substring over `owner/name`.
 *
 * Filtered HERE rather than through GitHub's search API on purpose: that
 * endpoint searches all of GitHub, so it would return public repositories the
 * token cannot touch and quietly turn this honest list into a misleading one.
 * It also spends a different, much smaller rate-limit budget.
 */
function matches(search: string): (entry: AvailableRepositoryEntry) => boolean {
  const needle = search.toLowerCase();
  return (entry) => entry.fullName.toLowerCase().includes(needle);
}

/**
 * The order the picker is rendered in.
 *
 * Addable first, then already registered, then archived — the two unaddable
 * groups sink but are never dropped. Within a group, most recently pushed
 * first, because the repository an operator wants to add is overwhelmingly one
 * they have touched lately; ties and undated rows fall back to the name, so
 * the order is stable across pages.
 */
function sortForSelection(
  entries: readonly AvailableRepositoryEntry[],
): AvailableRepositoryEntry[] {
  const rank: Record<RepositoryAdmission, number> = {
    available: 0,
    registered: 1,
    archived: 2,
  };

  return [...entries].sort((left, right) => {
    if (rank[left.admission] !== rank[right.admission]) {
      return rank[left.admission] - rank[right.admission];
    }

    const byPush = pushKey(right) - pushKey(left);
    if (byPush !== 0) return byPush;

    return left.fullName.localeCompare(right.fullName);
  });
}

/** A sortable instant for a push. Undated rows tie and fall to the name. */
function pushKey(entry: AvailableRepositoryEntry): number {
  if (entry.pushedAt === null) return 0;
  const parsed = Date.parse(entry.pushedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The success sentence, which is also the credential finding. */
function summarise(
  all: readonly AvailableRepositoryEntry[],
  matched: readonly AvailableRepositoryEntry[],
  search: string | null,
  truncated: boolean,
): string {
  if (all.length === 0) {
    return (
      'GitHub accepted the credential and it reaches no repositories at all. ' +
      'The token works; its scope covers nothing. Opifex uses a fine-grained ' +
      'personal access token (ADR-0001), which grants access one repository ' +
      "at a time — so add repositories to the token's Repository access and " +
      'list again.'
    );
  }

  const available = all.filter((e) => e.admission === 'available').length;
  const registered = all.filter((e) => e.admission === 'registered').length;
  const archived = all.filter((e) => e.admission === 'archived').length;

  const scope = truncated
    ? `The credential reaches more than ${all.length} repositories; this is ` +
      `the first ${all.length}, and the rest were not read.`
    : `The credential reaches ${all.length} ` +
      `repositor${all.length === 1 ? 'y' : 'ies'} — that is the token's ` +
      'scope, not everything the account owns.';

  const marked =
    registered === 0 && archived === 0
      ? ''
      : ` ${registered} already registered and ${archived} archived ` +
        `${registered + archived === 1 ? 'is' : 'are'} listed marked rather ` +
        'than hidden.';

  const filtered =
    search === null ? '' : ` ${matched.length} match "${search}".`;

  return `${scope} ${available} can be registered.${marked}${filtered}`;
}
