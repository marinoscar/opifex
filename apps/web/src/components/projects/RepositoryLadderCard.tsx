/**
 * One repository's enablement ladder (#350, epic #332).
 *
 * Four flags, rendered as the ordered progression `repository.dto.ts`
 * documents them as — observe, mirror labels, spec feedback, dispatch — each
 * saying what turning it ON permits and why it is its own rung. The ordering
 * lives in `config/repositoryLadder.ts`; this file only draws it.
 *
 * ## Enabling out of order warns and then obeys
 *
 * A rung turned on while something below it is off raises a confirmation
 * naming what is missing, and "Save anyway" writes it. Not a refusal: the API
 * accepts these combinations, an operator may have a reason, and a UI that
 * refuses is one they route around with `curl` — which is the situation this
 * whole section replaces. The warning is about the rungs THIS save turns on,
 * so editing a budget on a repository that was already out of order does not
 * re-ask; a dialog that fires on every save stops being read.
 *
 * ## The access test is separate from the switches, and may be unavailable
 *
 * The probe answers a question no flag does: whether the configured GitHub
 * credential can read THIS repository. A fine-grained PAT that passes a
 * `/rate_limit` check and does not cover this repository is otherwise only
 * discovered when a run fails at the end. #338 has not shipped it yet, so an
 * unbuilt endpoint renders as "not yet verifiable" — the same treatment
 * `config/readiness.ts` gives a step with no probe — rather than as a failure,
 * and the rest of the card works regardless.
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import HelpIcon from '@mui/icons-material/HelpOutlineOutlined';
import ScienceIcon from '@mui/icons-material/Science';

import {
  BUDGET_CEILING_MAX_USD,
  LADDER_RUNGS,
  ceilingChanged,
  ladderWarnings,
  parseBudgetCeiling,
  warningsIntroducedBy,
  type LadderState,
  type LadderWarning,
} from '../../config/repositoryLadder';
import type {
  RepositoryAccessProbeResult,
  UpdateRepositoryInput,
} from '../../services/api';
import type { RepositorySummary } from '../../types/cockpit';
import { useIsMounted } from '../../hooks/useIsMounted';

export interface RepositoryLadderCardProps {
  repository: RepositorySummary;
  /**
   * The picker pointed at this registration (#401).
   *
   * A row in the Add dialog marked `already registered` carries the existing
   * `repositoryId`, so it does better than refuse the add: it sends the
   * operator here. The card marks itself rather than only being scrolled to,
   * because scrolling moves the sighted reader and nobody else — `aria-current`
   * is what makes that answer mean the same thing for everyone.
   */
  isRevealed?: boolean;
  /** `projects:write`. Without it every control is disabled and says why. */
  canWrite: boolean;
  isSaving: boolean;
  /** Rejects to this component, which shows the API's own refusal. */
  onSave: (input: UpdateRepositoryInput) => Promise<void>;
  /** What a probe answered. Undefined means it has never been run here. */
  probe: RepositoryAccessProbeResult | undefined;
  isProbing: boolean;
  onTestAccess: () => void;
  /**
   * Open the stand-down dialog for this repository (#405).
   *
   * Handed up rather than owned here: that dialog asks how many work orders
   * exist before deciding whether de-registering is offered at all, and one
   * dialog mounted by the panel is one such request rather than one per card.
   */
  onRemove?: () => void;
  /**
   * Put a retired repository back at the bottom of the ladder. Rejects to this
   * component, which shows the API's own refusal.
   *
   * Direct rather than behind a confirmation: un-retiring enables nothing —
   * every rung stays off and has to be climbed again — so there is nothing to
   * warn about.
   */
  onUnretire?: () => Promise<void>;
  /** Open the move dialog. Absent when this build offers no move here. */
  onMove?: () => void;
}

function stateOf(repository: RepositorySummary): LadderState {
  return {
    observeEnabled: repository.observeEnabled,
    mirrorLabelsEnabled: repository.mirrorLabelsEnabled,
    specFeedbackEnabled: repository.specFeedbackEnabled,
    dispatchEnabled: repository.dispatchEnabled,
  };
}

