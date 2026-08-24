/**
 * Which watchdog checks are actually protecting THIS run (#104, epic #23).
 *
 * VISION §6 states the ambition and the honest limit in the same breath:
 * *"equal observability across vendors is not achievable. A common floor that
 * some runners exceed is."* This panel is that floor made visible for one run,
 * and #104's acceptance criterion is the sentence it has to be able to say:
 * *"an operator seeing 'loop detection: unavailable on this runner'
 * understands the risk they are carrying."*
 *
 * ## The one failure this panel exists to prevent
 *
 * > A check that is **unavailable** must report itself as unavailable, not
 * > silently pass. A tool-loop detector that quietly does nothing on a
 * > non-streaming runner looks identical, in the cockpit, to one that ran and
 * > found no loop — and that is worse than not having the check, because it
 * > manufactures false confidence.
 *
 * The API half of the issue derives the fact; this is where the fact either
 * reaches a human or doesn't. Three rules follow from it, and all three are
 * enforced by tests in `__tests__/components/runs/WatchdogCoveragePanel.test.tsx`:
 *
 *  1. `unavailable` never renders as green, as a tick, or as any affordance
 *     that reads like "fine". The chip is grey with a struck-through-eye icon
 *     and the word "Unavailable"; nothing in an unavailable row says "Active".
 *  2. `unavailable` never renders as a red error either. Nothing FAILED — a
 *     capability is absent, and it is not fixable except by changing runners.
 *     A red badge nobody can clear is a red badge everybody learns to ignore.
 *  3. Every row prints the API's `reason`, on EVERY status including `active`.
 *     The API populates it unconditionally for exactly this reason, and its
 *     own docblock says why: a UI that only explains itself when something is
 *     wrong teaches operators that a quiet badge means "nothing to explain",
 *     which is the habit that makes an unavailable check easy to skim past.
 *
 * ## Causes are shown next to effects
 *
 * `runnerKey`, `streamingFidelity` and `rateLimitSignal` are WHY the coverage
 * is what it is. A panel that showed only the four verdicts would send an
 * operator hunting through a capability manifest to answer "why?", so the
 * declarations sit at the top of the panel, above the checks they produced.
 *
 * ## Nothing here re-derives what a check means
 *
 * `signal` and `reason` are server-authored prose, rendered verbatim; the
 * display name is derived mechanically from the check id
 * (`watchdogFormat.ts`). There is no client-side table of what the four checks
 * do, because a second copy of the taxonomy is a copy that can disagree with
 * the detector that actually runs — and the disagreement would look exactly as
 * authoritative as the truth.
 */

import { Box, Card, CardContent, Divider, Grid, Stack } from '@mui/material';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { CheckStatusChip } from './CheckStatusChip';
import {
  formatCheckName,
  formatDeclaration,
  formatThresholdMs,
} from './watchdogFormat';
import {
  getCheckStatusDescriptor,
  isGuardedStatus,
} from '../../config/watchdogCoverage';
import { statusTokens } from '../../theme/tokens';
import type { CheckCoverage, RunCheckCoverage } from '../../types/cockpit';

export interface WatchdogCoveragePanelProps {
  coverage: RunCheckCoverage;
}

