import { useCallback, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Container,
  Divider,
  Link,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import BlockIcon from '@mui/icons-material/Block';

import { TrustGrantStatusChip } from '../components/trust/TrustGrantStatusChip';
import { BudgetCell, ExpiryCell } from '../components/trust/GrantHeadroomCells';
import { RevokeGrantDialog } from '../components/trust/RevokeGrantDialog';
import { RevocationOutcomeBanner } from '../components/trust/TrustOutcomeBanners';
import {
  describeAutoRevoke,
  describeHeadroomWarning,
  formatFailureRate,
  formatPercent,
  formatUsd,
} from '../components/trust/trustFormat';
import { endReasonLabel, isAuthorizingGrant } from '../config/trustStatus';
import { useTrustGrant } from '../hooks/useTrustGrants';
import { useGrantRevocation } from '../hooks/useTrustActions';
import { usePermissions } from '../hooks/usePermissions';
import { formatRelativeTime } from '../utils/time';
import type { TrustGrantDetail } from '../types/trust';

/** The permission `TrustController.revoke` really enforces. */
const REVOKE_PERMISSION = 'trust:revoke';

/**
 * `/trust/grants/:id` — one grant, in full (#101, epic #22, VISION §8).
 *
 * The screen an operator reaches when they need to decide whether a grant
 * should keep standing. So the four attributes come first — scope, expiry,
 * budget ceiling, auto-revoke thresholds — with the usage measured against
 * each, and the revoke control is directly beneath them rather than at the
 * bottom of the page. Narrowing authority is the safe direction and must never
 * be the hardest thing on the screen.
 *
 * Below that: what the class actually DOES (`actionClassEntry.definition`,
 * joined by the API from the ADR-0011 registry, because `re-dispatch` is a
 * label rather than an explanation), the provenance record, and the renewal
 * chain in both directions.
 *
 * ## Both halves of the renewal chain, on one screen
 *
 * `renewedFromId` is the grant this one replaced; `renewedBy` is the list of
 * grants issued to replace THIS one. Both are needed together: an expired
 * grant WITH a renewal is a grant somebody kept alive, and an expired grant
 * WITHOUT one is VISION §8's "silence revokes" having actually happened. The
 * backward edge alone cannot tell those apart.
 *
 * ## There is no renew button, deliberately and temporarily
 *
 * `POST /trust/grants/:id/renew` (#115) is not on this branch. The chain UI
 * below is built to display renewals the moment they exist; what is missing is
 * only the control that creates one, and a button calling an endpoint that
 * returns 404 would fail in exactly the place an operator is trying to keep
 * autonomy alive.
 */
export default function TrustGrantDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const grant = useTrustGrant(id);
  const { hasPermission } = usePermissions();
  const revocation = useGrantRevocation(grant.refresh);
  const [confirming, setConfirming] = useState(false);

  const canRevoke = hasPermission(REVOKE_PERMISSION);

  const handleConfirm = useCallback(
    (note?: string) => {
      setConfirming(false);
      void revocation.revoke(id, note);
    },
    [id, revocation],
  );

  return (
    <Container maxWidth="md" sx={{ px: { xs: 1.5, sm: 3 } }}>
      <Box sx={{ py: 2 }}>
        <Link
          component={RouterLink}
          to="/trust"
          variant="body2"
          sx={{ display: 'inline-block', mb: 2 }}
        >
          &larr; All trust grants
        </Link>

        {grant.error && !grant.data && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {grant.error}
          </Alert>
        )}

        {!grant.data && !grant.error && <Skeleton height={240} />}

        {grant.data && (
          <>
            <GrantHeader grant={grant.data} />
            <RevocationOutcomeBanner outcome={revocation.outcome} />
            <AttributesCard grant={grant.data} />

            {isAuthorizingGrant(grant.data.status) ? (
              <RevokeAction
                canRevoke={canRevoke}
                isRevoking={revocation.isRevoking}
                onOpen={() => setConfirming(true)}
              />
            ) : (
              <HowItEnded grant={grant.data} />
            )}

            <ClassDefinitionCard grant={grant.data} />
            <RenewalChainCard grant={grant.data} />
            <ProvenanceCard grant={grant.data} />
          </>
        )}
      </Box>

      <RevokeGrantDialog
        open={confirming}
        scope={
          grant.data
            ? `${grant.data.actionClassEntry?.title ?? grant.data.actionClass} in ${grant.data.repositoryId}`
            : ''
        }
        isRevoking={revocation.isRevoking}
        onCancel={() => setConfirming(false)}
        onConfirm={handleConfirm}
      />
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Above the fold
// ---------------------------------------------------------------------------

function GrantHeader({ grant }: { grant: TrustGrantDetail }) {
  const title = grant.actionClassEntry?.title ?? grant.actionClass;
  const warning = describeHeadroomWarning(grant);

  return (
    <>
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, mb: 0.5 }}
      >
        <Typography variant="h5" component="h1">
          {title}
        </Typography>
        <TrustGrantStatusChip status={grant.status} size="medium" />
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mb: 2 }}
      >
        {grant.actionClass} · {grant.repositoryId} · granted{' '}
        {formatRelativeTime(grant.createdAt) ?? 'at an unknown time'}
      </Typography>

      {warning && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="headroom-warning">
          This grant is close to the end of its terms — {warning}. If nobody
          acts, it stops on its own.
        </Alert>
      )}

      {/* A live grant for a class the registry has since marked ineligible
          could not be created today. It is reported rather than hidden: that
          is drift worth seeing, not a case that cannot happen. */}
      {isAuthorizingGrant(grant.status) &&
        grant.actionClassEntry &&
        !grant.actionClassEntry.autonomyEligible && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            The registry now marks this class ineligible for autonomy. This
            grant could not be created today, and it is still authorizing work.
          </Alert>
        )}

      {isAuthorizingGrant(grant.status) && !grant.actionClassEntry && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          The action-class registry does not recognise{' '}
          <code>{grant.actionClass}</code>. The grant is live regardless — the
          taxonomy was edited after it was issued.
        </Alert>
      )}
    </>
  );
}

