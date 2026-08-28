/**
 * Add a repository — chosen from what the credential reaches, never typed
 * (#401).
 *
 * ## Why a picker rather than a text field
 *
 * Registering a repository was reachable only by `curl`, so an operator saw
 * whatever was curl'd in once and could not add a second. A free-text
 * `owner/name` box would close that gap and repeat the mistake epic #391 just
 * corrected for the supervisor model: a free-text field for a value the system
 * can enumerate turns a typo into a confusing failure several seconds later
 * instead of an impossible input now. So this offers
 * `GET /api/repositories/available`, the way the model dropdown offers what
 * the supervisor key can reach, and follows `SupervisorModelPanel`'s
 * conventions on purpose — consistency between the two screens is worth more
 * than local cleverness.
 *
 * ## Every row is shown, and the unaddable ones are MARKED
 *
 * `registered` and `archived` rows are listed and cannot be selected. Hiding
 * them would leave an operator hunting for a repository they can see on
 * GitHub; offering them would walk them into the 409 or the 400 the API
 * documents. A `registered` row carries `repositoryId`, so it does better than
 * refuse: it sends them to the registration that already exists.
 *
 * ## The order is the API's
 *
 * Addable first, then registered, then archived; most recently pushed first
 * within each group. That order is deliberate and nothing here re-sorts it —
 * the same rule `modelOptions` states.
 *
 * ## The refusals are real states, not invented validation
 *
 * `github.token` is resolved per request, so the listing and the write can run
 * against different credentials and a row that was addable a moment ago can be
 * refused now. 400, 409 and 503 are therefore rendered from the API's own
 * answer rather than treated as impossible.
 *
 * ## Several at once, and partial success as the ORDINARY outcome (#407)
 *
 * Onboarding a team's repositories used to be this whole flow per row — open,
 * search, select, confirm, reopen. Selection is now a set, and the transport
 * is N sequential `POST /repositories` calls, argued on
 * `useAvailableRepositories.registerMany`. Three consequences are visible
 * here:
 *
 *  - **The report is per repository.** A batch of eight where two are already
 *    registered and one is unreachable is a normal answer, not an error, so
 *    the outcome list says what each row did and nothing is rolled back.
 *  - **The selection is bounded by what is on screen.** `selectedNames` is
 *    pruned to the addable rows of the ANSWERED page on every new listing, and
 *    select-all covers that same set. Selecting rows an operator cannot see —
 *    on another page, or under a search they have since changed — is how the
 *    wrong repository gets registered.
 *  - **After a mixed result the successes drop out of the selection and the
 *    refusals stay in.** Clearing everything would lose the record of what to
 *    retry; keeping everything would invite a second `POST` for a repository
 *    that already registered, whose only possible answer is a 409 that means
 *    nothing.
 *
 * ## Registering also creates the factory labels, and that half can fail alone (#415)
 *
 * `POST /repositories` provisions the label taxonomy on the repository it just
 * registered and answers `labelProvisioning` alongside the row. ADR-0001's
 * fine-grained PAT grants one repository and one permission at a time, so
 * "could read it" genuinely does not imply "can create labels in it" — a
 * refusal here is an **expected outcome of a correct configuration**, not an
 * exception, and reads as one.
 *
 * Both facts are therefore reported together and in that order: the repository
 * IS registered, and its labels are not there. Presenting a refused
 * provisioning as a failed registration would be false — the row is in the
 * list behind this dialog either way — and presenting the registration alone
 * would leave an operator with a repository in which no issue can ever be
 * marked `factory:ready`, which is the exact state #415 exists to end.
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import {
  batchPresentation,
  listingPresentation,
  markFor,
  pageSummary,
  pushedNote,
  refusalRemedies,
  refusedResults,
  registrationRefusal,
  resultLine,
  truncationNote,
  type RegistrationResult,
} from '../../config/availableRepositories';
import { registrationLabelNote } from '../../config/repositoryLabels';
import { useAvailableRepositories } from '../../hooks/useAvailableRepositories';
import type { RegisteredRepository } from '../../services/api';
import type {
  AvailableRepositories,
  AvailableRepository,
} from '../../types/repositories';

export interface AddRepositoryDialogProps {
  /**
   * `projects:write` — the string `RepositoriesController.register` enforces.
   * Without it the list is still readable and nothing can be registered; the
   * API refuses the write regardless of what is on screen.
   */
  canWrite: boolean;
  /**
   * The project the registration is filed into, or undefined for the
   * unassigned bucket (#406).
   *
   * Undefined is a real destination and not a missing value: `projectId: null`
   * is the state every repository registered before projects existed is in,
   * and a repository there is still observed, still dispatchable and still
   * walked up the ladder.
   */
  projectId?: string;
  /** The project's name, so the dialog can say where the row will land. */
  projectName?: string;
  onClose: () => void;
  /**
   * A row the API created. The panel adds it to its list, so a registration
   * shows up without a manual refresh.
   *
   * Called ONCE PER SUCCESSFUL registration, so a batch that half succeeded
   * still puts everything that landed into the list behind. The refusals are
   * reported in this dialog and are not announced to the panel — there is no
   * row to add for them.
   *
   * The row carries `labelProvisioning`, so the card behind this dialog opens
   * with the label observation the registration already took (#415) rather
   * than asking GitHub again a second later.
   */
  onRegistered: (repository: RegisteredRepository) => void;
  /** Send the operator to a registration that already exists, in the list behind. */
  onShowRegistered: (repositoryId: string) => void;
}

