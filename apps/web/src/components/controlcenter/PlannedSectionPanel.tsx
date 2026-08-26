/**
 * A Control Center section that is declared but not built (#347, epic #332).
 *
 * The four remaining sections — #348, #349, #350, #351 — are reachable from
 * the day the shell lands, and each says what it will hold and which issue
 * delivers it. That follows `config/cockpitApi.ts`'s rule for unwired panels:
 * the shape of the thing is part of what the app communicates, and "coming
 * soon" is not a claim anyone can check while "arrives in #350" is.
 *
 * It reuses `NotWiredState` rather than inventing a second appearance for
 * "unbuilt", which is the whole reason that component exists — a screen that
 * looked recessive-but-different would read as broken instead of as planned.
 */

import { Box, Typography } from '@mui/material';

import { NotWiredState } from '../common/NotWiredState';
import type { ControlCenterSection } from '../../config/controlCenter';

export interface PlannedSectionPanelProps {
  section: ControlCenterSection;
}

export function PlannedSectionPanel({ section }: PlannedSectionPanelProps) {
  return (
    <Box>
      <NotWiredState
        title={`${section.label} is not built yet`}
        detail={`${section.description} Tracked by issue #${section.issue}.`}
        phase={section.phase}
        Icon={section.Icon}
      />
      <Typography
        variant="caption"
        component="p"
        color="text.secondary"
        sx={{ mt: 2, textAlign: 'center' }}
      >
        Until then this is configured in <code>infra/compose/.env</code> and
        applied by recreating the container.
      </Typography>
    </Box>
  );
}

export default PlannedSectionPanel;