/**
 * VISION §8's four attributes, in §8's own order, in one card.
 *
 * One card rather than four, and no accordions: the four together are the
 * grant. A screen that made one of them cost a tap to reveal would be a screen
 * on which a grant looks bounded without anybody having checked the bound.
 */
function AttributesCard({ grant }: { grant: TrustGrantDetail }) {
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent sx={{ display: 'grid', gap: 2 }}>
        <Field label="Scope">
          <Typography variant="body1">
            {grant.actionClassEntry?.title ?? grant.actionClass} in{' '}
            {grant.repositoryId}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            One action class, one repository. There is no &ldquo;all
            repositories&rdquo; grant.
          </Typography>
        </Field>

        <Field label="Expiry">
          <ExpiryCell grant={grant} />
          <Typography variant="caption" color="text.secondary">
            {new Date(grant.expiresAt).toLocaleString()} · nobody has to do
            anything for this to take effect.
          </Typography>
        </Field>

        <Field label="Budget ceiling">
          <BudgetCell grant={grant} />
          <Typography variant="caption" color="text.secondary">
            Spent {formatUsd(grant.spentUsd)} of{' '}
            {formatUsd(grant.budgetCeilingUsd)}. The grant dies at the ceiling.
          </Typography>
        </Field>

        <Field label="Auto-revoke">
          <Typography variant="body1">{describeAutoRevoke(grant)}</Typography>
        </Field>

        <Divider />

        <Field label="Usage so far">
          <Stack
            direction="row"
            spacing={3}
            sx={{ flexWrap: 'wrap', rowGap: 1 }}
          >
            <Figure
              label="Authorized"
              value={String(grant.actionsAuthorized)}
            />
            <Figure label="Failed" value={String(grant.actionsFailed)} />
            {/*
              NULL IS NOT ZERO. `failureRate === null` means nothing has run
              under this grant yet; `0` means everything that ran succeeded.
              They support opposite conclusions about leaving it standing.
            */}
            <Figure
              label="Failure rate"
              value={formatFailureRate(grant.failureRate)}
              muted={grant.failureRate === null}
              testId="failure-rate"
            />
            <Figure
              label="Ceiling"
              value={formatPercent(grant.maxFailureRate)}
            />
          </Stack>
          {grant.failureRate === null && (
            <Typography variant="caption" color="text.secondary">
              No actions have run under this grant yet. A rate needs a sample —
              and the rate rules hold until {grant.minActionsBeforeAutoRevoke}{' '}
              actions have run.
            </Typography>
          )}
        </Field>
      </CardContent>
    </Card>
  );
}

function RevokeAction({
  canRevoke,
  isRevoking,
  onOpen,
}: {
  canRevoke: boolean;
  isRevoking: boolean;
  onOpen: () => void;
}) {
  if (!canRevoke) {
    // DISABLED rather than hidden, with the reason in one line. The operator
    // who can see a grant misbehaving deserves to know which permission stands
    // between them and stopping it.
    return (
      <Box sx={{ mb: 2 }}>
        <Button
          fullWidth
          size="large"
          variant="outlined"
          color="error"
          startIcon={<BlockIcon />}
          disabled
        >
          Revoke this grant
        </Button>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 1 }}
        >
          Revoking needs the <code>{REVOKE_PERMISSION}</code> permission, which
          is what the API enforces.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ mb: 2 }}>
      <Button
        fullWidth
        size="large"
        variant="outlined"
        color="error"
        startIcon={<BlockIcon />}
        disabled={isRevoking}
        onClick={onOpen}
      >
        Revoke this grant
      </Button>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 1 }}
      >
        Takes effect immediately and permanently. Restoring trust means issuing
        a new grant.
      </Typography>
    </Box>
  );
}

