/**
 * How the repository picker is PRESENTED (#401).
 *
 * The same shape `config/supervisorModel.ts` solved for the supervisor model
 * last week — a status plus a detail sentence, per-status presentation, and
 * rows marked rather than hidden — and deliberately the same conventions, so
 * the two screens read as one idea rather than two.
 *
 * ## The API's `detail` is quoted, never paraphrased
 *
 * Every presentation below carries this build's `remedy` and the API's own
 * `detail` is rendered verbatim beside it. The API knows things this build
 * cannot: which host refused, with what HTTP status, until when the rate limit
 * resets. Paraphrasing would throw that away, and re-deriving it here would be
 * a copy that goes stale.
 *
 * ## Seven statuses, because there are seven remedies
 *
 * The test for whether a status earns its own arm is whether it sends the
 * operator somewhere different. `invalid_credential` means get another token.
 * `refused` means the token is fine and its repository access is too narrow —
 * widen it, do not replace it — and folding it into `invalid_credential` would
 * send somebody to reissue a working credential. `rate_limited` means wait,
 * and the `detail` carries until when. `unreachable` says NOTHING about the
 * credential, so it must not read as a verdict on one. `no_credential` is not
 * a failure at all. `failed` is everything else, with GitHub's own words.
 *
 * ## `reachable: 0` with `status: 'ok'` is the eighth case, and it is not an error
 *
 * ADR-0001 chose a fine-grained personal access token, which grants access one
 * repository at a time. A token scoped to nothing is a token that works, so an
 * empty list is a successful answer and rendering it as a fault would send an
 * operator to reissue a credential that is fine. `listingPresentation` splits
 * it out of `ok` for that reason alone — the remedy is the token's repository
 * access, which is a different sentence from "choose one below".
 *
 * ## A batch's answer is per repository, and a mixed one is ORDINARY (#407)
 *
 * Registering several at once makes partial success the normal case rather
 * than an edge one, so the presentation at the bottom of this file reports
 * what happened to each repository and never rolls anything back. The
 * successful registrations are what the operator asked for; discarding them
 * to make the batch's answer a single word would throw away the work and the
 * reason it was requested.
 */

import { registrationLabelLine } from './repositoryLabels';
import type { RegisteredRepository } from '../services/api';
import type {
  AvailableRepositories,
  AvailableRepository,
  AvailableRepositoryStatus,
} from '../types/repositories';

// ---------------------------------------------------------------------------
// Admission — three marks, and the one that carries no chip
// ---------------------------------------------------------------------------

export interface AdmissionPresentation {
  /** The chip beside the repository, or null when there is nothing to say. */
  label: string | null;
  color: 'default' | 'info' | 'warning';
  /** Why it cannot be registered, in the operator's terms. */
  help: string;
  /** Whether `POST /repositories` would accept it. */
  addable: boolean;
}

/**
 * The mark for one admission state.
 *
 * `available` gets NO chip. A mark on every row is a mark on none, and these
 * chips exist to draw the eye to the two rows that need a sentence.
 */
export function admissionPresentation(
  admission: string,
): AdmissionPresentation {
  if (admission === 'available') {
    return {
      label: null,
      color: 'default',
      help: 'Registrable now.',
      addable: true,
    };
  }

  if (admission === 'registered') {
    return {
      label: 'already registered',
      color: 'info',
      help:
        'Opifex already watches this repository, so registering it again ' +
        'would answer 409. It is listed rather than hidden so that this list ' +
        'agrees with the one behind this dialog.',
      addable: false,
    };
  }

  if (admission === 'archived') {
    return {
      label: 'archived on GitHub',
      color: 'warning',
      help:
        'GitHub has archived this repository, and registration refuses an ' +
        'archived one — offering it would be a promise that fails several ' +
        'seconds later. Unarchive it on GitHub and list again.',
      addable: false,
    };
  }

  // An admission this build has never heard of. Marked and named rather than
  // guessed at: treating an unfamiliar word as `available` is the one thing
  // this mark exists not to do, since the guess ends in a refusal the operator
  // was told would not happen.
  return {
    label: admission,
    color: 'info',
    help:
      'This build does not recognise that admission state, so it will not ' +
      'assume the repository can be registered.',
    addable: false,
  };
}

/** The mark for one row. */
export function markFor(
  repository: AvailableRepository,
): AdmissionPresentation {
  return admissionPresentation(repository.admission);
}

// ---------------------------------------------------------------------------
// Status — seven remedies, plus the empty scope that is not a failure
// ---------------------------------------------------------------------------

