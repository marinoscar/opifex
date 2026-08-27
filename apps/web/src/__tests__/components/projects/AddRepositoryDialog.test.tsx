/**
 * The repository picker (#401).
 *
 * `ProjectRepositoriesPanel` is exercised rather than the dialog in isolation,
 * so `useAvailableRepositories`, `useRepositoryLadder`, `services/api` and MSW
 * are all in the path. The picker moved there with the ladder in #406; the
 * claims it makes are unchanged, because they are about requests rather than
 * about which screen mounts it. Every claim this control makes is about a request —
 * what GitHub answered, what the registration sent, whether the list behind
 * the dialog moved — and a mocked hook would let all of them be true of
 * nothing.
 *
 * The cases here are the ones a plausible implementation gets wrong:
 *
 *  - an add affordance that only appears once something is registered, which
 *    is the dead end #401 is about, one screen further along;
 *  - a free-text `owner/name` field, or a picker that re-sorts the API's
 *    deliberate order;
 *  - registered and archived rows hidden rather than marked — the operator
 *    then hunts for a repository they can see on GitHub;
 *  - `reachable: 0` drawn as a failure, sending somebody to reissue a working
 *    token;
 *  - `truncated` swallowed, so a list that stopped at 1000 is presented as
 *    complete;
 *  - a client-side search over one page, presented as a search over the whole
 *    reachable set;
 *  - the seven statuses collapsed, so `refused` reads as "get another token".
 */

import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { expectNoLeak, findLeaks } from '../../utils/domSecrets';
import { server } from '../../mocks/server';
import { PROJECT_ID, projectFixture } from '../../mocks/repositories';
import {
  REGISTERED_ID,
  THREE_ADMISSIONS,
  availableRepositoriesFailure,
  availableRepositoriesFixture,
  availableRepository,
  emptyScopeFixture,
} from '../../mocks/availableRepositories';
import { ProjectRepositoriesPanel } from '../../../components/projects/ProjectRepositoriesPanel';
import type { RepositorySummary } from '../../../types/cockpit';
import type { AvailableRepositories } from '../../../types/repositories';

const API_BASE = '*/api';

// ---------------------------------------------------------------------------
// Fixtures and handlers
// ---------------------------------------------------------------------------

function repository(
  overrides: Partial<RepositorySummary> = {},
): RepositorySummary {
  const owner = overrides.owner ?? 'acme';
  const name = overrides.name ?? 'sprockets';

  return {
    id: REGISTERED_ID,
    projectId: null,
    defaultBranch: 'main',
    observeEnabled: true,
    dispatchEnabled: false,
    mirrorLabelsEnabled: false,
    specFeedbackEnabled: false,
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    pathConstraints: [],
    lastObservedAt: null,
    // Present and null, never absent: `retiredAt !== null` is how a card
    // decides it is retired, and `undefined` would satisfy it.
    retiredAt: null,
    retiredById: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
    owner,
    name,
    fullName: overrides.fullName ?? `${owner}/${name}`,
  };
}

/** `GET /repositories` — the ladder behind the dialog. */
function registered(...items: RepositorySummary[]) {
  server.use(
    http.get(`${API_BASE}/repositories`, () =>
      HttpResponse.json({
        data: { items, total: items.length, page: 1, pageSize: 100 },
      }),
    ),
  );
}

/**
 * `GET /repositories/available`, answering from a responder that sees the
 * query the client actually sent.
 *
 * The captured `URLSearchParams` are what the search and paging assertions
 * read: `search` filters the whole reachable set server-side and `page` slices
 * what is left, so the only way to prove the client is not filtering 25 rows
 * in the browser is to look at what it asked for.
 */
function serveAvailable(
  responder: (
    params: URLSearchParams,
    call: number,
  ) => AvailableRepositories = () => availableRepositoriesFixture(),
) {
  const asked: URLSearchParams[] = [];

  server.use(
    http.get(`${API_BASE}/repositories/available`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      asked.push(params);
      return HttpResponse.json({ data: responder(params, asked.length) });
    }),
  );

  return asked;
}

/** `POST /repositories` — records the body, answers with the created row. */
function serveRegistration(created: RepositorySummary = repository()) {
  const bodies: Record<string, unknown>[] = [];

  server.use(
    http.post(`${API_BASE}/repositories`, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ data: created }, { status: 201 });
    }),
  );

  return bodies;
}