export function RepositoryLadderCard({
  repository,
  isRevealed = false,
  canWrite,
  isSaving,
  onSave,
  probe,
  isProbing,
  onTestAccess,
  onRemove,
  onUnretire,
  onMove,
}: RepositoryLadderCardProps) {
  const stored = stateOf(repository);
  const storedCeiling = repository.budgetCeilingUsd;
  // Read off the stored field, never off the four flags. See the header.
  const isRetired = repository.retiredAt !== null;

  const [draft, setDraft] = useState<LadderState>(stored);
  const [ceilingText, setCeilingText] = useState(storedCeiling ?? '');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [pending, setPending] = useState<LadderWarning[] | null>(null);
  const [isUnretiring, setIsUnretiring] = useState(false);
  // Every `setState` past an `await` is guarded: a card evicted from the list
  // while its request is in flight must not schedule an update.
  const isMounted = useIsMounted();

  // Re-seed from a freshly returned repository during render rather than in an
  // effect, so the switches never paint the stale position for a frame and
  // there is no second commit. Same reasoning as `InterfaceSection`.
  const [seededFrom, setSeededFrom] = useState(repository);
  if (repository !== seededFrom) {
    setSeededFrom(repository);
    setDraft(stateOf(repository));
    setCeilingText(repository.budgetCeilingUsd ?? '');
  }

  // Derived, not stored, so an amount the API would reject is named AS IT IS
  // TYPED. Reporting it only on Save would be unreachable: Save is disabled
  // while the field is invalid, so the operator would be left with a dead
  // button and no reason for it.
  const parsedCeiling = parseBudgetCeiling(ceilingText);
  const ceilingError = parsedCeiling.ok ? null : parsedCeiling.error;
  const flagsChanged = LADDER_RUNGS.some(
    (rung) => draft[rung.key] !== stored[rung.key],
  );
  const ceilingIsDifferent =
    parsedCeiling.ok && ceilingChanged(storedCeiling, parsedCeiling.value);
  const hasChanges = flagsChanged || ceilingIsDifferent;

  // Shown beside the rungs whatever their origin — including a repository that
  // arrived out of order from a curl call made before this screen existed.
  const standingWarnings = ladderWarnings(draft);

  const buildInput = (): UpdateRepositoryInput => {
    const input: UpdateRepositoryInput = {};
    for (const rung of LADDER_RUNGS) {
      if (draft[rung.key] !== stored[rung.key]) {
        input[rung.key] = draft[rung.key];
      }
    }
    if (
      parsedCeiling.ok &&
      ceilingChanged(storedCeiling, parsedCeiling.value)
    ) {
      input.budgetCeilingUsd = parsedCeiling.value;
    }
    return input;
  };

  const commit = async () => {
    setPending(null);
    setSaveError(null);
    try {
      await onSave(buildInput());
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'The API refused the change.',
      );
    }
  };

  const handleSave = () => {
    setSavedAt(null);
    // Unreachable while the button is disabled on an invalid ceiling; kept so
    // the write path cannot depend on that being true.
    if (!parsedCeiling.ok) return;

    const introduced = warningsIntroducedBy(stored, draft);
    if (introduced.length > 0) {
      setPending(introduced);
      return;
    }
    void commit();
  };

  const handleReset = () => {
    setDraft(stored);
    setCeilingText(storedCeiling ?? '');
    setSaveError(null);
    setSavedAt(null);
  };

  const disabled = !canWrite || isSaving;
  // The API refuses to turn any rung on while `retiredAt` is set and names the
  // rungs when it does. Disabling them here is that refusal rendered before it
  // happens, rather than a control left live to earn a 400.
  const rungsDisabled = disabled || isRetired;

  const handleUnretire = async () => {
    if (onUnretire === undefined) return;
    setSaveError(null);
    setSavedAt(null);
    setIsUnretiring(true);
    try {
      await onUnretire();
    } catch (err) {
      if (isMounted()) {
        setSaveError(
          err instanceof Error ? err.message : 'The API refused the change.',
        );
      }
    } finally {
      if (isMounted()) setIsUnretiring(false);
    }
  };

  return (
    <Paper
      component="li"
      // The anchor the picker's "Show it in the list" scrolls to. Always
      // rendered, so revealing a repository never depends on having already
      // been asked to reveal one.
      id={`repository-${repository.id}`}
      variant="outlined"
      sx={{
        p: { xs: 2, sm: 3 },
        listStyle: 'none',
        ...(isRevealed
          ? { borderColor: 'primary.main', borderWidth: 2 }
          : null),
      }}
      aria-label={`Repository ${repository.fullName}`}
      aria-current={isRevealed ? 'true' : undefined}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          mb: 1,
        }}
      >
        <Box>
          <Typography variant="h6" component="h3">
            {repository.fullName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Default branch {repository.defaultBranch} ·{' '}
            {repository.lastObservedAt
              ? `last observed ${new Date(repository.lastObservedAt).toLocaleString()}`
              : 'never observed'}
          </Typography>
        </Box>
        <Chip
          size="small"
          color={
            isRetired
              ? 'warning'
              : repository.dispatchEnabled
                ? 'primary'
                : 'default'
          }
          variant={
            isRetired || repository.dispatchEnabled ? 'filled' : 'outlined'
          }
          label={
            isRetired
              ? 'Retired'
              : repository.dispatchEnabled
                ? 'Dispatch enabled'
                : repository.observeEnabled
                  ? 'Observe only'
                  : 'Nothing enabled'
          }
        />
      </Stack>

      {isRetired && (
        <Alert
          severity="warning"
          variant="outlined"
          sx={{ mt: 1 }}
          action={
            onUnretire !== undefined && (
              <Button
                size="small"
                onClick={() => void handleUnretire()}
                disabled={!canWrite || isSaving || isUnretiring}
              >
                {isUnretiring ? 'Un-retiring…' : 'Un-retire'}
              </Button>
            )
          }
        >
          <AlertTitle>
            Retired{' '}
            {repository.retiredAt !== null &&
              new Date(repository.retiredAt).toLocaleString()}
          </AlertTitle>
          Every rung is off and none can be turned back on while it is retired.
          Its work orders, runs and their provenance are untouched — that is
          what retiring is for. Un-retiring returns it to the BOTTOM of the
          ladder; it does not restore the rungs that were on before.
        </Alert>
      )}

      <AccessTest
        probe={probe}
        isProbing={isProbing}
        onTestAccess={onTestAccess}
      />

      <Divider sx={{ my: 2 }} />

      <Stack component="ol" spacing={2} sx={{ p: 0, m: 0 }}>
        {LADDER_RUNGS.map((rung) => {
          const warning = standingWarnings.find(
            (entry) => entry.rung.key === rung.key,
          );
          return (
            <Box
              component="li"
              key={rung.key}
              sx={{ listStyle: 'none' }}
              aria-label={`Rung ${rung.ordinal}: ${rung.title}`}
            >
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'start' }}>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ minWidth: 20, pt: 1 }}
                >
                  {rung.ordinal}.
                </Typography>
                <Switch
                  checked={draft[rung.key]}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [rung.key]: event.target.checked,
                    }))
                  }
                  disabled={rungsDisabled}
                  slotProps={{
                    input: {
                      'aria-label': `${rung.title} — ${repository.fullName}`,
                    },
                  }}
                />
                <Box sx={{ flex: 1 }}>
                  <Typography variant="subtitle2">
                    {rung.title}
                    {rung.writesToGitHub && (
                      <Chip
                        size="small"
                        label="writes to GitHub"
                        sx={{ ml: 1 }}
                        variant="outlined"
                      />
                    )}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {rung.permits}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {rung.separateBecause}
                  </Typography>
                  {warning && (
                    <Alert severity="warning" sx={{ mt: 1 }}>
                      {warning.message}
                    </Alert>
                  )}
                </Box>
              </Stack>
            </Box>
          );
        })}
      </Stack>

      <Divider sx={{ my: 2 }} />

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: { sm: 'flex-start' } }}
      >
        <TextField
          label="Budget ceiling (USD per run)"
          value={ceilingText}
          onChange={(event) => setCeilingText(event.target.value)}
          disabled={disabled}
          size="small"
          error={!!ceilingError}
          helperText={
            ceilingError ??
            (storedCeiling === null
              ? `No per-repository ceiling stored. Up to $${BUDGET_CEILING_MAX_USD}; empty means none.`
              : `Stored: $${storedCeiling}. Clear the field to remove the ceiling.`)
          }
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
          sx={{ maxWidth: 360 }}
        />
        <Button
          size="small"
          onClick={() => setCeilingText('')}
          disabled={disabled || ceilingText === ''}
          sx={{ mt: { sm: 0.5 } }}
        >
          Clear ceiling
        </Button>
      </Stack>

      {!canWrite && (
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          Changing this needs <code>projects:write</code>, which this account
          does not hold. The ladder is read-only.
        </Alert>
      )}

      {saveError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {saveError}
        </Alert>
      )}
      {savedAt && !saveError && (
        <Alert severity="success" sx={{ mt: 2 }}>
          Saved at {savedAt}. The values above are what the API returned.
        </Alert>
      )}

      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 2, flexWrap: 'wrap', rowGap: 1 }}
      >
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={disabled || !hasChanges || !parsedCeiling.ok}
        >
          Save
        </Button>
        <Button onClick={handleReset} disabled={disabled || !hasChanges}>
          Reset
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        {onMove !== undefined && (
          <Button size="small" onClick={onMove} disabled={disabled}>
            Move…
          </Button>
        )}
        {/* Retire and de-register are ONE affordance leading to one dialog,
            because choosing between them is the decision — a row of two
            buttons would invite the wrong one and answer with a 400. A
            repository that is already retired is not offered it again; its
            remaining move is un-retiring, which is on the banner above. */}
        {onRemove !== undefined && !isRetired && (
          <Button
            size="small"
            color="warning"
            onClick={onRemove}
            disabled={disabled}
          >
            Retire or remove…
          </Button>
        )}
      </Stack>

      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        aria-labelledby={`out-of-order-${repository.id}`}
      >
        <DialogTitle id={`out-of-order-${repository.id}`}>
          Enabling a rung out of order
        </DialogTitle>
        <DialogContent>
          {(pending ?? []).map((warning) => (
            <DialogContentText key={warning.rung.key} sx={{ mb: 1 }}>
              {warning.message}
            </DialogContentText>
          ))}
          <DialogContentText variant="body2">
            This is allowed. The order exists so each rung is proven before the
            one above it — saving anyway skips that proof, it does not break
            anything the API would have stopped.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPending(null)}>Go back</Button>
          <Button variant="contained" onClick={() => void commit()}>
            Save anyway
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

