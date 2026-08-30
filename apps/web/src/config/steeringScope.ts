/**
 * What an operator may scope a steering instruction to (#460, epic #457).
 *
 * ADR-0020 settles the model: the accepted scopes are **a repository, a
 * project, the unassigned bucket, or every observed repository** — never a
 * project alone. `schema.prisma` calls a project "an organisational
 * convenience, not a tenancy boundary", `projectId` is nullable, and on any
 * deployment registered before #404 EVERY repository is unassigned. A picker
 * offering only projects would reach nothing at all on such an install, so
 * `projectId: null` is one of the four scopes here rather than an edge case
 * of the project one.
 *
 * ## The exclusivity is enforced by construction, not by checking
 *
 * `POST /steering/proposals` accepts at most one of `repository`, `project`
 * and `allRepositories` and answers 400 to two, because they are three answers
 * to one question rather than three independent filters. Every option below
 * carries ONE `SteeringScopeRequest`, so the refused combination has no shape
 * in this module to exist in — there is no validation to forget to run, and no
 * state where two are set for a later edit to leave behind.
 *
 * ## A pure module, for the reason `steeringChat.ts` is one
 *
 * The sentence an operator reads before writing labels across somebody else's
 * backlog is the feature. Sentences that live in a pure function can be
 * asserted directly instead of through a render, and the option list is the
 * one place where "which repositories does this reach" is decided.
 *
 * ## One registered repository is not a choice
 *
 * `buildScopeCatalogue` answers NO options when exactly one repository is
 * registered, and names it instead. That is ADR-0020 decision 1 read the other
 * way round: with one repository there is nothing for "everything else" to be
 * ambiguous about, the API resolves a bare `#12` and a sweep against it with
 * no scope at all, and a select with a single entry would be friction with no
 * risk behind it — which trains an operator to click past the control rather
 * than read it.
 */

import type { RepositorySummary } from '../types/cockpit';
import type { Project } from '../types/projects';
import type { SteeringScopeRequest } from '../types/steering';

/** Which of ADR-0020's four scopes — plus the stated absence of one. */
export type ScopeKind =
  'unscoped' | 'all-repositories' | 'project' | 'unassigned' | 'repository';

export interface ScopeOption {
  /** Stable across renders. The `<Select>` value and the React key. */
  id: string;
  kind: ScopeKind;
  /** What the closed control shows. Short enough to read at a glance. */
  label: string;
  /** What this reaches, in full. Rendered under the control and in the menu. */
  description: string;
  /**
   * The wire fields this option contributes — at most one, always.
   *
   * Spread into the propose body. An option that produced two would be a 400
   * the operator could not have caused, which is why the type is the union and
   * not three optional fields.
   */
  request: SteeringScopeRequest;
}

export interface ScopeCatalogue {
  /**
   * Every scope that may be chosen, in reading order.
   *
   * EMPTY when the deployment has zero or one registered repository: in
   * neither case is there a choice to make, and offering one anyway would be
   * the "choice with one option" #460 forbids.
   */
  options: ScopeOption[];
  /** `owner/name` when exactly one repository is registered, else null. */
  onlyRepository: string | null;
  /** Nothing is registered at all: steering can reach nothing. */
  registered: number;
}

/** The option an unset picker holds. Selected on mount, and re-selectable. */
export const UNSCOPED_ID = 'unscoped';

/**
 * The ids below are a CONTRACT, not an implementation detail (#461).
 *
 * Since the project screen links to `/steering?scope=<id>`, an option id is
 * something a browser address bar holds and an operator can bookmark. The two
 * builders exist so the catalogue and every link into it are formatted in one
 * place: an id spelled one way here and another way at the link site resolves
 * to `UNSCOPED` through `findScope`, which is the worst available failure —
 * the picker would open on "No scope chosen" and look like it had simply not
 * been told anything.
 */
export const ALL_REPOSITORIES_ID = 'all-repositories';

/** `projectId: null`. Only ever an id; the option exists when it is occupied. */
export const UNASSIGNED_ID = 'unassigned';

/** The id of the option scoping to one project, by its uuid. */
export function projectScopeId(projectId: string): string {
  return `project:${projectId}`;
}

/** The id of the option scoping to one repository, by its `owner/name`. */
export function repositoryScopeId(fullName: string): string {
  return `repository:${fullName}`;
}

/** The scope a bare `<ScopePicker/>` starts on — nothing stated. */
export const UNSCOPED: ScopeOption = {
  id: UNSCOPED_ID,
  kind: 'unscoped',
  label: 'No scope chosen',
  description:
    'Every issue has to be written out as owner/name#12. An instruction that ' +
    'holds everything else is refused rather than swept across every ' +
    'repository — say what it covers instead.',
  request: {},
};

