/**
 * The scope picker, mounted (#460, epic #457).
 *
 * `useSteeringScopes` is NOT mocked: the composer reads projects and
 * repositories over MSW the way a browser would, because what these cases
 * assert is which rows become which option and what leaves for the API — and
 * a mocked hook would let every one of those be true of nothing (#417's rule:
 * a fixture is evidence about a fixture).
 *
 * `onPropose` is a spy rather than a real request, because what is being
 * asserted here is the OBJECT the composer hands up: the exclusivity is a
 * property of that object, and reading it directly is stricter than reading it
 * back off a JSON body. `SteeringPage.test.tsx` asserts the wire.
 *
 * The cases are the ones a plausible implementation gets wrong:
 *
 *  - a picker offering only projects, unreachable for the repository that has
 *    none — every repository on a pre-#404 deployment;
 *  - a request carrying two of `repository`, `project` and `allRepositories`,
 *    which the API answers 400 to;
 *  - a select with one entry on a single-repository deployment;
 *  - a scope cleared between instructions, which makes the widest state the
 *    one you reach by doing nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { InstructionComposer } from '../../../components/steering/InstructionComposer';
import {
  OTHER_PROJECT_ID,
  PROJECT_ID,
  projectFixture,
  repositoryFixture,
} from '../../mocks/repositories';
import type { RepositorySummary } from '../../../types/cockpit';
import type { Project } from '../../../types/projects';

const API_BASE = '*/api';

const INSTRUCTION = 'only work on #1 and #2';

function registered(
  fullName: string,
  projectId: string | null = null,
): RepositorySummary {
  const [owner, name] = fullName.split('/');
  return repositoryFixture({
    id: `id-${fullName}`,
    owner,
    name,
    fullName,
    projectId,
    observeEnabled: true,
  });
}

/**
 * Both lists, and the repository query each request carried.
 *
 * The query is kept because the picker must offer exactly what steering calls
 * REGISTERED — `observeEnabled: true`, `retired: false`. A picker that read
 * the whole registry would offer a retired repository the API then answers 404
 * to, which is the typo failure this issue removes, arrived at from the other
 * end.
 */
function serveScopes(
  repositories: RepositorySummary[],
  projects: Project[] = [],
) {
  const queries: Record<string, string | null>[] = [];
  server.use(
    http.get(`${API_BASE}/repositories`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      queries.push({
        observeEnabled: params.get('observeEnabled'),
        retired: params.get('retired'),
      });
      return HttpResponse.json({
        data: {
          items: repositories,
          total: repositories.length,
          page: 1,
          pageSize: 100,
        },
      });
    }),
    http.get(`${API_BASE}/projects`, () =>
      HttpResponse.json({
        data: {
          items: projects,
          total: projects.length,
          page: 1,
          pageSize: 100,
          totalPages: 1,
        },
      }),
    ),
  );
  return queries;
}

const scopeControl = () => screen.getByRole('combobox', { name: /Scope/ });

/** Open the select and click one option by its visible label. */
async function chooseScope(
  user: ReturnType<typeof userEvent.setup>,
  label: string | RegExp,
) {
  await user.click(scopeControl());
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByText(label));
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

async function typeAndPropose(
  user: ReturnType<typeof userEvent.setup>,
  instruction = INSTRUCTION,
) {
  await user.type(screen.getByLabelText('Steering instruction'), instruction);
  await user.click(
    screen.getByRole('button', {
      name: 'Propose a label diff for this instruction',
    }),
  );
}

function renderComposer() {
  const onPropose = vi.fn();
  render(<InstructionComposer disabled={false} onPropose={onPropose} />);
  return onPropose;
}