export interface ListingPresentation {
  severity: 'info' | 'success' | 'warning' | 'error';
  /** The heading. Names the situation, never "Error". */
  title: string;
  /** What to do about it, in this build's words. The API's `detail` is
   * rendered verbatim beside it. */
  remedy: string;
}

const STATUS_PRESENTATION: Record<
  AvailableRepositoryStatus,
  ListingPresentation
> = {
  ok: {
    severity: 'success',
    title: 'GitHub answered',
    remedy: 'Choose the repository Opifex should watch.',
  },
  no_credential: {
    severity: 'info',
    title: 'No GitHub credential is configured yet',
    remedy:
      'Set github.token in the Credentials section to a fine-grained ' +
      'personal access token, then list again. Nothing is wrong: there is ' +
      'simply nothing to ask yet.',
  },
  invalid_credential: {
    severity: 'error',
    title: 'GitHub rejected the credential',
    remedy:
      'The token is wrong, revoked or expired — a fine-grained token expires ' +
      'on a fixed date and then fails exactly like this. Replace it in the ' +
      'Credentials section. GitHub answered, so this is a verdict on the ' +
      'credential and not on the network.',
  },
  refused: {
    severity: 'warning',
    title: 'The credential authenticated and was refused',
    remedy:
      'The token is valid and is not permitted to list repositories. Widen ' +
      'what it may reach — a fine-grained token needs read access to at ' +
      'least one repository, and its metadata permission — rather than ' +
      'issuing a new token, which would almost certainly fail the same way.',
  },
  rate_limited: {
    severity: 'warning',
    title: 'GitHub’s rate limit is exhausted',
    remedy:
      'The credential is fine and the hourly budget is spent; the reset time ' +
      'is below. ADR-0001 notes Opifex shares the operator’s own budget, so ' +
      'this can equally have been caused by something other than Opifex.',
  },
  unreachable: {
    severity: 'warning',
    title: 'Nothing answered',
    remedy:
      'The request never got a usable reply, so the credential was never ' +
      'judged — this says nothing at all about the token. Check the network, ' +
      'the proxy, and github.apiBaseUrl.',
  },
  failed: {
    severity: 'error',
    title: 'GitHub answered something unexpected',
    remedy:
      'Neither a credential verdict nor a network failure. GitHub’s own ' +
      'answer is quoted below. Trying again shortly is usually the right ' +
      'move.',
  },
};

/**
 * A credential that works and reaches nothing.
 *
 * Kept out of `ok` because the remedy is different and the tone matters: this
 * is the token's scope showing, exactly as ADR-0001 intended, so it is
 * guidance rather than an error. The API's `detail` says the same thing and is
 * rendered beside this — nothing here contradicts it.
 */
const EMPTY_SCOPE: ListingPresentation = {
  severity: 'info',
  title: 'The credential works and reaches no repository',
  remedy:
    'Nothing is broken. Opifex authenticates with a fine-grained personal ' +
    'access token (ADR-0001), which grants access one repository at a time, ' +
    'so a token can be perfectly valid and cover nothing. Add repositories ' +
    'to the token’s Repository access on GitHub and list again — do not ' +
    'reissue the token.',
};

/**
 * How to render one status, including one this build has never heard of.
 *
 * The fallback prints the raw word rather than folding an unknown status into
 * `failed`, for the same reason `config/supervisorModel.ts` does: the API's
 * `detail` is written for a human and is always shown, so a status this build
 * cannot interpret still arrives with its explanation intact.
 */
export function statusPresentation(status: string): ListingPresentation {
  return (
    STATUS_PRESENTATION[status as AvailableRepositoryStatus] ?? {
      severity: 'warning',
      title: `The API reported “${status}”`,
      remedy:
        'This build does not recognise that status, so it will not guess at ' +
        'a remedy. The API’s own explanation is below.',
    }
  );
}

/** How to render a whole answer — the status, or the empty scope inside `ok`. */
export function listingPresentation(
  listing: AvailableRepositories,
): ListingPresentation {
  if (listing.status === 'ok' && listing.reachable === 0) return EMPTY_SCOPE;
  return statusPresentation(listing.status);
}

// ---------------------------------------------------------------------------
// What the numbers on the page mean
// ---------------------------------------------------------------------------

/**
 * The truncation sentence, or null when the list is whole.
 *
 * `truncated` is the one way this endpoint could mislead without failing: a
 * list that stopped at GitHub's page cap and is presented as complete. So it
 * is surfaced on its own rather than left inside `detail`, where it would be
 * one clause in a paragraph.
 */
