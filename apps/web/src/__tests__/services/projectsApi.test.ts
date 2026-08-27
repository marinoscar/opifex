import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import {
  assignRepositoryToProject,
  createProject,
  deleteProject,
  getProjects,
  getRepositories,
  retireRepository,
  unassignRepositoryFromProject,
  unretireRepository,
} from '../../services/api';
import { PROJECT_ID, REPOSITORY_ID } from '../mocks/repositories';

/**
 * The projects and retirement clients (#404, #405, #406).
 *
 * What is asserted here is the WIRE CONTRACT: which query parameters reach
 * `GET /api/repositories`, which method and path each action uses, and what
 * comes back out of the `{ data }` envelope. All of them are places a
 * plausible client is silently wrong — a parameter the endpoint does not
 * declare is dropped by zod without a word, so a filter that looks applied
 * would simply return everything.
 *
 * The `retired` filter earns its own cases because its default is the
 * surprising one: **omitted means BOTH**. A client that helpfully sent
 * `retired=false` when nobody asked would hide a repository the moment it was
 * retired, leaving an operator unable to find the thing they just stood down
 * in order to un-retire it.
 */

const API = '*/api';

function repositoriesPage() {
  return HttpResponse.json({
    data: { items: [], total: 0, page: 1, pageSize: 25 },
  });
}

function captureRepositoryQuery() {
  const searches: string[] = [];
  server.use(
    http.get(`${API}/repositories`, ({ request }) => {
      searches.push(new URL(request.url).search);
      return repositoriesPage();
    }),
  );
  return searches;
}

describe('getRepositories', () => {
  it('omits `retired` entirely when it was not asked for, so both are returned', async () => {
    const searches = captureRepositoryQuery();

    await getRepositories({ projectId: 'none' });

    expect(searches).toEqual(['?projectId=none']);
    expect(searches[0]).not.toContain('retired');
  });

  it('sends retired=false only when false was actually asked for', async () => {
    // `false` and "not asked" are different requests, and a client that
    // collapsed them would make the default the opposite of the API's.
    const searches = captureRepositoryQuery();

    await getRepositories({ retired: false });

    expect(searches).toEqual(['?retired=false']);
  });

  it('sends the project id as the API spells it', async () => {
    const searches = captureRepositoryQuery();

    await getRepositories({ projectId: PROJECT_ID, retired: true });

    expect(searches).toEqual([`?projectId=${PROJECT_ID}&retired=true`]);
  });
});

describe('getProjects', () => {
  it('drops a blank search rather than sending one the API rejects', async () => {
    // `search` is `min(1)` after trimming, so a blank string is a 400 — and
    // "I cleared the box" means no filter, not a filter matching nothing.
    const searches: string[] = [];
    server.use(
      http.get(`${API}/projects`, ({ request }) => {
        searches.push(new URL(request.url).search);
        return HttpResponse.json({
          data: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 },
        });
      }),
    );

    await getProjects({ search: '   ' });
    await getProjects({ search: ' billing ' });

    expect(searches).toEqual(['', '?search=billing']);
  });
});

describe('The project write endpoints', () => {
  it('unwraps the created project out of the envelope', async () => {
    server.use(
      http.post(`${API}/projects`, () =>
        HttpResponse.json(
          {
            data: {
              id: PROJECT_ID,
              slug: 'billing-platform',
              name: 'Billing Platform',
              description: null,
              repositoryCount: 0,
              createdAt: '2026-08-01T09:00:00.000Z',
              updatedAt: '2026-08-01T09:00:00.000Z',
            },
          },
          { status: 201 },
        ),
      ),
    );

    await expect(createProject({ name: 'Billing Platform' })).resolves.toEqual(
      expect.objectContaining({ slug: 'billing-platform', repositoryCount: 0 }),
    );
  });

  it('returns what a deletion left unassigned rather than nothing', async () => {
    // A 204 would be shorter and would hide the one fact worth stating: the
    // repositories were not deleted with the project.
    server.use(
      http.delete(`${API}/projects/:id`, () =>
        HttpResponse.json({
          data: {
            id: PROJECT_ID,
            slug: 'billing-platform',
            unassignedRepositories: 3,
          },
        }),
      ),
    );

    await expect(deleteProject(PROJECT_ID)).resolves.toEqual({
      id: PROJECT_ID,
      slug: 'billing-platform',
      unassignedRepositories: 3,
    });
  });

  it('assigns with PUT and unassigns with DELETE on the project-scoped path', async () => {
    // Not a PATCH on the repository. The scoped path asserts the repository is
    // in THIS project, which is what makes a stale screen's unassign a 404
    // rather than a move it did not intend.
    const calls: string[] = [];
    server.use(
      http.put(
        `${API}/projects/:id/repositories/:repositoryId`,
        ({ request, params }) => {
          calls.push(`PUT ${String(params.id)}/${String(params.repositoryId)}`);
          void request;
          return HttpResponse.json({ data: { id: REPOSITORY_ID } });
        },
      ),
      http.delete(
        `${API}/projects/:id/repositories/:repositoryId`,
        ({ params }) => {
          calls.push(
            `DELETE ${String(params.id)}/${String(params.repositoryId)}`,
          );
          return HttpResponse.json({ data: { id: REPOSITORY_ID } });
        },
      ),
    );

    await assignRepositoryToProject(PROJECT_ID, REPOSITORY_ID);
    await unassignRepositoryFromProject(PROJECT_ID, REPOSITORY_ID);

    expect(calls).toEqual([
      `PUT ${PROJECT_ID}/${REPOSITORY_ID}`,
      `DELETE ${PROJECT_ID}/${REPOSITORY_ID}`,
    ]);
  });
});

describe('Retire and un-retire', () => {
  it('POSTs to the action endpoints, never a PATCH of the flags', async () => {
    const calls: string[] = [];
    server.use(
      http.post(`${API}/repositories/:id/retire`, async ({ request }) => {
        calls.push(`retire ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ data: { id: REPOSITORY_ID } });
      }),
      http.post(`${API}/repositories/:id/unretire`, async ({ request }) => {
        calls.push(`unretire ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ data: { id: REPOSITORY_ID } });
      }),
    );

    await retireRepository(REPOSITORY_ID, 'Superseded');
    await unretireRepository(REPOSITORY_ID);

    expect(calls).toEqual([
      'retire {"reason":"Superseded"}',
      // No `reason` key at all. The field is `min(1)` after trimming, so an
      // empty string is a 400 rather than "no reason given".
      'unretire {}',
    ]);
  });
});