/** `POST /repositories` refusing, the way the controller documents it. */
function refuseRegistration(status: number, message: string) {
  server.use(
    http.post(`${API_BASE}/repositories`, () =>
      HttpResponse.json({ message }, { status }),
    ),
  );
}

/** The panel that mounts the picker, in the unassigned scope. */
function renderPanel(canWrite = true) {
  render(
    <ProjectRepositoriesPanel
      scope={{ kind: 'unassigned' }}
      project={null}
      canWrite={canWrite}
      onEditProject={() => {}}
      onDeleteProject={() => {}}
      onRepositoryCountChanged={() => {}}
    />,
  );
}

async function openPicker(
  user: ReturnType<typeof userEvent.setup>,
  options: { canWrite?: boolean } = {},
) {
  renderPanel(options.canWrite ?? true);
  await user.click(
    await screen.findByRole('button', { name: /^add repository$/i }),
  );
  return screen.findByRole('dialog');
}

/** The rows, in the order they are painted. */
function renderedRows(): string[] {
  return screen
    .getAllByLabelText(/^Available repository /)
    .map((row) => row.getAttribute('aria-label') ?? '');
}

// ---------------------------------------------------------------------------

describe('AddRepositoryDialog', () => {
  describe('The affordance that did not exist', () => {
    it('offers Add repository when nothing is registered at all', async () => {
      // The state the issue is about: an operator sees whatever was curl'd in
      // once. With nothing registered there is nothing to hang an add button
      // off, which is exactly when one is needed.
      registered();
      serveAvailable();
      renderPanel();

      expect(
        await screen.findByRole('button', { name: /^add repository$/i }),
      ).toBeEnabled();
    });

    it('offers it beside the ladder once something is registered', async () => {
      registered(repository());
      serveAvailable();
      renderPanel();

      await screen.findByLabelText('Repository acme/sprockets');
      expect(
        screen.getByRole('button', { name: /^add repository$/i }),
      ).toBeEnabled();
    });

    it('disables it without projects:write', async () => {
      registered(repository());
      renderPanel(false);

      expect(
        await screen.findByRole('button', { name: /^add repository$/i }),
      ).toBeDisabled();
    });

    it('registers into the project the panel is open on, in ONE request', async () => {
      // Not a create followed by an assignment: two requests would leave a
      // window in which the repository exists in no project, and a failure in
      // the second would strand it there looking like an unassigned
      // registration nobody made.
      registered();
      serveAvailable();
      const bodies = serveRegistration(repository({ projectId: PROJECT_ID }));
      const assignments: string[] = [];
      server.use(
        http.put(
          `${API_BASE}/projects/:id/repositories/:repositoryId`,
          ({ params }) => {
            assignments.push(String(params.id));
            return HttpResponse.json({ data: repository() });
          },
        ),
      );
      const user = userEvent.setup();

      render(
        <ProjectRepositoriesPanel
          scope={{ kind: 'project', id: PROJECT_ID }}
          project={projectFixture()}
          canWrite
          onEditProject={() => {}}
          onDeleteProject={() => {}}
          onRepositoryCountChanged={() => {}}
        />,
      );
      await user.click(
        await screen.findByRole('button', { name: /^add repository$/i }),
      );
      await screen.findByRole('dialog');
      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({
        owner: 'acme',
        name: 'gadgets',
        projectId: PROJECT_ID,
      });
      // No follow-up assignment: the create carried the project.
      expect(assignments).toEqual([]);
    });

    it('registers into no project from the unassigned bucket, and says so', async () => {
      // `projectId: null` is a destination an operator may deliberately choose
      // rather than a value they forgot to supply, so the key is OMITTED and
      // the dialog explains where the row will land.
      registered();
      serveAvailable();
      const bodies = serveRegistration();
      const user = userEvent.setup();

      const dialog = await openPicker(user);
      expect(
        within(dialog).getByText(/registers the repository into no project/i),
      ).toBeInTheDocument();

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).not.toHaveProperty('projectId');
    });

    it('asks GitHub only once the dialog is opened', async () => {
      registered(repository());
      const asked = serveAvailable();
      const user = userEvent.setup();

      renderPanel();
      await screen.findByLabelText('Repository acme/sprockets');
      expect(asked).toHaveLength(0);

      await user.click(
        screen.getByRole('button', { name: /^add repository$/i }),
      );
      await waitFor(() => expect(asked).toHaveLength(1));
    });
  });

  describe('The three admissions', () => {
    it('renders every row in the API’s order, re-sorting nothing', async () => {
      // Addable, then registered, then archived — most recently pushed first
      // within a group. The order is the API's and is deliberate, so a picker
      // that sorted alphabetically would put `gadgets`, `legacy`, `sprockets`.
      registered();
      serveAvailable();
      await openPicker(userEvent.setup());

      await screen.findByLabelText('Available repository acme/gadgets');
      expect(renderedRows()).toEqual([
        'Available repository acme/gadgets',
        'Available repository acme/sprockets',
        'Available repository acme/legacy',
      ]);
    });

    it('offers the addable row as the only selectable one', async () => {
      registered();
      serveAvailable();
      await openPicker(userEvent.setup());

      await screen.findByLabelText('Available repository acme/gadgets');
      expect(
        screen.getByRole('button', { name: /^acme\/gadgets/ }),
      ).toBeInTheDocument();
      // The other two are present and are not buttons: shown, marked, and not
      // offered as if registration would work.
      expect(
        screen.queryByRole('button', { name: /^acme\/sprockets/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /^acme\/legacy/ }),
      ).not.toBeInTheDocument();
    });

    it('marks the registered row rather than hiding it', async () => {
      registered();
      serveAvailable();
      await openPicker(userEvent.setup());

      const row = await screen.findByLabelText(
        'Available repository acme/sprockets',
      );
      expect(within(row).getByText('already registered')).toBeInTheDocument();
      expect(within(row).getByText(/would answer 409/i)).toBeInTheDocument();
    });

    it('marks the archived row rather than hiding it', async () => {
      registered();
      serveAvailable();
      await openPicker(userEvent.setup());

      const row = await screen.findByLabelText(
        'Available repository acme/legacy',
      );
      expect(within(row).getByText('archived on GitHub')).toBeInTheDocument();
      expect(
        within(row).getByText(/registration refuses an archived one/i),
      ).toBeInTheDocument();
    });

    it('sends the operator to the registration that already exists', async () => {
      // Better than refusing: the row carries `repositoryId`, so the picker
      // can point at the row the operator was about to add again.
      registered(repository());
      serveAvailable();
      const user = userEvent.setup();
      await openPicker(user);

      await screen.findByLabelText('Available repository acme/sprockets');
      await user.click(
        screen.getByRole('button', { name: /show it in the list/i }),
      );

      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );
      expect(
        screen.getByLabelText('Repository acme/sprockets'),
      ).toHaveAttribute('aria-current', 'true');
    });

    it('will not offer an admission this build has never heard of', async () => {
      // Assuming an unfamiliar word means `available` is the one thing the
      // mark exists not to do: the guess ends in a refusal the operator was
      // told would not happen.
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({
          repositories: [
            {
              ...availableRepository({ name: 'gadgets' }),
              admission: 'suspended' as never,
            },
          ],
        }),
      );
      await openPicker(userEvent.setup());

      const row = await screen.findByLabelText(
        'Available repository acme/gadgets',
      );
      expect(within(row).getByText('suspended')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /^acme\/gadgets/ }),
      ).not.toBeInTheDocument();
    });

    it('does not mark a card nobody asked for', async () => {
      registered(repository());
      serveAvailable();
      renderPanel();

      const card = await screen.findByLabelText('Repository acme/sprockets');
      expect(card).not.toHaveAttribute('aria-current');
    });
  });

  describe('Registering', () => {
    it('sends owner and name, and no policy flags at all', async () => {
      // Every default lives in the Prisma schema, so omission is what makes a
      // new registration observed and never dispatched. Sending a copy of
      // those defaults would be a second declaration that could drift.
      registered();
      serveAvailable();
      const bodies = serveRegistration(
        repository({ name: 'gadgets', id: 'created-1' }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({ owner: 'acme', name: 'gadgets' });
    });

    it('puts the new repository in the list behind, with no manual refresh', async () => {
      registered();
      serveAvailable();
      serveRegistration(repository({ name: 'gadgets', id: 'created-1' }));
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      expect(
        await screen.findByLabelText('Repository acme/gadgets'),
      ).toBeInTheDocument();
    });

    it('re-lists, so the row it just added stops inviting a second attempt', async () => {
      registered();
      const asked = serveAvailable((_params, call) =>
        call === 1
          ? availableRepositoriesFixture()
          : availableRepositoriesFixture({
              repositories: THREE_ADMISSIONS.map((row) =>
                row.name === 'gadgets'
                  ? {
                      ...row,
                      admission: 'registered' as const,
                      repositoryId: 'created-1',
                    }
                  : row,
              ),
            }),
      );
      serveRegistration(repository({ name: 'gadgets', id: 'created-1' }));
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      await waitFor(() => expect(asked).toHaveLength(2));
      expect(
        await screen.findByText('acme/gadgets is registered'),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: /^acme\/gadgets/ }),
        ).not.toBeInTheDocument(),
      );
    });

    it('renders a 409 as the API’s own answer, claiming no success', async () => {
      registered();
      serveAvailable();
      refuseRegistration(409, 'Repository acme/gadgets is already registered');
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      expect(
        await screen.findByText('acme/gadgets is already registered'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Repository acme\/gadgets is already registered/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('acme/gadgets is registered'),
      ).not.toBeInTheDocument();
    });

    it('renders a 400 as reachability, not as a bad name', async () => {
      registered();
      serveAvailable();
      refuseRegistration(400, 'Repository acme/gadgets is archived');
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      expect(
        await screen.findByText(
          /GitHub could not offer acme\/gadgets for registration/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/github.token is resolved per request/i),
      ).toBeInTheDocument();
    });

    it('renders a 503 as a credential fact, and says nothing was written', async () => {
      registered();
      serveAvailable();
      refuseRegistration(503, 'The GitHub credential is missing or expired');
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      // Twice, and both are load-bearing: this build's heading for a 503, and
      // the API's own message quoted verbatim underneath it.
      expect(
        await screen.findAllByText(
          'The GitHub credential is missing or expired',
        ),
      ).toHaveLength(2);
      expect(screen.getByText(/nothing was written/i)).toBeInTheDocument();
    });

    it('renders a 403 on the write as a fact about the account', async () => {
      // `projects:write` is a different permission from the one that lists
      // repositories, so an operator can browse this picker and be refused
      // the registration — which says nothing about the repository.
      registered();
      serveAvailable();
      refuseRegistration(403, 'Forbidden');
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      expect(
        await screen.findByText('This account may not register a repository'),
      ).toBeInTheDocument();
      expect(screen.getByText(/needs projects:write/)).toBeInTheDocument();
    });

    it('renders a status it has no arm for without inventing a reason', async () => {
      registered();
      serveAvailable();
      refuseRegistration(418, 'The API is a teapot');
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      expect(
        await screen.findByText('acme/gadgets could not be registered'),
      ).toBeInTheDocument();
      expect(screen.getByText(/The API is a teapot/)).toBeInTheDocument();
      expect(screen.getByText(/Nothing was registered/)).toBeInTheDocument();
    });

    it('will not register until something is chosen', async () => {
      registered();
      serveAvailable();
      await openPicker(userEvent.setup());

      await screen.findByLabelText('Available repository acme/gadgets');
      expect(screen.getByRole('button', { name: /^Register$/ })).toBeDisabled();
    });
  });

  describe('Search and paging, which are the API’s', () => {
    it('sends the search to the server rather than filtering a page', async () => {
      registered();
      const asked = serveAvailable((params) =>
        availableRepositoriesFixture({
          repositories: params.get('search')
            ? [availableRepository({ name: 'billing' })]
            : THREE_ADMISSIONS,
          search: params.get('search'),
          total: params.get('search') ? 1 : 3,
          reachable: 3,
        }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await screen.findByLabelText('Available repository acme/gadgets');
      await user.type(screen.getByLabelText(/search repositories/i), 'billing');
      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => expect(asked).toHaveLength(2));
      expect(asked[1].get('search')).toBe('billing');
      expect(
        await screen.findByLabelText('Available repository acme/billing'),
      ).toBeInTheDocument();
    });

    it('starts again at page 1 when the search changes', async () => {
      // Page 4 of the old result set is not page 4 of the new one, and asking
      // for it would answer an empty page reading like "nothing matched".
      registered();
      const asked = serveAvailable((params) =>
        availableRepositoriesFixture({
          page: Number(params.get('page') ?? '1'),
          search: params.get('search'),
          total: 60,
          totalPages: 3,
          reachable: 60,
        }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await screen.findByLabelText('Available repository acme/gadgets');
      await user.click(screen.getByRole('button', { name: /^next$/i }));
      await waitFor(() => expect(asked).toHaveLength(2));
      expect(asked[1].get('page')).toBe('2');

      await user.type(screen.getByLabelText(/search repositories/i), 'billing');
      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await waitFor(() => expect(asked).toHaveLength(3));
      expect(asked[2].get('page')).toBe('1');
      expect(asked[2].get('search')).toBe('billing');
    });

    it('shows no pager for a single page', async () => {
      registered();
      serveAvailable();
      await openPicker(userEvent.setup());

      await screen.findByLabelText('Available repository acme/gadgets');
      expect(
        screen.queryByRole('button', { name: /^next$/i }),
      ).not.toBeInTheDocument();
    });

    it('says which rows this page is, and out of what', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({
          total: 60,
          totalPages: 3,
          reachable: 60,
        }),
      );
      await openPicker(userEvent.setup());

      // 25 is the page size the API echoed back, not the 3 rows this fixture
      // happens to carry — the summary describes the slice, not the array.
      expect(
        await screen.findByText('Showing 1–25 of 60 reachable.'),
      ).toBeInTheDocument();
    });

    it('tells an empty search apart from an empty scope', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({
          repositories: [],
          search: 'nothing-matches-this',
          total: 0,
          totalPages: 0,
          reachable: 42,
        }),
      );
      await openPicker(userEvent.setup());

      expect(
        await screen.findByText(/Nothing matches “nothing-matches-this”/),
      ).toBeInTheDocument();
      expect(screen.getByText(/reaches 42 repositories/)).toBeInTheDocument();
    });
  });

  describe('A token scoped to nothing', () => {
    it('reads as guidance, not as a failure', async () => {
      // ADR-0001 chose a fine-grained token that grants access one repository
      // at a time, so `status: 'ok'` with `reachable: 0` is a credential that
      // works and covers nothing. Drawing it as an error would send an
      // operator to reissue a token that is fine.
      registered();
      serveAvailable(() => emptyScopeFixture());
      await openPicker(userEvent.setup());

      expect(
        await screen.findByText(
          'The credential works and reaches no repository',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/do not reissue the token/i)).toBeInTheDocument();
      // And the API's own sentence, which says the same thing — nothing here
      // contradicts it.
      expect(screen.getByText(/its scope covers nothing/i)).toBeInTheDocument();
      expect(screen.getByText(/reaches no repositories at all/i)).toBeVisible();
    });

    it('is not styled as an error', async () => {
      registered();
      serveAvailable(() => emptyScopeFixture());
      await openPicker(userEvent.setup());

      const alert = (
        await screen.findByText(
          'The credential works and reaches no repository',
        )
      ).closest('.MuiAlert-root');
      expect(alert).toHaveClass('MuiAlert-colorInfo');
    });
  });

  describe('The seven statuses', () => {
    const cases: [string, string, string][] = [
      [
        'no_credential',
        'No GitHub credential is configured, so there is nothing to list yet.',
        'No GitHub credential is configured yet',
      ],
      [
        'invalid_credential',
        'GitHub rejected the credential (401): Bad credentials.',
        'GitHub rejected the credential',
      ],
      [
        'refused',
        'GitHub accepted the credential and refused the request (403).',
        'The credential authenticated and was refused',
      ],
      [
        'rate_limited',
        "GitHub's rate limit is exhausted until 2026-08-27T11:00:00.000Z.",
        'GitHub’s rate limit is exhausted',
      ],
      [
        'unreachable',
        'GitHub could not be reached: ETIMEDOUT.',
        'Nothing answered',
      ],
      [
        'failed',
        'Listing repositories failed: unexpected body.',
        'GitHub answered something unexpected',
      ],
    ];

    it.each(cases)(
      '%s gets its own heading and quotes the API verbatim',
      async (status, detail, heading) => {
        registered();
        serveAvailable(() =>
          availableRepositoriesFailure(
            status as AvailableRepositories['status'],
            detail,
          ),
        );
        await openPicker(userEvent.setup());

        expect(await screen.findByText(heading)).toBeInTheDocument();
        expect(screen.getByText(detail)).toBeInTheDocument();
      },
    );

    it('keeps `refused` away from "get another token"', async () => {
      // The distinction the API built the status for: the token authenticates
      // and its repository access is too narrow, so replacing it would almost
      // certainly fail identically.
      registered();
      serveAvailable(() =>
        availableRepositoriesFailure(
          'refused',
          'GitHub accepted the credential and refused the request (403).',
        ),
      );
      await openPicker(userEvent.setup());

      expect(
        await screen.findByText(/Widen what it may reach/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/The token is wrong, revoked or expired/),
      ).not.toBeInTheDocument();
    });

    it('names a status this build has never heard of instead of guessing', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFailure(
          'quota_frozen' as AvailableRepositories['status'],
          'GitHub froze the quota for this installation.',
        ),
      );
      await openPicker(userEvent.setup());

      expect(
        await screen.findByText('The API reported “quota_frozen”'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('GitHub froze the quota for this installation.'),
      ).toBeInTheDocument();
    });
  });

  describe('A truncated list', () => {
    it('says so, rather than presenting 1000 rows as everything', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({
          truncated: true,
          reachable: 1000,
          total: 1000,
          totalPages: 40,
        }),
      );
      await openPicker(userEvent.setup());

      expect(
        await screen.findByText('This list is truncated'),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /1000 is a lower bound on what the credential reaches/,
        ),
      ).toBeInTheDocument();
    });

    it('says nothing about truncation when the list is whole', async () => {
      registered();
      serveAvailable();
      await openPicker(userEvent.setup());

      await screen.findByLabelText('Available repository acme/gadgets');
      expect(
        screen.queryByText('This list is truncated'),
      ).not.toBeInTheDocument();
    });
  });

  describe('When the request itself fails', () => {
    it('reports a 403 as a fact about the account, not about the token', async () => {
      registered();
      server.use(
        http.get(`${API_BASE}/repositories/available`, () =>
          HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
        ),
      );
      await openPicker(userEvent.setup());

      expect(
        await screen.findByText(/which needs projects:read/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Nothing here says anything about the GitHub token/),
      ).toBeInTheDocument();
      // Never a credential verdict: nothing measured the token.
      expect(
        screen.queryByText('GitHub rejected the credential'),
      ).not.toBeInTheDocument();
    });
  });

  describe('The GitHub token reaches no rendered node', () => {
    it('reads the fields it needs by name and never serialises the answer', async () => {
      // This response carries a token the real API never sends — `detail` is
      // redacted by `GitHubHttpService` and no field on the DTO holds a
      // credential — because a faithful fixture could not leak and a test
      // using one would pass vacuously. What is proved is the property that
      // survives a regression on either side: this dialog reads the fields it
      // needs by name, so a token in the body reaches no text node, no
      // attribute and no input value.
      //
      // Assembled rather than written out, so the repository's pre-commit
      // secret scanner has no real-looking credential to object to.
      const token = ['github', 'pat', '11NEVERRENDERTHIS0123456789abcdef'].join(
        '_',
      );
      registered();
      server.use(
        http.get(`${API_BASE}/repositories/available`, () =>
          HttpResponse.json({
            data: {
              ...availableRepositoriesFixture(),
              token,
              repositories: THREE_ADMISSIONS.map((row) => ({ ...row, token })),
            },
          }),
        ),
      );
      await openPicker(userEvent.setup());

      // The scan is rooted at `document.body`, NOT at the render container:
      // #386 found a MUI Dialog portals out of the container, which made
      // exactly this assertion vacuous. The positive control below proves the
      // scan is walking the dialog's own content rather than an empty page.
      await screen.findByLabelText('Available repository acme/gadgets');
      expect(findLeaks(document.body, 'acme/gadgets').length).toBeGreaterThan(
        0,
      );

      expectNoLeak(document.body, token);
    });

    it('holds nothing back once a registration has been refused', async () => {
      // The refusal path renders the API's own message, which is the most
      // likely place for an unredacted value to arrive.
      const token = ['github', 'pat', '11NEVERRENDERTHIS0123456789abcdef'].join(
        '_',
      );
      registered();
      server.use(
        http.get(`${API_BASE}/repositories/available`, () =>
          HttpResponse.json({
            data: { ...availableRepositoriesFixture(), token },
          }),
        ),
      );
      refuseRegistration(503, 'The GitHub credential is missing or expired');
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: /^Register acme\/gadgets$/ }),
      );

      await screen.findAllByText('The GitHub credential is missing or expired');
      expectNoLeak(document.body, token);
    });
  });

  describe('Closing', () => {
    it('closes without registering anything', async () => {
      registered();
      serveAvailable();
      const bodies = serveRegistration();
      const user = userEvent.setup();
      await openPicker(user);

      await screen.findByLabelText('Available repository acme/gadgets');
      await user.click(screen.getByRole('button', { name: /^close$/i }));

      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );
      expect(bodies).toHaveLength(0);
    });
  });
});