export function truncationNote(listing: AvailableRepositories): string | null {
  if (!listing.truncated) return null;

  return (
    `This list is not complete. GitHub's listing hit its page cap, so ` +
    `${listing.reachable} is a lower bound on what the credential reaches ` +
    'and repositories beyond it were never read. Search for the one you ' +
    'want by name, or narrow the token’s repository access — a fine-grained ' +
    'token reaching this many repositories is itself worth a look.'
  );
}

/**
 * Which rows this page is showing, and out of what.
 *
 * `total` counts the search matches and `reachable` counts what the token sees
 * before searching. Both are said, because "your search matched nothing" and
 * "the token reaches nothing" are different findings with different fixes and
 * a single number cannot tell them apart.
 */
export function pageSummary(listing: AvailableRepositories): string {
  if (listing.total === 0) {
    return listing.search === null
      ? `No repositories to show. The credential reaches ${listing.reachable}.`
      : `Nothing matches “${listing.search}”. The credential reaches ` +
          `${listing.reachable} repositor${listing.reachable === 1 ? 'y' : 'ies'} ` +
          'in total, so clearing the search will show them.';
  }

  const first = (listing.page - 1) * listing.pageSize + 1;
  const last = Math.min(listing.page * listing.pageSize, listing.total);
  const matching =
    listing.search === null
      ? `${listing.total} reachable`
      : `${listing.total} matching “${listing.search}”, of ${listing.reachable} reachable`;

  return `Showing ${first}–${last} of ${matching}.`;
}

/** `2026-08-20` from an ISO instant, or a plain sentence when GitHub did not say. */
export function pushedNote(repository: AvailableRepository): string {
  if (repository.pushedAt === null) return 'no push date';
  const parsed = new Date(repository.pushedAt);
  if (Number.isNaN(parsed.getTime())) return 'no push date';
  return `pushed ${parsed.toLocaleDateString()}`;
}

// ---------------------------------------------------------------------------
// What a refused registration means
// ---------------------------------------------------------------------------

export interface RegistrationRefusal {
  /** The heading. Names the situation. */
  title: string;
  /** Why this can happen even though the row was offered. */
  remedy: string;
}

/**
 * The API's documented refusals, told apart by status.
 *
 * These stay real states rather than validation invented here. The picker
 * marks the rows that would answer 400 or 409, but `github.token` is resolved
 * PER REQUEST — so the listing and the write can run against different tokens,
 * and a row that was addable a moment ago can be refused now. Presenting that
 * as impossible would leave the operator with a silent failure.
 */
export function registrationRefusal(
  status: number | null,
  fullName: string,
): RegistrationRefusal {
  if (status === 409) {
    return {
      title: `${fullName} is already registered`,
      remedy:
        'It is in the list behind this dialog. The listing said otherwise, ' +
        'which means it was read before the repository was registered — ' +
        'list again to see the current state.',
    };
  }

  if (status === 400) {
    return {
      title: `GitHub could not offer ${fullName} for registration`,
      remedy:
        'Registration verifies the repository is reachable and refuses an ' +
        'archived one. The credential in force now may differ from the one ' +
        'this list was read with, since github.token is resolved per ' +
        'request. The API’s own reason is below.',
    };
  }

  if (status === 503) {
    return {
      title: 'The GitHub credential is missing or expired',
      remedy:
        'Registration could not verify the repository because there is no ' +
        'usable credential right now. Set or replace github.token in the ' +
        'Credentials section — nothing was written.',
    };
  }

  if (status === 403) {
    return {
      title: 'This account may not register a repository',
      remedy:
        'Registering needs projects:write, which is a different permission ' +
        'from the one that lists repositories. This is a fact about the ' +
        'account, not about the repository.',
    };
  }

  return {
    title: `${fullName} could not be registered`,
    remedy:
      'The API refused the write and its own answer is below. Nothing was ' +
      'registered.',
  };
}

// ---------------------------------------------------------------------------
// Registering several at once (#407)
// ---------------------------------------------------------------------------

/**
 * What happened to ONE repository in a batch.
 *
 * The unit of the answer is the repository, not the batch, because that is the
 * unit the operator chose in. Selecting eight where two are already registered
 * and one is unreachable is an ordinary outcome and not an error, so there is
 * no shape here for "the batch failed" — there is only a list of what each row
 * did.
 */
export type RegistrationResult =
  | { fullName: string; refusal: null; repository: RegisteredRepository }
  | { fullName: string; refusal: RegistrationFailure; repository: null };

/** Why one repository was refused. `status` is how the refusals are told apart. */
export interface RegistrationFailure {
  /** The HTTP status, or null when the request never got one. */
  status: number | null;
  /** The API's own message, rendered verbatim. */
  detail: string;
}

