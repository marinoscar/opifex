/**
 * The honest not-yet-wired state.
 *
 * Epic #19. `apps/api` has no runs, queue, projects, cost or metrics module and
 * `schema.prisma` has zero domain models, so most of the cockpit has nothing to
 * render. This component is what it renders instead, everywhere, so that
 * "unbuilt" has exactly one appearance in the app.
 *
 * ## The honesty contract — the reason this file exists
 *
 * 1. An unwired value shows `—`, NEVER `0`. Zero is a measurement; the whole
 *    failure mode here is a cockpit that reports a number nobody computed.
 * 2. It still shows what WILL be measured, and what that means. VISION §10 says
 *    the web app exists primarily to show the six success metrics — so a tile
 *    that teaches its own definition is doing the app's job even with no data
 *    behind it.
 * 3. It names the roadmap phase that will supply the data. "Coming soon" is not
 *    a claim anyone can check; "Phase 4 — Execution" is.
 * 4. No sparkline, no shimmer skeleton, no relative timestamp. A shimmer
 *    promises data arriving in a moment. This data is arriving in a quarter.
 * 5. Visually RECESSIVE — dashed border, secondary text, no elevation — so a
 *    screenful of these reads as "not built yet" rather than as "broken". That
 *    distinction is the difference between a roadmap and an outage.
 * 6. NOT `aria-hidden`. The explanation is wired to the title through
 *    `aria-describedby`, so a screen reader user gets the same "why is this
 *    empty" answer a sighted user gets from the caption.
 *
 * ## Why this is not `EmptyState`
 *
 * "Nothing to show" and "nothing to show YET, and here is why" are different
 * claims about the world. A wired panel reporting zero runs is GOOD NEWS; an
 * unwired one reporting nothing is an absence of news. Rendering them
 * identically would let the operator read one as the other, which for a
 * supervision tool is the single most expensive mistake the UI can make.
 */

import { useId } from 'react';
import { Box, Typography } from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';
import ConstructionIcon from '@mui/icons-material/Construction';

export interface NotWiredStateProps {
  /** What this surface will show, once it can. */
  title: string;
  /** One or two sentences: what it will mean, and why it is absent today. */
  detail: string;
  /** The roadmap phase that supplies it, verbatim from VISION §12. */
  phase: string;
  /** Override only where the default construction glyph would be misleading. */
  Icon?: SvgIconComponent;
  /** `compact` fits inside a panel body; `page` is the standalone page state. */
  variant?: 'compact' | 'page';
}

export function NotWiredState({
  title,
  detail,
  phase,
  Icon = ConstructionIcon,
  variant = 'page',
}: NotWiredStateProps) {
  const detailId = useId();
  const phaseId = useId();

  const isPage = variant === 'page';

  return (
    <Box
      sx={{
        // A DASHED border, not a solid one. Solid reads as a card that failed
        // to fill; dashed reads as a placeholder, which is what this is.
        border: '1px dashed',
        borderColor: 'divider',
        borderRadius: 2,
        px: { xs: 2, sm: 4 },
        py: isPage ? { xs: 4, sm: 6 } : 3,
        textAlign: 'center',
        // No background and no elevation: the panel must sit BEHIND real
        // content in the visual hierarchy, not beside it.
        backgroundColor: 'transparent',
      }}
    >
      <Icon
        // Decorative: everything it conveys is in the text below it, and an
        // announced "construction icon" adds nothing but noise.
        aria-hidden
        sx={{ fontSize: isPage ? 40 : 28, color: 'text.disabled', mb: 1 }}
      />

      <Typography
        variant={isPage ? 'h6' : 'subtitle1'}
        component="p"
        color="text.secondary"
        aria-describedby={`${detailId} ${phaseId}`}
        sx={{ fontWeight: 500 }}
      >
        {title}
      </Typography>

      <Typography
        id={detailId}
        variant="body2"
        color="text.secondary"
        sx={{ mt: 1, mx: 'auto', maxWidth: 560 }}
      >
        {detail}
      </Typography>

      <Typography
        id={phaseId}
        variant="caption"
        component="p"
        color="text.disabled"
        sx={{ mt: 2 }}
      >
        Arrives in {phase}
      </Typography>
    </Box>
  );
}

export default NotWiredState;
