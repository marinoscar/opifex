/**
 * One of VISION §10's six metrics, as a tile.
 *
 * Epic #19. This component is where the honesty contract from
 * `components/common/NotWiredState.tsx` is actually enforced for a NUMBER, so
 * each of its six points is implemented here explicitly:
 *
 *  1. An unwired or uncomputed value renders `—`. There is no code path in
 *     this file that can produce `0` from a `null`; `format()` is called only
 *     inside a `value !== null` branch, which is why `MetricDefinition.format`
 *     has no "no data" case to get wrong.
 *  2. The tile still shows its NAME, its definition and its "why" whatever the
 *     state. VISION §10 says the app exists primarily to show these six, and a
 *     tile that teaches what will be measured is doing that job with no data
 *     behind it.
 *  3. When unwired it names the roadmap phase that will supply it.
 *  4. No sparkline (a line needs two real samples — see `Sparkline`), no
 *     shimmer skeleton (a shimmer promises data in a moment; this data is a
 *     quarter away), no relative timestamp.
 *  5. Visually recessive when unwired — dashed border, no elevation,
 *     disabled-tier text — so six of them read "not built" and not "broken".
 *  6. Never `aria-hidden`. The definition and the explanation are wired to the
 *     tile through `aria-labelledby`/`aria-describedby`, so a screen reader
 *     user gets the same answer to "why is this blank" that the caption gives
 *     a sighted one.
 *
 * The value carries `className="opifex-num"` (tabular numerals — see the
 * `MuiCssBaseline` override in `theme/components.ts`). Without it a polled
 * figure reflows its own column on every tick and the stat row twitches, which
 * reads as instability in the system being watched rather than in the type.
 */

import { useId } from 'react';
import { Box, Typography } from '@mui/material';
import type { ResourceState } from '../../hooks/usePolledResource';
import type { MetricDefinition } from './metrics';
import { Sparkline, summarizeTrend } from './Sparkline';

export interface MetricTileProps {
  metric: MetricDefinition;
  /** `null` means "not computed". It renders `—`, never `0`. */
  value: number | null;
  /** The series behind the value, oldest first. `null` when there is none. */
  trend: readonly number[] | null;
  state: ResourceState;
  /** The roadmap phase, shown only in the `unwired` state. */
  phase?: string;
}

/**
 * Turn a trend into the sentence a screen reader actually reads.
 *
 * The direction alone is ambiguous — "rising" is good for first-pass
 * acceptance and bad for detection latency — so the metric's `direction`
 * decides the verdict word. This is the part of the sparkline that carries the
 * information; the drawing is decoration.
 */
export function describeTrend(metric: MetricDefinition, values: readonly number[]): string {
  const direction = summarizeTrend(values);

  if (direction === 'flat') {
    return `${metric.label} trend: unchanged over the last ${values.length} samples.`;
  }

  const isImprovement =
    direction === 'rising'
      ? metric.direction === 'higher-is-better'
      : metric.direction === 'lower-is-better';

  return `${metric.label} trend: ${direction} over the last ${values.length} samples — ${
    isImprovement ? 'better' : 'worse'
  }.`;
}

export function MetricTile({ metric, value, trend, state, phase }: MetricTileProps) {
  const labelId = useId();
  const helpId = useId();

  const isUnwired = state === 'unwired';
  // A sparkline needs two real samples. Everything else — one sample, an empty
  // array, `null` — draws nothing at all rather than a flat line.
  const hasTrend = !isUnwired && trend !== null && trend.length >= 2;

  return (
    <Box
      component="section"
      aria-labelledby={labelId}
      aria-describedby={helpId}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        p: 2,
        borderRadius: 2,
        // Dashed and flat when unwired, solid card when it has a real reading.
        // The two must be distinguishable at a glance across a row of six.
        border: '1px',
        borderStyle: isUnwired ? 'dashed' : 'solid',
        borderColor: 'divider',
        backgroundColor: isUnwired ? 'transparent' : 'background.paper',
      }}
    >
      <Typography
        id={labelId}
        variant="subtitle2"
        component="h3"
        color={isUnwired ? 'text.secondary' : 'text.primary'}
      >
        {metric.label}
      </Typography>

      {/* The definition, verbatim from VISION §10's metric name. Present in
          every state — point 2 of the contract. */}
      <Typography variant="caption" color="text.secondary">
        {metric.definition}
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, mt: 1 }}>
        <Typography
          variant="h4"
          component="p"
          // Tabular numerals. See the file header.
          className="opifex-num"
          color={value === null ? 'text.disabled' : 'text.primary'}
          sx={{ lineHeight: 1.1 }}
        >
          {/* An em dash, not a zero, not "N/A", not "0.0". */}
          {value === null ? '—' : metric.format(value)}
        </Typography>

        {hasTrend && (
          <Box sx={{ color: 'text.secondary', pb: 0.5 }}>
            <Sparkline values={trend} ariaLabel={describeTrend(metric, trend)} />
          </Box>
        )}
      </Box>

      {/* VISION §10's "Why" cell, verbatim, plus its target where one exists.
          Wired to the tile through `aria-describedby` above. */}
      <Typography id={helpId} variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
        {metric.help}
        {metric.target ? ` ${metric.target}` : ''}
      </Typography>

      {isUnwired && phase && (
        <Typography variant="caption" color="text.disabled" sx={{ mt: 'auto', pt: 1 }}>
          Arrives in {phase}
        </Typography>
      )}
    </Box>
  );
}

export default MetricTile;
