/**
 * Settings → Personal access tokens: the DataTable column contract
 * (upstream template issue #67, epic #51).
 *
 * ## What `GET /api/pat` honours: nothing
 *
 * `pat.controller.ts` declares `@Get()` with no `@Query()` at all — the
 * endpoint returns the caller's whole token list, unpaginated, unsorted and
 * unfiltered. So NO column here declares `sortable`, `filterable` or
 * `searchable`. Both flags default to `false` in the contract precisely so a
 * table like this one cannot accidentally advertise a control the page has no
 * way to answer.
 *
 * ## `tokenPrefix` is `exportable: false`
 *
 * The prefix is already truncated on screen, so this is not about secrecy on
 * the page — it is about the LIFETIME of the artefact. A CSV is a file: it
 * lands in a downloads folder, gets mailed around and survives the session,
 * the token and often the employment that produced it. Token material of any
 * length has no business in a document with that lifetime, and "it's only the
 * first few characters" is exactly the reasoning that puts the whole secret in
 * the next file. The flag exists in the contract for this case
 * (`types.ts`: "material that must never leave the app").
 *
 * ## Names are not unique — the disambiguation decision
 *
 * `createPatSchema` does not require a unique `name`, and `pat.service.ts` does
 * no uniqueness check, so twenty tokens may all be called `ci-token`. That is a
 * real accessibility failure and not a cosmetic one: `rowAccessibleName()`
 * names every selection checkbox and every row-action button after the first
 * `primary` column's SCALAR, so twenty rows would offer twenty controls all
 * announced as "Revoke for ci-token".
 *
 * The fix is a suffix on this column's `value`, applied UNCONDITIONALLY, rather
 * than client-side uniqueness enforcement at create time. Three reasons:
 *
 *  - Create-time validation cannot fix rows that already exist. Duplicate names
 *    are in the database today, and a rule the UI applies on the way in leaves
 *    every historical duplicate exactly as ambiguous as it was.
 *  - It is not enforceable anyway. The endpoint is a public, documented API
 *    reachable from a second tab, a script or a CLI; a client-side check makes
 *    a promise only one of the writers has agreed to keep.
 *  - The suffix must be a pure function of ONE row. The `render` for a cell is
 *    called per row with no knowledge of the rest of the page, and the "export
 *    all matching rows" walk is fed page by page — a suffix applied only "when
 *    ambiguous" would need the whole set, and would flip on and off as the page
 *    composition changed, so the same token's accessible name would differ
 *    between page 1 and page 2.
 *
 * `render` keeps the plain name, so the VISIBLE cell and the card headline read
 * `ci-token` exactly as before. The suffix appears only where uniqueness is the
 * requirement: accessible names, and the CSV (where it doubles as the row's
 * link back to the API resource, since `id` is not otherwise a column).
 */

import { Chip, Typography } from '@mui/material';
import type { DataTableColumn } from '../datatable';
import type { PersonalAccessToken } from '../../types';

/** Persistence key for `user_settings.dataTables`. */
export const TABLE_ID = 'settings-pats';

export type PatStatus = 'active' | 'expired' | 'revoked';

export function getTokenStatus(token: {
  expiresAt: string;
  revokedAt: string | null;
}): PatStatus {
  if (token.revokedAt) return 'revoked';
  if (new Date(token.expiresAt) < new Date()) return 'expired';
  return 'active';
}

const STATUS_LABELS: Record<PatStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

/** How much of the id is enough to tell two same-named tokens apart. */
const ID_SUFFIX_LENGTH = 8;

/**
 * The token's row-unique scalar: its name plus a short, stable slice of its id.
 * See the module docblock for why this is unconditional.
 */
export function patRowLabel(token: PersonalAccessToken): string {
  return `${token.name} (${token.id.slice(0, ID_SUFFIX_LENGTH)})`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

export function buildPatColumns(): DataTableColumn<PersonalAccessToken>[] {
  return [
    {
      id: 'name',
      label: 'Name',
      priority: 'primary',
      hideable: false, // it is the row's accessible name
      minWidth: 180,
      flex: 1,
      value: patRowLabel,
      render: (token) => <Typography variant="body2">{token.name}</Typography>,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      width: 120,
      value: (token) => STATUS_LABELS[getTokenStatus(token)],
      render: (token) => {
        const status = getTokenStatus(token);
        if (status === 'active')
          return <Chip label="Active" color="success" size="small" />;
        if (status === 'expired') return <Chip label="Expired" size="small" />;
        return <Chip label="Revoked" color="error" size="small" />;
      },
    },
    {
      id: 'tokenPrefix',
      label: 'Token Prefix',
      priority: 'secondary',
      exportable: false, // see the module docblock
      minWidth: 140,
      value: (token) => `${token.tokenPrefix}...`,
      render: (token) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {token.tokenPrefix}...
        </Typography>
      ),
    },
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'detail',
      width: 120,
      value: (token) => formatDate(token.createdAt),
    },
    {
      id: 'expiresAt',
      label: 'Expires',
      priority: 'detail',
      width: 120,
      value: (token) => formatDate(token.expiresAt),
    },
    {
      id: 'lastUsedAt',
      label: 'Last Used',
      priority: 'detail',
      width: 120,
      value: (token) =>
        token.lastUsedAt ? formatDate(token.lastUsedAt) : 'Never',
    },
  ];
}
