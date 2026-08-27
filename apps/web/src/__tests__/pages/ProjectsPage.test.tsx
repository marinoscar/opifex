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
import { http, HttpResponse } from 'msw';

import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import ProjectsPage from '../../pages/ProjectsPage';
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
 * The page, as an account that may actually change things.
 *
 * The default fixture user is the seeded VIEWER, who holds `projects:read` and
 * not `projects:write` — correct for the read-only case below and wrong for
 * every other one, where a missing New project button would look like a bug in
 * the page rather than in the fixture.
 */
function renderPage() {
  return render(<ProjectsPage />, {
    wrapperOptions: { user: mockAdminUser },
  });
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
      serveProjects();
      const asked = serveRepositories({ none: [], [PROJECT_ID]: [] });
      server.use(
        http.post(`${API_BASE}/projects`, () =>
          HttpResponse.json({ data: projectFixture() }, { status: 201 }),
        ),
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
        await screen.findByRole('heading', { name: 'Billing Platform' }),
      ).toBeInTheDocument();
      await waitFor(() => expect(asked).toContain(PROJECT_ID));
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
