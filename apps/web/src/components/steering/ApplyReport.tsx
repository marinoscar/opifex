/**
 * What an applied proposal actually did, per issue (#426).
 *
 * The per-issue list is unconditional, for the reason `BulkSteerToolbar`'s is:
 * a headline can only be a summary, and the case where a summary is most
 * tempting — "18 of 20 applied" — is exactly the case where the operator needs
 * to know WHICH two, and why. Skipped issues are in the same list as applied
 * ones rather than in a section below it, so a failure cannot be scrolled past.
 *
 * `writesEnabled: false` is stated in the headline AND on every issue's own
 * line, in `queueSteering.ts`'s words, because an operator scanning the list
 * must not have to infer it from a banner above.
 */

import { Alert, AlertTitle, Box, Stack, Typography } from '@mui/material';

import {
  applyHeadline,
  applyOutcomes,
  driftLine,
  outcomeLine,
} from '../../config/steeringChat';
import type { SteeringApplyResult } from '../../types/steering';

export function ApplyReport({ result }: { result: SteeringApplyResult }) {
  const headline = applyHeadline(result);
  const outcomes = applyOutcomes(result);

  return (
    <Alert severity={headline.severity} data-testid="apply-report">
      <AlertTitle>{headline.title}</AlertTitle>
      <Typography variant="body2">{headline.body}</Typography>

      <Stack spacing={1} sx={{ mt: 1.5 }}>
        {outcomes.map((outcome) => (
          <Box key={`${outcome.kind}-${outcome.ref}`}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {outcome.ref}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {outcomeLine(outcome)}
            </Typography>
            {outcome.kind === 'skipped' &&
              outcome.skipped.drift.map((drift) => (
                <Typography
                  key={drift.label}
                  variant="body2"
                  color="text.secondary"
                >
                  {driftLine(drift)}
                </Typography>
              ))}
          </Box>
        ))}
      </Stack>

      {/* Said once more at the bottom, as a property of the deployment rather
          than of this run: the next apply will do the same thing. */}
      {!result.writesEnabled && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 1.5 }}
        >
          github.writesEnabled is off on this deployment, so every steer is
          recorded and none is performed until it is turned on.
        </Typography>
      )}
    </Alert>
  );
}
