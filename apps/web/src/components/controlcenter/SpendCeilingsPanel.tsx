/**
 * The hard spend ceilings, editable — and what that now rests on
 * (#349, #345, ADR-0018).
 *
 * ## The most consequential fields in the application
 *
 * These two figures are the limit no trust grant may raise (VISION §8). Until
 * #345 they were settable only in `.env`, which made the guarantee
 * STRUCTURAL: raising one required access to the host. It is now
 * ACCESS-CONTROLLED, resting on #334 and #346, and ADR-0018 §6 is explicit
 * that either barrier missing invalidates the decision rather than weakening
 * it. So the panel links the ADR rather than paraphrasing it, and every change
 * goes through a confirmation that states what moves and what that does —
 * not "are you sure", which is a question nobody has ever answered no to.
 *
 * ## The USD field is a text field, deliberately
 *
 * Not `type="number"`. The registry declares these keys as strings so that
 * `50O` stays distinguishable from unset, and a number input would either
 * refuse the keystroke or hand back an empty string — collapsing MALFORMED
 * into UNSET in the browser, which is the exact collapse the API's registry
 * header refuses to make. What is typed is what is stored and what is shown
 * back.
 *
 * ## Spend is shown where it can be, and named where it cannot
 *
 * `GET /api/cost/summary` publishes the factory ceiling's window and the spend
 * against it. Nothing publishes the supervisor's, so that half says so and
 * names why — the treatment `config/readiness.ts` gives a step no endpoint can
 * answer. A budget figure is the last place to infer one.
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  LinearProgress,
  Link,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { ceilingUsedPercent, floorCaveat, money } from '../cost/costFormat';
import {
  CEILING_ADR,
  CEILING_DEFINITIONS,
  ceilingInForce,
  classifyCeiling,
  describeCeilingChange,
  describeClassification,
  type CeilingChange,
  type CeilingDefinition,
} from '../../config/spendCeilings';
import type { CeilingSpendProblem } from '../../hooks/useCeilingSpend';
import type { CostSummary } from '../../types/cockpit';
import type {
  OperatorSetting,
  OperatorSettingsDocument,
  OperatorSettingsPatch,
  PlainOperatorSetting,
} from '../../types/operatorSettings';

export interface SpendCeilingsPanelProps {
  document: OperatorSettingsDocument;
  canWrite: boolean;
  isSaving: boolean;
  /** `ceiling` out of the cost read model, when it could be read. */
  spend: CostSummary | null;
  spendIsLoading: boolean;
  spendProblem: CeilingSpendProblem | null;
  /** Sends the ceiling keys and nothing else. */
  onSave: (patch: OperatorSettingsPatch) => Promise<void>;
  /** Notes an unsaved edit, so a probe answer about it can be marked stale. */
  onPendingKeysChange?: (keys: string[]) => void;
}

type Draft = Record<string, string>;