/**
 * Mounted only while it is open, so the listing is read when the operator asks
 * for it rather than on every load of the Projects panel — a GitHub request is
 * not free, and `useAvailableRepositories` reads on mount.
 */
export function AddRepositoryDialog({
  canWrite,
  projectId,
  projectName,
  onClose,
  onRegistered,
  onShowRegistered,
}: AddRepositoryDialogProps) {
  const {
    listing,
    isLoading,
    requestError,
    search,
    goToPage,
    applySearch,
    refresh,
    progress,
    registerMany,
  } = useAvailableRepositories();

  /** What the operator is typing. The APPLIED search is the hook's. */
  const [searchDraft, setSearchDraft] = useState('');
  /** The chosen repositories, by full name. Never contains a row that is not
   * addable on the page currently answered — see the prune below. */
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  /** What the last batch did, per repository. Null before there has been one. */
  const [results, setResults] = useState<RegistrationResult[] | null>(null);

  const rows = listing?.repositories ?? [];
  const addable = rows.filter((row) => markFor(row).addable);

  // Re-seed on a fresh answer — a new page, a new search, a refresh after a
  // write. During render rather than in an effect, the way
  // `SupervisorModelPanel` does it, so no control paints a stale value for a
  // frame and the repo's `react-hooks/set-state-in-effect` lint stays
  // satisfied. The report deliberately survives: the refresh that follows a
  // batch is the one that proves what landed.
  //
  // The selection is PRUNED rather than cleared, and that single rule is what
  // bounds it. A row that is not addable on the answered page drops out — so
  // paging or searching empties the selection, since none of the old rows are
  // in the new answer, while the re-list after a batch drops exactly the
  // repositories that just became `already registered` and keeps the refusals
  // the operator may want to try again. Nothing can be registered that is not
  // on the page in front of them.
  const [seededFrom, setSeededFrom] = useState(listing);
  if (listing !== seededFrom) {
    setSeededFrom(listing);
    const stillAddable = new Set(addable.map((row) => row.fullName));
    setSelectedNames((current) =>
      current.filter((name) => stillAddable.has(name)),
    );
  }

  // In the API's order rather than in click order: what is registered should
  // be what the operator can see, top to bottom, and a set has no order of its
  // own to prefer.
  const chosen = rows.filter((row) => selectedNames.includes(row.fullName));
  const allSelected = addable.length > 0 && chosen.length === addable.length;

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    applySearch(searchDraft);
  };

  const clearSearch = () => {
    setSearchDraft('');
    applySearch('');
  };

  /** Select-all, over the rows on THIS page under THIS search, and no others. */
  const toggleAll = () => {
    setSelectedNames(allSelected ? [] : addable.map((row) => row.fullName));
  };

  const toggleOne = (fullName: string) => {
    setSelectedNames((current) =>
      current.includes(fullName)
        ? current.filter((name) => name !== fullName)
        : [...current, fullName],
    );
  };

  const registerChosen = async () => {
    if (chosen.length === 0) return;
    // Dropped before the batch starts rather than left underneath it: a report
    // from the previous attempt sitting above a running one would be read as
    // this one's answer.
    setResults(null);

    // Never rejects — a refusal is one entry in the answer, not a thrown
    // error. See `registerMany`.
    const outcomes = await registerMany(chosen, projectId);
    setResults(outcomes);

    // The panel's list is told before this dialog re-reads anything, so every
    // repository that landed is behind the dialog the moment it exists.
    for (const outcome of outcomes) {
      if (outcome.repository !== null) onRegistered(outcome.repository);
    }

    // What succeeded leaves the selection; what was refused stays in it. A
    // retry then re-sends only the ones that have not already worked, and the
    // operator does not have to re-find them.
    const succeeded = new Set(
      outcomes
        .filter((outcome) => outcome.refusal === null)
        .map((outcome) => outcome.fullName),
    );
    setSelectedNames((current) =>
      current.filter((name) => !succeeded.has(name)),
    );

    // And the picker re-reads, so the rows just added flip to `already
    // registered` instead of inviting a second attempt.
    await refresh();
  };

  return (
    <Dialog
      open
      // Refused while a batch is running: closing would take away the only
      // place the per-repository report is about to be shown, for
      // registrations that are being written either way.
      onClose={progress === null ? onClose : undefined}
      fullWidth
      maxWidth="md"
      aria-labelledby="add-repository-title"
    >
      <DialogTitle id="add-repository-title">
        {projectName === undefined
          ? 'Add repositories'
          : `Add repositories to ${projectName}`}
      </DialogTitle>

      <DialogContent dividers>
        {projectName === undefined && (
          <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
            Anything registered here goes into no project. That is a normal
            place for a repository to live — unassigned repositories are
            observed, dispatchable and walked up the ladder exactly like any
            other — and any of them can be filed into a project at any time
            afterwards.
          </Alert>
        )}

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          These are the repositories the configured GitHub credential can reach
          —{' '}
          <strong>
            the token&apos;s scope, not the account&apos;s inventory
          </strong>
          . Opifex authenticates with a fine-grained personal access token
          (ADR-0001), chosen so the reachable set is a list somebody granted
          rather than everything an account owns. A short list is that scope
          showing.
        </Typography>

        <Box component="form" onSubmit={submitSearch} sx={{ mb: 2 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField
              fullWidth
              size="small"
              label="Search repositories"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              helperText={
                'Matched against owner/name across everything the token ' +
                'reaches, not just this page.'
              }
            />
            <Box>
              <Button type="submit" variant="outlined" disabled={isLoading}>
                Search
              </Button>
              {search !== '' && (
                <Button onClick={clearSearch} disabled={isLoading}>
                  Clear
                </Button>
              )}
            </Box>
          </Stack>
        </Box>

        {requestError !== null && (
          <Alert severity="error" sx={{ mb: 2 }}>
            <AlertTitle>The list could not be requested</AlertTitle>
            {requestError} This is a failure of the request, not a verdict on
            the GitHub credential.
          </Alert>
        )}

        {results !== null && (
          <RegistrationReport results={results} projectName={projectName} />
        )}

        {listing !== null && <ListingState listing={listing} />}

        {isLoading && <LinearProgress aria-label="Asking GitHub" />}

        {listing !== null && listing.repositories.length > 0 && (
          <>
            <Typography
              variant="caption"
              component="p"
              color="text.secondary"
              sx={{ mt: 2 }}
            >
              {pageSummary(listing)}
            </Typography>

            {addable.length > 0 && (
              <Box sx={{ mt: 1 }}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={allSelected}
                      indeterminate={chosen.length > 0 && !allSelected}
                      onChange={toggleAll}
                      disabled={!canWrite}
                    />
                  }
                  label={`Select the ${addable.length} that can be added on this page`}
                />
                <Typography
                  variant="caption"
                  component="p"
                  color="text.secondary"
                >
                  This covers what is listed above and nothing else — the
                  current page, under the current search. Rows on another page,
                  or excluded by the search, are not selected, because
                  registering something you cannot see is how the wrong
                  repository gets registered.
                </Typography>
              </Box>
            )}

            <List
              aria-label="Repositories the credential can reach"
              sx={{ mt: 1 }}
            >
              {listing.repositories.map((repository) => (
                <RepositoryRow
                  key={repository.fullName}
                  repository={repository}
                  isSelected={selectedNames.includes(repository.fullName)}
                  canWrite={canWrite}
                  onSelect={() => toggleOne(repository.fullName)}
                  onShowRegistered={onShowRegistered}
                />
              ))}
            </List>

            <Pager
              listing={listing}
              isLoading={isLoading}
              onGoToPage={goToPage}
            />
          </>
        )}

        {listing !== null &&
          listing.repositories.length === 0 &&
          listing.status === 'ok' &&
          listing.reachable > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              {pageSummary(listing)}
            </Typography>
          )}
      </DialogContent>

      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button
          onClick={() => void refresh()}
          disabled={isLoading || progress !== null}
          startIcon={isLoading ? <CircularProgress size={14} /> : undefined}
        >
          {isLoading ? 'Asking GitHub…' : 'List again'}
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        {progress !== null && (
          <Typography variant="body2" color="text.secondary">
            Registering {progress.done + 1} of {progress.total} —{' '}
            {progress.current}
          </Typography>
        )}
        <Button onClick={onClose} disabled={progress !== null}>
          Close
        </Button>
        <Button
          variant="contained"
          onClick={() => void registerChosen()}
          disabled={chosen.length === 0 || !canWrite || progress !== null}
        >
          {registerLabel(chosen.map((row) => row.fullName))}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * What GitHub said, or why nothing was asked.
 *
 * The API's `detail` is quoted verbatim under this build's remedy, because it
 * carries what this build cannot know — which status GitHub returned, when a
 * rate limit resets. `truncated` is surfaced separately rather than left as a
 * clause inside `detail`: a list that stopped at the page cap and is presented
 * as complete is the one way this endpoint could mislead without failing.
 */
function ListingState({ listing }: { listing: AvailableRepositories }) {
  const presentation = listingPresentation(listing);
  const truncation = truncationNote(listing);

  return (
    <Box>
      <Alert severity={presentation.severity} sx={{ mb: 1 }}>
        <AlertTitle>{presentation.title}</AlertTitle>
        {presentation.remedy}
        <Typography variant="body2" sx={{ mt: 1 }}>
          {listing.detail}
        </Typography>
        <Typography variant="caption" component="p" sx={{ mt: 1 }}>
          {listing.reachable} reachable · asked{' '}
          {new Date(listing.checkedAt).toLocaleString()}
        </Typography>
      </Alert>

      {truncation !== null && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          <AlertTitle>This list is truncated</AlertTitle>
          {truncation}
        </Alert>
      )}
    </Box>
  );
}

