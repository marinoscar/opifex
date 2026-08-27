/**
 * Repositories — a signpost, since they are managed on `/projects` (#406,
 * epic #403).
 *
 * The enablement ladder (#350) and the add picker (#401) were both built here,
 * and both moved. The operator's objection is the reason: *"repository
 * selection should not be a configuration, should be a main feature like
 * projects."* Adding a repository, walking it up the ladder and retiring it
 * are the work, not the settings for the work.
 *
 * ## The section stays, exactly as #394 left one for the supervisor model
 *
 * Deleting it would be quietly incomplete in a worse way than a duplicate
 * editor: an operator who came to the Control Center looking for the
 * enablement ladder — because that is where it was, and because the Readiness
 * chain still counts registered repositories — would find nothing at all and
 * conclude the feature was removed. So the section is still listed, still
 * opens, and names where the controls went.
 *
 * ## And it is a signpost rather than a second editor
 *
 * Two screens that both write `PATCH /repositories/:id` would be two places to
 * look for the same switch and two places for it to disagree. This one reads
 * nothing and writes nothing.
 */

import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Stack,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { LADDER_RUNGS } from '../../config/repositoryLadder';

export interface RepositoriesSectionProps {
  /** `projects:write` — the string `RepositoriesController.update` enforces. */
  canWrite: boolean;
}

export function RepositoriesSection({ canWrite }: RepositoriesSectionProps) {
  return (
    <Box>
      <Alert severity="info" variant="outlined">
        <AlertTitle>Managed on Projects</AlertTitle>
        Registering a repository, walking it up the enablement ladder, retiring
        it and filing it into a project all happen on the Projects destination
        in the main menu. That is the operator&apos;s own correction: repository
        selection is a feature, not a setting.
        <Box sx={{ mt: 1 }}>
          <Button
            size="small"
            variant="contained"
            component={RouterLink}
            to="/projects"
          >
            Go to Projects
          </Button>
        </Box>
      </Alert>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        {ladderSentence()}
      </Typography>

      <Stack component="ol" spacing={0.5} sx={{ mt: 1, pl: 3 }}>
        {LADDER_RUNGS.map((rung) => (
          <Typography
            component="li"
            variant="body2"
            color="text.secondary"
            key={rung.key}
          >
            <strong>{rung.title}</strong> — {rung.permits}
          </Typography>
        ))}
      </Stack>

      {!canWrite && (
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          Changing any of this needs <code>projects:write</code>, which this
          account does not hold. Projects will open read-only.
        </Alert>
      )}
    </Box>
  );
}

/**
 * The ladder said once, in its own order.
 *
 * Built from `LADDER_RUNGS` rather than typed out, so a rung added or
 * reordered cannot leave this sentence describing the previous design.
 */
function ladderSentence(): string {
  const names = LADDER_RUNGS.map((rung) => rung.title.toLowerCase()).join(
    ', then ',
  );
  return (
    `Each repository is enabled in stages — ${names} — because the ` +
    'observation week has to end one repository at a time, and reading, ' +
    'writing a label and running are three different permissions to grant.'
  );
}

export default RepositoriesSection;