function HowItEnded({ grant }: { grant: TrustGrantDetail }) {
  return (
    <Card sx={{ mb: 2 }} data-testid="how-it-ended">
      <CardContent>
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ display: 'block', lineHeight: 1.6 }}
        >
          How it ended
        </Typography>
        <Typography variant="body1">
          {endReasonLabel(grant.endReason)}
          {grant.endedAt
            ? ` · ${formatRelativeTime(grant.endedAt) ?? new Date(grant.endedAt).toLocaleString()}`
            : ''}
        </Typography>
        {/* The sentence naming the numbers that ended it. It is the only place
            "suspended because the failure rate crossed 34% over 8 actions"
            exists, and `status` cannot reconstruct it. */}
        {grant.endDetail && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {grant.endDetail}
          </Typography>
        )}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 1 }}
        >
          This grant authorizes nothing. It is kept because the record of what
          was trusted, and why that stopped, is evidence.
        </Typography>
      </CardContent>
    </Card>
  );
}

function ClassDefinitionCard({ grant }: { grant: TrustGrantDetail }) {
  const entry = grant.actionClassEntry;

  if (!entry) {
    return (
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="overline" color="text.secondary">
            What this class does
          </Typography>
          <Typography variant="body2" color="text.secondary">
            The action-class registry does not recognise{' '}
            <code>{grant.actionClass}</code>, so there is no definition to show.
            A grant outlives edits to the taxonomy; this is drift, not an error.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent sx={{ display: 'grid', gap: 1.5 }}>
        <Field label="What this class does">
          <Typography variant="body1">{entry.definition}</Typography>
        </Field>
        <Field label="Effect">
          <Typography variant="body2">{entry.effect}</Typography>
        </Field>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip size="small" variant="outlined" label={entry.reversibility} />
          <Chip
            size="small"
            variant="outlined"
            label={
              entry.autonomyEligible
                ? 'Autonomy-eligible'
                : 'Not autonomy-eligible'
            }
          />
          {entry.spendsMoney && (
            <Chip size="small" variant="outlined" label="Spends money" />
          )}
          {entry.hasProposer && (
            <Chip size="small" variant="outlined" label="Has a proposer" />
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * The renewal chain, both directions.
 *
 * Rendered even when it is EMPTY, and the empty text is the point: an expired
 * grant with no renewal is "silence revokes" having happened, which is a fact
 * about the factory rather than an absence of data.
 */
function RenewalChainCard({ grant }: { grant: TrustGrantDetail }) {
  return (
    <Card sx={{ mb: 2 }} data-testid="renewal-chain">
      <CardContent>
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ display: 'block', lineHeight: 1.6, mb: 1 }}
        >
          Renewal chain
        </Typography>

        <Typography variant="body2" sx={{ mb: 1 }}>
          Replaces:{' '}
          {grant.renewedFromId ? (
            <Link
              component={RouterLink}
              to={`/trust/grants/${grant.renewedFromId}`}
            >
              {grant.renewedFromId}
            </Link>
          ) : (
            <Box component="span" sx={{ color: 'text.secondary' }}>
              nothing — this is an original grant.
            </Box>
          )}
        </Typography>

        <Typography variant="body2" component="div">
          Replaced by:{' '}
          {grant.renewedBy.length === 0 ? (
            <Box component="span" sx={{ color: 'text.secondary' }}>
              nothing.{' '}
              {isAuthorizingGrant(grant.status)
                ? 'Nobody has renewed it yet.'
                : 'When it ended, nobody kept it alive — silence revoked it.'}
            </Box>
          ) : (
            <Stack component="ul" spacing={0.5} sx={{ pl: 3, mt: 0.5, mb: 0 }}>
              {grant.renewedBy.map((renewal) => (
                <Box component="li" key={renewal.id}>
                  <Link
                    component={RouterLink}
                    to={`/trust/grants/${renewal.id}`}
                  >
                    {renewal.id}
                  </Link>{' '}
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    — {renewal.status}, issued{' '}
                    {formatRelativeTime(renewal.createdAt) ??
                      'at an unknown time'}
                  </Box>
                </Box>
              ))}
            </Stack>
          )}
        </Typography>
      </CardContent>
    </Card>
  );
}

function ProvenanceCard({ grant }: { grant: TrustGrantDetail }) {
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent sx={{ display: 'grid', gap: 1.5 }}>
        <Field label="Granted by">
          <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
            {grant.grantedById}
          </Typography>
        </Field>
        {grant.grantedFromProposalId && (
          <Field label="From approval">
            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
              {grant.grantedFromProposalId}
            </Typography>
          </Field>
        )}
        {grant.revokedById && (
          <Field label="Revoked by">
            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
              {grant.revokedById}
            </Typography>
          </Field>
        )}
        {grant.note && (
          <Field label="Note from the grantor">
            <Typography variant="body2">{grant.note}</Typography>
          </Field>
        )}
        <Field label="Grant id">
          <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
            {grant.id}
          </Typography>
        </Field>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', lineHeight: 1.6 }}
      >
        {label}
      </Typography>
      {children}
    </Box>
  );
}

function Figure({
  label,
  value,
  muted = false,
  testId,
}: {
  label: string;
  value: string;
  muted?: boolean;
  testId?: string;
}) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        color={muted ? 'text.secondary' : 'text.primary'}
        sx={{ fontVariantNumeric: 'tabular-nums' }}
        data-testid={testId}
      >
        {value}
      </Typography>
    </Box>
  );
}
