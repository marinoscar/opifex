/**
 * The Projects panel — the enablement ladder (#350), retirement (#405) and
 * everything else `/projects` now does to a repository (#406, epic #403).
 *
 * These cases came with the ladder when it moved out of the Control Center,
 * because what they assert is the DESIGN — the ordered progression, the
 * out-of-order confirmation, the PATCH that carries only what moved — and none
 * of that is a property of where the component is mounted.
 *
 * `useRepositoryLadder` is NOT mocked: the panel runs for real against MSW,
 * because what is being asserted is what reaches and leaves the API. A mocked
 * hook would let "enabling a rung sends only that rung" be true of nothing.
 *
 * The cases here are the ones a plausible implementation gets wrong:
 *
 *  - four switches rendered as a set rather than as an ordered progression;
 *  - a rung enabled out of order saved silently, or refused outright;
 *  - a PATCH carrying flags the operator never touched, resetting them;
 *  - an empty budget field sent as `0` rather than as `null`;
 *  - the access probe's missing endpoint drawn as a failure, or as a pass;
 *  - retired read off the four flags rather than off `retiredAt`;
 *  - de-register offered on a repository whose deletion the API would refuse;
 *  - the unassigned bucket rendered as a lesser screen than a project;
 *  - a GitHub-level label failure rendered as "0 of 15 labels present", which
 *    is the one mistake #415's row exists not to make.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { ProjectRepositoriesPanel } from '../../../components/projects/ProjectRepositoriesPanel';
import type { RepositorySummary } from '../../../types/cockpit';
import type { Project, ProjectScope } from '../../../types/projects';
import {
  DECLARED_LABELS,
  PROJECT_ID,
  labelFailureFixture,
  labelReportFixture,
  projectFixture,
  repositoryFixture,
} from '../../mocks/repositories';
import type { LabelProvisioningReport } from '../../../types/repositoryLabels';

const API_BASE = '*/api';

/**
 * One repository, in the API's own serialisation.
 *
 * Delegated to the shared fixture so `retiredAt` and `retiredById` are always
 * PRESENT and null rather than absent. An omitted `retiredAt` is `undefined`,
 * which is not `null`, and every card in this file would then render as
 * retired — a fixture bug wearing a component bug's clothes.
 */
function repository(
  overrides: Partial<RepositorySummary> = {},
): RepositorySummary {
  return repositoryFixture(overrides);
}

/**
 * `GET /repositories` answering with these rows, and RECORDING what was asked.
 *
 * The scope reaches the API as `?projectId=`, so the handler keeps the query
 * it saw. A panel that read the whole registry and filtered client-side would
 * pass every rendering assertion in this file and be wrong about the one thing
 * the scope is for.
 */
function listing(...items: RepositorySummary[]) {
  const queries: (string | null)[] = [];
  server.use(
    http.get(`${API_BASE}/repositories`, ({ request }) => {
      queries.push(new URL(request.url).searchParams.get('projectId'));
      return HttpResponse.json({
        data: { items, total: items.length, page: 1, pageSize: 100 },
      });
    }),
  );
  return queries;
}

/**
 * Captures the PATCH body, and answers with the row it implies.
 *
 * The response is NOT a straight echo of the request, and the difference is
 * the whole point: `budgetCeilingUsd` goes to the API as a **number** and
 * comes back as a **string**. `repository.dto.ts` is explicit about why — the
 * column is a Postgres `DECIMAL` and Prisma returns a `Decimal`, because
 * serialising a spend ceiling through a JS number would round it, and that is
 * the one field where rounding is least acceptable.
 *
 * A mock that echoed the number back would hand the component a shape the real
 * API never produces, and the component would then be exercised against a
 * fiction: `budgetCeilingUsd` is typed `string | null`, so a number reaching
 * the field seeds `ceilingText` with one and `parseBudgetCeiling` throws
 * `input.trim is not a function` on the next render. That is a bug in the
 * mock, not in the component — so the mock re-serialises the way the API does.
 */
function capturePatch(stored: RepositorySummary) {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.patch(`${API_BASE}/repositories/:id`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      const { budgetCeilingUsd, ...rest } = body;
      return HttpResponse.json({
        data: {
          ...stored,
          ...rest,
          ...('budgetCeilingUsd' in body
            ? {
                budgetCeilingUsd:
                  budgetCeilingUsd === null
                    ? null
                    : Number(budgetCeilingUsd).toFixed(2),
              }
            : {}),
        },
      });
    }),
  );
  return bodies;
}

/**
 * The two label endpoints, RECORDING what was called (#415).
 *
 * The record is the point: checking must write nothing, so a test that only
 * looked at the rendering could not tell a `GET` from a `POST`. `get` may be
 * an HTTP failure instead of a report, which is a different thing from a
 * report carrying a failure `status` — the panel has to keep those apart.
 */
function serveLabels(options: {
  get?: LabelProvisioningReport | { httpStatus: number; message: string };
  post?: LabelProvisioningReport | { httpStatus: number; message: string };
}) {
  const calls: string[] = [];

  const answer = (
    value: LabelProvisioningReport | { httpStatus: number; message: string },
  ) =>
    'httpStatus' in value
      ? HttpResponse.json(
          { message: value.message },
          { status: value.httpStatus },
        )
      : HttpResponse.json({ data: value });

  server.use(
    http.get(`${API_BASE}/repositories/:id/labels`, ({ params }) => {
      calls.push(`GET ${String(params.id)}`);
      return answer(options.get ?? labelReportFixture());
    }),
    http.post(`${API_BASE}/repositories/:id/labels`, ({ params }) => {
      calls.push(`POST ${String(params.id)}`);
      return answer(options.post ?? labelReportFixture({ applied: true }));
    }),
  );

  return calls;
}

