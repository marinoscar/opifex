/**
 * One operator setting, drawn from the response and nothing else
 * (#348, epic #332).
 *
 * ## The control is chosen by `type`, never by the key
 *
 * `boolean` is a switch, `enum` is a select over the values the API sent,
 * `integer` is a number field bounded by the constraints the API sent, and
 * everything else — including a `type` this build has never heard of — is a
 * text field. There is no map from key to control anywhere in `apps/web`, so a
 * key added to the backend registry renders here with no frontend change. That
 * is the acceptance criterion for this issue, not a style preference: a
 * hand-listed field set drifts from the registry the first time somebody adds
 * a key, and drifts silently.
 *
 * ## Four different facts, kept apart
 *
 * A row can say four things about one key and they are not interchangeable:
 * what it RESOLVES to, what a probe OBSERVED where anything did, WHERE the
 * value came from, and WHEN a change to it takes effect. Epic #332's first
 * rule is that configured and observed are never merged; the reload chip is
 * the second, and it is quoted from the API rather than inferred — the UI has
 * no way to know that `github.apiBaseUrl` is frozen in a constructor, and
 * guessing "live" because it looks like a URL would be the screen making up a
 * claim about the deployment.
 *
 * ## Secrets are read-only here, on purpose
 *
 * The API returns `{ configured, source, hint, updatedAt }` for a secret and
 * never a value, so there is nothing to seed an input with. Rotation and the
 * Test buttons live in the Credentials section (#349), which is also where the
 * additional `operator_settings:write_secret` permission is explained — this
 * section does not ask for it, and a field here would 403 for an operator who
 * holds only `system_settings:write`. The row states what is configured and
 * where it came from, and points at where the rest is.
 */

import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import UndoIcon from '@mui/icons-material/Undo';

import {
  provenanceOf,
  reloadPresentation,
  type ObservedFact,
} from '../../config/operatorSettings';
import {
  baselineFieldValue,
  isChanged,
  type DraftEntry,
  type DraftFieldValue,
} from '../../config/operatorSettingsDraft';
import type {
  OperatorSetting,
  PlainOperatorSetting,
  SecretOperatorSetting,
} from '../../types/operatorSettings';

export interface SettingRowProps {
  entry: OperatorSetting;
  /** Absent means this row has not been touched. */
  draft: DraftEntry | undefined;
  /** What a probe found about this key, where anything did. */
  observed: ObservedFact | null;
  /** Holds `system_settings:write`. */
  canWrite: boolean;
  /** A save is in flight, or writing is impossible for another reason. */
  disabled: boolean;
  /** Why this row cannot be sent as it stands, if it cannot. */
  problem?: string;
  onChange: (key: string, value: DraftFieldValue) => void;
  onRevert: (key: string) => void;
  /** Drop this row's draft and go back to what the API returned. */
  onDiscard: (key: string) => void;
}

export function SettingRow({
  entry,
  draft,
  observed,
  canWrite,
  disabled,
  problem,
  onChange,
  onRevert,
  onDiscard,
}: SettingRowProps) {
  const reload = reloadPresentation(entry.reload);
  const provenance = provenanceOf(entry);
  const changed = draft ? isChanged(entry, draft) : false;
  // A revert only means something when there is a stored row to delete.
  const mayRevert = canWrite && !disabled && entry.source === 'database';

  return (
    <Paper
      component="li"
      variant="outlined"
      aria-label={entry.key}
      sx={{ p: { xs: 1.5, sm: 2 }, listStyle: 'none' }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          alignItems: { sm: 'flex-start' },
          justifyContent: 'space-between',
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" component="h4">
            {entry.label}
          </Typography>
          <Typography
            variant="caption"
            component="p"
            color="text.secondary"
            sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
          >
            {entry.key} · {entry.envVar}
          </Typography>
        </Box>

        <Stack
          direction="row"
          spacing={1}
          sx={{ flexWrap: 'wrap', rowGap: 1, justifyContent: 'flex-end' }}
        >
          <Tooltip title={reload.help}>
            <Chip
              size="small"
              color={reload.color}
              variant="outlined"
              label={reload.label}
            />
          </Tooltip>
          <Tooltip title={provenance.detail}>
            <Chip
              size="small"
              variant={entry.source === 'database' ? 'filled' : 'outlined'}
              label={provenance.label}
            />
          </Tooltip>
          {entry.dangerous && (
            <Tooltip title="Changing this can spend money, act outwardly, or widen a boundary.">
              <Chip size="small" color="warning" label="dangerous" />
            </Tooltip>
          )}
        </Stack>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        {entry.help}
      </Typography>

      {entry.error && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {entry.error.message} ({entry.error.reason})
        </Alert>
      )}

      {entry.invalid && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          The value supplied by the {entry.invalid.source} was rejected, so it
          is NOT in force: {entry.invalid.reason}
        </Alert>
      )}

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{ mt: 2, alignItems: 'flex-start' }}
      >
        <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
          {entry.secret ? (
            <SecretValue entry={entry} />
          ) : (
            <PlainControl
              entry={entry}
              draft={draft}
              canWrite={canWrite}
              disabled={disabled}
              problem={problem}
              onChange={onChange}
            />
          )}
        </Box>

        {observed && (
          <Box
            sx={{
              flex: 1,
              width: '100%',
              p: 1.5,
              borderRadius: 1,
              bgcolor: 'action.hover',
            }}
          >
            <Typography variant="overline" component="p" color="text.secondary">
              Observed
            </Typography>
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {observed.statement}
            </Typography>
            <Typography
              variant="caption"
              component="p"
              color="text.secondary"
              sx={{ mt: 0.5 }}
            >
              {observed.source}
            </Typography>
            {observed.disagrees && (
              <Typography variant="caption" component="p" color="warning.main">
                This is not what the configured value says. Both are shown;
                neither is derived from the other.
              </Typography>
            )}
          </Box>
        )}
      </Stack>

      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1, alignItems: 'center' }}
      >
        {!entry.secret && (
          <Button
            size="small"
            onClick={() => onRevert(entry.key)}
            disabled={!mayRevert}
          >
            Revert to environment
          </Button>
        )}
        {changed && (
          <Button
            size="small"
            startIcon={<UndoIcon />}
            onClick={() => onDiscard(entry.key)}
            disabled={disabled}
          >
            Undo
          </Button>
        )}
        {draft?.kind === 'revert' && changed && (
          <Typography variant="caption" color="text.secondary">
            Will delete the stored value and fall back to {entry.envVar}.
          </Typography>
        )}
        {entry.updatedAt && (
          <Typography variant="caption" color="text.secondary">
            Stored {new Date(entry.updatedAt).toLocaleString()}
          </Typography>
        )}
      </Stack>
    </Paper>
  );
}

