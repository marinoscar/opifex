/**
 * The Control Center's Repositories section — the enablement ladder (#350,
 * epic #332).
 *
 * `useRepositoryLadder` is NOT mocked: the section runs for real against MSW,
 * because what is being asserted is what reaches and leaves the API. A mocked
 * hook would let "enabling a rung sends only that rung" be true of nothing.
 *
 * The cases here are the ones a plausible implementation gets wrong:
 *
 *  - four switches rendered as a set rather than as an ordered progression;
 *  - a rung enabled out of order saved silently, or refused outright;
 *  - a PATCH carrying flags the operator never touched, resetting them;
 *  - an empty budget field sent as `0` rather than as `null`;
 *  - the access probe's missing endpoint drawn as a failure, or as a pass.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { RepositoriesSection } from '../../../components/controlcenter/RepositoriesSection';
import type { RepositorySummary } from '../../../types/cockpit';

const API_BASE = '*/api';

function repository(
  overrides: Partial<RepositorySummary> = {},
): RepositorySummary {
  return {
    id: 'repo-1',
    projectId: null,
    owner: 'acme',
    name: 'widgets',
    fullName: 'acme/widgets',
    defaultBranch: 'main',
    observeEnabled: false,
    dispatchEnabled: false,
    mirrorLabelsEnabled: false,
    specFeedbackEnabled: false,
    budgetCeilingUsd: null,
    wallClockTimeoutMinutes: null,
    pathConstraints: [],
    lastObservedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** `GET /repositories` answering with these rows. */
function listing(...items: RepositorySummary[]) {
  server.use(
    http.get(`${API_BASE}/repositories`, () =>
      HttpResponse.json({
        data: { items, total: items.length, page: 1, pageSize: 100 },
      }),
    ),
  );
}

/** Captures the PATCH body, and answers with the row it implies. */
function capturePatch(stored: RepositorySummary) {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.patch(`${API_BASE}/repositories/:id`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      return HttpResponse.json({ data: { ...stored, ...body } });
    }),
  );
  return bodies;
}

async function awaitCard(name = 'Repository acme/widgets') {
  return screen.findByLabelText(name);
}

describe('RepositoriesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('The ladder', () => {
    it('renders the four flags as an ordered progression', async () => {
      listing(repository());
      render(<RepositoriesSection canWrite />);

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
      render(<RepositoriesSection canWrite />);

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
      render(<RepositoriesSection canWrite />);

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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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
      render(<RepositoriesSection canWrite />);

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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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

      render(<RepositoriesSection canWrite />);
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
      render(<RepositoriesSection canWrite />);
      await awaitCard();

      expect(screen.queryByText('Reachable')).not.toBeInTheDocument();
      expect(screen.queryByText('Not yet verifiable')).not.toBeInTheDocument();
    });
  });

  describe('Without projects:write', () => {
    it('renders the ladder read-only and says which permission is missing', async () => {
      listing(repository({ observeEnabled: true }));
      render(<RepositoriesSection canWrite={false} />);

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
      render(<RepositoriesSection canWrite />);

      expect(await screen.findByText(/projects:read/)).toBeInTheDocument();
      // Never "no repositories": that is a measurement nobody made.
      expect(
        screen.queryByText(/No repository is registered/i),
      ).not.toBeInTheDocument();
    });

    it('says an empty deployment has no ladder to climb yet', async () => {
      listing();
      render(<RepositoriesSection canWrite />);

      expect(
        await screen.findByText(/No repository is registered/i),
      ).toBeInTheDocument();
    });

    it('renders one card per registered repository', async () => {
      listing(
        repository(),
        repository({ id: 'repo-2', name: 'gadgets', fullName: 'acme/gadgets' }),
      );
      render(<RepositoriesSection canWrite />);

      await awaitCard();
      expect(await awaitCard('Repository acme/gadgets')).toBeInTheDocument();
    });
  });
});
