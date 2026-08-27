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
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import {
  listingPresentation,
  markFor,
  pageSummary,
  pushedNote,
  registrationRefusal,
  truncationNote,
  type RegistrationRefusal,
} from '../../config/availableRepositories';
import { useAvailableRepositories } from '../../hooks/useAvailableRepositories';
import { ApiError } from '../../services/api';
import type { RepositorySummary } from '../../types/cockpit';
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
  onClose: () => void;
  /**
   * The row the API created. The section adds it to its list, so a
   * registration shows up without a manual refresh.
   */
  onRegistered: (repository: RepositorySummary) => void;
  /** Send the operator to a registration that already exists, in the list behind. */
  onShowRegistered: (repositoryId: string) => void;
}

/**
 * Mounted only while it is open, so the listing is read when the operator asks
 * for it rather than on every Control Center page load — a GitHub request is
 * not free, and `useAvailableRepositories` reads on mount.
 */
export function AddRepositoryDialog({
  canWrite,
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
    isRegistering,
    register,
  } = useAvailableRepositories();

  /** What the operator is typing. The APPLIED search is the hook's. */
  const [searchDraft, setSearchDraft] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<
    (RegistrationRefusal & { detail: string }) | null
  >(null);
  const [registered, setRegistered] = useState<string | null>(null);

  // Re-seed on a fresh answer — a new page, a new search, a refresh after a
  // write. During render rather than in an effect, the way
  // `SupervisorModelPanel` does it, so no control paints a stale value for a
  // frame and the repo's `react-hooks/set-state-in-effect` lint stays
  // satisfied. The success note deliberately survives: the refresh that
  // follows a registration is the one that proves it landed.
  const [seededFrom, setSeededFrom] = useState(listing);
  if (listing !== seededFrom) {
    setSeededFrom(listing);
    setSelected(null);
    setRefusal(null);
  }

  const rows = listing?.repositories ?? [];
  const chosen = rows.find((row) => row.fullName === selected) ?? null;

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    applySearch(searchDraft);
  };

  const clearSearch = () => {
    setSearchDraft('');
    applySearch('');
  };

  const registerChosen = async () => {
    if (chosen === null) return;
    setRefusal(null);
    setRegistered(null);

    try {
      const created = await register(chosen);
      setRegistered(created.fullName);
      // The section's list is told before this dialog re-reads anything, so
      // the new repository is behind the dialog the moment it is created.
      onRegistered(created);
      // And the picker itself re-reads, so the row the operator just added
      // flips to `already registered` instead of inviting a second attempt.
      await refresh();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : null;
      setRefusal({
        ...registrationRefusal(status, chosen.fullName),
        detail:
          error instanceof Error
            ? error.message
            : 'The API gave no reason for the refusal.',
      });
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby="add-repository-title"
    >
      <DialogTitle id="add-repository-title">Add a repository</DialogTitle>

      <DialogContent dividers>
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

        {registered !== null && (
          <Alert severity="success" sx={{ mb: 2 }}>
            <AlertTitle>{registered} is registered</AlertTitle>
            It is in the list behind this dialog, observed and not dispatched —
            dispatch, mirror labels and spec feedback all start off, and are
            enabled one rung at a time. Another repository can be added without
            closing this.
          </Alert>
        )}

        {refusal !== null && (
          <Alert severity="error" sx={{ mb: 2 }}>
            <AlertTitle>{refusal.title}</AlertTitle>
            {refusal.remedy}
            <Typography variant="body2" sx={{ mt: 1 }}>
              {refusal.detail}
            </Typography>
          </Alert>
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

            <List
              aria-label="Repositories the credential can reach"
              sx={{ mt: 1 }}
            >
              {listing.repositories.map((repository) => (
                <RepositoryRow
                  key={repository.fullName}
                  repository={repository}
                  isSelected={repository.fullName === selected}
                  canWrite={canWrite}
                  onSelect={() => setSelected(repository.fullName)}
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
          disabled={isLoading}
          startIcon={isLoading ? <CircularProgress size={14} /> : undefined}
        >
          {isLoading ? 'Asking GitHub…' : 'List again'}
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          onClick={() => void registerChosen()}
          disabled={chosen === null || !canWrite || isRegistering}
        >
          {chosen === null ? 'Register' : `Register ${chosen.fullName}`}
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
    return (
      <ListItem
        divider
        aria-label={label}
        alignItems="flex-start"
        secondaryAction={
          repository.repositoryId !== null ? (
            <Button
              size="small"
              onClick={() =>
                onShowRegistered(repository.repositoryId as string)
              }
            >
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
        {text}
      </ListItemButton>
    </ListItem>
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