/**
 * The editable half of a non-secret row.
 *
 * A pending revert shows the value that is in force today, disabled, rather
 * than blanking the field: the operator is deleting an override, and what they
 * are about to fall back to is not known until the API answers.
 */
function PlainControl({
  entry,
  draft,
  canWrite,
  disabled,
  problem,
  onChange,
}: {
  entry: PlainOperatorSetting;
  draft: DraftEntry | undefined;
  canWrite: boolean;
  disabled: boolean;
  problem?: string;
  onChange: (key: string, value: DraftFieldValue) => void;
}) {
  const baseline = baselineFieldValue(entry);
  const reverting = draft?.kind === 'revert';
  const current = draft?.kind === 'edit' ? draft.value : baseline;
  const locked = !canWrite || disabled || reverting;

  const helper =
    problem ??
    (entry.acceptsNull
      ? 'Leave empty to store "no limit". That is a stored value, not a revert.'
      : undefined);

  if (entry.type === 'boolean') {
    return (
      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={current === true}
              onChange={(event) => onChange(entry.key, event.target.checked)}
              disabled={locked}
              slotProps={{ input: { 'aria-label': entry.label } }}
            />
          }
          label={String(current === true)}
        />
        <Typography variant="caption" component="p" color="text.secondary">
          Default: {String(entry.default)}
        </Typography>
      </Box>
    );
  }

  const text = typeof current === 'boolean' ? String(current) : current;

  return (
    <TextField
      label={entry.label}
      value={text}
      onChange={(event) => onChange(entry.key, event.target.value)}
      disabled={locked}
      error={problem !== undefined}
      helperText={helper ?? `Default: ${formatDefault(entry.default)}`}
      select={
        entry.type === 'enum' && (entry.constraints.values?.length ?? 0) > 0
      }
      type={entry.type === 'integer' ? 'number' : 'text'}
      size="small"
      fullWidth
      slotProps={{
        htmlInput: {
          ...(entry.constraints.min === undefined
            ? {}
            : { min: entry.constraints.min }),
          ...(entry.constraints.max === undefined
            ? {}
            : { max: entry.constraints.max }),
        },
      }}
    >
      {(entry.constraints.values ?? []).map((value) => (
        <MenuItem key={value} value={value}>
          {value}
        </MenuItem>
      ))}
    </TextField>
  );
}

/** `{ configured, source, hint, updatedAt }` — every field a secret returns. */
function SecretValue({ entry }: { entry: SecretOperatorSetting }) {
  return (
    <Box>
      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
        {entry.configured ? (entry.hint ?? 'configured') : 'not configured'}
      </Typography>
      <Typography variant="caption" component="p" color="text.secondary">
        Read-only here — the API never returns the value. Rotating this
        credential, clearing it, and testing it against the service it is for
        all live in the <strong>Credentials</strong> section, which is also
        where the extra permission a secret write needs is explained.
      </Typography>
    </Box>
  );
}

/** A default, as a field's helper text. Null is a value here, not an absence. */
function formatDefault(value: string | number | boolean | null): string {
  if (value === null) return 'no limit (null)';
  if (value === '') return '(empty)';
  return String(value);
}

export default SettingRow;
