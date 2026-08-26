/**
 * Readiness — `docs/RUNBOOK-enable-claude-code-local.md` rendered live
 * (#347, epic #332).
 *
 * The runbook's four steps plus the per-repository one the epic adds, each
 * with the observable that proves it and a way to the setting that fixes it.
 * The chain itself is built in `config/readiness.ts`, which is pure; this file
 * only draws it.
 *
 * ## The summary counts rather than concluding
 *
 * There is no single "ready / not ready" verdict at the top, and that is
 * deliberate. Two of the five steps have no probe behind them today, so any
 * overall verdict would be a claim resting on facts nobody has checked —
 * precisely the failure epic #324 documented, where an unauthenticated CLI
 * registered as a healthy runner. Counting the four kinds of answer leaves the
 * conclusion where it belongs.
 */

import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';

import { LoadingSpinner } from '../common/LoadingSpinner';
import { ReadinessStepCard } from './ReadinessStepCard';
import type { ControlCenterSectionKey } from '../../config/controlCenter';
import type { ReadinessStep, ReadinessSummary } from '../../config/readiness';

export interface ReadinessSectionProps {
  steps: ReadinessStep[];
  summary: ReadinessSummary;
  isLoading: boolean;
  isRefreshing: boolean;
  lastUpdatedAt: Date | null;
  onRefresh: () => void;
  onNavigateToSection: (section: ControlCenterSectionKey) => void;
}

export function ReadinessSection({
  steps,
  summary,
  isLoading,
  isRefreshing,
  lastUpdatedAt,
  onRefresh,
  onNavigateToSection,
}: ReadinessSectionProps) {
  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          mb: 2,
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {summariseInWords(summary)}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {/* The timestamp is when the observations were READ, never when the
              page was drawn. A screen that says "now" while showing a
              five-minute-old fleet is the lie this whole screen is against. */}
          <Typography variant="caption" color="text.secondary">
            {lastUpdatedAt
              ? `Observed at ${lastUpdatedAt.toLocaleTimeString()}`
              : 'Not yet observed'}
          </Typography>
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            Re-check
          </Button>
        </Stack>
      </Stack>

      {summary.unverifiable > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {unverifiableNotice(summary.unverifiable)}
        </Alert>
      )}

      <Stack component="ul" spacing={2} sx={{ p: 0, m: 0 }}>
        {steps.map((step) => (
          <ReadinessStepCard
            key={step.id}
            step={step}
            onNavigateToFix={(target) =>
              onNavigateToSection(target.fix.section)
            }
          />
        ))}
      </Stack>
    </Box>
  );
}

/**
 * Why some steps are amber, said once at the top rather than five times.
 *
 * Built as a string rather than as JSX so the singular and plural forms are
 * legible here and cannot pick up a missing space from JSX whitespace
 * collapsing. This paragraph is the screen explaining its own honesty, and a
 * garbled one would undercut the thing it is explaining.
 */
function unverifiableNotice(count: number): string {
  const subject =
    count === 1
      ? 'One step has no probe behind it yet, so it is'
      : `${count} steps have no probe behind them yet, so they are`;

  return (
    `${subject} reported as not yet verifiable rather than assumed. That is ` +
    'the point: `claude --version` succeeds without credentials, so a green ' +
    'check inferred from the version probe would be the exact failure this ' +
    'chain exists to catch.'
  );
}

/** The count, as a sentence. Never a single overall verdict — see the header. */
function summariseInWords(summary: ReadinessSummary): string {
  const parts = [`${summary.pass} of ${summary.total} verified`];
  if (summary.blocked > 0) parts.push(`${summary.blocked} blocked`);
  if (summary.unverifiable > 0) {
    parts.push(`${summary.unverifiable} not yet verifiable`);
  }
  if (summary.unknown > 0) parts.push(`${summary.unknown} could not be read`);
  return parts.join(', ');
}

export default ReadinessSection;