/**
 * One repository.
 *
 * An addable row is a button. An unaddable one is not — it is present, marked,
 * and says why, which is the whole reason the API marks rather than filters.
 * A `registered` row goes further and offers the registration that exists.
 */
function RepositoryRow({
  repository,
  isSelected,
  canWrite,
  onSelect,
  onShowRegistered,
}: {
  repository: AvailableRepository;
  isSelected: boolean;
  canWrite: boolean;
  onSelect: () => void;
  onShowRegistered: (repositoryId: string) => void;
}) {
  const mark = markFor(repository);
  const label = `Available repository ${repository.fullName}`;

  const text = (
    <ListItemText
      primary={
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
        >
          <span>{repository.fullName}</span>
          {repository.private && (
            <Chip size="small" variant="outlined" label="private" />
          )}
          {mark.label !== null && (
            <Tooltip title={mark.help}>
              <Chip
                size="small"
                color={mark.color}
                variant="outlined"
                label={mark.label}
              />
            </Tooltip>
          )}
        </Stack>
      }
      secondary={
        <>
          <Typography variant="body2" color="text.secondary" component="span">
            {repository.description ?? 'No description on GitHub.'}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            component="span"
            sx={{ display: 'block' }}
          >
            {repository.defaultBranch} · {pushedNote(repository)}
          </Typography>
          {!mark.addable && (
            <Typography
              variant="caption"
              color="text.secondary"
              component="span"
              sx={{ display: 'block' }}
            >
              {mark.help}
            </Typography>
          )}
        </>
      }
    />
  );

  if (!mark.addable) {
    // Narrowed to a const, so the callback closes over a `string` instead of
    // over a field TypeScript would have to re-narrow inside the closure.
    const existing = repository.repositoryId;

    return (
      <ListItem
        divider
        aria-label={label}
        alignItems="flex-start"
        secondaryAction={
          existing !== null ? (
            <Button size="small" onClick={() => onShowRegistered(existing)}>
              Show it in the list
            </Button>
          ) : undefined
        }
      >
        {text}
      </ListItem>
    );
  }

  return (
    <ListItem divider disablePadding aria-label={label} alignItems="flex-start">
      <ListItemButton
        selected={isSelected}
        onClick={onSelect}
        disabled={!canWrite}
        aria-pressed={isSelected}
      >
        {/* The whole row stays the control — one button per repository, with
            its `aria-pressed` carrying the state — and this checkbox is the
            visual mark on it. `tabIndex={-1}` keeps it out of the tab order so
            a selection is never two stops, and `aria-hidden` keeps the row
            from announcing its state twice. */}
        <ListItemIcon sx={{ minWidth: 0, mr: 1.5, mt: 0.5 }}>
          <Checkbox
            edge="start"
            checked={isSelected}
            tabIndex={-1}
            disableRipple
            slotProps={{ input: { 'aria-hidden': true, tabIndex: -1 } }}
          />
        </ListItemIcon>
        {text}
      </ListItemButton>
    </ListItem>
  );
}

