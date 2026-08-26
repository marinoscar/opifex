/**
 * Credentials — secrets, Test buttons and the spend ceilings
 * (#349, epic #332).
 *
 * `CredentialsSectionContainer` is exercised rather than the presentational
 * component, so the hooks, `services/api` and MSW are all in the path. The
 * claims this section makes are about requests — what a save sends, what a
 * probe answered, what the cost read model reported — and a mocked hook would
 * let every one of them be true of nothing.
 *
 * The headline test is `does not render a configured secret's value anywhere`,
 * and it is written as a whole-DOM scan rather than as a set of `queryByText`
 * calls: a credential leaks through the channel nobody thought of. See
 * `utils/domSecrets.ts`, whose own suite plants a leak in each channel it
 * claims to cover.
 */

import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { expectNoLeak } from '../../utils/domSecrets';
import { server } from '../../mocks/server';
import { costSummaryFixture } from '../../mocks/costSummary';
import {
  OPERATOR_SETTINGS_FIXTURE,
  maskedHint,
  operatorSettingsFixture,
} from '../../mocks/operatorSettings';
import { CredentialsSectionContainer } from '../../../components/controlcenter/CredentialsSectionContainer';
import type { CostSummary } from '../../../types/cockpit';
import type {
  OperatorSetting,
  OperatorSettingsDocument,
} from '../../../types/operatorSettings';

const API_BASE = '*/api';

/**
 * The token an operator has already saved.
 *
 * The API never serialises it — the response's secret arm has no `value`
 * member — so the fixture below carries only `maskedHint(GITHUB_TOKEN)`,
 * which is what `maskSecret` really produces. The scan is for the whole
 * string; the last four characters are in the hint on purpose and are not a
 * leak.
 */
const GITHUB_TOKEN = 'ghp_configured_0123456789abcdef';

/** The token an operator types into Replace. */
const NEW_TOKEN = 'ghp_freshly_pasted_9876543210zzzz';

function renderSection(
  options: { canWrite?: boolean; canWriteSecret?: boolean } = {},
) {
  const onSaved = vi.fn();

  const result = render(
    <CredentialsSectionContainer
      canWrite={options.canWrite ?? true}
      canWriteSecret={options.canWriteSecret ?? true}
      onSaved={onSaved}
    />,
  );

  return { ...result, onSaved };
}

/** Serve this document instead of the default fixture. */
function serve(document: OperatorSettingsDocument) {
  server.use(
    http.get(`${API_BASE}/operator-settings`, () =>
      HttpResponse.json({ data: document }),
    ),
  );
}

/** The same fixture with one entry replaced. */
function withEntry(
  key: string,
  change: Record<string, unknown>,
): OperatorSetting[] {
  return OPERATOR_SETTINGS_FIXTURE.map((entry) =>
    entry.key === key ? ({ ...entry, ...change } as OperatorSetting) : entry,
  );
}

/** Capture what a save actually sends, and answer with a fresh document. */
function recordPatch(response?: OperatorSettingsDocument) {
  const seen: { bodies: Record<string, unknown>[] } = { bodies: [] };

  server.use(
    http.patch(`${API_BASE}/operator-settings`, async ({ request }) => {
      seen.bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({
        data: response ?? operatorSettingsFixture({ revision: 8 }),
      });
    }),
  );

  return seen;
}

/** Answer one probe with a real `ProbeResultDto` shape. */
function serveProbe(
  probe: string,
  result: {
    ok: boolean;
    detail: string;
    skipped?: boolean;
    rateLimit?: {
      limit: number;
      windowSeconds: number;
      remaining: number;
      resetSeconds: number;
    };
  },
) {
  const calls = { count: 0 };

  server.use(
    http.post(`${API_BASE}/operator-settings/probes/${probe}`, () => {
      calls.count += 1;
      return HttpResponse.json({
        data: {
          probe,
          ok: result.ok,
          detail: result.detail,
          checkedAt: '2026-08-20T14:32:00.000Z',
          skipped: result.skipped ?? false,
          ...(result.rateLimit ? { rateLimit: result.rateLimit } : {}),
        },
      });
    }),
  );

  return calls;
}

