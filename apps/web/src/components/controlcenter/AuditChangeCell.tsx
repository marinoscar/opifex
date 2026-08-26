/**
 * The `{ key, from, to }` diff of one audit row (#351, epic #332).
 *
 * Every decision about WHAT may be shown is made in
 * `config/auditHistory.ts` and none of it is made here: this component
 * receives `AuditChange[]` and can only draw what those objects carry. A
 * secret change arrives with `from` and `to` already `null`, so there is no
 * value in scope for this file to print by accident — which is the point of
 * splitting them. The rule is a property of a pure function with its own
 * tests, not of a JSX expression somebody might edit.
 *
 * The masked value is not shown even as a mask. `********Ly5Hs` is four
 * characters of a real credential printed next to the name of the key it
 * belongs to; the Credentials section (#349) shows a hint because an operator
 * there is matching a value they hold, and a history has no such job.
 */

import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';

import {
  describeSecretEffect,
  type AuditChange,
} from '../../config/auditHistory';

export interface AuditChangeCellProps {
  changes: AuditChange[];
}

/** Monospace, so `30000` and `null` are legible as values rather than prose. */
const VALUE_SX = {
  fontFamily: 'monospace',
  fontSize: '0.8125rem',
  wordBreak: 'break-word',
} as const;

export function AuditChangeCell({ changes }: AuditChangeCellProps) {
  if (changes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No details recorded
      </Typography>
    );
  }

  return (
    <Stack spacing={0.5} sx={{ minWidth: 0, py: 0.5 }}>
      {changes.map((change) => (
        <Box key={change.field} sx={{ minWidth: 0 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            component="span"
            sx={{ mr: 0.5 }}
          >
            {change.field}
          </Typography>
          {change.secret && change.effect ? (
            <Tooltip
              title={
                'The value is not in the audit row and is not shown here. ' +
                'What was recorded is that it changed, and by whom.'
              }
              enterTouchDelay={0}
            >
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                icon={<LockIcon fontSize="small" />}
                label={describeSecretEffect(change.effect)}
              />
            </Tooltip>
          ) : (
            <PlainChange change={change} />
          )}
        </Box>
      ))}
    </Stack>
  );
}

/**
 * A non-secret change.
 *
 * `from` is drawn only when the writer actually recorded one. Most writers do
 * not — the allowlist records `{ email }` and nothing else — and rendering
 * "not set → x@example.com" for those would claim a before-state the row never
 * asserted.
 */
function PlainChange({ change }: { change: AuditChange }) {
  return (
    <Typography component="span" sx={VALUE_SX}>
      {change.from !== null && (
        <>
          <Box component="span" sx={{ color: 'text.secondary' }}>
            {change.from}
          </Box>
          {sourceSuffix(change.fromSource)}
          <Box component="span" sx={{ mx: 0.5 }}>
            →
          </Box>
        </>
      )}
      {change.to ?? 'not recorded'}
      {sourceSuffix(change.toSource)}
    </Typography>
  );
}

/**
 * Where a settings value came from — `default`, `env` or `database`.
 *
 * Epic #332's first design rule is that configured and observed are different
 * facts, and for operator settings the layer a value resolved from is half of
 * what "it changed" means: clearing a database row does not restore the code's
 * default if the environment still names a value.
 */
function sourceSuffix(source: string | undefined) {
  if (!source) return null;
  return (
    <Box component="span" sx={{ color: 'text.secondary', ml: 0.5 }}>
      ({source})
    </Box>
  );
}

export default AuditChangeCell;
