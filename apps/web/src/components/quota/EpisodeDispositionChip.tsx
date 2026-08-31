/**
 * What Opifex did about a block — and, always, the observation behind it
 * (#476).
 *
 * ## `basis` is not optional decoration, it is half the component
 *
 * `dispositionBasis` is a sentence the API writes for every single row, naming
 * the stored fact each verdict was derived from: "the run is still blocked and
 * a resume is scheduled for …", "the run blocked again at …, which it could
 * not have done without running again in between", "nothing stored says: the
 * run is 'running', no resume is scheduled …". The API's own comment puts it
 * as a rule — *"a one-word column that cannot be audited is a column that gets
 * argued with"* — and a UI that rendered the word and dropped the sentence
 * would put that column right back.
 *
 * So the chip's tooltip is ALWAYS two parts: what the verdict means in
 * general, and what made it true for this row. The table additionally carries
 * the basis as its own column so it survives a CSV export and reaches a phone,
 * where hovering is not a gesture.
 *
 * ## `unknown` renders like every other value here, on purpose
 *
 * Not greyed out, not an em dash, not an empty cell: a chip with an icon, a
 * label reading "Not recorded", and its own basis sentence. It is a real
 * answer to "what did Opifex do" — the honest one — and the only thing that
 * distinguishes it visually is the absence of a status hue, which says it is
 * not a verdict without saying it is a failure.
 */

import { Box, Chip, Tooltip, Typography } from '@mui/material';
import type { ChipProps } from '@mui/material';
import { getEpisodeDispositionDescriptor } from '../../config/quotaHistory';
import type { EpisodeDisposition } from '../../types/quota';
import { useQuotaChipSx } from './quotaChipStyles';

export interface EpisodeDispositionChipProps {
  disposition: EpisodeDisposition;
  /**
   * The API's own sentence for THIS episode, rendered verbatim.
   *
   * Required rather than optional: every episode carries one, and making it
   * omissible would make dropping it the path of least resistance at the next
   * call site.
   */
  basis: string;
  /** `small` in table rows (the default), `medium` beside a heading. */
  size?: ChipProps['size'];
}

export function EpisodeDispositionChip({
  disposition,
  basis,
  size = 'small',
}: EpisodeDispositionChipProps) {
  const descriptor = getEpisodeDispositionDescriptor(disposition);
  const sx = useQuotaChipSx(descriptor.token);
  const Icon = descriptor.Icon;

  return (
    <Tooltip
      enterTouchDelay={0}
      title={
        <Box>
          <Typography variant="caption" component="div">
            {descriptor.description}
          </Typography>
          <Typography
            variant="caption"
            component="div"
            sx={{ mt: 0.5, fontStyle: 'italic' }}
          >
            {/* The API's wording, not a paraphrase of it. Prefixed only, so a
                reader can see where the claim stops and the evidence starts. */}
            Because {basis}.
          </Typography>
        </Box>
      }
    >
      {/*
        The span is required: it holds the tooltip's ref, and it gives touch
        users something to long-press that is not the chip's own ripple target.
      */}
      <span style={{ display: 'inline-flex' }}>
        <Chip
          size={size}
          icon={<Icon fontSize={size === 'small' ? 'small' : 'medium'} />}
          label={descriptor.label}
          variant="outlined"
          // The WIRE value, not the label: a test should assert the fact rather
          // than the phrasing.
          data-disposition={disposition}
          sx={sx}
        />
      </span>
    </Tooltip>
  );
}

export default EpisodeDispositionChip;