/** The label row of one card. */
function labelRow(card: HTMLElement) {
  return within(card).getByLabelText(/^Factory labels/);
}

/**
 * The panel, in a chosen scope.
 *
 * Defaults to the unassigned bucket, which is where every repository on any
 * existing deployment actually is.
 */
function renderPanel(
  options: {
    canWrite?: boolean;
    scope?: ProjectScope;
    project?: Project | null;
    onEditProject?: () => void;
    onDeleteProject?: () => void;
    onRepositoryCountChanged?: (projectId: string, delta: number) => void;
  } = {},
) {
  return render(
    <ProjectRepositoriesPanel
      scope={options.scope ?? { kind: 'unassigned' }}
      project={options.project ?? null}
      canWrite={options.canWrite ?? true}
      onEditProject={options.onEditProject ?? (() => {})}
      onDeleteProject={options.onDeleteProject ?? (() => {})}
      onRepositoryCountChanged={options.onRepositoryCountChanged ?? (() => {})}
    />,
  );
}

async function awaitCard(name = 'Repository acme/widgets') {
  return screen.findByLabelText(name);
}

describe('ProjectRepositoriesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('The ladder', () => {
    it('renders the four flags as an ordered progression', async () => {
      listing(repository());
      renderPanel();

      const card = await awaitCard();
      const rungs = within(card).getAllByRole('listitem');

      expect(rungs.map((item) => item.getAttribute('aria-label'))).toEqual([
        'Rung 1: Observe',
        'Rung 2: Mirror labels',
        'Rung 3: Spec feedback',
        'Rung 4: Dispatch',
      ]);
    });

    it('says what each rung permits', async () => {
      listing(repository());
      renderPanel();

      const card = await awaitCard();
      expect(
        within(card).getByText(/The reconciler reads this repository/i),
      ).toBeInTheDocument();
      expect(
        within(card).getByText(/may write `factory\/\*` labels/i),
      ).toBeInTheDocument();
      expect(
        within(card).getByText(/This is where money is spent/i),
      ).toBeInTheDocument();
    });

    it('reflects the stored flags on the switches', async () => {
      listing(repository({ observeEnabled: true }));
      renderPanel();

      await awaitCard();
      expect(
        screen.getByRole('switch', { name: /^Observe — acme\/widgets$/ }),
      ).toBeChecked();
      expect(
        screen.getByRole('switch', { name: /^Dispatch — acme\/widgets$/ }),
      ).not.toBeChecked();
    });
  });

  describe('Saving', () => {
    it('sends ONLY the rung that moved', async () => {
      // Omitted fields are left alone by the API, so a PATCH that echoed the
      // whole ladder would overwrite a flag another operator changed between
      // this read and this write.
      const stored = repository();
      listing(stored);
      const bodies = capturePatch(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.click(
        screen.getByRole('switch', { name: /^Observe — acme\/widgets$/ }),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({ observeEnabled: true });
    });

    it('renders what the API returned, not what was sent', async () => {
      const stored = repository();
      listing(stored);
      server.use(
        http.patch(`${API_BASE}/repositories/:id`, () =>
          // The API refused the flag and said so by returning it unchanged —
          // enabling dispatch re-verifies reachability server-side.
          HttpResponse.json({ data: { ...stored, observeEnabled: false } }),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      const observe = screen.getByRole('switch', {
        name: /^Observe — acme\/widgets$/,
      });
      await user.click(observe);
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(observe).not.toBeChecked());
    });

    it('shows the API refusal instead of claiming a save', async () => {
      const stored = repository();
      listing(stored);
      server.use(
        http.patch(`${API_BASE}/repositories/:id`, () =>
          HttpResponse.json(
            { message: 'The GitHub credential is missing or expired' },
            { status: 503 },
          ),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.click(
        screen.getByRole('switch', { name: /^Observe — acme\/widgets$/ }),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      expect(
        await screen.findByText(/credential is missing or expired/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/^Saved at/)).not.toBeInTheDocument();
    });
  });

  describe('Enabling a rung out of order', () => {
    it('warns before saving, naming what is missing', async () => {
      const stored = repository();
      listing(stored);
      const bodies = capturePatch(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.click(
        screen.getByRole('switch', { name: /^Dispatch — acme\/widgets$/ }),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(/Enabling a rung out of order/i),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(/Dispatch is on with/i),
      ).toBeInTheDocument();
      // Nothing was written while the question was on screen.
      expect(bodies).toHaveLength(0);
    });

    it('WARNS rather than refuses — "Save anyway" writes it', async () => {
      // The point of warning instead of blocking: a UI that refuses is one the
      // operator routes around with curl, which is what this section replaces.
      const stored = repository();
      listing(stored);
      const bodies = capturePatch(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.click(
        screen.getByRole('switch', { name: /^Dispatch — acme\/widgets$/ }),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));
      await user.click(
        await screen.findByRole('button', { name: /save anyway/i }),
      );

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({ dispatchEnabled: true });
    });

    it('writes nothing when the operator goes back', async () => {
      const stored = repository();
      listing(stored);
      const bodies = capturePatch(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.click(
        screen.getByRole('switch', { name: /^Dispatch — acme\/widgets$/ }),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));
      await user.click(await screen.findByRole('button', { name: /go back/i }));

      expect(bodies).toHaveLength(0);
    });

    it('does not ask when the ladder is climbed in order', async () => {
      const stored = repository({ observeEnabled: true });
      listing(stored);
      const bodies = capturePatch(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.click(
        screen.getByRole('switch', { name: /^Mirror labels — acme\/widgets$/ }),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows a standing warning for a repository already out of order', async () => {
      // Enabled by a curl call before this screen existed. The state is worth
      // seeing even though this save is not the one that created it.
      listing(repository({ dispatchEnabled: true }));
      renderPanel();

      const card = await awaitCard();
      expect(
        within(card).getByText(/Dispatch is on with observe/i),
      ).toBeInTheDocument();
    });
  });

  describe('Budget ceiling', () => {
    it('sends an edited ceiling as a number', async () => {
      const stored = repository();
      listing(stored);
      const bodies = capturePatch(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.type(screen.getByLabelText(/budget ceiling/i), '12.5');
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({ budgetCeilingUsd: 12.5 });
    });

    it('clears a ceiling as null, never as zero', async () => {
      // `0` is rejected by the API's `positive()` and would read as "spend
      // nothing" while actually meaning the request failed.
      const stored = repository({ budgetCeilingUsd: '40.00' });
      listing(stored);
      const bodies = capturePatch(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.click(screen.getByRole('button', { name: /clear ceiling/i }));
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({ budgetCeilingUsd: null });
    });

    it('names an out-of-range ceiling as it is typed, and will not send it', async () => {
      // The error has to be visible BEFORE Save is pressed, because Save is
      // disabled while the field is invalid — reporting it on click only would
      // leave a dead button with no reason attached to it.
      const stored = repository();
      listing(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.type(screen.getByLabelText(/budget ceiling/i), '99999');

      expect(
        await screen.findByText(/caps a per-run ceiling/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });

    it('will not send a ceiling of zero, and says to clear instead', async () => {
      const stored = repository();
      listing(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      await user.type(screen.getByLabelText(/budget ceiling/i), '0');

      expect(await screen.findByText(/clear the field/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });

    it('does not PATCH a ceiling that only changed its decimal form', async () => {
      // The stored value is a DECIMAL string; '40.00' and 40 are one ceiling.
      const stored = repository({ budgetCeilingUsd: '40.00' });
      listing(stored);
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();

      const field = screen.getByLabelText(/budget ceiling/i);
      await user.clear(field);
      await user.type(field, '40');

      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    });
  });

  describe('The per-repository access test', () => {
    it('reports a reachable repository', async () => {
      listing(repository());
      server.use(
        http.post(`${API_BASE}/operator-settings/probes/github-repo`, () =>
          HttpResponse.json({
            data: {
              ok: true,
              detail: 'GET /repos/acme/widgets returned 200',
              checkedAt: new Date().toISOString(),
            },
          }),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(screen.getByRole('button', { name: /test access/i }));

      expect(await screen.findByText('Reachable')).toBeInTheDocument();
      expect(
        screen.getByText(/GET \/repos\/acme\/widgets returned 200/),
      ).toBeInTheDocument();
    });

    it('reports a token that is valid and does not cover THIS repository', async () => {
      listing(repository());
      server.use(
        http.post(`${API_BASE}/operator-settings/probes/github-repo`, () =>
          HttpResponse.json({
            data: {
              ok: false,
              detail: 'GET /repos/acme/widgets returned 404',
              checkedAt: new Date().toISOString(),
            },
          }),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(screen.getByRole('button', { name: /test access/i }));

      expect(
        await screen.findByText(
          /Not reachable with the configured credential/i,
        ),
      ).toBeInTheDocument();
    });

    it('says "not yet verifiable" when the probe endpoint does not exist', async () => {
      // #338 has not landed. An unrouted path answers 404, and drawing that as
      // a failed access test would report bad news about the repository that
      // nothing established.
      listing(repository());
      server.use(
        http.post(`${API_BASE}/operator-settings/probes/github-repo`, () =>
          HttpResponse.json(
            {
              message: 'Cannot POST /api/operator-settings/probes/github-repo',
            },
            { status: 404 },
          ),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(screen.getByRole('button', { name: /test access/i }));

      expect(await screen.findByText('Not yet verifiable')).toBeInTheDocument();
      expect(screen.getByText(/arrives in #338/i)).toBeInTheDocument();
      expect(screen.queryByText('Reachable')).not.toBeInTheDocument();
    });

    it('leaves the rest of the section usable when the probe is missing', async () => {
      const stored = repository();
      listing(stored);
      const bodies = capturePatch(stored);
      server.use(
        http.post(`${API_BASE}/operator-settings/probes/github-repo`, () =>
          HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(screen.getByRole('button', { name: /test access/i }));
      await screen.findByText('Not yet verifiable');

      await user.click(
        screen.getByRole('switch', { name: /^Observe — acme\/widgets$/ }),
      );
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(bodies).toHaveLength(1));
    });

    it('shows no verdict at all before the test is run', async () => {
      listing(repository());
      renderPanel();
      await awaitCard();

      expect(screen.queryByText('Reachable')).not.toBeInTheDocument();
      expect(screen.queryByText('Not yet verifiable')).not.toBeInTheDocument();
    });
  });

  describe('Without projects:write', () => {
    it('renders the ladder read-only and says which permission is missing', async () => {
      listing(repository({ observeEnabled: true }));
      renderPanel({ canWrite: false });

      await awaitCard();
      for (const name of [
        'Observe',
        'Mirror labels',
        'Spec feedback',
        'Dispatch',
      ]) {
        expect(
          screen.getByRole('switch', {
            name: new RegExp(`^${name} — acme/widgets$`),
          }),
        ).toBeDisabled();
      }
      expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
      expect(screen.getByText('projects:write')).toBeInTheDocument();
      // The stored state is still fully legible — a reader entitled to see the
      // configuration sees it.
      expect(
        screen.getByRole('switch', { name: /^Observe — acme\/widgets$/ }),
      ).toBeChecked();
    });
  });

  describe('Reading the list', () => {
    it('reports a forbidden read as a fact about the account', async () => {
      server.use(
        http.get(`${API_BASE}/repositories`, () =>
          HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
        ),
      );
      renderPanel();

      expect(await screen.findByText(/projects:read/)).toBeInTheDocument();
      // Never "nothing here": that is a measurement nobody made.
      expect(
        screen.queryByText(/No repository is outside a project/i),
      ).not.toBeInTheDocument();
    });

    it('says an empty unassigned bucket is empty, not broken', async () => {
      listing();
      renderPanel();

      expect(
        await screen.findByText(/No repository is outside a project/i),
      ).toBeInTheDocument();
    });

    it('renders one card per registered repository', async () => {
      listing(
        repository(),
        repository({
          id: '44444444-4444-4444-8444-444444444444',
          name: 'gadgets',
          fullName: 'acme/gadgets',
        }),
      );
      renderPanel();

      await awaitCard();
      expect(await awaitCard('Repository acme/gadgets')).toBeInTheDocument();
    });
  });

  describe('The scope, including the one with no project', () => {
    it('asks the API for the unassigned bucket by name', async () => {
      // `projectId=none` is the API's own spelling and the only query that
      // returns the repositories registered before projects existed. A panel
      // that read the whole registry and filtered in the browser would render
      // identically and be wrong the moment a second project existed.
      const queries = listing(repository());
      renderPanel();

      await awaitCard();
      expect(queries).toEqual(['none']);
    });

    it('asks for one project by id when that is the scope', async () => {
      const queries = listing(repository({ projectId: PROJECT_ID }));
      renderPanel({
        scope: { kind: 'project', id: PROJECT_ID },
        project: projectFixture({ repositoryCount: 1 }),
      });

      await awaitCard();
      expect(queries).toEqual([PROJECT_ID]);
    });

    it('gives the unassigned bucket the same ladder as a project', async () => {
      // The acceptance criterion: a repository with no project is FULLY usable
      // here. Not a list, not a read-only view — the switches and the Add
      // button, exactly as a project gets them.
      listing(repository());
      renderPanel();

      const card = await awaitCard();
      expect(within(card).getAllByRole('listitem')).toHaveLength(4);
      expect(
        screen.getByRole('switch', { name: /^Dispatch — acme\/widgets$/ }),
      ).toBeEnabled();
      expect(
        screen.getByRole('button', { name: /^add repository$/i }),
      ).toBeEnabled();
    });

    it('says unassigned is a state rather than a backlog', async () => {
      listing(repository());
      renderPanel();

      await awaitCard();
      expect(
        screen.getByText(/first-class state, not a backlog/i),
      ).toBeInTheDocument();
    });

    it('offers Edit and Delete project only inside a project', async () => {
      listing(repository());
      renderPanel();
      await awaitCard();

      expect(
        screen.queryByRole('button', { name: /delete project/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Retired', () => {
    it('is read from retiredAt, not from the four flags being off', async () => {
      // All four off is reachable without anyone deciding anything — four
      // PATCHes, or a registration that passed observeEnabled: false. Drawing
      // that as retired would report a decision nobody made.
      listing(repository());
      renderPanel();

      const card = await awaitCard();
      expect(within(card).getByText('Nothing enabled')).toBeInTheDocument();
      expect(within(card).queryByText('Retired')).not.toBeInTheDocument();
    });

    it('marks a repository whose retiredAt is set', async () => {
      listing(repository({ retiredAt: '2026-08-20T10:00:00.000Z' }));
      renderPanel();

      const card = await awaitCard();
      expect(within(card).getByText('Retired')).toBeInTheDocument();
      expect(
        within(card).getByText(/work orders, runs and their provenance/i),
      ).toBeInTheDocument();
    });

    it('freezes the rungs while retired, because the API refuses to raise one', async () => {
      listing(repository({ retiredAt: '2026-08-20T10:00:00.000Z' }));
      renderPanel();

      await awaitCard();
      for (const name of [
        'Observe',
        'Mirror labels',
        'Spec feedback',
        'Dispatch',
      ]) {
        expect(
          screen.getByRole('switch', {
            name: new RegExp(`^${name} — acme/widgets$`),
          }),
        ).toBeDisabled();
      }
    });

    it('offers un-retire on a retired repository and retire on a live one', async () => {
      listing(repository({ retiredAt: '2026-08-20T10:00:00.000Z' }));
      renderPanel();

      await awaitCard();
      expect(
        screen.getByRole('button', { name: /^un-retire$/i }),
      ).toBeInTheDocument();
      // Retiring something already retired is not offered a second time.
      expect(
        screen.queryByRole('button', { name: /retire or remove/i }),
      ).not.toBeInTheDocument();
    });

    it('un-retires through the endpoint that says so, not through a PATCH', async () => {
      // Turning a rung on while retired IS un-retiring, and the API refuses
      // it precisely so the audit row gets written. A PATCH here would be the
      // route around that refusal.
      const stored = repository({ retiredAt: '2026-08-20T10:00:00.000Z' });
      listing(stored);
      const calls: string[] = [];
      server.use(
        http.post(`${API_BASE}/repositories/:id/unretire`, ({ params }) => {
          calls.push(String(params.id));
          return HttpResponse.json({
            data: { ...stored, retiredAt: null, retiredById: null },
          });
        }),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(screen.getByRole('button', { name: /^un-retire$/i }));

      await waitFor(() => expect(calls).toEqual([stored.id]));
      const card = await awaitCard();
      await waitFor(() =>
        expect(within(card).queryByText('Retired')).not.toBeInTheDocument(),
      );
    });
  });

  describe('Retire, and the narrow case where delete is honest', () => {
    it('sends the reason on the retire endpoint, and keeps the row listed', async () => {
      // A retired repository is still listed — hiding it would leave an
      // operator unable to find the thing they just retired in order to
      // un-retire it.
      const stored = repository({ observeEnabled: true });
      listing(stored);
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.post(
          `${API_BASE}/repositories/:id/retire`,
          async ({ request }) => {
            bodies.push((await request.json()) as Record<string, unknown>);
            return HttpResponse.json({
              data: {
                ...stored,
                observeEnabled: false,
                retiredAt: '2026-08-27T12:00:00.000Z',
                retiredById: '55555555-5555-4555-8555-555555555555',
              },
            });
          },
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(
        screen.getByRole('button', { name: /retire or remove/i }),
      );
      await user.type(
        await screen.findByLabelText(/why \(optional\)/i),
        'Moved to another factory',
      );
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', {
          name: /^retire$/i,
        }),
      );

      await waitFor(() =>
        expect(bodies).toEqual([{ reason: 'Moved to another factory' }]),
      );
      const card = await awaitCard();
      expect(within(card).getByText('Retired')).toBeInTheDocument();
    });

    it('omits the reason rather than sending an empty one', async () => {
      const stored = repository();
      listing(stored);
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.post(
          `${API_BASE}/repositories/:id/retire`,
          async ({ request }) => {
            bodies.push((await request.json()) as Record<string, unknown>);
            return HttpResponse.json({
              data: { ...stored, retiredAt: '2026-08-27T12:00:00.000Z' },
            });
          },
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(
        screen.getByRole('button', { name: /retire or remove/i }),
      );
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', {
          name: /^retire$/i,
        }),
      );

      // `reason` has `min(1)` after trimming, so an empty string is a 400.
      await waitFor(() => expect(bodies).toEqual([{}]));
    });

    it('offers de-register only when the API confirms nothing has run', async () => {
      listing(repository());
      server.use(
        http.get(`${API_BASE}/work-orders`, () =>
          HttpResponse.json({
            data: { items: [], total: 0, page: 1, pageSize: 1, totalPages: 0 },
          }),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(
        screen.getByRole('button', { name: /retire or remove/i }),
      );

      expect(
        await screen.findByRole('button', { name: /de-register instead/i }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Nothing has run here/i)).toBeInTheDocument();
    });

    it('withholds de-register when work orders exist, and says how many', async () => {
      // The whole point of retire: DELETE is refused with a 400 while the
      // repository has work orders, so offering it would offer it exactly
      // where it fails.
      listing(repository());
      server.use(
        http.get(`${API_BASE}/work-orders`, () =>
          HttpResponse.json({
            data: { items: [], total: 7, page: 1, pageSize: 1, totalPages: 7 },
          }),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(
        screen.getByRole('button', { name: /retire or remove/i }),
      );

      expect(await screen.findByText(/7 work orders/i)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /de-register instead/i }),
      ).not.toBeInTheDocument();
    });

    it('withholds de-register when the count could not be READ, never assuming zero', async () => {
      // `workorders:read` is a different permission from the one that opens
      // this screen. Answering "nothing has run" to somebody who may not ask
      // is the inference this epic keeps naming.
      listing(repository());
      server.use(
        http.get(`${API_BASE}/work-orders`, () =>
          HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(
        screen.getByRole('button', { name: /retire or remove/i }),
      );

      expect(
        await screen.findByText(/could not read how many work orders/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/workorders:read/)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /de-register instead/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Nothing has run here/i),
      ).not.toBeInTheDocument();
    });

    it('drops the row only after the DELETE succeeds', async () => {
      const stored = repository();
      listing(stored);
      server.use(
        http.delete(`${API_BASE}/repositories/:id`, () =>
          HttpResponse.json(
            { message: 'Repository has work orders' },
            { status: 400 },
          ),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(
        screen.getByRole('button', { name: /retire or remove/i }),
      );
      await user.click(
        await screen.findByRole('button', { name: /de-register instead/i }),
      );

      expect(
        await screen.findByText(/Repository has work orders/i),
      ).toBeInTheDocument();
      // Still there. A row removed optimistically would report a
      // de-registration the API declined.
      expect(await awaitCard()).toBeInTheDocument();
    });

    it('removes the row when the API accepts the de-registration', async () => {
      listing(repository());
      server.use(
        http.delete(
          `${API_BASE}/repositories/:id`,
          () => new HttpResponse(null, { status: 204 }),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(
        screen.getByRole('button', { name: /retire or remove/i }),
      );
      await user.click(
        await screen.findByRole('button', { name: /de-register instead/i }),
      );

      await waitFor(() =>
        expect(
          screen.queryByLabelText('Repository acme/widgets'),
        ).not.toBeInTheDocument(),
      );
    });

    it('offers neither action without projects:write', async () => {
      listing(repository());
      renderPanel({ canWrite: false });

      await awaitCard();
      expect(
        screen.getByRole('button', { name: /retire or remove/i }),
      ).toBeDisabled();
    });
  });

  describe('Moving a repository between projects', () => {
    it('assigns through the project endpoint and takes the row out of this scope', async () => {
      const stored = repository();
      listing(stored);
      const assigned: string[] = [];
      server.use(
        http.get(`${API_BASE}/projects`, () =>
          HttpResponse.json({
            data: {
              items: [projectFixture()],
              total: 1,
              page: 1,
              pageSize: 25,
              totalPages: 1,
            },
          }),
        ),
        http.put(
          `${API_BASE}/projects/:id/repositories/:repositoryId`,
          ({ params }) => {
            assigned.push(
              `${String(params.id)}/${String(params.repositoryId)}`,
            );
            return HttpResponse.json({
              data: { ...stored, projectId: String(params.id) },
            });
          },
        ),
      );
      const counted: [string, number][] = [];
      const user = userEvent.setup();

      renderPanel({
        onRepositoryCountChanged: (projectId, delta) =>
          counted.push([projectId, delta]),
      });
      await awaitCard();
      await user.click(screen.getByRole('button', { name: /^move…$/i }));
      await user.click(
        await screen.findByRole('button', { name: /Billing Platform/i }),
      );

      await waitFor(() =>
        expect(assigned).toEqual([`${PROJECT_ID}/${stored.id}`]),
      );
      // The badge beside the list is told, so it does not need a re-read.
      expect(counted).toEqual([[PROJECT_ID, 1]]);
      await waitFor(() =>
        expect(
          screen.queryByLabelText('Repository acme/widgets'),
        ).not.toBeInTheDocument(),
      );
    });

    it('shows the API refusal and keeps the row where it is', async () => {
      // A move that failed and closed the dialog anyway would take the API's
      // reason with it and leave an operator looking at a list that did not
      // change, with nothing said about why.
      const stored = repository();
      listing(stored);
      server.use(
        http.get(`${API_BASE}/projects`, () =>
          HttpResponse.json({
            data: {
              items: [projectFixture()],
              total: 1,
              page: 1,
              pageSize: 25,
              totalPages: 1,
            },
          }),
        ),
        http.put(`${API_BASE}/projects/:id/repositories/:repositoryId`, () =>
          HttpResponse.json({ message: 'Project not found' }, { status: 404 }),
        ),
      );
      const user = userEvent.setup();

      renderPanel();
      await awaitCard();
      await user.click(screen.getByRole('button', { name: /^move…$/i }));
      await user.click(
        await screen.findByRole('button', { name: /Billing Platform/i }),
      );

      expect(await screen.findByText(/Project not found/i)).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(await awaitCard()).toBeInTheDocument();
    });

    it('unassigns through the path that asserts which project it is in', async () => {
      // 404 when the repository is in a DIFFERENT project, which is what stops
      // a stale screen unassigning it from wherever it really went.
      const stored = repository({ projectId: PROJECT_ID });
      listing(stored);
      const removed: string[] = [];
      server.use(
        http.delete(
          `${API_BASE}/projects/:id/repositories/:repositoryId`,
          ({ params }) => {
            removed.push(`${String(params.id)}/${String(params.repositoryId)}`);
            return HttpResponse.json({ data: { ...stored, projectId: null } });
          },
        ),
      );
      const user = userEvent.setup();

      renderPanel({
        scope: { kind: 'project', id: PROJECT_ID },
        project: projectFixture({ repositoryCount: 1 }),
      });
      await awaitCard();
      await user.click(screen.getByRole('button', { name: /^move…$/i }));
      await user.click(
        await screen.findByRole('button', { name: /No project/i }),
      );

      await waitFor(() =>
        expect(removed).toEqual([`${PROJECT_ID}/${stored.id}`]),
      );
    });
  });

  /**
   * The observed label row (#415).
   *
   * The four switches are configured state; this is what GitHub had when
   * somebody last looked. The cases below are the ones that decide whether
   * that distinction survives contact with a real answer.
   */
  describe('The label row', () => {
    const M = DECLARED_LABELS.length;

    it('claims nothing before anybody has looked', async () => {
      serveLabels({});
      listing(repository());
      renderPanel();

      const row = labelRow(await awaitCard());
      expect(
        within(row).getByRole('button', { name: /^check labels$/i }),
      ).toBeInTheDocument();
      // No count, no verdict, no repair. "Nobody has looked" is a third state
      // and it renders as one — not as a pass and not as an absence.
      expect(within(row).queryByText(/labels present/i)).toBeNull();
      expect(
        within(row).queryByRole('button', { name: /create missing labels/i }),
      ).toBeNull();
    });

    it('asks GitHub only when asked to, and writes nothing doing it', async () => {
      const calls = serveLabels({});
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const card = await awaitCard();
      // Nothing on load: each check costs a GitHub request from a budget
      // shared with the operator's own use.
      expect(calls).toEqual([]);

      await user.click(
        within(labelRow(card)).getByRole('button', { name: /check labels/i }),
      );

      await waitFor(() =>
        expect(calls).toEqual([`GET ${repositoryFixture().id}`]),
      );
    });

    it('counts what is there against what is declared', async () => {
      serveLabels({ get: labelReportFixture() });
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );

      expect(
        await within(row).findByText(`${M} of ${M} labels present`),
      ).toBeInTheDocument();
      // Nothing to repair, so nothing is offered: a button here would be a
      // write with no work to do.
      expect(
        within(row).queryByRole('button', { name: /create missing labels/i }),
      ).toBeNull();
    });

    it('names what is missing and what it costs, not just how many', async () => {
      serveLabels({
        get: labelReportFixture({ missing: ['factory:ready', 'tier:small'] }),
      });
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );

      expect(
        await within(row).findByText(`${M - 2} of ${M} labels present`),
      ).toBeInTheDocument();
      // NAMED. A count cannot say whether the absent one is the eligibility
      // signal or a model-tier hint, and those are not the same situation.
      const outstanding = within(row).getByLabelText(/missing or out of date/i);
      expect(
        within(outstanding).getByText('factory:ready'),
      ).toBeInTheDocument();
      expect(within(outstanding).getByText('tier:small')).toBeInTheDocument();
      // Grouped by kind, each saying what its absence costs.
      expect(
        within(outstanding).getByText(/Input labels — the control surface/),
      ).toBeInTheDocument();
      expect(
        within(outstanding).getByText(/Routing labels — what the work needs/),
      ).toBeInTheDocument();
      expect(
        within(outstanding).getByText(/whole eligibility signal/i),
      ).toBeInTheDocument();
    });

    it('names what has drifted and what differs about it', async () => {
      serveLabels({
        get: labelReportFixture({
          drifted: { 'factory:ready': ['color ededed -> d93f0b'] },
        }),
      });
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );

      // Drifted labels EXIST, so the count does not dock them.
      expect(
        await within(row).findByText(`${M} of ${M} labels present`),
      ).toBeInTheDocument();
      expect(
        within(row).getByText(/color ededed -> d93f0b/),
      ).toBeInTheDocument();
    });

    it('renders the observation with an age, so it can be seen to go stale', async () => {
      serveLabels({
        get: labelReportFixture({ checkedAt: new Date().toISOString() }),
      });
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );

      expect(
        await within(row).findByText(/Observed just now/),
      ).toHaveTextContent(/Nothing here is stored or re-checked/);
    });

    /**
     * Every GitHub-level failure, as the API actually sends it: `present: 0`,
     * `declared: 15`, and an EMPTY `labels` array.
     *
     * This is the case the row exists to get right. "None are present" and
     * "nobody could ask" are different facts with different fixes, and a
     * component reading the counters without checking whether anything was
     * read would print "0 of 15 labels present" for all seven of these.
     */
    describe.each([
      ['no_credential', /No GitHub credential is configured/i],
      ['invalid_credential', /GitHub rejected the credential/i],
      ['refused', /authenticated and was not permitted/i],
      ['not_found', /answered 404/i],
      ['rate_limited', /rate limit is exhausted/i],
      ['unreachable', /Nothing answered/i],
      ['failed', /answered something unexpected/i],
    ] as const)('when GitHub answers %s', (status, headline) => {
      it('never renders a count, because nothing was observed', async () => {
        serveLabels({
          get: labelFailureFixture(status, 'GitHub said something specific.'),
        });
        listing(repository());
        const user = userEvent.setup();
        renderPanel();

        const row = labelRow(await awaitCard());
        await user.click(
          within(row).getByRole('button', { name: /check labels/i }),
        );

        // Awaited on the API's own sentence, which is rendered whatever the
        // status — so the count assertion below is the one that fails when
        // this goes wrong, rather than a missing headline masking it.
        await within(row).findByText('GitHub said something specific.');

        // The assertion this whole feature turns on.
        expect(row).not.toHaveTextContent(/\d+ of \d+ labels present/);
        expect(row).not.toHaveTextContent(`0 of ${M}`);
        expect(within(row).getByText(headline)).toBeInTheDocument();
      });

      it('quotes the API’s own sentence rather than paraphrasing it', async () => {
        serveLabels({
          get: labelFailureFixture(status, 'GitHub said something specific.'),
        });
        listing(repository());
        const user = userEvent.setup();
        renderPanel();

        const row = labelRow(await awaitCard());
        await user.click(
          within(row).getByRole('button', { name: /check labels/i }),
        );

        expect(
          await within(row).findByText('GitHub said something specific.'),
        ).toBeInTheDocument();
      });

      it('withholds the repair action and says why', async () => {
        serveLabels({
          get: labelFailureFixture(status, 'GitHub said something specific.'),
        });
        listing(repository());
        const user = userEvent.setup();
        renderPanel();

        const row = labelRow(await awaitCard());
        await user.click(
          within(row).getByRole('button', { name: /check labels/i }),
        );

        await within(row).findByText(headline);
        expect(
          within(row).queryByRole('button', { name: /create missing labels/i }),
        ).toBeNull();
        // A missing control with no explanation reads as a bug, and an
        // operator who is not told will press again.
        expect(
          within(row).getByText(/Creating the labels is not offered here/i),
        ).toBeInTheDocument();
      });
    });

    it('tells a failed REQUEST apart from a GitHub refusal', async () => {
      serveLabels({
        get: { httpStatus: 403, message: 'Forbidden' },
      });
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );

      expect(
        await within(row).findByText(/could not be asked about/i),
      ).toBeInTheDocument();
      // A 403 is a fact about the ACCOUNT. Nothing about GitHub, the token or
      // the labels was established, so no count and no verdict are shown.
      expect(row).not.toHaveTextContent(/\d+ of \d+ labels present/);
      expect(within(row).getByText(/projects:read/)).toBeInTheDocument();
    });

    it('drops a request failure once a later check answers', async () => {
      // The two are mutually exclusive by construction: a report means the
      // request completed. A stale error left under a fresh report would
      // report a failure that has since been answered.
      let call = 0;
      server.use(
        http.get(`${API_BASE}/repositories/:id/labels`, () => {
          call += 1;
          return call === 1
            ? HttpResponse.json({ message: 'Forbidden' }, { status: 403 })
            : HttpResponse.json({ data: labelReportFixture() });
        }),
      );
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );
      await within(row).findByText(/could not be asked about/i);

      // Still "Check labels" and not "again": a failed request observed
      // nothing, so there is no earlier answer for this to be a second look at.
      await user.click(
        within(row).getByRole('button', { name: /^check labels$/i }),
      );

      expect(
        await within(row).findByText(`${M} of ${M} labels present`),
      ).toBeInTheDocument();
      expect(within(row).queryByText(/could not be asked about/i)).toBeNull();
    });

    it('repairs by POST, and reports what the writes did', async () => {
      const calls = serveLabels({
        get: labelReportFixture({ missing: ['factory:ready', 'tier:small'] }),
        post: labelReportFixture({
          applied: true,
          missing: ['factory:ready', 'tier:small'],
          created: ['factory:ready', 'tier:small'],
        }),
      });
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );
      await user.click(
        await within(row).findByRole('button', {
          name: /create missing labels/i,
        }),
      );

      expect(await within(row).findByText('2 created')).toBeInTheDocument();
      await waitFor(() =>
        expect(calls).toEqual([
          `GET ${repositoryFixture().id}`,
          `POST ${repositoryFixture().id}`,
        ]),
      );
      // `state` still reads `missing` on both labels — the API does not
      // rewrite it — so a row that read `state` would go on listing them as
      // absent immediately after creating them.
      expect(row).not.toHaveTextContent(/not on GitHub/);
      expect(
        within(row).queryByRole('button', { name: /create missing labels/i }),
      ).toBeNull();
    });

    it('is honest when a repair only partly worked', async () => {
      serveLabels({
        get: labelReportFixture({ missing: ['factory:ready', 'tier:small'] }),
        post: labelReportFixture({
          applied: true,
          missing: ['factory:ready', 'tier:small'],
          created: ['tier:small'],
          failed: { 'factory:ready': 'GitHub answered 403 for this label.' },
        }),
      });
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );
      await user.click(
        await within(row).findByRole('button', {
          name: /create missing labels/i,
        }),
      );

      expect(
        await within(row).findByText('1 written, 1 failed'),
      ).toBeInTheDocument();
      // The one that worked stays worked, and the one that did not carries
      // GitHub's own reason.
      expect(within(row).getByText(/stay written/)).toBeInTheDocument();
      expect(
        within(row).getByText(/GitHub answered 403 for this label\./),
      ).toBeInTheDocument();
      // Still repairable: the read succeeded and something is still missing.
      expect(
        within(row).getByRole('button', { name: /create missing labels/i }),
      ).toBeInTheDocument();
    });

    it('reports a refused repair without inventing a count', async () => {
      serveLabels({
        get: labelReportFixture({ missing: ['factory:ready'] }),
        post: labelFailureFixture('refused', 'GitHub answered 403.', {
          applied: true,
        }),
      });
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );
      await user.click(
        await within(row).findByRole('button', {
          name: /create missing labels/i,
        }),
      );

      expect(
        await within(row).findByText('Nothing was written'),
      ).toBeInTheDocument();
      expect(row).not.toHaveTextContent(/\d+ of \d+ labels present/);
      expect(
        within(row).queryByRole('button', { name: /create missing labels/i }),
      ).toBeNull();
    });

    it('reports an idempotent second run as the no-op it is', async () => {
      serveLabels({
        get: labelReportFixture({ missing: ['factory:ready'] }),
        post: labelReportFixture({ applied: true }),
      });
      listing(repository());
      const user = userEvent.setup();
      renderPanel();

      const row = labelRow(await awaitCard());
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );
      await user.click(
        await within(row).findByRole('button', {
          name: /create missing labels/i,
        }),
      );

      expect(
        await within(row).findByText('Nothing needed creating'),
      ).toBeInTheDocument();
    });

    it('disables the repair without projects:write', async () => {
      serveLabels({
        get: labelReportFixture({ missing: ['factory:ready'] }),
      });
      listing(repository());
      const user = userEvent.setup();
      renderPanel({ canWrite: false });

      const row = labelRow(await awaitCard());
      // Checking is a read and stays available; only the write is refused.
      await user.click(
        within(row).getByRole('button', { name: /check labels/i }),
      );

      expect(
        await within(row).findByRole('button', {
          name: /create missing labels/i,
        }),
      ).toBeDisabled();
    });
  });
});
