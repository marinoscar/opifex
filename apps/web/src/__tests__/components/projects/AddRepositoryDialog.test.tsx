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
import { delay, http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { expectNoLeak, findLeaks } from '../../utils/domSecrets';
import { server } from '../../mocks/server';
import {
  DECLARED_LABELS,
  PROJECT_ID,
  labelFailureFixture,
  labelReportFixture,
  projectFixture,
} from '../../mocks/repositories';
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
import type { LabelProvisioningReport } from '../../../types/repositoryLabels';
import type {
  AvailableRepositories,
  AvailableRepository,
} from '../../../types/repositories';

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

/**
 * `POST /repositories` answering with the row AND what provisioning did (#415).
 *
 * A separate helper from `serveRegistration` on purpose: the plain one answers
 * without a `labelProvisioning` field at all, which is what an API from before
 * #415 sends and which every other case in this file is written against. Only
 * the cases below care about the field, and they say so by using this.
 */
function serveRegistrationWithLabels(
  labelProvisioning: LabelProvisioningReport | null,
  created: RepositorySummary = repository(),
) {
  server.use(
    http.post(`${API_BASE}/repositories`, () =>
      HttpResponse.json(
        { data: { ...created, labelProvisioning } },
        { status: 201 },
      ),
    ),
  );
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
        within(dialog).getByText(/registered here goes into no project/i),
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

// ---------------------------------------------------------------------------
// Several at once (#407)
// ---------------------------------------------------------------------------

/** Three addable rows, plus the registered and archived ones from #401. */
const THREE_ADDABLE: AvailableRepository[] = [
  availableRepository({ name: 'alpha', pushedAt: '2026-08-24T09:00:00.000Z' }),
  availableRepository({ name: 'beta', pushedAt: '2026-08-23T09:00:00.000Z' }),
  availableRepository({ name: 'gamma', pushedAt: '2026-08-22T09:00:00.000Z' }),
  availableRepository({
    name: 'sprockets',
    admission: 'registered',
    repositoryId: REGISTERED_ID,
    pushedAt: '2026-08-21T09:00:00.000Z',
  }),
  availableRepository({
    name: 'legacy',
    archived: true,
    admission: 'archived',
    pushedAt: '2024-01-04T09:00:00.000Z',
  }),
];

/** What the API should do with one repository. */
type Answer = { status: number; message: string } | RepositorySummary;

/**
 * `POST /repositories`, answering per repository and recording the shape of
 * the traffic.
 *
 * `peak` is what makes the transport decision testable rather than merely
 * documented: N requests are only kinder to `github.rateLimitReserve` than a
 * batch endpoint if they are actually issued one at a time, and a `Promise.all`
 * would satisfy every other assertion in this file while bursting five
 * reachability checks at GitHub at once.
 */
function serveEachRegistration(outcome: (fullName: string) => Answer) {
  const attempts: string[] = [];
  let inFlight = 0;
  let peak = 0;

  server.use(
    http.post(`${API_BASE}/repositories`, async ({ request }) => {
      const body = (await request.json()) as { owner: string; name: string };
      const fullName = `${body.owner}/${body.name}`;
      attempts.push(fullName);

      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(5);
      inFlight -= 1;

      const answer = outcome(fullName);
      return 'status' in answer
        ? HttpResponse.json(
            { message: answer.message },
            { status: answer.status },
          )
        : HttpResponse.json({ data: answer }, { status: 201 });
    }),
  );

  return { attempts, peak: () => peak };
}

/** The created row for `acme/<name>`, with an id nothing else uses. */
function created(name: string): RepositorySummary {
  return repository({ name, id: `created-${name}` });
}

describe('Adding several at once', () => {
  describe('The selection', () => {
    it('registers every chosen repository, one request each', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      const post = serveEachRegistration((fullName) =>
        created(fullName.split('/')[1]),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/alpha/ }),
      );
      await user.click(screen.getByRole('button', { name: /^acme\/gamma/ }));
      await user.click(
        screen.getByRole('button', { name: 'Register 2 repositories' }),
      );

      await waitFor(() => expect(post.attempts).toHaveLength(2));
      // In the API's order — what is on screen, top to bottom — rather than in
      // the order the rows were clicked.
      expect(post.attempts).toEqual(['acme/alpha', 'acme/gamma']);
    });

    it('issues them ONE AT A TIME, never as a burst', async () => {
      // The transport decision: N requests rather than a batch endpoint, and
      // sequential rather than concurrent. Each registration makes the API
      // verify reachability against GitHub, sharing the budget
      // `github.rateLimitReserve` holds back for the operator's own use, so
      // firing the selection at once is the shape that trips a secondary rate
      // limit. `reconciler.service.ts` sweeps sequentially for this reason.
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      const post = serveEachRegistration((fullName) =>
        created(fullName.split('/')[1]),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      );

      await waitFor(() => expect(post.attempts).toHaveLength(3));
      expect(post.peak()).toBe(1);
    });

    it('names the one repository when only one is chosen', async () => {
      // The common case is still a single add, and "Register" beside a list is
      // not a description of what is about to happen.
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/beta/ }),
      );
      expect(
        screen.getByRole('button', { name: 'Register acme/beta' }),
      ).toBeEnabled();
    });

    it('deselects a row that is clicked twice', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      const row = await screen.findByRole('button', { name: /^acme\/beta/ });
      await user.click(row);
      expect(row).toHaveAttribute('aria-pressed', 'true');
      await user.click(row);
      expect(row).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
    });
  });

  describe('Select-all, bounded by what is on screen', () => {
    it('selects the addable rows and leaves the marked ones alone', async () => {
      // Already-registered and archived rows stay visible and unselectable, so
      // a bulk selection cannot contain one that would fail for a reason
      // already known before asking.
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      const post = serveEachRegistration((fullName) =>
        created(fullName.split('/')[1]),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      );

      await waitFor(() => expect(post.attempts).toHaveLength(3));
      expect(post.attempts).toEqual(['acme/alpha', 'acme/beta', 'acme/gamma']);
      expect(post.attempts).not.toContain('acme/sprockets');
      expect(post.attempts).not.toContain('acme/legacy');
    });

    it('covers the current page only, never rows on another one', async () => {
      // Selecting things the operator cannot see is how the wrong repository
      // gets registered. Page 1's selection does not survive into page 2 and
      // page 2's select-all covers page 2.
      registered();
      serveAvailable((params) =>
        availableRepositoriesFixture({
          repositories:
            params.get('page') === '2'
              ? [availableRepository({ name: 'later' })]
              : THREE_ADDABLE,
          page: Number(params.get('page') ?? '1'),
          total: 4,
          totalPages: 2,
          reachable: 4,
        }),
      );
      const post = serveEachRegistration((fullName) =>
        created(fullName.split('/')[1]),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      expect(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      ).toBeEnabled();

      await user.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByLabelText('Available repository acme/later');
      // The three from page 1 are gone from the selection, not carried along
      // invisibly.
      expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();

      await user.click(
        screen.getByRole('checkbox', {
          name: /select the 1 that can be added/i,
        }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register acme/later' }),
      );

      await waitFor(() => expect(post.attempts).toHaveLength(1));
      expect(post.attempts).toEqual(['acme/later']);
    });

    it('covers the current search only, never what it excluded', async () => {
      registered();
      serveAvailable((params) =>
        availableRepositoriesFixture({
          repositories: params.get('search')
            ? [availableRepository({ name: 'beta' })]
            : THREE_ADDABLE,
          search: params.get('search'),
          total: params.get('search') ? 1 : 3,
          reachable: 3,
        }),
      );
      const post = serveEachRegistration((fullName) =>
        created(fullName.split('/')[1]),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.type(screen.getByLabelText(/search repositories/i), 'beta');
      await user.click(screen.getByRole('button', { name: /^search$/i }));

      await screen.findByRole('checkbox', {
        name: /select the 1 that can be added/i,
      });
      // The narrowed answer narrowed the selection with it: `beta` matched the
      // search and is still chosen, and the two rows the search excluded are
      // gone from the selection rather than carried along out of sight.
      await user.click(
        await screen.findByRole('button', { name: 'Register acme/beta' }),
      );

      await waitFor(() => expect(post.attempts).toHaveLength(1));
      expect(post.attempts).toEqual(['acme/beta']);
    });

    it('does not resurrect a selection the operator paged away from', async () => {
      // The bound is on the SELECTION, not only on what the register button
      // acts over. A selection that survives out of sight and reappears on the
      // way back is a set of rows nobody chose in this visit to the page — and
      // the operator has no way to know it is armed.
      registered();
      serveAvailable((params) =>
        availableRepositoriesFixture({
          repositories:
            params.get('page') === '2'
              ? [availableRepository({ name: 'later' })]
              : THREE_ADDABLE,
          page: Number(params.get('page') ?? '1'),
          total: 4,
          totalPages: 2,
          reachable: 4,
        }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByLabelText('Available repository acme/later');
      await user.click(screen.getByRole('button', { name: /^previous$/i }));

      const alpha = await screen.findByRole('button', {
        name: /^acme\/alpha/,
      });
      expect(alpha).toHaveAttribute('aria-pressed', 'false');
      expect(
        screen.getByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      ).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
    });

    it('clears the selection when pressed a second time', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      const all = await screen.findByRole('checkbox', {
        name: /select the 3 that can be added/i,
      });
      await user.click(all);
      expect(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      ).toBeEnabled();

      await user.click(all);
      expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
    });

    it('is not offered when nothing on the page can be added', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({
          repositories: THREE_ADMISSIONS.filter(
            (row) => row.admission !== 'available',
          ),
        }),
      );
      await openPicker(userEvent.setup());

      await screen.findByLabelText('Available repository acme/sprockets');
      expect(
        screen.queryByRole('checkbox', {
          name: /that can be added on this page/i,
        }),
      ).not.toBeInTheDocument();
    });
  });

  describe('A mixed outcome, which is an ordinary one', () => {
    /**
     * Five chosen: two register, one is already registered, one is archived,
     * one has no usable credential. The case the whole design exists for.
     */
    function serveMixed() {
      return serveEachRegistration((fullName) => {
        if (fullName === 'acme/beta') {
          return {
            status: 409,
            message: 'Repository acme/beta is already registered',
          };
        }
        if (fullName === 'acme/gamma') {
          return { status: 400, message: 'Repository acme/gamma is archived' };
        }
        return created(fullName.split('/')[1]);
      });
    }

    async function registerThree(user: ReturnType<typeof userEvent.setup>) {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      const post = serveMixed();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      );
      return post;
    }

    it('attempts every repository, stopping at no refusal', async () => {
      // Stopping at the first refusal would make the outcome depend on the
      // order the rows happened to arrive in.
      const user = userEvent.setup();
      const post = await registerThree(user);

      await waitFor(() => expect(post.attempts).toHaveLength(3));
      expect(post.attempts).toEqual(['acme/alpha', 'acme/beta', 'acme/gamma']);
    });

    it('reports what happened to each one, and counts them honestly', async () => {
      const user = userEvent.setup();
      await registerThree(user);

      expect(await screen.findByText('1 of 3 registered')).toBeInTheDocument();

      const succeeded = screen.getByLabelText(
        'Registration result for acme/alpha',
      );
      expect(within(succeeded).getByText('registered')).toBeInTheDocument();

      const conflict = screen.getByLabelText(
        'Registration result for acme/beta',
      );
      expect(within(conflict).getByText('refused')).toBeInTheDocument();
      // This build's heading for a 409, and the API's own message verbatim.
      expect(
        within(conflict).getByText(/acme\/beta is already registered\./),
      ).toBeInTheDocument();
      expect(
        within(conflict).getByText(
          /Repository acme\/beta is already registered/,
        ),
      ).toBeInTheDocument();

      const archived = screen.getByLabelText(
        'Registration result for acme/gamma',
      );
      expect(
        within(archived).getByText(
          /GitHub could not offer acme\/gamma for registration\./,
        ),
      ).toBeInTheDocument();
      expect(
        within(archived).getByText(/Repository acme\/gamma is archived/),
      ).toBeInTheDocument();
    });

    it('keeps what succeeded, and says so rather than rolling back', async () => {
      // The successful registrations are exactly what the operator asked for.
      const user = userEvent.setup();
      await registerThree(user);

      await screen.findByText('1 of 3 registered');
      expect(screen.getByText(/stay registered/i)).toBeInTheDocument();
      // And it is in the list behind, with no manual refresh.
      expect(
        await screen.findByLabelText('Repository acme/alpha'),
      ).toBeInTheDocument();
    });

    it('leaves only the refusals selected, so a retry re-sends nothing that worked', async () => {
      // Clearing everything would lose the record of what to try again;
      // keeping everything would re-POST a registration whose only possible
      // answer is a 409 that means nothing.
      const user = userEvent.setup();
      const post = await registerThree(user);
      await waitFor(() => expect(post.attempts).toHaveLength(3));

      await screen.findByText('1 of 3 registered');
      await user.click(
        await screen.findByRole('button', { name: 'Register 2 repositories' }),
      );

      await waitFor(() => expect(post.attempts).toHaveLength(5));
      expect(post.attempts.slice(3)).toEqual(['acme/beta', 'acme/gamma']);
      expect(post.attempts.slice(3)).not.toContain('acme/alpha');
    });

    it('does not report a batch as a success', async () => {
      const user = userEvent.setup();
      await registerThree(user);

      const alert = (await screen.findByText('1 of 3 registered')).closest(
        '.MuiAlert-root',
      );
      expect(alert).toHaveClass('MuiAlert-colorWarning');
    });

    it('says every remedy once, however many rows hit it', async () => {
      // A remedy is a fact about the KIND of refusal, never about which
      // repository met it, so three 409s earn one sentence rather than three
      // copies of it.
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      serveEachRegistration((fullName) => ({
        status: 409,
        message: `Repository ${fullName} is already registered`,
      }));
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      );

      expect(
        await screen.findByText('None of the 3 could be registered'),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText(/It is in the list behind this dialog/),
      ).toHaveLength(1);
      // And each repository is still individually accounted for above it.
      expect(screen.getAllByText(/is already registered\./)).toHaveLength(3);
    });

    it('reports a whole batch that worked as one line, not three', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      serveEachRegistration((fullName) => created(fullName.split('/')[1]));
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      );

      expect(
        await screen.findByText('3 repositories are registered'),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText('Registration result for acme/gamma'),
      ).toBeInTheDocument();
    });

    it('names the project the batch landed in', async () => {
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      const post = serveEachRegistration((fullName) =>
        repository({
          name: fullName.split('/')[1],
          id: `created-${fullName}`,
          projectId: PROJECT_ID,
        }),
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
      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      );

      await waitFor(() => expect(post.attempts).toHaveLength(3));
      expect(
        await screen.findByText(
          '3 repositories are registered in Billing Platform',
        ),
      ).toBeInTheDocument();
      // Every one carried the project on its own create.
      expect(post.attempts).toEqual(['acme/alpha', 'acme/beta', 'acme/gamma']);
    });
  });

  describe('While the batch runs', () => {
    it('takes the previous report down before the next batch starts', async () => {
      // A finished report sitting above a running batch is read as that
      // batch's answer, which is the one moment this panel can say something
      // that is true of a different set of repositories.
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      let release: (() => void) | null = null;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let call = 0;
      server.use(
        http.post(`${API_BASE}/repositories`, async ({ request }) => {
          const body = (await request.json()) as {
            owner: string;
            name: string;
          };
          call += 1;
          if (call > 1) await held;
          return HttpResponse.json(
            { data: created(body.name) },
            { status: 201 },
          );
        }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('button', { name: /^acme\/alpha/ }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register acme/alpha' }),
      );
      expect(
        await screen.findByText('acme/alpha is registered'),
      ).toBeInTheDocument();

      await user.click(
        await screen.findByRole('button', { name: /^acme\/beta/ }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register acme/beta' }),
      );

      await screen.findByText(/Registering 1 of 1 — acme\/beta/);
      expect(
        screen.queryByText('acme/alpha is registered'),
      ).not.toBeInTheDocument();

      release?.();
      expect(
        await screen.findByText('acme/beta is registered'),
      ).toBeInTheDocument();
    });

    it('says which repository the wait is on', async () => {
      // Sequential registrations of a large selection are a real wait, and an
      // unmoving spinner and a progressing count are the same duration and not
      // the same experience.
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      let release: (() => void) | null = null;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let call = 0;
      server.use(
        http.post(`${API_BASE}/repositories`, async ({ request }) => {
          const body = (await request.json()) as {
            owner: string;
            name: string;
          };
          call += 1;
          if (call === 1) await held;
          return HttpResponse.json(
            { data: created(body.name) },
            { status: 201 },
          );
        }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      );

      expect(
        await screen.findByText(/Registering 1 of 3 — acme\/alpha/),
      ).toBeInTheDocument();
      // And nothing can be closed out from under the report that is coming.
      expect(screen.getByRole('button', { name: /^close$/i })).toBeDisabled();

      release?.();
      expect(
        await screen.findByText('3 repositories are registered'),
      ).toBeInTheDocument();
    });
  });

  /**
   * What registering did to the repository's labels (#415).
   *
   * Registration provisions the factory taxonomy and answers
   * `labelProvisioning` beside the created row. ADR-0001's fine-grained PAT
   * grants one repository and one permission at a time, so a token that can
   * READ a repository need not be able to create labels in it — a refusal here
   * is an expected outcome of a correct configuration, not an exception.
   *
   * The cases below are the ones that decide whether both facts survive: the
   * repository IS registered, and separately its labels are not there.
   */
  describe('What registering did to the labels', () => {
    const M = DECLARED_LABELS.length;

    async function registerGadgets() {
      const user = userEvent.setup();
      await openPicker(user);
      await user.click(
        await screen.findByRole('button', { name: /^acme\/gadgets/ }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register acme/gadgets' }),
      );
      return user;
    }

    it('says nothing extra when the labels were provisioned cleanly', async () => {
      registered();
      serveAvailable();
      serveRegistrationWithLabels(
        labelReportFixture({
          applied: true,
          missing: ['factory:ready'],
          created: ['factory:ready'],
        }),
      );
      await registerGadgets();

      expect(
        await screen.findByText('acme/gadgets is registered'),
      ).toBeInTheDocument();
      // The expected case is not news, and an alert per repository saying so
      // would bury the one that matters.
      expect(screen.queryByLabelText(/^Label provisioning for/)).toBeNull();
    });

    it('reports a refused provisioning WITHOUT reporting a failed registration', async () => {
      registered();
      serveAvailable();
      serveRegistrationWithLabels(
        labelFailureFixture(
          'refused',
          'GitHub answered 403 when creating labels.',
          { repository: 'acme/gadgets' },
        ),
      );
      await registerGadgets();

      // Both facts, and the registration first. The row IS registered — the
      // panel behind this dialog has it — and only the labels are missing.
      expect(
        await screen.findByText('acme/gadgets is registered'),
      ).toBeInTheDocument();

      const note = screen.getByLabelText('Label provisioning for acme/gadgets');
      expect(note).toHaveTextContent(
        'acme/gadgets is registered; its labels could not be created',
      );
      expect(note).toHaveTextContent(/The registration itself stands/);
      // The API's own sentence survives.
      expect(note).toHaveTextContent(
        'GitHub answered 403 when creating labels.',
      );
      // And no count is invented from a report that observed nothing.
      expect(note).not.toHaveTextContent(/\d+ of \d+ labels present/);
      // The remedy is the token's permissions, not a new token.
      expect(note).toHaveTextContent(/Issues: read and write/);
    });

    it('says which labels are absent when only some could be made', async () => {
      registered();
      serveAvailable();
      serveRegistrationWithLabels(
        labelReportFixture({
          repository: 'acme/gadgets',
          applied: true,
          missing: ['factory:ready', 'tier:small'],
          created: ['tier:small'],
          failed: { 'factory:ready': 'GitHub answered 403 for this label.' },
        }),
      );
      await registerGadgets();

      const note = await screen.findByLabelText(
        'Label provisioning for acme/gadgets',
      );
      expect(note).toHaveTextContent(`2 of ${M} labels are not on it`);
      expect(note).toHaveTextContent(/registered and observed either way/);
    });

    it('flags a null report as the anomaly it is, without failing the add', async () => {
      registered();
      serveAvailable();
      serveRegistrationWithLabels(null);
      await registerGadgets();

      expect(
        await screen.findByText('acme/gadgets is registered'),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText('Label provisioning for acme/gadgets'),
      ).toHaveTextContent(/should not happen/);
    });

    it('says nothing at all when the API publishes no such field', async () => {
      // An API from before #415: there is no outcome to describe and no action
      // to offer, and a warning on every registration nobody can act on is one
      // nobody reads.
      registered();
      serveAvailable();
      serveRegistration();
      await registerGadgets();

      expect(
        await screen.findByText('acme/gadgets is registered'),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText(/^Label provisioning for/)).toBeNull();
    });

    it('reports per repository in a batch, not per batch', async () => {
      // The credential is fine-grained: it can be permitted to label one
      // repository of a batch and refused on the others. One summarised
      // sentence could not say which.
      registered();
      serveAvailable(() =>
        availableRepositoriesFixture({ repositories: THREE_ADDABLE }),
      );
      server.use(
        http.post(`${API_BASE}/repositories`, async ({ request }) => {
          const body = (await request.json()) as {
            owner: string;
            name: string;
          };
          const fullName = `${body.owner}/${body.name}`;
          return HttpResponse.json(
            {
              data: {
                ...repository({ name: body.name }),
                labelProvisioning:
                  fullName === 'acme/beta'
                    ? labelFailureFixture('refused', 'GitHub answered 403.', {
                        repository: fullName,
                      })
                    : labelReportFixture({
                        repository: fullName,
                        applied: true,
                      }),
              },
            },
            { status: 201 },
          );
        }),
      );
      const user = userEvent.setup();
      await openPicker(user);

      await user.click(
        await screen.findByRole('checkbox', {
          name: /select the 3 that can be added/i,
        }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Register 3 repositories' }),
      );

      expect(
        await screen.findByText('3 repositories are registered'),
      ).toBeInTheDocument();
      // Exactly one note, for exactly the repository that was refused.
      const notes = screen.getAllByLabelText(/^Label provisioning for/);
      expect(notes.map((note) => note.getAttribute('aria-label'))).toEqual([
        'Label provisioning for acme/beta',
      ]);
      // And the per-row lines say what each one's labels did.
      expect(
        within(
          screen.getByLabelText('Registration result for acme/alpha'),
        ).getByText(`Registered. All ${M} labels were already present.`),
      ).toBeInTheDocument();
      expect(
        within(
          screen.getByLabelText('Registration result for acme/beta'),
        ).getByText(/Labels not created/),
      ).toBeInTheDocument();
    });

    it('hands the report to the card behind, so nothing is asked twice', async () => {
      // The registration already looked. Making the operator press Check on a
      // repository checked a second ago would spend another GitHub request to
      // learn what is already known.
      registered();
      serveAvailable();
      const labelCalls: string[] = [];
      server.use(
        http.get(`${API_BASE}/repositories/:id/labels`, () => {
          labelCalls.push('GET');
          return HttpResponse.json({ data: labelReportFixture() });
        }),
      );
      serveRegistrationWithLabels(
        labelFailureFixture('refused', 'GitHub answered 403 for labels.', {
          repository: 'acme/gadgets',
        }),
        repository({ name: 'gadgets' }),
      );
      const user = await registerGadgets();

      await screen.findByText('acme/gadgets is registered');
      await user.click(screen.getByRole('button', { name: /^close$/i }));

      const card = await screen.findByLabelText('Repository acme/gadgets');
      const row = within(card).getByLabelText(/^Factory labels/);
      expect(row).toHaveTextContent(/authenticated and was not permitted/);
      expect(row).toHaveTextContent('GitHub answered 403 for labels.');
      // Seeded, not re-read.
      expect(labelCalls).toEqual([]);
      // And still no count invented from an answer that observed nothing.
      expect(row).not.toHaveTextContent(/\d+ of \d+ labels present/);
    });
  });
});