export function SpendCeilingsPanel({
  document,
  canWrite,
  isSaving,
  spend,
  spendIsLoading,
  spendProblem,
  onSave,
}: SpendCeilingsPanelProps) {
  const [draft, setDraft] = useState<Draft>(() => seed(document.settings));
  const [confirming, setConfirming] = useState<{
    definition: CeilingDefinition;
    changes: CeilingChange[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Re-seed on a fresh document — a save landing, or a 409's refetch. During
  // render rather than in an effect, the way `SettingsSection` does it, so no
  // field paints a stale figure for a frame and the repo's
  // `react-hooks/set-state-in-effect` rule stays satisfied.
  const [seededFrom, setSeededFrom] = useState(document);
  if (document !== seededFrom) {
    setSeededFrom(document);
    setDraft(seed(document.settings));
  }

  const commit = async (changes: CeilingChange[]) => {
    const patch: OperatorSettingsPatch = {};
    // `change.value`, never `change.to`: the display string writes an empty
    // figure as "(not set)", and the wire value for that is the empty string
    // — which stores "no ceiling", as opposed to a JSON null, which would
    // delete the row and fall back to the environment variable.
    for (const change of changes) patch[change.key] = change.value;

    setConfirming(null);
    setError(null);

    try {
      await onSave(patch);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'The API refused the change.',
      );
    }
  };

  return (
    <Box>
      <Typography variant="h6" component="h3" gutterBottom>
        Spend ceilings
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        The most this deployment may spend per window, and the limit no trust
        grant may raise. These were settable only in <code>.env</code> until
        #345; the guarantee is now access-controlled rather than structural,
        which is a deliberate trade recorded in{' '}
        <Link href={CEILING_ADR.url} target="_blank" rel="noreferrer">
          {CEILING_ADR.id} — {CEILING_ADR.title}
        </Link>{' '}
        (<code>{CEILING_ADR.path}</code>). It holds only while an agent inherits
        no credential to authenticate with (#334) and a non-interactive token is
        refused on this write path (#346).
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {savedAt && !error && (
        <Alert severity="success" sx={{ mb: 2 }}>
          Saved at {savedAt}. The figures below are the API re-resolved after
          the write.
        </Alert>
      )}

      <Stack spacing={2}>
        {CEILING_DEFINITIONS.map((definition) => {
          const usd = plain(document.settings, definition.usdKey);
          const window = plain(document.settings, definition.windowKey);
          // A definition whose keys this deployment does not publish renders
          // nothing rather than a broken panel.
          if (!usd || !window) return null;

          const changes = [
            describeCeilingChange(
              definition,
              'usd',
              usd,
              draft[definition.usdKey] ?? '',
            ),
            describeCeilingChange(
              definition,
              'window',
              window,
              draft[definition.windowKey] ?? '',
            ),
          ].filter((change): change is CeilingChange => change !== null);

          return (
            <Paper
              key={definition.id}
              variant="outlined"
              sx={{ p: { xs: 2, sm: 3 } }}
              aria-label={`${definition.title} ceiling`}
            >
              <Typography variant="subtitle1" component="h4">
                {definition.title}
              </Typography>
              <Typography
                variant="caption"
                component="p"
                color="text.secondary"
                sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
              >
                {definition.usdKey} · {definition.windowKey}
              </Typography>

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={2}
                sx={{ mt: 2, alignItems: 'flex-start' }}
              >
                <TextField
                  // Text, not number — see this file's header.
                  label={usd.label}
                  value={draft[definition.usdKey] ?? ''}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [definition.usdKey]: event.target.value,
                    }))
                  }
                  disabled={!canWrite || isSaving}
                  size="small"
                  fullWidth
                  helperText={describeClassification(
                    classifyCeiling(draft[definition.usdKey] ?? ''),
                    definition,
                  )}
                  slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                />
                <TextField
                  label={window.label}
                  value={draft[definition.windowKey] ?? ''}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [definition.windowKey]: event.target.value,
                    }))
                  }
                  disabled={!canWrite || isSaving}
                  size="small"
                  fullWidth
                  helperText="Rolling window, in days. Shortening it lets the same figure permit more spend per month."
                  slotProps={{ htmlInput: { inputMode: 'numeric', min: 1 } }}
                />
              </Stack>

              <SpendAgainstWindow
                definition={definition}
                configuredUsd={String(usd.value ?? '')}
                configuredWindow={String(window.value ?? '')}
                spend={spend}
                isLoading={spendIsLoading}
                problem={spendProblem}
              />

              <Stack
                direction="row"
                spacing={1}
                sx={{
                  mt: 2,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  rowGap: 1,
                }}
              >
                <Button
                  variant="contained"
                  size="small"
                  disabled={!canWrite || isSaving || changes.length === 0}
                  onClick={() => setConfirming({ definition, changes })}
                >
                  Change this ceiling
                </Button>
                <Button
                  size="small"
                  disabled={isSaving || changes.length === 0}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      [definition.usdKey]: String(usd.value ?? ''),
                      [definition.windowKey]: String(window.value ?? ''),
                    }))
                  }
                >
                  Undo
                </Button>
                {changes.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    {changes.length} field
                    {changes.length === 1 ? '' : 's'} changed. Nothing is sent
                    until you confirm.
                  </Typography>
                )}
              </Stack>
            </Paper>
          );
        })}
      </Stack>

      {!canWrite && (
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          Changing a ceiling needs <code>system_settings:write</code> and an
          interactive session: the API refuses a personal access token or a
          device token here whatever permissions it carries, because a limit an
          agent could raise is not a limit.
        </Alert>
      )}

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        aria-labelledby="confirm-ceiling-change"
      >
        <DialogTitle id="confirm-ceiling-change">
          Change the {confirming?.definition.title.toLowerCase()} ceiling?
        </DialogTitle>
        <DialogContent>
          {(confirming?.changes ?? []).map((change) => (
            <Box key={change.key} sx={{ mb: 2 }}>
              <DialogContentText sx={{ fontFamily: 'monospace' }}>
                {change.label}: {change.from} → {change.to}
              </DialogContentText>
              <DialogContentText variant="body2">
                {change.consequence}
              </DialogContentText>
            </Box>
          ))}
          <Divider sx={{ my: 1 }} />
          <DialogContentText variant="body2">
            This is written to the database and takes effect without a restart.
            It is recorded in <code>audit_events</code> against this account.
            See {CEILING_ADR.id} for why a figure that used to require host
            access is editable here.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(null)}>Go back</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => void commit(confirming?.changes ?? [])}
          >
            Change the ceiling
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/**
 * What has been spent against this ceiling's window — or why that is not a
 * question this deployment can answer.
 */