/**
 * What the action button says.
 *
 * Names the repository when there is exactly one, because "Register" beside a
 * list of twenty is not a description of what is about to happen and a single
 * add is still the common case.
 */
function registerLabel(fullNames: readonly string[]): string {
  if (fullNames.length === 0) return 'Register';
  if (fullNames.length === 1) return `Register ${fullNames[0]}`;
  return `Register ${fullNames.length} repositories`;
}

/**
 * What a finished batch did, per repository.
 *
 * ## A batch of one is reported as it always was
 *
 * `batchPresentation` returns null for a single refusal, and this renders that
 * repository's own refusal instead — the same alert a single registration has
 * shown since #401. There is no per-row list either, because a list of one row
 * repeats the heading above it. Everything else about the batch is unchanged
 * by its size.
 *
 * ## Per repository above, per REASON below
 *
 * Each row carries the API's own `detail`, so eight refusals produce eight
 * accounts of what happened. The remedies are deduplicated underneath, because
 * a remedy is a fact about the kind of refusal rather than about the
 * repository, and eight copies of "replace github.token" is a wall rather than
 * a report.
 */
function RegistrationReport({
  results,
  projectName,
}: {
  results: RegistrationResult[];
  projectName?: string;
}) {
  const presentation = batchPresentation(results, projectName);
  const refused = refusedResults(results);

  if (presentation === null) {
    const only = refused[0];
    const refusal = registrationRefusal(only.refusal.status, only.fullName);

    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        <AlertTitle>{refusal.title}</AlertTitle>
        {refusal.remedy}
        <Typography variant="body2" sx={{ mt: 1 }}>
          {only.refusal.detail}
        </Typography>
      </Alert>
    );
  }

  return (
    <>
      <Alert severity={presentation.severity} sx={{ mb: 2 }}>
        <AlertTitle>{presentation.title}</AlertTitle>
        {presentation.body}

        {results.length > 1 && (
          <List
            dense
            aria-label="What happened to each repository"
            sx={{ mt: 1 }}
          >
            {results.map((result) => (
              <ListItem
                key={result.fullName}
                disableGutters
                aria-label={`Registration result for ${result.fullName}`}
              >
                <ListItemText
                  primary={
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        rowGap: 0.5,
                      }}
                    >
                      <span>{result.fullName}</span>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={result.refusal === null ? 'success' : 'error'}
                        label={
                          result.refusal === null ? 'registered' : 'refused'
                        }
                      />
                    </Stack>
                  }
                  secondary={resultLine(result)}
                />
              </ListItem>
            ))}
          </List>
        )}

        {results.length > 1 &&
          refusalRemedies(results).map((remedy) => (
            <Typography key={remedy} variant="body2" sx={{ mt: 1 }}>
              {remedy}
            </Typography>
          ))}
      </Alert>

      <LabelProvisioningNotes results={results} />
    </>
  );
}

