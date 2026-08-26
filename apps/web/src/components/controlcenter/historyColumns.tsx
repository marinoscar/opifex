/**
 * History: the DataTable column contract for the audit log (#351, epic #332).
 *
 * A sibling module rather than columns inlined in the section, following
 * `trustGrantColumns.tsx` and `userListColumns.tsx`: the column list is the
 * table's PUBLIC shape — what a test, a CSV export and both renderers read —
 * while the section owns the state that feeds it.
 *
 * ## What `GET /api/audit-events` actually honours
 *
 * Read off `apps/api/src/audit-events/dto/audit-event-list-query.dto.ts`:
 *
 *   | query param   | accepts                          | column here          |
 *   | ------------- | -------------------------------- | -------------------- |
 *   | `targetType`  | any string                       | `targetType`, `is`   |
 *   | `targetId`    | any string                       | not offered          |
 *   | `action`      | any string                       | not offered          |
 *   | `actorUserId` | a uuid                           | not offered          |
 *   | `since`/`until` | ISO datetimes                  | not offered          |
 *   | `sortOrder`   | `asc` \| `desc`                  | nothing sortable     |
 *
 * **No column is sortable, and that is the contract rather than an omission.**
 * The endpoint has no `sort` parameter at all: it orders by `createdAt desc`
 * with an `id` tiebreaker and `sortOrder` only flips that one ordering. A
 * sortable header could therefore only re-order the 25 rows on screen, which
 * is a control that looks live and quietly lies.
 *
 * `targetType` IS offered because it is #351's own acceptance criterion — it
 * is what separates "what changed about my configuration" from every storage
 * upload and role change in the same table. `actorUserId` is not, because it
 * takes a uuid and nothing in this app publishes the user list to a text box;
 * `action` is not, because its accepted values are an open set spread across
 * nine writers and a hand-copied list here would go stale silently.
 *
 * ## The change column never carries a value it was not given
 *
 * Both its `render` and its `value` (the CSV scalar) are built from
 * `auditChangesOf`, never from the raw `meta`. That matters most for the
 * scalar: an export is the easier of the two to leak by accident, because
 * nobody reads it before it lands in a downloads folder.
 */

import { Stack, Tooltip, Typography } from '@mui/material';

import { AuditChangeCell } from './AuditChangeCell';
import {
  AUDIT_TARGET_TYPES,
  auditChangesOf,
  auditTargetTypeLabel,
  describeAuditActor,
  describeAuditChanges,
} from '../../config/auditHistory';
import type { DataTableColumn } from '../datatable';
import type { AuditEvent } from '../../types/audit';
import { formatRelativeTime } from '../../utils/time';

/**
 * Persistence key for `user_settings.dataTables`. A constant, never derived
 * from the route or the heading: it is a storage key and must survive a rename.
 */
export const TABLE_ID = 'control-center-history';

export function historyColumns(): DataTableColumn<AuditEvent>[] {
  return [
    {
      id: 'createdAt',
      label: 'When',
      priority: 'primary',
      minWidth: 150,
      // The ISO string is the scalar, so an exported row carries a timestamp
      // that can be sorted and parsed rather than the words "3m ago".
      value: (event) => event.createdAt,
      render: (event) => (
        <Tooltip title={new Date(event.createdAt).toLocaleString()}>
          <Typography variant="body2" noWrap>
            {formatRelativeTime(event.createdAt) ?? event.createdAt}
          </Typography>
        </Tooltip>
      ),
    },
    {
      id: 'actor',
      label: 'Who',
      priority: 'primary',
      minWidth: 180,
      truncate: true,
      // Three different claims, kept apart: a named person, a person whose
      // account is gone, and nothing human at all. See `describeAuditActor`.
      value: (event) => describeAuditActor(event),
      render: (event) => (
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {describeAuditActor(event)}
          </Typography>
          {event.actor?.displayName && (
            <Typography variant="caption" color="text.secondary" noWrap>
              {event.actor.email}
            </Typography>
          )}
        </Stack>
      ),
    },
    {
      id: 'action',
      label: 'Action',
      priority: 'primary',
      minWidth: 190,
      truncate: true,
      // The action string verbatim. Not prettified into a sentence: it is the
      // identifier a reader can grep for in the API, and a friendly rewrite
      // would be one more thing that can drift from what the writer records.
      value: (event) => event.action,
      render: (event) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }} noWrap>
          {event.action}
        </Typography>
      ),
    },
    {
      id: 'targetType',
      label: 'Target',
      priority: 'primary',
      minWidth: 200,
      filterable: ['is'],
      filterType: 'enum',
      enumValues: [...AUDIT_TARGET_TYPES],
      value: (event) => auditTargetTypeLabel(event.targetType),
      render: (event) => (
        <Stack spacing={0} sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {auditTargetTypeLabel(event.targetType)}
          </Typography>
          {/* The subject itself — a settings key, a user id, a repository.
              Always safe to print: it is a NAME, and the value that belongs to
              it is what the change column withholds. */}
          <Typography variant="caption" color="text.secondary" noWrap>
            {event.targetId}
          </Typography>
        </Stack>
      ),
    },
    {
      id: 'change',
      label: 'What changed',
      priority: 'secondary',
      minWidth: 280,
      value: (event) => describeAuditChanges(auditChangesOf(event)),
      render: (event) => (
        <AuditChangeCell
          changes={auditChangesOf(event)}
          subject={event.targetId}
        />
      ),
    },
  ];
}
