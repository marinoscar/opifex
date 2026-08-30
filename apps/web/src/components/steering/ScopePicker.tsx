/**
 * Where an instruction applies, chosen from what exists (#460, epic #457).
 *
 * ## Why this replaced a text box
 *
 * The field this stands in for was `Repository (optional)`, free text, no
 * autocomplete and no check against the registered set. A typo came back
 * `repository-not-registered`; a plausible but wrong slug scoped the
 * instruction to a real repository the operator was not thinking about, and
 * neither failure was visible until the proposal returned. Every option here
 * is built from a row the API served, so an unregistered slug is not
 * expressible at all — the failure is removed rather than reported.
 *
 * ## What it offers, and why the unassigned bucket is not an afterthought
 *
 * ADR-0020's four scopes: a repository, a project, `projectId: null`, or every
 * observed repository. `schema.prisma` calls a project "an organisational
 * convenience, not a tenancy boundary", so on any deployment registered before
 * #404 every repository is unassigned and a picker offering only projects
 * would reach nothing at all. `buildScopeCatalogue` lists the bucket whenever
 * anything is in it, beside the projects rather than under them.
 *
 * ## One repository is not a choice
 *
 * With exactly one registered repository this renders a SENTENCE, not a
 * select. ADR-0020 leaves that deployment alone deliberately — the API
 * resolves both a bare `#12` and an "everything else" sweep against the single
 * repository with no scope supplied — and a control with one entry is friction
 * with no risk behind it, which teaches an operator to click past the thing
 * they are meant to read.
 *
 * ## The selection stays on screen
 *
 * The control sits above the instruction and its description is rendered under
 * it, so what the instruction reaches is readable at the moment it is being
 * written. The composer repeats it as a chip beside Propose, because the last
 * thing worth re-reading before writing labels to somebody else's backlog is
 * where they are going.
 */

import {
  Alert,
  Box,
  Chip,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import type { ScopeCatalogue, ScopeOption } from '../../config/steeringScope';

export interface ScopePickerProps {
  catalogue: ScopeCatalogue;
  isLoading: boolean;
  /** Why the lists could not be read. Rendered instead of a half-built list. */
  error: string | null;
  /** A list ran past the page cap and is incomplete. */
  truncated: boolean;
  /** The option currently chosen. Always one; `UNSCOPED` before any choice. */
  selected: ScopeOption;
  disabled: boolean;
  onSelect: (id: string) => void;
}

export function ScopePicker({
  catalogue,
  isLoading,
  error,
  truncated,
  selected,
  disabled,
  onSelect,
}: ScopePickerProps) {
  if (isLoading) {
    return (
      <Skeleton variant="rounded" height={56} aria-label="Loading scope" />
    );
  }

  if (error !== null) {
    return (
      <Alert severity="warning">
        {error} Every issue has to be written out as owner/name#12 until this
        can be read, and an instruction that holds everything else will be
        refused rather than swept.
      </Alert>
    );
  }

  // Nothing registered. Said plainly rather than as an empty select, which
  // would read like a list that had not loaded.
  if (catalogue.registered === 0) {
    return (
      <Alert severity="info">
        No repository is registered with Opifex, so steering can reach nothing
        yet. Register one on the Projects screen first.
      </Alert>
    );
  }

  // Exactly one. Named, never offered as a choice — see the header.
  if (catalogue.onlyRepository !== null) {
    return (
      <Alert severity="info" icon={false}>
        <Typography variant="body2">
          Everything applies to <strong>{catalogue.onlyRepository}</strong>, the
          only repository Opifex observes. A bare #12 means an issue in it, and
          there is nothing else for “everything else” to reach.
        </Typography>
      </Alert>
    );
  }

  return (
    <Box>
      <TextField
        select
        fullWidth
        size="small"
        label="Scope"
        id="steering-scope"
        value={selected.id}
        disabled={disabled}
        onChange={(event) => onSelect(event.target.value)}
        slotProps={{
          select: {
            // Long option descriptions make each row two lines; the menu has
            // to be scrollable rather than taller than the viewport.
            MenuProps: { slotProps: { paper: { sx: { maxHeight: 420 } } } },
            // The closed control shows the LABEL, not the menu row: the
            // default would render the option's two-line body inside a
            // single-line input. The description is rendered under the control
            // instead of as helper text, because it is a sentence about
            // consequences rather than a hint about how to use a select.
            renderValue: () => selected.label,
          },
        }}
      >
        {catalogue.options.map((option) => (
          <MenuItem key={option.id} value={option.id}>
            <Stack sx={{ py: 0.25 }}>
              <Typography variant="body2">{option.label}</Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ whiteSpace: 'normal' }}
              >
                {option.description}
              </Typography>
            </Stack>
          </MenuItem>
        ))}
      </TextField>

      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 0.75, alignItems: 'flex-start' }}
      >
        <Chip
          size="small"
          label={selected.label}
          // The one scope worth colouring: it reaches every repository the
          // deployment observes, including ones nobody named.
          color={selected.kind === 'all-repositories' ? 'warning' : 'default'}
          variant={selected.kind === 'unscoped' ? 'outlined' : 'filled'}
        />
        <Typography variant="caption" color="text.secondary">
          {selected.description}
        </Typography>
      </Stack>

      {truncated && (
        <Typography variant="caption" color="warning.main" component="p">
          More repositories or projects are registered than this list holds, so
          it is incomplete. Name the issues as owner/name#12 if the one you want
          is missing.
        </Typography>
      )}
    </Box>
  );
}

export default ScopePicker;