/**
 * What happened to the LABELS of the repositories that registered (#415).
 *
 * ## Only where there is something to say
 *
 * `registrationLabelNote` answers null for a clean provisioning, so a
 * successful batch shows nothing here: "and its labels were created" is the
 * expected case, and an alert per repository saying so would bury the one that
 * matters.
 *
 * ## Below the registration alert, never instead of it
 *
 * The order carries the meaning. Registration succeeded — the row is in the
 * list behind this dialog and is being observed — and separately its labels
 * are not on GitHub. Merging the two would either report a registration that
 * failed (false) or a registration that is fine (also false, since no issue in
 * it can be marked ready).
 *
 * ## Per repository, because the answer is per repository
 *
 * The credential is fine-grained: it can be permitted to label one repository
 * of a batch of eight and refused on the other seven. One summarised sentence
 * could not say which.
 */
function LabelProvisioningNotes({
  results,
}: {
  results: RegistrationResult[];
}) {
  const notes = results.flatMap((result) => {
    if (result.refusal !== null) return [];
    const note = registrationLabelNote(
      result.fullName,
      result.repository.labelProvisioning,
    );
    return note === null ? [] : [{ fullName: result.fullName, note }];
  });

  if (notes.length === 0) return null;

  return (
    <>
      {notes.map(({ fullName, note }) => (
        <Alert
          key={fullName}
          severity={note.severity}
          sx={{ mb: 2 }}
          aria-label={`Label provisioning for ${fullName}`}
        >
          <AlertTitle>{note.title}</AlertTitle>
          {note.body}
        </Alert>
      ))}
    </>
  );
}

/**
 * Which page, out of how many.
 *
 * Driven by what the API ANSWERED rather than by what was requested: while a
 * page is in flight those differ, and only one of them is a fact.
 */
function Pager({
  listing,
  isLoading,
  onGoToPage,
}: {
  listing: AvailableRepositories;
  isLoading: boolean;
  onGoToPage: (page: number) => void;
}) {
  if (listing.totalPages <= 1) return null;

  return (
    <>
      <Divider sx={{ my: 1 }} />
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: 'center', justifyContent: 'center' }}
      >
        <Button
          size="small"
          onClick={() => onGoToPage(listing.page - 1)}
          disabled={isLoading || listing.page <= 1}
        >
          Previous
        </Button>
        <Typography variant="body2" color="text.secondary">
          Page {listing.page} of {listing.totalPages}
        </Typography>
        <Button
          size="small"
          onClick={() => onGoToPage(listing.page + 1)}
          disabled={isLoading || listing.page >= listing.totalPages}
        >
          Next
        </Button>
      </Stack>
    </>
  );
}

export default AddRepositoryDialog;
