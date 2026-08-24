import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Container,
  FormControlLabel,
  Skeleton,
  Switch,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import BlockIcon from '@mui/icons-material/Block';

import { DataTable } from '../components/datatable';
import type { DataTableFilterModel } from '../components/datatable';
import {
  trustGrantColumns,
  TABLE_ID,
} from '../components/trust/trustGrantColumns';
import { RevokeGrantDialog } from '../components/trust/RevokeGrantDialog';
import {
  PromotionLadderPanel,
  DEMOTE_PERMISSION,
} from '../components/trust/PromotionLadderPanel';
import {
  DemotionOutcomeBanner,
  RevocationOutcomeBanner,
} from '../components/trust/TrustOutcomeBanners';
import { needsAttention } from '../components/trust/trustFormat';
import { isAuthorizingGrant } from '../config/trustStatus';
import { usePromotionLadder, useTrustGrants } from '../hooks/useTrustGrants';
import { useClassDemotion, useGrantRevocation } from '../hooks/useTrustActions';
import { usePermissions } from '../hooks/usePermissions';
import { TRUST_GRANT_STATUSES } from '../types/trust';
import type { TrustGrantListItem, TrustGrantStatus } from '../types/trust';

/** The permission `TrustController.revoke` and `PromotionController.demote` enforce. */
const REVOKE_PERMISSION = 'trust:revoke';

/**
 * `/trust` — what may run unattended, and how a class earns the right to
 * (#101, epic #22, VISION §7 and §8).
 *
 * ## Two tabs, one navigation
 *
 * The grants list and the promotion ladder are two views of one question, from
 * opposite ends: a grant is authority that EXISTS, a rung is how a class
 * becomes eligible for one. #101 requires both be reachable without a second
 * navigation, so they are tabs on one route rather than two destinations. The
 * ladder is deliberately not a panel below the table — it is long, and burying
 * "what would it take to promote this" under a scroll is how it stays opaque.
 *
 * Both tabs poll independently and both mount immediately, so switching is
 * instant and neither is refetched on every toggle.
 *
 * ## What this page does NOT offer
 *
 * A "grant trust" button. `POST /trust/grants` exists and the API client wraps
 * it, but VISION §8 puts the granting act on the approval screen — "Always
 * approve this class", one tap, in the moment somebody is already judging that
 * class with its context in front of them. A create form here would be the
 * same authority granted from a screen with none of that context, and it would
 * quietly become the normal way to do it.
 *
 * A "renew" button is likewise absent: `POST /trust/grants/:id/renew` (#115)
 * is not on this branch, and a button that called an endpoint that does not
 * exist would fail in the one place an operator is trying to keep autonomy
 * alive.
 */