/** `1 repository` / `4 repositories`. The one plural this module needs. */
function repositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`;
}

/** `a, b and c`, or `a, b and 4 more` past three. Never an unbounded line. */
function nameList(names: readonly string[]): string {
  if (names.length <= 3) {
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

function repositoriesLine(names: readonly string[]): string {
  return `${repositoryCount(names.length)}: ${nameList(names)}.`;
}

/**
 * The scopes this deployment actually has.
 *
 * `repositories` must already be narrowed to what steering calls REGISTERED —
 * `observeEnabled: true` and `retiredAt: null`, `registeredRepositories()`'s
 * own filter. Offering anything else would put a scope in the list that the
 * API answers `repository-not-registered` to, which is the typo failure #460
 * exists to remove, reintroduced from the other end.
 *
 * The buckets are derived from `projectId` on each row rather than from one
 * filtered request per project: `GET /repositories` carries `projectId`, so a
 * single pass answers every project AND the unassigned bucket, where N
 * filtered requests would be one per project for the same answer.
 */
export function buildScopeCatalogue(
  projects: readonly Project[],
  repositories: readonly RepositorySummary[],
): ScopeCatalogue {
  const registered = repositories.length;

  if (registered <= 1) {
    return {
      options: [],
      onlyRepository: registered === 1 ? repositories[0].fullName : null,
      registered,
    };
  }

  const unassigned = repositories
    .filter((repository) => repository.projectId === null)
    .map((repository) => repository.fullName);

  const options: ScopeOption[] = [
    UNSCOPED,
    {
      id: ALL_REPOSITORIES_ID,
      kind: 'all-repositories',
      label: 'Every observed repository',
      description:
        `All ${repositoryCount(registered)} Opifex observes. An exclusive ` +
        'instruction reaches issues in every one of them, including ' +
        'repositories nobody named.',
      // The deployment-wide sweep, stated. ADR-0020 decision 2: it stopped
      // being the meaning of an empty field and became something typed.
      request: { allRepositories: true },
    },
  ];

  for (const project of projects) {
    const inProject = repositories
      .filter((repository) => repository.projectId === project.id)
      .map((repository) => repository.fullName);

    options.push({
      id: projectScopeId(project.id),
      kind: 'project',
      label: `Project: ${project.name}`,
      description:
        inProject.length === 0
          ? // The client-side preview of the API's `empty-scope`. Said before
            // the round trip rather than instead of it: the API is still the
            // one that decides, and its answer is rendered when it differs.
            `No observed repository is filed under ${project.name}, so this ` +
            'scope would reach nothing.'
          : repositoriesLine(inProject),
      request: { project: project.id },
    });
  }

  // Listed only when something is in it. A project exists whether or not it
  // holds anything — an operator filed it — but "no project" is a bucket
  // rather than a thing, and an empty one is a guaranteed `empty-scope`.
  if (unassigned.length > 0) {
    options.push({
      id: UNASSIGNED_ID,
      kind: 'unassigned',
      label: `No project (${unassigned.length})`,
      description:
        `${repositoriesLine(unassigned)} Unassigned is a state, not a gap — ` +
        'it is where every repository registered before projects existed ' +
        'still lives.',
      // `'none'` is a member of the `project` field rather than a separate
      // flag, matching the API's own idiom: unassigned is an ANSWER to "which
      // project", not a different question.
      request: { project: 'none' },
    });
  }

  for (const repository of repositories) {
    options.push({
      id: repositoryScopeId(repository.fullName),
      kind: 'repository',
      label: repository.fullName,
      description:
        `Only ${repository.fullName}. A bare #12 means an issue in it, and ` +
        'nothing outside it is touched.',
      request: { repository: repository.fullName },
    });
  }

  return { options, onlyRepository: null, registered };
}

/** The option with this id, or the unscoped one. Never undefined. */
export function findScope(
  options: readonly ScopeOption[],
  id: string,
): ScopeOption {
  return options.find((option) => option.id === id) ?? UNSCOPED;
}

/**
 * Whether an unscoped instruction can still be swept over this deployment.
 *
 * True only for the case ADR-0020 leaves alone: exactly one registered
 * repository, where the API resolves both a bare `#12` and the "everything
 * else" sweep against it without being told. Anything wider and an exclusive
 * instruction comes back `ambiguous-scope`, which is what the composer warns
 * about before the round trip rather than after it.
 */
export function unscopedIsUnambiguous(catalogue: ScopeCatalogue): boolean {
  return catalogue.registered === 1;
}
