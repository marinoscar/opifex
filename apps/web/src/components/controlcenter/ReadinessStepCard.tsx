/**
 * One link in the readiness chain (#347, epic #332).
 *
 * The card's layout is the epic's first design rule made visual: **observed
 * and configured sit side by side**, in two labelled boxes, and neither is
 * ever derived from the other. `DISPATCH_ENABLED=true` next to
 * `dispatchable: 0` is the most useful sentence this UI can say, and it can
 * only say it if the two facts have their own places to be.
 *
 * Every fact names the endpoint that produced it. A reader must be able to run
 * the same request and read the same sentence — otherwise the card is asking
 * to be believed rather than checked.
 */

import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import ScienceIcon from '@mui/icons-material/Science';
import type { SvgIconComponent } from '@mui/icons-material';

import type {
  ReadinessFact,
  ReadinessStep,
  ReadinessVerdict,
} from '../../config/readiness';

/**
 * How each verdict presents itself.
 *
 * `unverifiable` and `unknown` deliberately do NOT share a look. One means
 * nothing can answer this yet and the other means this read did not get an
 * answer; an operator's next move is different for each, and a shared grey
 * chip would ask them to guess which they were looking at.
 *
 * Colours are palette tokens, never literals, so both themes are handled by
 * the theme rather than by this file.
 */
export const VERDICT_DESCRIPTORS: Record<
  ReadinessVerdict,
  { label: string; color: string; Icon: SvgIconComponent }
> = {
  pass: { label: 'Verified', color: 'success.main', Icon: CheckCircleIcon },
  blocked: { label: 'Blocked', color: 'error.main', Icon: CancelIcon },
  unverifiable: {
    label: 'Not yet verifiable',
    color: 'warning.main',
    Icon: ScienceIcon,
  },
  unknown: {
    label: 'Could not read',
    color: 'text.disabled',
    Icon: HelpOutlineIcon,
  },
};

export interface ReadinessStepCardProps {
  step: ReadinessStep;
  /** Called with the section that owns the fix. */
  onNavigateToFix: (step: ReadinessStep) => void;
}

export function ReadinessStepCard({
  step,
  onNavigateToFix,
}: ReadinessStepCardProps) {
  const descriptor = VERDICT_DESCRIPTORS[step.verdict];
  const { Icon } = descriptor;

  return (
    <Paper
      variant="outlined"
      component="li"
      sx={{ p: { xs: 2, sm: 3 }, listStyle: 'none' }}
      aria-label={`Step ${step.ordinal}: ${step.title}`}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
        }}
      >
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <Icon aria-hidden sx={{ color: descriptor.color }} />
          <Typography variant="h6" component="h3">
            {step.ordinal}. {step.title}
          </Typography>
        </Stack>
        {/* The verdict is a WORD, not only a colour: a red dot and an amber
            dot are the same dot to a colour-blind operator, and this screen's
            whole point is a distinction between four states. */}
        <Chip
          size="small"
          label={descriptor.label}
          sx={{ color: descriptor.color, borderColor: descriptor.color }}
          variant="outlined"
        />
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        {step.purpose}
      </Typography>

      {(step.observed || step.configured) && (
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          sx={{ mt: 2 }}
        >
          <FactBox
            heading="Observed"
            explanation="What a probe found."
            fact={step.observed}
            absent="Nothing probes this."
          />
          <FactBox
            heading="Configured"
            explanation="What an operator permitted."
            fact={step.configured}
            absent="No endpoint reports this yet."
          />
        </Stack>
      )}

      <Typography variant="body2" sx={{ mt: 2 }}>
        {step.detail}
      </Typography>

      {step.caveat && (
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          {step.caveat}
        </Alert>
      )}

      {step.verdict !== 'pass' && (
        <Box sx={{ mt: 2 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => onNavigateToFix(step)}
          >
            {step.fix.label}
          </Button>
          {step.fix.today && (
            <Typography
              variant="caption"
              component="p"
              color="text.secondary"
              sx={{ mt: 1 }}
            >
              {step.fix.today}
            </Typography>
          )}
        </Box>
      )}
    </Paper>
  );
}

/**
 * One half of the side-by-side pair.
 *
 * Renders even when its fact is ABSENT, and says so. An empty column would
 * read as "nothing to report"; "Nothing probes this" is the report.
 */
function FactBox({
  heading,
  explanation,
  fact,
  absent,
}: {
  heading: string;
  explanation: string;
  fact: ReadinessFact | null;
  absent: string;
}) {
  return (
    <Box
      sx={{
        flex: 1,
        p: 1.5,
        borderRadius: 1,
        bgcolor: 'action.hover',
        minWidth: 0,
      }}
    >
      <Typography variant="overline" color="text.secondary" component="p">
        {heading}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p">
        {explanation}
      </Typography>
      {fact ? (
        <>
          <Typography
            variant="body2"
            sx={{ mt: 0.5, fontFamily: 'monospace', wordBreak: 'break-word' }}
          >
            {fact.statement}
          </Typography>
          <Typography
            variant="caption"
            component="p"
            color="text.secondary"
            sx={{ mt: 0.5, wordBreak: 'break-word' }}
          >
            {fact.source}
          </Typography>
        </>
      ) : (
        <Typography variant="body2" color="text.disabled" sx={{ mt: 0.5 }}>
          {absent}
        </Typography>
      )}
    </Box>
  );
}

export default ReadinessStepCard;
