/**
 * Realistic GitHub REST payloads.
 *
 * #51 asks for "realistic GitHub payloads, not hand-simplified shapes", and
 * the reason is specific: the read adapter's whole job is normalizing GitHub's
 * quirks, so a fixture that has already removed them tests nothing. These keep
 * the fields that have actually caused bugs —
 *
 *  - `pull_request` present on an issue that is really a PR
 *  - `user: null` for a deleted account
 *  - `labels` as objects with colours and descriptions, not strings
 *  - `body: null` for an empty issue
 *
 * — plus the surrounding noise, so a change that starts depending on a field
 * we do not model fails here rather than in production.
 */

export interface RawLabelFixture {
  id: number;
  node_id: string;
  url: string;
  name: string;
  color: string;
  default: boolean;
  description: string | null;
}

export function rawLabel(name: string, color = 'ededed'): RawLabelFixture {
  return {
    id: 208045946,
    node_id: 'MDU6TGFiZWwyMDgwNDU5NDY=',
    url: `https://api.github.com/repos/acme/app/labels/${encodeURIComponent(name)}`,
    name,
    color,
    default: false,
    description: null,
  };
}

export function rawIssue(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 1296269,
    node_id: 'MDU6SXNzdWUx',
    url: 'https://api.github.com/repos/acme/app/issues/312',
    repository_url: 'https://api.github.com/repos/acme/app',
    labels_url:
      'https://api.github.com/repos/acme/app/issues/312/labels{/name}',
    comments_url: 'https://api.github.com/repos/acme/app/issues/312/comments',
    events_url: 'https://api.github.com/repos/acme/app/issues/312/events',
    html_url: 'https://github.com/acme/app/issues/312',
    number: 312,
    state: 'open',
    state_reason: null,
    title: 'Add CSV export to the reports page',
    body: 'Operators export reports by hand, twenty minutes at a time.',
    user: {
      login: 'marinoscar',
      id: 581497,
      node_id: 'MDQ6VXNlcjU4MTQ5Nw==',
      avatar_url: 'https://avatars.githubusercontent.com/u/581497?v=4',
      type: 'User',
      site_admin: false,
    },
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: 0,
    closed_at: null,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-02T10:00:00Z',
    author_association: 'OWNER',
    reactions: { url: 'x', total_count: 0, '+1': 0, '-1': 0 },
    timeline_url: 'https://api.github.com/repos/acme/app/issues/312/timeline',
    ...overrides,
  };
}

/** A timeline `labeled` event, which is the only place the APPLIER appears. */
export function rawLabeledEvent(
  label: string,
  actor: { login: string; type: string },
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 6430295168,
    node_id: 'LE_lADOA...',
    url: 'https://api.github.com/repos/acme/app/issues/events/6430295168',
    actor: {
      login: actor.login,
      id: 581497,
      node_id: 'MDQ6VXNlcjU4MTQ5Nw==',
      avatar_url: 'https://avatars.githubusercontent.com/u/581497?v=4',
      type: actor.type,
      site_admin: false,
    },
    event: 'labeled',
    commit_id: null,
    commit_url: null,
    created_at: '2026-08-02T11:00:00Z',
    label: { name: label, color: 'fbca04' },
    performed_via_github_app: null,
    ...overrides,
  };
}