export function WatchdogCoveragePanel({
  coverage,
}: WatchdogCoveragePanelProps) {
  return (
    <Card component="section" aria-labelledby="watchdog-coverage-heading">
      <CardContent>
        <Typography variant="h6" id="watchdog-coverage-heading" gutterBottom>
          Watchdog coverage
        </Typography>
        <Typography variant="body2" color="text.secondary">
          What the control plane can and cannot see on this run. Derived from
          the runner&apos;s declared capabilities, not from what the checks
          found — a check listed here as unavailable did not pass, it never ran.
        </Typography>

        <Divider sx={{ my: 2 }} />

        <CoverageSummary coverage={coverage} />
        <Declarations coverage={coverage} />

        <Stack spacing={2} sx={{ mt: 2 }} divider={<Divider flexItem />}>
          {coverage.checks.map((check) => (
            <CheckRow key={check.check} check={check} />
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * The panel-level rollup, so an operator scanning the page learns "this run is
 * missing a check" without reading four rows.
 *
 * Painted from the SAME status tokens the chips use rather than from a MUI
 * `Alert` severity, and that is the load-bearing decision here. MUI's
 * severities are `success`/`info`/`warning`/`error`, and the only two an
 * `unavailable` rollup could plausibly claim are the two this issue forbids:
 * a green success banner is the false confidence #104 is about, and a red
 * error banner asserts a breakage that did not happen. Reusing the token
 * vocabulary keeps the summary in the same three-way register as the rows
 * beneath it, so "grey" means the same thing everywhere on the panel.
 *
 * `weakest` comes from the server. The counts below are arithmetic over the
 * rows already on screen — not a second opinion about severity.
 */
function CoverageSummary({ coverage }: { coverage: RunCheckCoverage }) {
  const theme = useTheme();
  const descriptor = getCheckStatusDescriptor(coverage.weakest);
  const token =
    statusTokens[theme.palette.mode === 'dark' ? 'dark' : 'light'][
      descriptor.token
    ];
  const Icon = descriptor.Icon;

  const unguarded = coverage.checks.filter(
    (check) => !isGuardedStatus(check.status),
  );
  const degraded = coverage.checks.filter(
    (check) => check.status === 'degraded',
  );
  const total = coverage.checks.length;

  return (
    <Box
      // `status` rather than `alert`: this is a standing description of the
      // run, not an interruption, and it is present on every run detail page
      // including the entirely healthy ones.
      role="status"
      data-weakest={coverage.weakest}
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        p: 2,
        borderRadius: 1,
        border: 1,
        borderColor: token.fg,
        backgroundColor: token.surface,
        color: token.fg,
      }}
    >
      <Icon fontSize="small" sx={{ mt: '2px', flexShrink: 0 }} />
      <Box>
        <Typography variant="subtitle2" component="p">
          {summaryHeadline(coverage.weakest)}
        </Typography>
        <Typography variant="body2" component="p" sx={{ mt: 0.5 }}>
          {unguarded.length > 0
            ? `${unguarded.length} of ${total} checks cannot run on this runner: ${unguarded
                .map((check) => formatCheckName(check.check))
                .join(
                  ', ',
                )}. The failure modes they guard are unguarded on this run.`
            : degraded.length > 0
              ? `${degraded.length} of ${total} checks are running on a weaker signal or a coarser threshold. All ${total} are watching, but detection is slower or approximate.`
              : `All ${total} checks are protecting this run as designed.`}
        </Typography>
      </Box>
    </Box>
  );
}

/**
 * The headline is written per status rather than derived from the counts, so
 * the `unavailable` case gets the plainest sentence in the file. "Some checks
 * are degraded" would have been true of it and useless.
 */
function summaryHeadline(weakest: RunCheckCoverage['weakest']): string {
  switch (weakest) {
    case 'active':
      return 'Fully covered';
    case 'degraded':
      return 'Covered, with reduced sensitivity';
    case 'unavailable':
      return 'Not fully covered — a check is missing on this runner';
  }
}

/**
 * The three declarations that produced everything below.
 *
 * `formatDeclaration` renders a null as "No manifest filed" rather than
 * "None", and the distinction is not cosmetic: `none` is a runner that told us
 * it streams nothing, null is a runner that told us nothing at all. The second
 * is the more alarming fact and has a different remedy — register the runner.
 */
function Declarations({ coverage }: { coverage: RunCheckCoverage }) {
  return (
    <Grid container spacing={2} sx={{ mt: 2 }}>
      <Declaration label="Runner" value={coverage.runnerKey} />
      <Declaration
        label="Streaming fidelity"
        value={formatDeclaration(coverage.streamingFidelity)}
      />
      <Declaration
        label="Rate-limit signal"
        value={formatDeclaration(coverage.rateLimitSignal)}
      />
    </Grid>
  );
}

function Declaration({ label, value }: { label: string; value: string }) {
  return (
    <Grid size={{ xs: 12, sm: 4 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        {label}
      </Typography>
      <Typography variant="body1" sx={{ wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Grid>
  );
}

/**
 * One check.
 *
 * The name and the chip share a line and wrap together on narrow viewports —
 * a status that ends up on its own line, away from the check it belongs to, is
 * a status that can be read against the wrong row.
 */
function CheckRow({ check }: { check: CheckCoverage }) {
  return (
    <Box data-check={check.check}>
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Typography variant="subtitle1" component="h3">
          {formatCheckName(check.check)}
        </Typography>
        <CheckStatusChip status={check.status} />
        {check.thresholdMs !== null && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            Threshold {formatThresholdMs(check.thresholdMs)}
          </Typography>
        )}
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        Watching: {check.signal}
      </Typography>

      {/*
        The reason, on EVERY status. Rendering it only when something is wrong
        would make a silent row mean "nothing to explain" — the reading that
        lets an unavailable check pass for a healthy one.
      */}
      <Typography variant="body2" sx={{ mt: 0.5 }}>
        {check.reason}
      </Typography>
    </Box>
  );
}

export default WatchdogCoveragePanel;