function serveCost(summary: CostSummary) {
  server.use(
    http.get(`${API_BASE}/cost/summary`, () =>
      HttpResponse.json({ data: summary }),
    ),
  );
}

/** The card for a credential, by the key it is labelled with. */
function card(key: string) {
  return screen.findByLabelText(key);
}

describe('CredentialsSection', () => {
  describe('Secrets are write-only', () => {
    it('does not render a configured secret’s value anywhere in the DOM', async () => {
      // THE acceptance criterion. Every text node, every comment, every
      // attribute of every element, and the `value` property of every input —
      // the last of which never appears in `innerHTML`, so a check that read
      // the markup would miss precisely the channel a credential would use.
      serve(
        operatorSettingsFixture({
          settings: withEntry('github.token', {
            configured: true,
            hint: maskedHint(GITHUB_TOKEN),
          }),
        }),
      );

      const { container } = renderSection();
      await card('github.token');

      expectNoLeak(container, GITHUB_TOKEN);
      // …and the masked hint IS shown, so the scan above is passing over a
      // rendered credential rather than over an empty screen.
      expect(screen.getByText('********cdef')).toBeInTheDocument();
    });

    it('does not render a value even if the response carries one', async () => {
      // The API's secret arm has no `value` member at all, so this document
      // cannot come from it. It is served anyway: the guarantee worth having
      // is that the section does not render a field it was handed, which is
      // what a stray `JSON.stringify(entry)` or an `entry as any` would do
      // long after everyone has stopped thinking about this.
      serve(
        operatorSettingsFixture({
          settings: withEntry('github.token', { value: GITHUB_TOKEN }),
        }),
      );

      const { container } = renderSection();
      await card('github.token');

      expectNoLeak(container, GITHUB_TOKEN);
    });

    it('offers a password field with autocomplete off, and no value prop', async () => {
      const user = userEvent.setup();
      renderSection();

      const github = await card('github.token');
      await user.click(within(github).getByRole('button', { name: 'Replace' }));

      const field = within(github).getByLabelText(/New value for GitHub token/);
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', 'off');
      // Uncontrolled: React never wrote a value into the markup, which is what
      // keeps the credential out of every serialisation of the tree.
      expect(field).not.toHaveAttribute('value');
    });

    it('keeps a value being typed out of every node except the field itself', async () => {
      const user = userEvent.setup();
      const { container } = renderSection();

      const github = await card('github.token');
      await user.click(within(github).getByRole('button', { name: 'Replace' }));
      await user.type(
        within(github).getByLabelText(/New value for GitHub token/),
        NEW_TOKEN,
      );

      // The field holds it, necessarily. Nothing else may — not a helper
      // line, not a chip, not a title attribute, not a confirmation.
      expectNoLeak(container, NEW_TOKEN, { allowInputValues: true });
    });

    it('sends the typed value under its own key, and nothing else', async () => {
      const user = userEvent.setup();
      const patches = recordPatch();
      renderSection();

      const github = await card('github.token');
      await user.click(within(github).getByRole('button', { name: 'Replace' }));
      await user.type(
        within(github).getByLabelText(/New value for GitHub token/),
        NEW_TOKEN,
      );
      await user.click(
        within(github).getByRole('button', { name: 'Save credential' }),
      );

      await waitFor(() => expect(patches.bodies).toHaveLength(1));
      // One key. A secret write needs a permission a ceiling edit does not,
      // and the API applies a multi-key patch key by key.
      expect(patches.bodies[0]).toEqual({ 'github.token': NEW_TOKEN });
    });

    it('holds nothing back in the DOM once the save has landed', async () => {
      const user = userEvent.setup();
      recordPatch();
      const { container } = renderSection();

      const github = await card('github.token');
      await user.click(within(github).getByRole('button', { name: 'Replace' }));
      await user.type(
        within(github).getByLabelText(/New value for GitHub token/),
        NEW_TOKEN,
      );
      await user.click(
        within(github).getByRole('button', { name: 'Save credential' }),
      );

      await screen.findByText(/The old token is still valid/i);
      // No allowance this time: the field is gone, so the value must be gone
      // with it.
      expectNoLeak(container, NEW_TOKEN);
    });
  });

  describe('Rotation', () => {
    it('says the old GitHub token is still valid until it is revoked at GitHub', async () => {
      const user = userEvent.setup();
      recordPatch();
      renderSection();

      const github = await card('github.token');
      await user.click(within(github).getByRole('button', { name: 'Replace' }));
      await user.type(
        within(github).getByLabelText(/New value for GitHub token/),
        NEW_TOKEN,
      );
      await user.click(
        within(github).getByRole('button', { name: 'Save credential' }),
      );

      const notice = await screen.findByText(/The old token is still valid/i);
      expect(notice).toBeInTheDocument();
      expect(
        screen.getByText(/does NOT revoke the old one/),
      ).toBeInTheDocument();
      expect(screen.getByText(/already under way/i)).toBeInTheDocument();
    });

    it('clears a stored credential with a null, and it then reads from the environment', async () => {
      const user = userEvent.setup();
      // What the API really returns after a clear: the row is gone, so the
      // key resolves from the environment and `updatedAt` is null again.
      const patches = recordPatch(
        operatorSettingsFixture({
          revision: 9,
          settings: withEntry('runners.claudeCodeLocal.oauthToken', {
            source: 'env',
            updatedAt: null,
            configured: true,
            hint: '********envv',
          }),
        }),
      );
      renderSection();

      const claude = await card('runners.claudeCodeLocal.oauthToken');
      await user.click(
        within(claude).getByRole('button', {
          name: /Clear \(revert to environment\)/,
        }),
      );
      await user.click(
        within(claude).getByRole('button', { name: 'Clear it' }),
      );

      await waitFor(() => expect(patches.bodies).toHaveLength(1));
      expect(patches.bodies[0]).toEqual({
        'runners.claudeCodeLocal.oauthToken': null,
      });

      const after = await card('runners.claudeCodeLocal.oauthToken');
      await waitFor(() =>
        expect(within(after).getByText('from environment')).toBeInTheDocument(),
      );
    });

    it('cannot clear a key that has nothing stored', async () => {
      renderSection();

      // `github.token` reads from the environment in the fixture: there is no
      // row to delete, and sending one would write an audit entry for a change
      // nobody made.
      const github = await card('github.token');
      expect(
        within(github).getByRole('button', {
          name: /Clear \(revert to environment\)/,
        }),
      ).toBeDisabled();
      expect(
        within(github).getByText(/Nothing is stored here to clear/),
      ).toBeInTheDocument();
    });

    it('withholds the field from an account without the secret permission', async () => {
      renderSection({ canWriteSecret: false });

      const github = await card('github.token');
      expect(
        within(github).getByRole('button', { name: 'Replace' }),
      ).toBeDisabled();
      expect(
        within(github).getByText(/operator_settings:write_secret/),
      ).toBeInTheDocument();
    });

    it('refuses to store anything while there is no encryption key', async () => {
      serve(
        operatorSettingsFixture({
          secretStorage: {
            configured: false,
            problem: 'OPIFEX_SETTINGS_ENCRYPTION_KEY is not set.',
          },
        }),
      );
      renderSection();

      expect(
        await screen.findByText(/Secret storage is not configured/),
      ).toBeInTheDocument();
      const github = await card('github.token');
      expect(
        within(github).getByRole('button', { name: 'Replace' }),
      ).toBeDisabled();
    });
  });

  describe('Test buttons', () => {
    it('renders what the probe found, with the API’s own timestamp', async () => {
      const user = userEvent.setup();
      serveProbe('github-token', {
        ok: true,
        detail: 'The token is valid. 4987 of 5000 requests left this hour.',
      });
      renderSection();

      const github = await card('github.token');
      await user.click(
        within(github).getByRole('button', { name: 'Test token' }),
      );

      expect(await screen.findByText('It works')).toBeInTheDocument();
      expect(
        screen.getByText(/4987 of 5000 requests left this hour/),
      ).toBeInTheDocument();
      // `checkedAt` is the API's clock, rendered as one — an observation with
      // an age rather than a status.
      expect(
        screen.getByText(
          (_, node) =>
            node?.textContent?.startsWith('Checked at') === true &&
            node.textContent.includes('2026'),
        ),
      ).toBeInTheDocument();
    });

    it('renders a rejected credential as a finding, not as an error', async () => {
      const user = userEvent.setup();
      serveProbe('github-token', {
        ok: false,
        detail: 'GitHub answered 401: Bad credentials.',
      });
      renderSection();

      const github = await card('github.token');
      await user.click(
        within(github).getByRole('button', { name: 'Test token' }),
      );

      expect(await screen.findByText('It does not work')).toBeInTheDocument();
      expect(
        screen.getByText(/GitHub answered 401: Bad credentials/),
      ).toBeInTheDocument();
    });

    it('says a rate-limited probe did not run, and how long until it can', async () => {
      const user = userEvent.setup();
      serveProbe('claude-credential', {
        ok: false,
        skipped: true,
        detail: 'Rate limited: this probe spends real quota.',
        rateLimit: {
          limit: 5,
          windowSeconds: 3600,
          remaining: 0,
          resetSeconds: 2820,
        },
      });
      renderSection();

      const claude = await card('runners.claudeCodeLocal.oauthToken');
      await user.click(
        within(claude).getByRole('button', {
          name: /Test the credential \(spends quota\)/,
        }),
      );

      // Not "It does not work": nothing was tested, and saying otherwise
      // would report a working credential as broken.
      expect(await screen.findByText('Did not run')).toBeInTheDocument();
      expect(
        screen.getByText(
          '0 of 5 left in this 60 minutes window, resetting in 47 minutes.',
        ),
      ).toBeInTheDocument();
    });

    it('reports a probe the API will not run as untested, not as a failure', async () => {
      const user = userEvent.setup();
      server.use(
        http.post(`${API_BASE}/operator-settings/probes/github-token`, () =>
          HttpResponse.json(
            { message: 'Missing permissions', statusCode: 403 },
            { status: 403 },
          ),
        ),
      );
      renderSection();

      const github = await card('github.token');
      await user.click(
        within(github).getByRole('button', { name: 'Test token' }),
      );

      expect(await screen.findByText('Not tested')).toBeInTheDocument();
      expect(
        screen.getByText(/says nothing either way about the credential/),
      ).toBeInTheDocument();
    });

    it('says what the two spending probes cost before either is pressed', async () => {
      renderSection();

      const claude = await card('runners.claudeCodeLocal.oauthToken');
      expect(
        within(claude).getByText(/spends real quota and real money/),
      ).toBeInTheDocument();
      // The allowance is the API's to report, and this screen does not know
      // it until a result carries one — which it says rather than inventing a
      // number.
      expect(
        within(claude).getByText(/until one runs, this screen does not know/),
      ).toBeInTheDocument();
    });

    it('marks an earlier result stale once the value it tested has changed', async () => {
      const user = userEvent.setup();
      serveProbe('github-token', { ok: true, detail: 'The token is valid.' });
      // What a real rotation returns: a new hint and a new `updatedAt`.
      recordPatch(
        operatorSettingsFixture({
          revision: 8,
          settings: withEntry('github.token', {
            source: 'database',
            hint: '********zzzz',
            updatedAt: '2026-08-20T15:00:00.000Z',
          }),
        }),
      );
      renderSection();

      const github = await card('github.token');
      await user.click(
        within(github).getByRole('button', { name: 'Test token' }),
      );
      expect(await screen.findByText('It works')).toBeInTheDocument();

      await user.click(within(github).getByRole('button', { name: 'Replace' }));
      await user.type(
        within(github).getByLabelText(/New value for GitHub token/),
        NEW_TOKEN,
      );
      await user.click(
        within(github).getByRole('button', { name: 'Save credential' }),
      );

      // The observation is kept — a token that worked is evidence — but it is
      // never again presented as the current state of the deployment.
      expect(await screen.findByText('Stale observation')).toBeInTheDocument();
      expect(
        screen.getByText(/describes the previous value/),
      ).toBeInTheDocument();
      expect(screen.queryByText('It works')).not.toBeInTheDocument();
    });

    it('marks a result stale while an unsaved replacement sits in the field', async () => {
      const user = userEvent.setup();
      serveProbe('github-token', { ok: true, detail: 'The token is valid.' });
      renderSection();

      const github = await card('github.token');
      await user.click(
        within(github).getByRole('button', { name: 'Test token' }),
      );
      expect(await screen.findByText('It works')).toBeInTheDocument();

      await user.click(within(github).getByRole('button', { name: 'Replace' }));
      await user.type(
        within(github).getByLabelText(/New value for GitHub token/),
        NEW_TOKEN,
      );

      expect(await screen.findByText('Stale observation')).toBeInTheDocument();
      expect(
        screen.getByText(/unsaved change to github\.token/),
      ).toBeInTheDocument();
    });

    it('does not offer probes to an account that may not run them', async () => {
      renderSection({ canWrite: false });

      const github = await card('github.token');
      expect(
        within(github).getByRole('button', { name: 'Test token' }),
      ).toBeDisabled();
    });
  });

  describe('Spend ceilings', () => {
    it('shows spend against the ceiling’s own window', async () => {
      renderSection();

      const ceiling = await screen.findByLabelText('Factory spend ceiling');
      expect(
        within(ceiling).getByText(/\$12\.50 spent over the last 30 days/),
      ).toBeInTheDocument();
      // Reported and estimated are never summed into one figure by the API,
      // and are not summed here either.
      expect(
        within(ceiling).getByText(
          /\$11\.00 reported by runners and \$1\.50 estimated/,
        ),
      ).toBeInTheDocument();
    });

    it('says supervisor spend is not observable rather than showing the factory figure', async () => {
      renderSection();

      const ceiling = await screen.findByLabelText('Supervisor spend ceiling');
      expect(
        within(ceiling).getByText(/not yet observable/i),
      ).toBeInTheDocument();
      expect(
        within(ceiling).getByText(/metered on a separate key/),
      ).toBeInTheDocument();
    });

    it('reports an unreadable cost read model as a fact about the account', async () => {
      server.use(
        http.get(`${API_BASE}/cost/summary`, () =>
          HttpResponse.json(
            { message: 'Missing permissions: runs:read', statusCode: 403 },
            { status: 403 },
          ),
        ),
      );
      renderSection();

      const ceiling = await screen.findByLabelText('Factory spend ceiling');
      await waitFor(() =>
        expect(
          within(ceiling).getByText(/Spend could not be read/),
        ).toBeInTheDocument(),
      );
      expect(within(ceiling).getByText(/runs:read/)).toBeInTheDocument();
    });

    it('keeps a mistyped ceiling distinguishable from an unset one', async () => {
      const user = userEvent.setup();
      renderSection();

      const ceiling = await screen.findByLabelText('Factory spend ceiling');
      const field = within(ceiling).getByLabelText('Hard spend ceiling (USD)');
      await user.clear(field);
      await user.type(field, '50O');

      expect(
        within(ceiling).getByText(/"50O" is not a non-negative number/),
      ).toBeInTheDocument();
      // Not the same sentence as an empty field, which refuses for a
      // different reason.
      await user.clear(field);
      expect(
        within(ceiling).getByText(/REFUSES every dispatch/),
      ).toBeInTheDocument();
    });

    it('reports the malformed ceiling the API says it is enforcing', async () => {
      serveCost(
        costSummaryFixture({
          ceiling: {
            limitUsd: null,
            windowDays: 30,
            malformed: '50O',
            spend: {
              reportedUsd: 0,
              estimatedUsd: 0,
              totalUsd: 0,
              runsWithoutCost: 0,
              unboundedRuns: 0,
            },
            headroomUsd: null,
          },
        }),
      );
      renderSection();

      const ceiling = await screen.findByLabelText('Factory spend ceiling');
      await waitFor(() =>
        expect(
          within(ceiling).getByText(/enforcing as MALFORMED: "50O"/),
        ).toBeInTheDocument(),
      );
      // The configured field says $25, the API says it is enforcing nothing.
      // Both are shown and neither is derived from the other.
      expect(
        within(ceiling).getByText(/not what the configured fields above say/),
      ).toBeInTheDocument();
    });

    it('sends nothing until the change is confirmed, and says what it does', async () => {
      const user = userEvent.setup();
      const patches = recordPatch();
      renderSection();

      const ceiling = await screen.findByLabelText('Factory spend ceiling');
      const field = within(ceiling).getByLabelText('Hard spend ceiling (USD)');
      await user.clear(field);
      await user.type(field, '5');
      await user.click(
        within(ceiling).getByRole('button', { name: 'Change this ceiling' }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/25 → 5/)).toBeInTheDocument();
      expect(
        within(dialog).getByText(/LOWERS the limit from \$25 to \$5/),
      ).toBeInTheDocument();
      expect(within(dialog).getByText(/not recalled/)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: 'Go back' }));
      expect(patches.bodies).toHaveLength(0);
    });

    it('sends the ceiling as the string the operator typed', async () => {
      const user = userEvent.setup();
      const patches = recordPatch();
      renderSection();

      const ceiling = await screen.findByLabelText('Factory spend ceiling');
      const field = within(ceiling).getByLabelText('Hard spend ceiling (USD)');
      await user.clear(field);
      await user.type(field, '100');
      await user.click(
        within(ceiling).getByRole('button', { name: 'Change this ceiling' }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.click(
        within(dialog).getByRole('button', { name: 'Change the ceiling' }),
      );

      await waitFor(() => expect(patches.bodies).toHaveLength(1));
      // A STRING, not a number: the registry declares this key as one so a
      // malformed figure stays distinguishable from an unset one.
      expect(patches.bodies[0]).toEqual({
        'dispatch.hardSpendCeilingUsd': '100',
      });
    });

    it('sends an empty figure as an empty string, which is not a revert', async () => {
      const user = userEvent.setup();
      const patches = recordPatch();
      renderSection();

      const ceiling = await screen.findByLabelText('Factory spend ceiling');
      await user.clear(
        within(ceiling).getByLabelText('Hard spend ceiling (USD)'),
      );
      await user.click(
        within(ceiling).getByRole('button', { name: 'Change this ceiling' }),
      );
      const dialog = await screen.findByRole('dialog');
      await user.click(
        within(dialog).getByRole('button', { name: 'Change the ceiling' }),
      );

      await waitFor(() => expect(patches.bodies).toHaveLength(1));
      // JSON null would DELETE the row and fall back to the environment
      // variable, which is a different instruction from "no ceiling".
      expect(patches.bodies[0]).toEqual({ 'dispatch.hardSpendCeilingUsd': '' });
    });

    it('refuses a window that is not a positive whole number', async () => {
      const user = userEvent.setup();
      renderSection();

      const ceiling = await screen.findByLabelText('Factory spend ceiling');
      const window = within(ceiling).getByLabelText(
        'Hard spend ceiling window (days)',
      );
      await user.clear(window);
      await user.type(window, '0');

      expect(within(ceiling).getByText(/at least 1 day/)).toBeInTheDocument();
      expect(
        within(ceiling).getByRole('button', { name: 'Change this ceiling' }),
      ).toBeDisabled();
    });

    it('links the ADR that made these editable', async () => {
      renderSection();

      const link = await screen.findByRole('link', {
        name: /ADR-0018/,
      });
      expect(link).toHaveAttribute(
        'href',
        expect.stringContaining(
          '0018-operator-settings-resolution-and-ceilings',
        ),
      );
    });
  });
});
