/**
 * "There is nothing here, and that is the real answer."
 *
 * Epic #19. The counterpart to `NotWiredState`, and the two being SEPARATE
 * components is the honesty mechanism rather than redundancy:
 *
 *   `EmptyState`     — we asked, the answer was zero. On the attention panel
 *                      that is the best news the cockpit can deliver.
 *   `NotWiredState`  — we did not ask, because there is nobody to ask yet.
 *
 * On the same panel, "no escalations because nothing needs attention" and "no
 * escalations because the watchdog does not exist" are OPPOSITE meanings. An
 * operator who reads the second as the first has been told their runs are
 * healthy by a component that has never looked at a run. For a supervision
 * tool that is the single most expensive mistake the UI can make, so the two
 * are held apart in the type system and in the pixels:
 *
 *   - `EmptyState` is confident: solid surface, a positive icon, normal body
 *     text, and an optional action ("View all runs").
 *   - `NotWiredState` is recessive: dashed border, no background, disabled-tier
 *     text, and a roadmap phase instead of an action.
 *
 * The tests assert they do not render alike; do not "unify" them.
 */

import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import type { SvgIconComponent } from '@mui/icons-material';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';

export interface EmptyStateProps {
  /** The finding, stated as a fact: "Nothing needs attention." */
  title: string;
  /** Optional second line — what would put something here. */
  detail?: string;
  /** Optional call to action; a link to the full list, usually. */
  action?: ReactNode;
  /**
   * Defaults to a check mark, because on this dashboard empty overwhelmingly
   * means healthy. Override where zero is merely neutral (an idle queue) so the
   * screen does not congratulate the operator for having no work scheduled.
   */
  Icon?: SvgIconComponent;
}

export function EmptyState({
  title,
  detail,
  action,
  Icon = CheckCircleOutlinedIcon,
}: EmptyStateProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 1,
        px: 2,
        py: 4,
      }}
    >
      {/* Decorative: the title already says it, and an announced "check circle
          icon" only adds noise to the one screen reader users most need to be
          able to skim. */}
      <Icon aria-hidden sx={{ fontSize: 32, color: 'text.secondary' }} />

      {/* `body1`, not `text.disabled`: this is a REPORTED result, and a result
          that is greyed out reads as a component that gave up. */}
      <Typography variant="body1" component="p" color="text.primary">
        {title}
      </Typography>

      {detail && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ maxWidth: 480 }}
        >
          {detail}
        </Typography>
      )}

      {action && <Box sx={{ mt: 1 }}>{action}</Box>}
    </Box>
  );
}

export default EmptyState;
