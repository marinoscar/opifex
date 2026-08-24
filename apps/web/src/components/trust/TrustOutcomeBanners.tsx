/**
 * What happened to a revocation, and what happened to a demotion (#101).
 *
 * Both follow `ApprovalDetailPage`'s outcome banner: the union the hook
 * returns is rendered case by case rather than collapsed into one "error"
 * string, because the cases call for completely different things from the
 * operator.
 */

import { Alert, AlertTitle, Box } from '@mui/material';
import type {
  ClassDemotionOutcome,
  GrantRevocationOutcome,
} from '../../hooks/useTrustActions';

export function RevocationOutcomeBanner({
  outcome,
}: {
  outcome: GrantRevocationOutcome | null;
}) {
  if (!outcome) return null;

  if (outcome.kind === 'revoked') {
    return (
      <Alert severity="success" sx={{ mb: 2 }}>
        <AlertTitle>Revoked, and recorded as yours.</AlertTitle>
        This class stops running unattended in this repository from now on.
        Restoring trust means issuing a new grant — the row stays exactly as it
        is, because it is the record of what was trusted and why that stopped.
      </Alert>
    );
  }

  if (outcome.kind === 'already-ended') {
    // `info`, not `error`. Nothing was changed and the original end reason
    // stands — which is what the operator wanted. The API preserves it
    // deliberately: "revoked by Ana" overwriting "suspended: failure rate 62%
    // over 8 actions" would erase the only record of a class misbehaving.
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>It had already ended. Nothing was changed.</AlertTitle>
        {outcome.message}
        <Box component="span" sx={{ display: 'block', mt: 1 }}>
          Nothing further is needed: the grant authorizes nothing.
        </Box>
      </Alert>
    );
  }

  if (outcome.kind === 'forbidden') {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        <AlertTitle>Not revoked — the API refused it.</AlertTitle>
        {outcome.message} The grant is still active and still authorizing work.
      </Alert>
    );
  }

  return (
    <Alert severity="error" sx={{ mb: 2 }}>
      <AlertTitle>
        {outcome.kind === 'gone'
          ? 'No grant with that id.'
          : 'The revocation did not go through.'}
      </AlertTitle>
      {outcome.message}
      {outcome.kind === 'failed' && (
        <Box component="span" sx={{ display: 'block', mt: 1 }}>
          The grant may still be active. Nothing here has changed it.
        </Box>
      )}
    </Alert>
  );
}

export function DemotionOutcomeBanner({
  outcome,
}: {
  outcome: ClassDemotionOutcome | null;
}) {
  if (!outcome) return null;

  if (outcome.kind === 'demoted') {
    const { grantsSuspended, notified, rungMayBeRestoredByLadder, state } =
      outcome.result;

    return (
      <Alert
        // `warning` rather than `success` WHEN the rung may come back, because
        // the headline is then a caveat rather than a completion. The
        // suspension succeeded either way; what differs is whether the screen
        // is about to contradict itself an hour from now.
        severity={rungMayBeRestoredByLadder ? 'warning' : 'success'}
        sx={{ mb: 2 }}
        data-testid="demotion-outcome"
      >
        <AlertTitle>
          {state.actionClassTitle ?? state.actionClass} demoted.{' '}
          {grantsSuspended === 1
            ? '1 trust grant suspended.'
            : `${grantsSuspended} trust grants suspended.`}
        </AlertTitle>
        The suspension is durable: nothing re-creates a suspended grant, so
        nothing resumes running on its own.
        {rungMayBeRestoredByLadder && (
          <Box
            component="span"
            sx={{ display: 'block', mt: 1, fontWeight: 600 }}
            data-testid="rung-may-be-restored"
          >
            The RUNG may not stick. This class&rsquo;s record still clears the
            bar, so the next hourly evaluation is likely to put it back on the
            promoted rung. That does not un-suspend the grants — but the rung
            will read &ldquo;Promoted&rdquo; again, and that is the ladder, not
            your demotion being undone.
          </Box>
        )}
        {!notified && (
          <Box component="span" sx={{ display: 'block', mt: 1 }}>
            No notification was delivered. The demotion still happened; nobody
            else was told about it.
          </Box>
        )}
      </Alert>
    );
  }

  if (outcome.kind === 'not-promoted') {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>It was not on the promoted rung.</AlertTitle>
        {outcome.message}
      </Alert>
    );
  }

  return (
    <Alert severity="error" sx={{ mb: 2 }}>
      <AlertTitle>
        {outcome.kind === 'forbidden'
          ? 'Not demoted — the API refused it.'
          : 'The demotion did not go through.'}
      </AlertTitle>
      {outcome.message}
    </Alert>
  );
}