/**
 * The per-repository access test, including the honest unavailable case.
 *
 * `not-implemented` and `forbidden` are drawn as "not yet verifiable" rather
 * than as a failure, because neither says anything about the repository: the
 * first is a missing endpoint (#338) and the second is a fact about the
 * account. Painting either red would be a claim nobody checked, and painting
 * them green would be the exact inference epic #324 was about.
 */
function AccessTest({
  probe,
  isProbing,
  onTestAccess,
}: {
  probe: RepositoryAccessProbeResult | undefined;
  isProbing: boolean;
  onTestAccess: () => void;
}) {
  return (
    <Box sx={{ mt: 1 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: { sm: 'center' } }}
      >
        <Button
          size="small"
          startIcon={<ScienceIcon />}
          onClick={onTestAccess}
          disabled={isProbing}
        >
          {isProbing ? 'Testing access…' : 'Test access'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          Reads this repository with the configured GitHub credential — the
          check that catches a fine-grained token that is valid and does not
          cover this repository.
        </Typography>
      </Stack>

      {probe && (
        <Alert
          severity={severityOf(probe)}
          icon={iconOf(probe)}
          variant="outlined"
          sx={{ mt: 1 }}
        >
          <Typography variant="subtitle2" component="span">
            {headlineOf(probe)}
          </Typography>
          <Typography variant="body2">{probe.detail}</Typography>
          {probe.checkedAt && (
            <Typography variant="caption" color="text.secondary">
              Checked at {new Date(probe.checkedAt).toLocaleString()}
            </Typography>
          )}
        </Alert>
      )}
    </Box>
  );
}

function severityOf(probe: RepositoryAccessProbeResult) {
  switch (probe.state) {
    case 'reachable':
      return 'success' as const;
    case 'unreachable':
      return 'error' as const;
    case 'not-implemented':
    case 'forbidden':
      return 'info' as const;
    default:
      return 'warning' as const;
  }
}

function iconOf(probe: RepositoryAccessProbeResult) {
  switch (probe.state) {
    case 'reachable':
      return <CheckCircleIcon fontSize="inherit" />;
    case 'unreachable':
      return <ErrorIcon fontSize="inherit" />;
    default:
      return <HelpIcon fontSize="inherit" />;
  }
}

function headlineOf(probe: RepositoryAccessProbeResult): string {
  switch (probe.state) {
    case 'reachable':
      return 'Reachable';
    case 'unreachable':
      return 'Not reachable with the configured credential';
    case 'not-implemented':
    case 'forbidden':
      return 'Not yet verifiable';
    default:
      return 'The test did not complete';
  }
}

export default RepositoryLadderCard;
