/**
 * `/projects` — the destination that manages rather than reads (#406, epic
 * #403).
 *
 * The page runs for real against MSW. `useProjects` and `useRepositoryLadder`
 * are not mocked, because every claim this screen makes is about a request —
 * which scope was asked for, what a create sent, what a delete left behind —
 * and a mocked hook would let all of them be true of nothing.
 *
 * The cases here are the ones a plausible implementation gets wrong:
 *
 *  - unassigned reachable only after a project exists, which strands every
 *    repository registered before projects did (all of them, today);
 *  - a selected scope that does not reach the API, so the panel shows the
 *    whole registry under one project's heading;
 *  - a 409 on a taken slug swallowed, or worse, retried with a suffix;
 *  - deleting a project presented as deleting its repositories;
 *  - `projects:write` treated as a reachability gate, so a viewer holding
 *    `projects:read` gets nothing instead of a read-only screen.
 */

import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { useLocation } from 'react-router-dom';

import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import type { MockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import ProjectsPage from '../../pages/ProjectsPage';
import {
  steerProjectHref,
  steerRepositoryHref,
} from '../../config/steeringLink';
import {
  OTHER_PROJECT_ID,
  PROJECT_ID,
  projectFixture,
  repositoryFixture,
} from '../mocks/repositories';
import type { Project } from '../../types/projects';
import type { RepositorySummary } from '../../types/cockpit';

const API_BASE = '*/api';

/** `GET /projects`, flat-paginated the way `ProjectsService` answers. */
function serveProjects(...items: Project[]) {
  const searches: (string | null)[] = [];
  server.use(
    http.get(`${API_BASE}/projects`, ({ request }) => {
      searches.push(new URL(request.url).searchParams.get('search'));
      return HttpResponse.json({
        data: {
          items,
          total: items.length,
          page: 1,
          pageSize: 25,
          totalPages: items.length === 0 ? 0 : 1,
        },
      });
    }),
  );
  return searches;
}

/**
 * `GET /repositories`, answering per scope and RECORDING the scope it saw.
 *
 * Keyed by the `projectId` query rather than returning one list, because a
 * page that ignored the scope would pass every rendering assertion here and
 * be wrong about the single thing the two panes are for.
 */
function serveRepositories(byScope: Record<string, RepositorySummary[]>) {
  const asked: (string | null)[] = [];
  server.use(
    http.get(`${API_BASE}/repositories`, ({ request }) => {
      const scope = new URL(request.url).searchParams.get('projectId');
      asked.push(scope);
      const items = byScope[scope ?? 'none'] ?? [];
      return HttpResponse.json({
        data: { items, total: items.length, page: 1, pageSize: 100 },
      });
    }),
  );
  return asked;
}

/**
 * Where the router thinks it is.
 *
 * Rendered beside the page because the selection is now a query parameter
 * (#461): "the project is selected" and "the URL says so" are two different
 * claims, and only the second one survives a reload or can be linked to.
 */
function LocationProbe() {
  const location = useLocation();
  return (
    <span data-testid="location">{`${location.pathname}${location.search}`}</span>
  );
}

const locationNow = () => screen.getByTestId('location').textContent;

/**
 * The page, as an account that may actually change things.
 *
 * The default fixture user is the seeded VIEWER, who holds `projects:read` and
 * not `projects:write` — correct for the read-only case below and wrong for
 * every other one, where a missing New project button would look like a bug in
 * the page rather than in the fixture.
 *
 * `route` is how a reload or a pasted link is expressed: the wrapper mounts a
 * `MemoryRouter` at it, so a page rendered at `/projects?project=<id>` has
 * been told nothing except what the address says.
 */
function renderPage(
  options: { user?: MockUser; route?: string } = {},
): ReturnType<typeof render> {
  return render(
    <>
      <ProjectsPage />
      <LocationProbe />
    </>,
    {
      wrapperOptions: {
        user: options.user ?? mockAdminUser,
        route: options.route ?? '/projects',
      },
    },
  );
}

describe('ProjectsPage', () => {
  describe('Unassigned is first-class', () => {
    it('opens on the unassigned bucket when no project exists at all', async () => {
      // The state of every deployment before #404: `Project` was modelled and
      // never built, so every repository has `projectId: null`. Landing
      // anywhere else would show an operator an empty screen and hide their
      // entire registry.
      serveProjects();
      const asked = serveRepositories({
        none: [repositoryFixture()],
      });

      renderPage();

      expect(
        await screen.findByLabelText('Repository acme/widgets'),
      ).toBeInTheDocument();
      expect(asked).toEqual(['none']);
    });

    it('lists Unassigned even when projects exist, and lists it first', async () => {
      serveProjects(projectFixture({ repositoryCount: 2 }));
      serveRepositories({ none: [] });

      renderPage();

      const nav = await screen.findByRole('navigation', { name: 'Projects' });
      const rows = within(within(nav).getByRole('list')).getAllByRole(
        'listitem',
      );
      expect(rows[0]).toHaveTextContent('Unassigned');
      expect(rows[1]).toHaveTextContent('Billing Platform');
    });

    it('asks the API for the chosen project, not for everything', async () => {
      serveProjects(projectFixture({ repositoryCount: 1 }));
      const asked = serveRepositories({
        none: [],
        [PROJECT_ID]: [
          repositoryFixture({
            projectId: PROJECT_ID,
            name: 'ledger',
            fullName: 'acme/ledger',
          }),
        ],
      });
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });
      await user.click(
        screen.getByRole('button', { name: /Billing Platform/ }),
      );

      expect(
        await screen.findByLabelText('Repository acme/ledger'),
      ).toBeInTheDocument();
      expect(asked).toEqual(['none', PROJECT_ID]);
    });
  });

  describe('Switching scope', () => {
    it('carries no panel state from one group into another', async () => {
      // The panel is remounted on a scope change. Without that, a probe
      // verdict, a revealed row or an open stand-down dialog would survive
      // into a group they were never about — and a probe answer is a claim
      // about ONE repository at ONE moment, which is exactly the kind of
      // inference this cockpit is not allowed to make.
      serveProjects(projectFixture({ repositoryCount: 1 }));
      serveRepositories({
        none: [repositoryFixture()],
        [PROJECT_ID]: [
          repositoryFixture({
            id: '66666666-6666-4666-8666-666666666666',
            projectId: PROJECT_ID,
            name: 'ledger',
            fullName: 'acme/ledger',
          }),
        ],
      });
      server.use(
        // #338 has not shipped, so an unrouted path answers 404 and the card
        // draws "not yet verifiable" — a verdict, and one that must not
        // outlive the scope it was asked in.
        http.post(`${API_BASE}/operator-settings/probes/github-repo`, () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      );
      const user = userEvent.setup();

      renderPage();
      await screen.findByLabelText('Repository acme/widgets');
      await user.click(screen.getByRole('button', { name: /test access/i }));
      expect(await screen.findByText('Not yet verifiable')).toBeInTheDocument();

      await user.click(
        screen.getByRole('button', { name: /Billing Platform/ }),
      );
      await screen.findByLabelText('Repository acme/ledger');
      await user.click(screen.getByRole('button', { name: /^Unassigned/ }));
      await screen.findByLabelText('Repository acme/widgets');

      expect(screen.queryByText('Not yet verifiable')).not.toBeInTheDocument();
    });
  });

  describe('Creating a project', () => {
    it('omits the slug when nobody typed one, letting the API derive it', async () => {
      // Sending this build's own derivation would freeze today's algorithm
      // into every project created by a stale tab. The preview says what will
      // happen; the API decides.
      serveProjects();
      serveRepositories({ none: [] });
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.post(`${API_BASE}/projects`, async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json(
            { data: projectFixture({ name: 'Billing Platform' }) },
            { status: 201 },
          );
        }),
      );
      const user = userEvent.setup();

      renderPage();
      await user.click(
        await screen.findByRole('button', { name: /new project/i }),
      );
      await user.type(
        await screen.findByLabelText(/^name/i),
        'Billing Platform',
      );
      await user.click(screen.getByRole('button', { name: /create project/i }));

      await waitFor(() =>
        expect(bodies).toEqual([
          { name: 'Billing Platform', description: null },
        ]),
      );
    });

    it('previews the slug the API would derive', async () => {
      serveProjects();
      serveRepositories({ none: [] });
      const user = userEvent.setup();

      renderPage();
      await user.click(
        await screen.findByRole('button', { name: /new project/i }),
      );
      await user.type(
        await screen.findByLabelText(/^name/i),
        'Billing Platform',
      );

      expect(
        await screen.findByText(/derives “billing-platform”/i),
      ).toBeInTheDocument();
    });

    it('shows the 409 for a taken slug rather than retrying with a suffix', async () => {
      // The API refuses instead of appending `-2`, because a suffix hands back
      // a handle nobody chose and every later reference to the original
      // silently resolves to somebody else's project.
      serveProjects();
      serveRepositories({ none: [] });
      const attempts: unknown[] = [];
      server.use(
        http.post(`${API_BASE}/projects`, async ({ request }) => {
          attempts.push(await request.json());
          return HttpResponse.json(
            { message: 'The slug billing-platform is already taken' },
            { status: 409 },
          );
        }),
      );
      const user = userEvent.setup();

      renderPage();
      await user.click(
        await screen.findByRole('button', { name: /new project/i }),
      );
      await user.type(
        await screen.findByLabelText(/^name/i),
        'Billing Platform',
      );
      await user.click(screen.getByRole('button', { name: /create project/i }));

      expect(
        await screen.findByText(/billing-platform is already taken/i),
      ).toBeInTheDocument();
      // One attempt. A second would be the suffix retry by another name.
      expect(attempts).toHaveLength(1);
      // And the dialog stayed open, so the operator can fix the name.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('selects the project it just created', async () => {
      // The list GROWS, because `useProjects.create` re-reads it rather than
      // splicing the answer in — and since #461 the header reads the name off
      // that list rather than off a held object, so a fixture that stayed
      // empty would be asserting against an API that cannot exist.
      const listed: Project[] = [];
      server.use(
        http.get(`${API_BASE}/projects`, () =>
          HttpResponse.json({
            data: {
              items: listed,
              total: listed.length,
              page: 1,
              pageSize: 25,
              totalPages: listed.length === 0 ? 0 : 1,
            },
          }),
        ),
        http.post(`${API_BASE}/projects`, () => {
          listed.push(projectFixture());
          return HttpResponse.json({ data: projectFixture() }, { status: 201 });
        }),
      );
      const asked = serveRepositories({ none: [], [PROJECT_ID]: [] });
      const user = userEvent.setup();

      renderPage();
      await user.click(
        await screen.findByRole('button', { name: /new project/i }),
      );
      await user.type(
        await screen.findByLabelText(/^name/i),
        'Billing Platform',
      );
      await user.click(screen.getByRole('button', { name: /create project/i }));

      expect(
        await screen.findByRole('heading', { name: 'Billing Platform' }),
      ).toBeInTheDocument();
      await waitFor(() => expect(asked).toContain(PROJECT_ID));
      // In the address, not only on screen: a create that selected the project
      // in local state would leave a reload back on the unassigned bucket.
      expect(locationNow()).toBe(`/projects?project=${PROJECT_ID}`);
    });
  });

  describe('Editing a project', () => {
    it('renames without moving the slug', async () => {
      // Derivation happens once, at creation. A rename that quietly moved the
      // handle would break everything that referenced it, so the PATCH carries
      // no slug unless the operator edited the slug field itself.
      serveProjects(projectFixture({ repositoryCount: 1 }));
      serveRepositories({ none: [], [PROJECT_ID]: [] });
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.patch(`${API_BASE}/projects/:id`, async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({
            data: projectFixture({ name: 'Billing', repositoryCount: 1 }),
          });
        }),
      );
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });
      await user.click(
        screen.getByRole('button', { name: /Billing Platform/ }),
      );
      await user.click(await screen.findByRole('button', { name: /^edit$/i }));

      const name = await screen.findByLabelText(/^name/i);
      await user.clear(name);
      await user.type(name, 'Billing');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).not.toHaveProperty('slug');
      expect(bodies[0]).toEqual({
        name: 'Billing',
        description: 'Everything that takes money.',
      });
      // And the header shows the name the API returned.
      expect(
        await screen.findByRole('heading', { name: 'Billing' }),
      ).toBeInTheDocument();
    });

    it('sends the slug when the operator moved it deliberately', async () => {
      serveProjects(projectFixture());
      serveRepositories({ none: [], [PROJECT_ID]: [] });
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.patch(`${API_BASE}/projects/:id`, async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({
            data: projectFixture({ slug: 'billing' }),
          });
        }),
      );
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });
      await user.click(
        screen.getByRole('button', { name: /Billing Platform/ }),
      );
      await user.click(await screen.findByRole('button', { name: /^edit$/i }));

      const slug = await screen.findByLabelText(/^slug/i);
      await user.clear(slug);
      await user.type(slug, 'billing');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toHaveProperty('slug', 'billing');
    });
  });

  describe('Paging the project list', () => {
    it('asks the API for the next page rather than slicing this one', async () => {
      const pages: string[] = [];
      server.use(
        http.get(`${API_BASE}/projects`, ({ request }) => {
          const page = new URL(request.url).searchParams.get('page') ?? '1';
          pages.push(page);
          return HttpResponse.json({
            data: {
              items: [
                projectFixture({
                  id: page === '1' ? PROJECT_ID : OTHER_PROJECT_ID,
                  name: page === '1' ? 'Billing Platform' : 'Ledger',
                  slug: page === '1' ? 'billing-platform' : 'ledger',
                }),
              ],
              total: 2,
              page: Number(page),
              pageSize: 1,
              totalPages: 2,
            },
          });
        }),
      );
      serveRepositories({ none: [] });
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });
      await user.click(screen.getByRole('button', { name: /^next$/i }));

      await waitFor(() => expect(pages).toEqual(['1', '2']));
      expect(
        await screen.findByRole('button', { name: /Ledger/ }),
      ).toBeInTheDocument();
    });
  });

  describe('Deleting a project', () => {
    it('says the repositories become unassigned, not deleted', async () => {
      serveProjects(projectFixture({ repositoryCount: 3 }));
      serveRepositories({ none: [], [PROJECT_ID]: [] });
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });
      await user.click(
        screen.getByRole('button', { name: /Billing Platform/ }),
      );
      await user.click(
        await screen.findByRole('button', { name: /delete project/i }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(/3 repositories will become unassigned/i),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(/They are not deleted/i),
      ).toBeInTheDocument();
    });

    it('shows the API refusal rather than closing on a failed deletion', async () => {
      serveProjects(projectFixture({ repositoryCount: 1 }));
      serveRepositories({ none: [], [PROJECT_ID]: [] });
      server.use(
        http.delete(`${API_BASE}/projects/:id`, () =>
          HttpResponse.json({ message: 'Project not found' }, { status: 404 }),
        ),
      );
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });
      await user.click(
        screen.getByRole('button', { name: /Billing Platform/ }),
      );
      await user.click(
        await screen.findByRole('button', { name: /delete project/i }),
      );
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', {
          name: /^delete project$/i,
        }),
      );

      expect(await screen.findByText(/Project not found/i)).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('falls back to the unassigned bucket once the project is gone', async () => {
      serveProjects(projectFixture({ repositoryCount: 1 }));
      const asked = serveRepositories({
        none: [repositoryFixture()],
        [PROJECT_ID]: [],
      });
      server.use(
        http.delete(`${API_BASE}/projects/:id`, () =>
          HttpResponse.json({
            data: {
              id: PROJECT_ID,
              slug: 'billing-platform',
              unassignedRepositories: 1,
            },
          }),
        ),
      );
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });
      await user.click(
        screen.getByRole('button', { name: /Billing Platform/ }),
      );
      await user.click(
        await screen.findByRole('button', { name: /delete project/i }),
      );
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', {
          name: /^delete project$/i,
        }),
      );

      // The repositories are exactly where the operator should now be looking.
      expect(
        await screen.findByLabelText('Repository acme/widgets'),
      ).toBeInTheDocument();
      expect(asked[asked.length - 1]).toBe('none');
    });
  });

  /**
   * The selection is a query parameter, not local state (#461).
   *
   * It used to be `useState` here, which made every claim below impossible:
   * the scope died on reload, could not be linked to, and could not be handed
   * to `/steering`. The cases are the ones a plausible move-it-to-the-URL gets
   * wrong — a URL written but not read, a URL read but not written, and a
   * header that renders the unassigned bucket while a named project's
   * repositories load underneath it.
   */
  describe('Which project is open lives in the URL', () => {
    it('opens on the project the address names, and asks the API for it', async () => {
      serveProjects(projectFixture({ repositoryCount: 1 }));
      const asked = serveRepositories({
        none: [],
        [PROJECT_ID]: [repositoryFixture({ projectId: PROJECT_ID })],
      });

      // A reload, expressed exactly: the page is told nothing but the address.
      renderPage({ route: `/projects?project=${PROJECT_ID}` });

      expect(
        await screen.findByRole('heading', { name: 'Billing Platform' }),
      ).toBeInTheDocument();
      await waitFor(() => expect(asked).toEqual([PROJECT_ID]));
      // The unassigned bucket was never asked for. A page that landed on it
      // first and corrected itself would show the whole registry under this
      // project's heading for a frame.
      expect(asked).not.toContain('none');
    });

    it('reads the unassigned bucket from an absent parameter and from none', async () => {
      serveProjects(projectFixture());
      const asked = serveRepositories({ none: [repositoryFixture()] });

      renderPage({ route: '/projects?project=none' });

      expect(
        await screen.findByLabelText('Repository acme/widgets'),
      ).toBeInTheDocument();
      // `none` is the value `GET /repositories?projectId=` itself takes, so
      // the address and the request say unassigned the same way.
      expect(asked).toEqual(['none']);
      expect(
        screen.getByRole('heading', { name: 'Unassigned' }),
      ).toBeInTheDocument();
    });

    it('writes the selection into the address when a row is clicked', async () => {
      serveProjects(projectFixture({ repositoryCount: 1 }));
      serveRepositories({ none: [], [PROJECT_ID]: [] });
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });
      expect(locationNow()).toBe('/projects');

      await user.click(
        screen.getByRole('button', { name: /Billing Platform/ }),
      );
      await waitFor(() =>
        expect(locationNow()).toBe(`/projects?project=${PROJECT_ID}`),
      );

      // Back to the bucket CLEARS the parameter rather than writing `none`:
      // a bare `/projects` is the address the navigation rail already points
      // at, and the two must be the same page.
      await user.click(screen.getByRole('button', { name: /^Unassigned/ }));
      await waitFor(() => expect(locationNow()).toBe('/projects'));
    });

    it('keeps the project heading when the search filters its row away', async () => {
      // The URL carries the id; the list carries the name. A search that
      // removes the selected row must not blank the header over the panel —
      // the repositories under it have not moved anywhere.
      server.use(
        http.get(`${API_BASE}/projects`, ({ request }) => {
          const search = new URL(request.url).searchParams.get('search');
          // The selected project matches nothing the operator searched for, so
          // its row leaves the list while it stays open in the panel.
          const items =
            search === null ? [projectFixture({ repositoryCount: 1 })] : [];
          return HttpResponse.json({
            data: {
              items,
              total: items.length,
              page: 1,
              pageSize: 25,
              totalPages: items.length === 0 ? 0 : 1,
            },
          });
        }),
      );
      serveRepositories({ none: [], [PROJECT_ID]: [] });
      const user = userEvent.setup();

      renderPage({ route: `/projects?project=${PROJECT_ID}` });
      await screen.findByRole('heading', { name: 'Billing Platform' });

      await user.type(
        screen.getByLabelText(/search projects/i),
        'ledger{enter}',
      );

      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: /Billing Platform/ }),
        ).toBeNull(),
      );
      expect(
        screen.getByRole('heading', { name: 'Billing Platform' }),
      ).toBeInTheDocument();
      expect(locationNow()).toBe(`/projects?project=${PROJECT_ID}`);
    });

    it('does not call an unloaded project the unassigned bucket', async () => {
      // The id is known before the name is. A heading reading "Unassigned"
      // over a named project's repositories would be wrong about the one
      // thing that header exists to say.
      server.use(
        http.get(`${API_BASE}/projects`, async () => {
          await delay(50);
          return HttpResponse.json({
            data: {
              items: [projectFixture()],
              total: 1,
              page: 1,
              pageSize: 25,
              totalPages: 1,
            },
          });
        }),
      );
      serveRepositories({ none: [], [PROJECT_ID]: [] });

      renderPage({ route: `/projects?project=${PROJECT_ID}` });

      expect(
        screen.queryByRole('heading', { name: 'Unassigned' }),
      ).not.toBeInTheDocument();
      expect(
        await screen.findByRole('heading', { name: 'Billing Platform' }),
      ).toBeInTheDocument();
    });
  });

  /**
   * Steering, reached from what the operator is already looking at (#461).
   *
   * The permission is the whole difficulty. Steering is gated on
   * `workorders:write` and this page on `projects:read` — genuinely different
   * rights, and epic #457 flags the asymmetry as something to design around
   * rather than discover later. An account can hold every project permission
   * there is and no right to steer at all, so the entry point has to be ABSENT
   * for them rather than disabled or 403-on-click.
   */
  describe('Steering from the project screen', () => {
    /** Every project permission, and no `workorders:write`. */
    const cannotSteer: MockUser = {
      ...mockAdminUser,
      permissions: mockAdminUser.permissions.filter(
        (permission) => permission !== 'workorders:write',
      ),
    };

    it('links to steering with the open project already scoped', async () => {
      serveProjects(projectFixture({ repositoryCount: 1 }));
      serveRepositories({ none: [], [PROJECT_ID]: [] });

      renderPage({ route: `/projects?project=${PROJECT_ID}` });

      const link = await screen.findByRole('link', {
        name: /steer this project/i,
      });
      expect(link).toHaveAttribute('href', steerProjectHref(PROJECT_ID));
    });

    it('links to steering per repository, from the card that names it', async () => {
      serveProjects(projectFixture({ repositoryCount: 1 }));
      serveRepositories({
        none: [],
        [PROJECT_ID]: [
          repositoryFixture({ projectId: PROJECT_ID, observeEnabled: true }),
        ],
      });

      renderPage({ route: `/projects?project=${PROJECT_ID}` });

      const card = await screen.findByLabelText('Repository acme/widgets');
      expect(
        within(card).getByRole('link', { name: /steer/i }),
      ).toHaveAttribute('href', steerRepositoryHref('acme/widgets'));
    });

    it('renders no steering entry point at all without workorders:write', async () => {
      serveProjects(projectFixture({ repositoryCount: 1 }));
      serveRepositories({
        none: [],
        [PROJECT_ID]: [
          repositoryFixture({ projectId: PROJECT_ID, observeEnabled: true }),
        ],
      });

      renderPage({
        route: `/projects?project=${PROJECT_ID}`,
        user: cannotSteer,
      });

      await screen.findByLabelText('Repository acme/widgets');
      expect(screen.queryByRole('link', { name: /steer/i })).toBeNull();
      // Absent, not disabled — there is no button under a different name
      // either. The rest of the screen is untouched, which is what makes this
      // a permission gate rather than a broken page.
      expect(screen.queryByRole('button', { name: /steer/i })).toBeNull();
      expect(
        screen.getByRole('button', { name: /^edit$/i }),
      ).toBeInTheDocument();
    });

    it('offers no link from a repository steering could not reach', async () => {
      // `useSteeringScopes` builds its options from
      // `observeEnabled=true&retired=false`. A link from anything else would
      // open the picker on nothing chosen and look like a dropped selection.
      serveProjects(projectFixture({ repositoryCount: 2 }));
      serveRepositories({
        none: [],
        [PROJECT_ID]: [
          repositoryFixture({
            id: 'unobserved-id',
            owner: 'acme',
            name: 'quiet',
            fullName: 'acme/quiet',
            projectId: PROJECT_ID,
            observeEnabled: false,
          }),
          repositoryFixture({
            projectId: PROJECT_ID,
            observeEnabled: true,
            retiredAt: '2026-08-02T09:00:00.000Z',
          }),
        ],
      });

      renderPage({ route: `/projects?project=${PROJECT_ID}` });

      const unobserved = await screen.findByLabelText('Repository acme/quiet');
      expect(within(unobserved).queryByRole('link', { name: /steer/i })).toBe(
        null,
      );
      const retired = screen.getByLabelText('Repository acme/widgets');
      expect(within(retired).queryByRole('link', { name: /steer/i })).toBe(
        null,
      );
      // The project itself is still steerable: it holds repositories that
      // could become observable, and the picker states what it reaches.
      expect(
        screen.getByRole('link', { name: /steer this project/i }),
      ).toBeInTheDocument();
    });
  });

  describe('Without projects:write', () => {
    it('renders a working read-only screen, not an empty one', async () => {
      // `projects:read` reaches the page — the destination gate — and the
      // acting permission gates the controls inside it. The seeded viewer role
      // holds the first and not the second.
      serveProjects(projectFixture({ repositoryCount: 1 }));
      serveRepositories({ none: [repositoryFixture()] });

      render(<ProjectsPage />, { wrapperOptions: { user: mockUser } });

      expect(
        await screen.findByLabelText('Repository acme/widgets'),
      ).toBeInTheDocument();
      // Twice: once for the page and once on the card, which is not a
      // duplicate — a reader landing on either has to learn the same thing.
      expect(screen.getAllByText('projects:write').length).toBeGreaterThan(0);
      expect(
        screen.queryByRole('button', { name: /new project/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^add repository$/i }),
      ).toBeDisabled();
    });
  });

  describe('The subtitle that started this issue', () => {
    it('no longer sends the operator to a settings screen to change things', async () => {
      // The old page said: "This table READS those permissions; the Control
      // Center is where they are changed." That sentence is the issue.
      serveProjects();
      serveRepositories({ none: [] });

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });

      expect(
        screen.queryByText(/the Control Center is where they are changed/i),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/added, enabled and retired here/i),
      ).toBeInTheDocument();
    });
  });

  describe('Searching projects', () => {
    it('sends the search to the API rather than filtering the page', async () => {
      const searches = serveProjects(projectFixture({ id: OTHER_PROJECT_ID }));
      serveRepositories({ none: [] });
      const user = userEvent.setup();

      renderPage();
      await screen.findByRole('navigation', { name: 'Projects' });
      await user.type(
        screen.getByLabelText(/search projects/i),
        'ledger{enter}',
      );

      await waitFor(() => expect(searches).toEqual([null, 'ledger']));
    });
  });
});