function SpendAgainstWindow({
  definition,
  configuredUsd,
  configuredWindow,
  spend,
  isLoading,
  problem,
}: {
  definition: CeilingDefinition;
  configuredUsd: string;
  configuredWindow: string;
  spend: CostSummary | null;
  isLoading: boolean;
  problem: CeilingSpendProblem | null;
}) {
  if (definition.spendSource.kind === 'not-observable') {
    return (
      <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
        <AlertTitle>Spend against this window is not yet observable</AlertTitle>
        {definition.spendSource.reason} The ceiling is still enforced; what is
        missing is a reading of how much of it has been used.
      </Alert>
    );
  }

  if (isLoading) return <Skeleton height={90} sx={{ mt: 2 }} />;

  if (problem) {
    return (
      <Alert
        severity={problem.kind === 'forbidden' ? 'info' : 'warning'}
        variant="outlined"
        sx={{ mt: 2 }}
      >
        <AlertTitle>Spend could not be read</AlertTitle>
        {problem.detail}
      </Alert>
    );
  }

  if (!spend) return null;

  const { ceiling } = spend;
  const inForce = ceilingInForce(configuredUsd, configuredWindow, ceiling);
  const percent = ceilingUsedPercent(ceiling.limitUsd, ceiling.spend.totalUsd);
  const caveat = floorCaveat(ceiling.spend);

  return (
    <Box sx={{ mt: 2, p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}>
      <Typography variant="overline" component="p" color="text.secondary">
        Observed
      </Typography>
      <Typography variant="body2">
        {money(ceiling.spend.totalUsd)} spent over the last {ceiling.windowDays}{' '}
        days — the ceiling&apos;s own window, not a window this screen chose.
      </Typography>
      <Typography variant="caption" component="p" color="text.secondary">
        {money(ceiling.spend.reportedUsd)} reported by runners and{' '}
        {money(ceiling.spend.estimatedUsd)} estimated from authorized ceilings.
        The two are never added into one figure by the API and are not added
        here. Headroom: {money(ceiling.headroomUsd)}.
      </Typography>
      {percent !== null && (
        <LinearProgress
          variant="determinate"
          value={percent}
          sx={{ mt: 1, mb: 1 }}
          aria-label={`${definition.title} ceiling used`}
        />
      )}
      {caveat && (
        <Typography variant="caption" component="p" color="warning.main">
          {caveat}
        </Typography>
      )}
      <Typography variant="caption" component="p" color="text.secondary">
        {inForce.statement}
      </Typography>
      {inForce.disagrees && (
        <Typography variant="caption" component="p" color="warning.main">
          This is not what the configured fields above say. Both are shown;
          neither is derived from the other.
        </Typography>
      )}
      <Typography variant="caption" component="p" color="text.secondary">
        Source: GET /api/cost/summary → ceiling. Generated{' '}
        {new Date(spend.generatedAt).toLocaleString()}.
      </Typography>
    </Box>
  );
}

/** The draft, seeded from the document. Text, never coerced to a number. */
function seed(settings: readonly OperatorSetting[]): Draft {
  const draft: Draft = {};
  for (const definition of CEILING_DEFINITIONS) {
    for (const key of [definition.usdKey, definition.windowKey]) {
      const entry = plain(settings, key);
      if (entry) draft[key] = entry.value === null ? '' : String(entry.value);
    }
  }
  return draft;
}

/** The non-secret entry for a key, or null when the response has no such key. */
function plain(
  settings: readonly OperatorSetting[],
  key: string,
): PlainOperatorSetting | null {
  const entry = settings.find((candidate) => candidate.key === key);
  return entry && !entry.secret ? entry : null;
}

export default SpendCeilingsPanel;