/** The refused rows of a batch, narrowed so `refusal` is known to be present. */
export type RefusedResult = Extract<RegistrationResult, { repository: null }>;

/** The refused rows, in the order they were attempted. */
export function refusedResults(
  results: readonly RegistrationResult[],
): RefusedResult[] {
  return results.filter((result): result is RefusedResult => {
    return result.refusal !== null;
  });
}

/**
 * The one sentence a newly registered repository is owed.
 *
 * Said once for the whole batch rather than once per row: the staged rollout
 * is a property of registration, not of any particular repository, and
 * repeating it eight times would bury the per-row answers it sits above.
 */
const OBSERVED_NOT_DISPATCHED =
  'Observed and not dispatched — dispatch, mirror labels and spec feedback ' +
  'all start off, and are enabled one rung at a time. More can be added ' +
  'without closing this.';

export interface BatchPresentation {
  severity: 'success' | 'warning' | 'error';
  title: string;
  body: string;
}

/**
 * The headline over a finished batch — or null, when the batch was one
 * repository that was refused.
 *
 * Null is not an omission. A batch of one has no per-repository report to
 * make that its own refusal does not already make, and stacking "no repository
 * was registered" on top of "acme/gadgets is already registered" would say the
 * same thing twice, the second time less usefully. The caller renders
 * `registrationRefusal` instead, which is exactly what a single registration
 * showed before batches existed.
 *
 * **Nothing here rolls anything back.** A mixed result is reported as a mixed
 * result: the registrations that succeeded are what the operator asked for,
 * and undoing them to make the answer tidy would throw away the work and lose
 * the reason it was requested.
 */
export function batchPresentation(
  results: readonly RegistrationResult[],
  projectName?: string,
): BatchPresentation | null {
  const refused = refusedResults(results);
  const succeeded = results.length - refused.length;
  const where = projectName === undefined ? '' : ` in ${projectName}`;

  if (refused.length === 0) {
    return {
      severity: 'success',
      title:
        results.length === 1
          ? `${results[0].fullName} is registered${where}`
          : `${results.length} repositories are registered${where}`,
      body: OBSERVED_NOT_DISPATCHED,
    };
  }

  if (succeeded === 0) {
    // A single refusal is told by `registrationRefusal`, which names the
    // repository and the remedy. See above.
    if (results.length === 1) return null;

    return {
      severity: 'error',
      title: `None of the ${results.length} could be registered`,
      body:
        'Every one was refused, and the API’s own reason for each is below. ' +
        'They are still selected, so nothing has to be picked again to try ' +
        'them once the reason is dealt with.',
    };
  }

  return {
    severity: 'warning',
    title: `${succeeded} of ${results.length} registered${where}`,
    body:
      'The ones that succeeded are registered and stay registered — they are ' +
      'what was asked for, and undoing them to make this answer tidy would ' +
      'throw them away. Each refusal is below with the API’s own reason. ' +
      'Only the refused ones are still selected, so trying again cannot ' +
      're-send a registration that already worked.',
  };
}

/**
 * What one row in the per-repository report says under its name.
 *
 * The refused arm quotes the API verbatim after this build's heading for the
 * status, so a reason this build has no arm for still arrives intact.
 */
export function resultLine(result: RegistrationResult): string {
  if (result.refusal === null) {
    // Registration and label provisioning are two outcomes of one request, and
    // a row that said only "Registered." would hide the second one — which for
    // a fine-grained token is the half most likely to have been refused. Null
    // when the API published no such field at all, in which case there is
    // nothing to append rather than an empty sentence to invent.
    const labels = registrationLabelLine(result.repository.labelProvisioning);
    return labels === null ? 'Registered.' : `Registered. ${labels}`;
  }
  const refusal = registrationRefusal(result.refusal.status, result.fullName);
  return `${refusal.title}. ${result.refusal.detail}`;
}

/**
 * The remedies for a batch's refusals, deduplicated, in first-seen order.
 *
 * A remedy is a fact about the KIND of refusal — reissue the credential, widen
 * its access, list again — and never about which repository hit it. Six 409s
 * therefore earn one sentence rather than six copies of it, which is the
 * difference between a report an operator reads and a wall they scroll past.
 * The per-repository detail above is where the six are still individually
 * accounted for.
 */
export function refusalRemedies(
  results: readonly RegistrationResult[],
): string[] {
  const seen = new Set<string>();

  for (const result of refusedResults(results)) {
    seen.add(
      registrationRefusal(result.refusal.status, result.fullName).remedy,
    );
  }

  return [...seen];
}