describe('InstructionComposer scope picker', () => {
  it('asks for exactly the set steering calls registered', async () => {
    const queries = serveScopes([
      registered('acme/widgets'),
      registered('acme/legacy'),
    ]);
    renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });
    expect(queries[0]).toEqual({ observeEnabled: 'true', retired: 'false' });
  });

  it('has no free-text repository field left to mistype into', async () => {
    serveScopes([registered('acme/widgets'), registered('acme/legacy')]);
    renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });
    expect(screen.queryByLabelText('Repository for bare issue numbers')).toBe(
      null,
    );
    expect(screen.queryByLabelText(/Repository \(optional\)/)).toBeNull();
  });

  /**
   * The failure mode the epic calls out by name: `projectId` is nullable, and
   * on a deployment predating #404 EVERY repository is unassigned. A picker
   * reachable only through projects would reach nothing there.
   */
  it('lets a repository with no project be chosen directly', async () => {
    const user = userEvent.setup();
    serveScopes(
      [registered('acme/widgets', PROJECT_ID), registered('acme/legacy')],
      [projectFixture({ id: PROJECT_ID, name: 'Billing Platform' })],
    );
    const onPropose = renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });
    await chooseScope(user, 'acme/legacy');
    await typeAndPropose(user);

    expect(onPropose).toHaveBeenCalledWith(INSTRUCTION, {
      repository: 'acme/legacy',
    });
  });

  it('lets the whole unassigned bucket be chosen as one scope', async () => {
    const user = userEvent.setup();
    serveScopes(
      [registered('acme/widgets', PROJECT_ID), registered('acme/legacy')],
      [projectFixture({ id: PROJECT_ID, name: 'Billing Platform' })],
    );
    const onPropose = renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });
    await chooseScope(user, 'No project (1)');
    await typeAndPropose(user);

    // `'none'` is a member of `project`, not a separate flag: unassigned is an
    // ANSWER to "which project", the API's own idiom.
    expect(onPropose).toHaveBeenCalledWith(INSTRUCTION, { project: 'none' });
  });

  it('sends a project as a project, never as its repositories', async () => {
    const user = userEvent.setup();
    serveScopes(
      [
        registered('acme/widgets', PROJECT_ID),
        registered('acme/invoices', PROJECT_ID),
        registered('acme/legacy'),
      ],
      [projectFixture({ id: PROJECT_ID, name: 'Billing Platform' })],
    );
    const onPropose = renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });
    await chooseScope(user, 'Project: Billing Platform');
    await typeAndPropose(user);

    // The expansion is the API's, at request time. Sending the repositories
    // would make the browser's view of the project the authority.
    expect(onPropose).toHaveBeenCalledWith(INSTRUCTION, {
      project: PROJECT_ID,
    });
  });

  /** ADR-0020 decision 2: the deployment-wide sweep is stated, not defaulted. */
  it('offers every observed repository as a deliberate choice', async () => {
    const user = userEvent.setup();
    serveScopes([registered('acme/widgets'), registered('acme/legacy')]);
    const onPropose = renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });

    // Not what an untouched composer sends.
    await typeAndPropose(user);
    expect(onPropose).toHaveBeenLastCalledWith(INSTRUCTION, {});

    await chooseScope(user, 'Every observed repository');
    await typeAndPropose(user, 'hold #14');
    expect(onPropose).toHaveBeenLastCalledWith('hold #14', {
      allRepositories: true,
    });
  });

  it('never hands up two of the three scope fields', async () => {
    const user = userEvent.setup();
    serveScopes(
      [registered('acme/widgets', PROJECT_ID), registered('acme/legacy')],
      [
        projectFixture({ id: PROJECT_ID, name: 'Billing Platform' }),
        projectFixture({
          id: OTHER_PROJECT_ID,
          name: 'Platform',
          slug: 'platform',
        }),
      ],
    );
    const onPropose = renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });

    // Changing the scope replaces it. A picker that accumulated would earn a
    // 400 the operator could not have caused.
    await chooseScope(user, 'acme/widgets');
    await chooseScope(user, 'Project: Billing Platform');
    await chooseScope(user, 'Every observed repository');
    await typeAndPropose(user);

    const [, scope] = onPropose.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(Object.keys(scope)).toEqual(['allRepositories']);
  });

  it('keeps the scope for the next instruction', async () => {
    const user = userEvent.setup();
    serveScopes([registered('acme/widgets'), registered('acme/legacy')]);
    const onPropose = renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });
    await chooseScope(user, 'acme/widgets');
    await typeAndPropose(user);
    await typeAndPropose(user, 'hold #14');

    // Clearing it between instructions would make the widest state the one an
    // operator arrives at by doing nothing.
    expect(onPropose).toHaveBeenLastCalledWith('hold #14', {
      repository: 'acme/widgets',
    });
  });

  it('keeps the chosen scope on screen beside the button', async () => {
    const user = userEvent.setup();
    serveScopes([registered('acme/widgets'), registered('acme/legacy')]);
    renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });
    await chooseScope(user, 'acme/widgets');

    expect(
      await screen.findByText('Applies to: acme/widgets'),
    ).toBeInTheDocument();
    // And what it means, not only its name.
    expect(
      screen.getByText(/Only acme\/widgets\. A bare #12 means an issue in it/),
    ).toBeInTheDocument();
  });

  it('is reachable and operable from the keyboard', async () => {
    const user = userEvent.setup();
    serveScopes([registered('acme/widgets'), registered('acme/legacy')]);
    const onPropose = renderComposer();

    const control = await screen.findByRole('combobox', { name: /Scope/ });
    control.focus();
    expect(control).toHaveFocus();

    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText('acme/legacy'));
    await typeAndPropose(user);

    expect(onPropose).toHaveBeenCalledWith(INSTRUCTION, {
      repository: 'acme/legacy',
    });
  });

  /**
   * ADR-0020 leaves this deployment alone deliberately: with one registered
   * repository the API resolves a bare `#12` and an "everything else" sweep
   * against it unaided, so a control with one entry is friction with no risk
   * behind it — which trains an operator to click past it.
   */
  it('does not make a one-repository deployment choose', async () => {
    const user = userEvent.setup();
    serveScopes([registered('acme/only')], [projectFixture()]);
    const onPropose = renderComposer();

    expect(await screen.findByText(/the only repository/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Scope/ })).toBeNull();
    expect(screen.queryByText(/Applies to:/)).toBeNull();
    // And no warning about an unscoped instruction, because there is nothing
    // ambiguous about one here.
    expect(screen.queryByText(/No scope is chosen/)).toBeNull();

    await typeAndPropose(user);
    expect(onPropose).toHaveBeenCalledWith(INSTRUCTION, {});
  });

  it('warns before the round trip when nothing is scoped', async () => {
    serveScopes([registered('acme/widgets'), registered('acme/legacy')]);
    renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });
    // The count is in the sentence: "more than one" is the whole reason the
    // API refuses, and naming it is what tells an operator the warning is
    // about their deployment rather than about steering in general.
    expect(
      screen.getByText(/No scope is chosen, so a bare #12 has 2 repositories/),
    ).toBeInTheDocument();
  });

  /**
   * Both list schemas cap `pageSize` at 100. A first-page-only read on a
   * deployment with more than that would offer 100 repositories with no sign
   * the rest existed — a picker that silently omits a repository is the same
   * mis-scoping this issue removes, reached from the other direction.
   */
  it('reads past the first page rather than offering a truncated list', async () => {
    const user = userEvent.setup();
    const pagesAsked: string[] = [];
    server.use(
      http.get(`${API_BASE}/repositories`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page') ?? '1';
        pagesAsked.push(page);
        return HttpResponse.json({
          data: {
            items:
              page === '1'
                ? [registered('acme/widgets'), registered('acme/invoices')]
                : [registered('acme/onlyOnPageTwo')],
            total: 3,
            page: Number(page),
            pageSize: 2,
          },
        });
      }),
      http.get(`${API_BASE}/projects`, () =>
        HttpResponse.json({
          data: { items: [], total: 0, page: 1, pageSize: 100, totalPages: 0 },
        }),
      ),
    );
    const onPropose = renderComposer();

    await screen.findByRole('combobox', { name: /Scope/ });
    expect(pagesAsked).toEqual(['1', '2']);

    await chooseScope(user, 'acme/onlyOnPageTwo');
    await typeAndPropose(user);
    expect(onPropose).toHaveBeenCalledWith(INSTRUCTION, {
      repository: 'acme/onlyOnPageTwo',
    });
  });

  it('says so plainly when nothing is registered at all', async () => {
    serveScopes([]);
    renderComposer();

    expect(
      await screen.findByText(/No repository is registered with Opifex/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Scope/ })).toBeNull();
  });

  it('falls back to naming issues in full when the lists cannot be read', async () => {
    server.use(
      http.get(`${API_BASE}/repositories`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );
    renderComposer();

    expect(
      await screen.findByText(/Every issue has to be written out as/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Scope/ })).toBeNull();
    // The instruction box still works: a scope that cannot be read is not a
    // reason to refuse an instruction naming `owner/name#12`.
    expect(screen.getByLabelText('Steering instruction')).toBeEnabled();
  });
});