export default function TrustPage() {
  const [tab, setTab] = useState<'grants' | 'ladder'>('grants');
  const { hasPermission } = usePermissions();
  const canRevoke = hasPermission(REVOKE_PERMISSION);

  return (
    <Container maxWidth="xl">
      <Box sx={{ py: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Trust
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          What the factory may do unattended, on what terms, and how close each
          grant is to the end of them. Every grant is scoped to one action class
          in one repository — it is never &ldquo;trust the agent&rdquo;.
        </Typography>

        {!canRevoke && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You can see what runs unattended but not stop it. Revoking a grant
            or demoting a class needs <code>{REVOKE_PERMISSION}</code>, which is
            the permission the API enforces.
          </Alert>
        )}

        <Tabs
          value={tab}
          onChange={(_event, next: 'grants' | 'ladder') => setTab(next)}
          sx={{ mb: 2 }}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
        >
          <Tab
            value="grants"
            label="Grants"
            id="trust-tab-grants"
            aria-controls="trust-panel-grants"
          />
          <Tab
            value="ladder"
            label="Promotion ladder"
            id="trust-tab-ladder"
            aria-controls="trust-panel-ladder"
          />
        </Tabs>

        {/* Both panels stay MOUNTED: each owns a poll, and unmounting would
            restart it from a spinner — and refetch — every time the operator
            looked at the other one. `hidden` takes the inactive panel out of
            the accessibility tree, so a screen reader is never offered two
            screens at once. */}
        <Box
          id="trust-panel-grants"
          data-testid="trust-panel-grants"
          hidden={tab !== 'grants'}
          role="tabpanel"
          aria-labelledby="trust-tab-grants"
        >
          <GrantsTab canRevoke={canRevoke} />
        </Box>
        <Box
          id="trust-panel-ladder"
          data-testid="trust-panel-ladder"
          hidden={tab !== 'ladder'}
          role="tabpanel"
          aria-labelledby="trust-tab-ladder"
        >
          <LadderTab canDemote={canRevoke} />
        </Box>
      </Box>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

function GrantsTab({ canRevoke }: { canRevoke: boolean }) {
  const [filters, setFilters] = useState<DataTableFilterModel>([]);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<TrustGrantListItem | null>(
    null,
  );

  const status = statusFilter(filters);
  // Both are passed through untouched rather than reconciled here. The API's
  // precedence is the real one — an explicit `status` overrides `includeEnded`
  // — and a client that "helpfully" suppressed one of them would produce a
  // filter that silently returned nothing.
  const grants = useTrustGrants({
    ...(status ? { status } : {}),
    ...(includeEnded ? { includeEnded: true } : {}),
  });

  const revocation = useGrantRevocation(grants.refresh);
  const rows = grants.data ?? [];

  const columns = useMemo(() => trustGrantColumns(), []);

  const rowActions = useMemo(
    () => [
      {
        id: 'revoke',
        label: 'Revoke',
        icon: <BlockIcon fontSize="small" />,
        destructive: true,
        // Disabled rather than absent on an ended grant, and disabled rather
        // than absent without the permission: a row whose action silently
        // vanishes teaches nothing about why.
        disabled: (grant: TrustGrantListItem) =>
          !canRevoke || !isAuthorizingGrant(grant.status),
        onClick: (grant: TrustGrantListItem) => setPendingRevoke(grant),
      },
    ],
    [canRevoke],
  );

  const attention = rows.filter(needsAttention).length;

  const handleConfirm = useCallback(
    (note?: string) => {
      if (!pendingRevoke) return;
      const id = pendingRevoke.id;
      setPendingRevoke(null);
      void revocation.revoke(id, note);
    },
    [pendingRevoke, revocation],
  );

  return (
    <Box>
      <RevocationOutcomeBanner outcome={revocation.outcome} />

      <FormControlLabel
        sx={{ mb: 1 }}
        control={
          <Switch
            checked={includeEnded}
            onChange={(event) => setIncludeEnded(event.target.checked)}
            slotProps={{ input: { 'aria-label': 'Show ended grants' } }}
          />
        }
        label="Show ended grants (revoked, expired, suspended)"
      />

      {attention > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }} data-testid="attention-banner">
          {attention === 1
            ? '1 active grant is near its expiry or its budget ceiling.'
            : `${attention} active grants are near their expiry or their budget ceiling.`}{' '}
          Each is marked in the table. Silence revokes them: if nobody acts,
          they stop on their own.
        </Alert>
      )}

      {!grants.data && !grants.error && <Skeleton height={200} />}

      <DataTable<TrustGrantListItem>
        tableId={TABLE_ID}
        ariaLabel="Trust grants"
        columns={columns}
        rows={rows}
        rowId={(grant) => grant.id}
        loading={grants.isRefreshing && grants.state !== 'ready'}
        error={grants.error}
        rowActions={rowActions}
        emptyState={
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              {includeEnded
                ? 'No grant has ever been issued for this filter. Nothing has run unattended.'
                : 'Nothing may run unattended right now. A grant appears here when somebody taps “Always approve this class” on an approval — turn on “Show ended grants” for the ones that have since expired or been revoked.'}
            </Typography>
          </Box>
        }
        filters={filters}
        onFiltersChange={setFilters}
      />

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 3 }}
      >
        Ended grants are never deleted. The record of what was trusted, and why
        it stopped being trusted, is the evidence the promotion ladder and the
        daily digest are made of.
      </Typography>

      <RevokeGrantDialog
        open={pendingRevoke !== null}
        scope={
          pendingRevoke
            ? `${pendingRevoke.actionClassTitle ?? pendingRevoke.actionClass} in ${pendingRevoke.repositoryId}`
            : ''
        }
        isRevoking={revocation.isRevoking}
        onCancel={() => setPendingRevoke(null)}
        onConfirm={handleConfirm}
      />
    </Box>
  );
}

/**
 * The one filter the endpoint honours, pulled out of the table's model.
 *
 * `GET /api/trust/grants` takes a single `status` from a four-member enum, so
 * a model carrying anything else is ignored rather than approximated —
 * `trustGrantColumns.tsx` declares only `status` as filterable for exactly
 * that reason.
 */
export function statusFilter(
  filters: DataTableFilterModel,
): TrustGrantStatus | undefined {
  const entry = filters.find(
    (filter) => filter.columnId === 'status' && filter.operator === 'is',
  );
  return TRUST_GRANT_STATUSES.includes(entry?.value as TrustGrantStatus)
    ? (entry?.value as TrustGrantStatus)
    : undefined;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

function LadderTab({ canDemote }: { canDemote: boolean }) {
  const ladder = usePromotionLadder();
  const demotion = useClassDemotion(ladder.refresh);

  const handleDemote = useCallback(
    (actionClass: string, note?: string) => {
      void demotion.demote(actionClass, note);
    },
    [demotion],
  );

  return (
    <Box>
      <DemotionOutcomeBanner outcome={demotion.outcome} />

      {ladder.error && !ladder.data && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {ladder.error}
        </Alert>
      )}

      {!ladder.data && !ladder.error && <Skeleton height={240} />}

      {ladder.data && (
        <PromotionLadderPanel
          ladder={ladder.data}
          canDemote={canDemote}
          demotingClass={demotion.demotingClass}
          onDemote={handleDemote}
        />
      )}

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 3 }}
      >
        Demoting a class needs <code>{DEMOTE_PERMISSION}</code>. Promotion has
        no button at all: a rung is earned on recorded human decisions, and a
        promote control would be a way to skip the evidence.
      </Typography>
    </Box>
  );
}
