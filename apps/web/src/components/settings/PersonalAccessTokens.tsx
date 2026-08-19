/**
 * Settings → Personal access tokens (upstream template issue #67, epic #51).
 *
 * Two things this migration deletes rather than wraps:
 *
 *  - The `{isLoading ? <CircularProgress/> : ...}` ternary. `loading` is a
 *    prop; the table stays mounted across the refetch that follows every
 *    create and every revoke.
 *  - The bare `<Box sx={{ overflowX: 'auto' }}>` around the table. `DataTable`
 *    owns its own scroll container, and a second one nested outside it gives
 *    the page two independent horizontal scrollers over the same content.
 *
 * The outer `Card` / `CardContent` stays: it is the settings page's section
 * chrome, not table chrome, and it also hosts the "Create Token" button — a
 * table-level action with no row and no selection behind it.
 *
 * The list stays UNPAGINATED. `GET /api/pat` returns the caller's whole token
 * list in one response, so there is no server page to ask for; client-side
 * pagination would be legal (the page may slice what it already holds) but
 * would be chrome over a list that is a handful of rows for every real user.
 * Client-side FILTERING is not legal, which is why no column here declares
 * `filterable` — see `patColumns.tsx`.
 */

import { useMemo, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import { DataTable } from '../datatable';
import type { DataTableRowAction } from '../datatable';
import { usePersonalAccessTokens } from '../../hooks/usePersonalAccessTokens';
import { CreatePatDialog } from './CreatePatDialog';
import { PatTokenRevealDialog } from './PatTokenRevealDialog';
import type { PatCreatedResponse, PersonalAccessToken } from '../../types';
import { TABLE_ID, buildPatColumns, getTokenStatus } from './patColumns';

export function PersonalAccessTokens() {
  const { tokens, isLoading, error, createToken, revokeToken } = usePersonalAccessTokens();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [revealDialogOpen, setRevealDialogOpen] = useState(false);
  const [createdTokenValue, setCreatedTokenValue] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const columns = useMemo(() => buildPatColumns(), []);

  const handleCreated = (response: PatCreatedResponse) => {
    setCreatedTokenValue(response.token);
    setRevealDialogOpen(true);
  };

  // Keyed on `revoking` (a string id or null — a scalar) and the stable
  // `revokeToken` callback. Never on `tokens`: the hook refetches after every
  // revoke and hands back brand-new objects.
  const rowActions = useMemo(
    () =>
      [
        {
          id: 'revoke',
          label: 'Revoke',
          icon: <DeleteIcon fontSize="small" />,
          destructive: true,
          // An expired or already-revoked token keeps its (disabled) control
          // rather than losing it, so the row's shape does not change with its
          // status. The in-flight id disables just the row being revoked.
          disabled: (token) =>
            getTokenStatus(token) !== 'active' || revoking === token.id,
          confirm: {
            title: 'Revoke token?',
            description: (token) =>
              `"${token.name}" will stop working immediately. This cannot be undone.`,
            confirmLabel: 'Revoke',
          },
          onClick: (token) => {
            setRevoking(token.id);
            void revokeToken(token.id).finally(() => setRevoking(null));
          },
        },
      ] satisfies DataTableRowAction<PersonalAccessToken>[],
    [revoking, revokeToken],
  );

  return (
    <>
      <Card>
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              mb: 1,
            }}
          >
            <Box>
              <Typography variant="h6" gutterBottom>
                Personal Access Tokens
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Create tokens to authenticate API requests without OAuth.
              </Typography>
            </Box>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => setCreateDialogOpen(true)}
              size="small"
            >
              Create Token
            </Button>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          <DataTable<PersonalAccessToken>
            tableId={TABLE_ID}
            data-testid="settings-pats-table"
            ariaLabel="Personal access tokens"
            density="compact"
            columns={columns}
            rows={tokens}
            rowId={(token) => token.id}
            loading={isLoading}
            emptyState={
              <Typography variant="body2" color="text.secondary">
                No personal access tokens yet. Create one to get started.
              </Typography>
            }
            rowActions={rowActions}
            csvExport={{ filename: 'personal-access-tokens' }}
          />
        </CardContent>
      </Card>

      <CreatePatDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={handleCreated}
        onCreate={createToken}
      />

      <PatTokenRevealDialog
        open={revealDialogOpen}
        onClose={() => {
          setRevealDialogOpen(false);
          setCreatedTokenValue(null);
        }}
        token={createdTokenValue}
      />
    </>
  );
}
