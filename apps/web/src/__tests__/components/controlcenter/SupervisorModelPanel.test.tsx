/**
 * The provider, the key and the model — one screen (#394, epic #391).
 *
 * `CredentialsSectionContainer` is exercised rather than the panel in
 * isolation, so `useOperatorSettings`, `useSupervisorModels`, `services/api`
 * and MSW are all in the path. Every claim this control makes is about a
 * request — what the provider answered, what a save sent, whether changing the
 * provider asked again — and a mocked hook would let all of them be true of
 * nothing.
 *
 * ## The two tests that carry the issue
 *
 * `offers an unrecognised-version model and lets it be selected` and
 * `no rendered node anywhere in the document contains the API key`. The second
 * is rooted at `document.body` and not at the render container, deliberately:
 * #386 found that a MUI Dialog portals out of the container and made exactly
 * this assertion vacuous, and this screen opens a MUI Select, whose menu
 * portals to `document.body` in the same way. The test opens one before it
 * scans, so the trap is exercised rather than avoided.
 */

import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { expectNoLeak, findLeaks } from '../../utils/domSecrets';
import { server } from '../../mocks/server';
import {
  OPERATOR_SETTINGS_FIXTURE,
  operatorSettingsFixture,
} from '../../mocks/operatorSettings';
import {
  OPENAI_MODELS,
  supervisorModelCatalogFixture,
  supervisorModelFailureFixture,
} from '../../mocks/supervisorModels';
import { CredentialsSectionContainer } from '../../../components/controlcenter/CredentialsSectionContainer';
import type {
  OperatorSetting,
  OperatorSettingsDocument,
} from '../../../types/operatorSettings';
import type { SupervisorModelCatalog } from '../../../types/supervisorModels';

const API_BASE = '*/api';

/**
 * The key an operator pastes into Replace. Never stored in the fixture.
 *
 * Deliberately NOT shaped like either vendor's real prefix. The leak scan is a
 * substring search, so the shape is load-bearing for nothing here — key shape
 * is only ever inspected server-side, by `providerOfKeyShape`, to tell
 * `wrong_provider` from `invalid_key` — while a literal that looks like a real
 * credential is exactly what this repository's pre-commit secret scanner is
 * for, and it is right to object to one.
 */
const SUPERVISOR_KEY = 'pasted-supervisor-credential-0123456789abcdef';

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

/** Serve this settings document instead of the default fixture. */
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

/**
 * Answer the catalogue read, one response per call.
 *
 * The count is the assertion for "changing the provider re-resolves the list":
 * a second GET is the only observable difference between asking again and
 * leaving the previous vendor's models on screen.
 */
function serveCatalog(...responses: SupervisorModelCatalog[]) {
  const calls = { count: 0 };

  server.use(
    http.get(`${API_BASE}/operator-settings/supervisor-models`, () => {
      const body = responses[Math.min(calls.count, responses.length - 1)];
      calls.count += 1;
      return HttpResponse.json({ data: body });
    }),
  );

  return calls;
}

/** Capture what a save actually sends, and answer with a fresh document. */
function recordPatch(...responses: OperatorSettingsDocument[]) {
  const seen: { bodies: Record<string, unknown>[] } = { bodies: [] };

  server.use(
    http.patch(`${API_BASE}/operator-settings`, async ({ request }) => {
      const index = Math.min(seen.bodies.length, responses.length - 1);
      seen.bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({
        data: responses[index] ?? operatorSettingsFixture({ revision: 8 }),
      });
    }),
  );

  return seen;
}

/** The panel, once the first catalogue answer has landed. */
async function panel() {
  const found = await screen.findByLabelText('Supervisor model');
  await screen.findByRole('button', { name: 'List models' });
  return found;
}

/** Open a MUI select by its accessible name and return its options. */
async function openSelect(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole('combobox', { name }));
  return screen.getAllByRole('option');
}

describe('SupervisorModelPanel', () => {
  describe('One screen, not two tabs', () => {
    it('offers the provider, the key and the model together', async () => {
      renderSection();
      const supervisor = await panel();

      // The provider picker.
      expect(
        within(supervisor).getByRole('combobox', {
          name: 'Supervisor model provider',
        }),
      ).toBeInTheDocument();
      // The key — the same card every other credential gets, composed in
      // rather than reimplemented.
      expect(
        within(supervisor).getByLabelText('models.anthropic.apiKey'),
      ).toBeInTheDocument();
      // And the model, on the same screen, which is the whole issue.
      expect(
        within(supervisor).getByRole('combobox', {
          name: 'Supervisor model name',
        }),
      ).toBeInTheDocument();
    });

    it('lists the supervisor key inside the panel and not twice', async () => {
      renderSection();
      await panel();

      expect(screen.getAllByLabelText('models.anthropic.apiKey')).toHaveLength(
        1,
      );
    });
  });

  describe('The model is a dropdown whenever a list is available', () => {
    it('offers every model the provider listed, in the API’s order', async () => {
      const user = userEvent.setup();
      renderSection();
      await panel();

      const options = await openSelect(user, 'Supervisor model name');

      // The API pre-sorts: admitted, then unrecognised, then below the floor.
      // Nothing in apps/web re-sorts it, and this asserts that by comparing
      // against the fixture's order rather than a tidier one.
      expect(
        options.map((option) => option.getAttribute('data-value')),
      ).toEqual([
        '',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-daybreak-latest',
        'claude-sonnet-4-5',
      ]);
    });

    it('falls back to a text field when no list arrived', async () => {
      // `unreachable` — the provider never answered, so there is nothing to
      // choose from. Blocking the operator from setting a model at all would
      // make a network problem into a configuration outage.
      serveCatalog(
        supervisorModelFailureFixture(
          'unreachable',
          'api.anthropic.com could not be reached: no answer within 60000ms.',
        ),
      );

      renderSection();
      await panel();

      const field = screen.getByLabelText('Supervisor model name');
      expect(field).toHaveValue('claude-sonnet-4-5');
      expect(field.tagName).toBe('INPUT');
    });
  });

  describe('An unrecognised version is offered, marked, and selectable', () => {
    it('marks it as unjudged rather than as broken', async () => {
      const user = userEvent.setup();
      renderSection();
      await panel();

      const options = await openSelect(user, 'Supervisor model name');
      const unrecognised = options.find(
        (option) =>
          option.getAttribute('data-value') === 'claude-daybreak-latest',
      );

      expect(unrecognised).toBeDefined();
      expect(
        within(unrecognised as HTMLElement).getByText('version not recognised'),
      ).toBeInTheDocument();
      // The tone is the requirement, not the chip: the likeliest reason an id
      // fails to parse is that it is NEWER than the rule, and saying "broken"
      // would send an operator away from the model they came for.
      expect(unrecognised).not.toHaveTextContent(/invalid|broken|unsupported/i);
    });

    it('lets it be selected and sends it verbatim', async () => {
      const user = userEvent.setup();
      const patches = recordPatch();
      renderSection();
      await panel();

      await openSelect(user, 'Supervisor model name');
      await user.click(
        screen.getByRole('option', { name: /claude-daybreak-latest/ }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Save model settings' }),
      );

      await waitFor(() => expect(patches.bodies).toHaveLength(1));
      // The model key alone. The base URL was not touched, so it is not sent.
      expect(patches.bodies[0]).toEqual({
        'supervisor.model.name': 'claude-daybreak-latest',
      });
    });

    it('explains what the mark means beside the selection', async () => {
      const user = userEvent.setup();
      renderSection();
      await panel();

      await openSelect(user, 'Supervisor model name');
      await user.click(
        screen.getByRole('option', { name: /claude-daybreak-latest/ }),
      );

      expect(
        screen.getByText(/could not read a version out of that model id/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/NEWER than the naming rule/),
      ).toBeInTheDocument();
    });
  });

  describe('A configured model that is not in the list', () => {
    it('stays selected and says why', async () => {
      // The floor moved, or the vendor stopped listing it, or the key reaches
      // a different project. Every one of those is a case where the stored
      // configuration is fine — so clearing it would be worse than the
      // free-text field this control replaces.
      serve(
        operatorSettingsFixture({
          settings: withEntry('supervisor.model.name', {
            value: 'claude-opus-3-5-retired',
          }),
        }),
      );

      const user = userEvent.setup();
      renderSection();
      await panel();

      const select = screen.getByRole('combobox', {
        name: 'Supervisor model name',
      });
      expect(select).toHaveTextContent('claude-opus-3-5-retired');
      expect(
        screen.getByText(/is not in the list, and stays selected/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/not in the list anthropic just returned/i),
      ).toBeInTheDocument();

      // And it is still in the dropdown, because a selected option missing
      // from its own list is a control silently showing the wrong value.
      const options = await openSelect(user, 'Supervisor model name');
      expect(
        options.map((option) => option.getAttribute('data-value')),
      ).toContain('claude-opus-3-5-retired');
    });

    it('does not claim a model is missing when no list arrived at all', async () => {
      // "The provider did not answer" is not evidence that a model does not
      // exist, and saying so would be the screen inventing a finding.
      serveCatalog(
        supervisorModelFailureFixture(
          'unreachable',
          'api.anthropic.com could not be reached.',
        ),
      );

      renderSection();
      await panel();

      expect(
        screen.queryByText(/is not in the list, and stays selected/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('Changing the provider re-resolves the list', () => {
    it('saves the provider and asks again', async () => {
      const openai = supervisorModelCatalogFixture({
        provider: 'openai',
        minimumVersion: '5.4',
        detail: 'OpenAI listed 3 models; 1 is at or above the 5.4 floor.',
        models: OPENAI_MODELS,
      });
      const calls = serveCatalog(supervisorModelCatalogFixture(), openai);
      const patches = recordPatch(
        operatorSettingsFixture({
          revision: 8,
          settings: withEntry('supervisor.model.provider', {
            value: 'openai',
            source: 'database',
          }),
        }),
      );

      const user = userEvent.setup();
      renderSection();
      await panel();
      expect(calls.count).toBe(1);

      await openSelect(user, 'Supervisor model provider');
      await user.click(screen.getByRole('option', { name: 'openai' }));

      await waitFor(() => expect(patches.bodies).toHaveLength(1));
      expect(patches.bodies[0]).toEqual({
        'supervisor.model.provider': 'openai',
      });

      // Asked again — and the previous vendor's models are gone, not left on
      // screen selectable. A stale list is worse than an empty one.
      await waitFor(() => expect(calls.count).toBe(2));
      await screen.findByText(/OpenAI listed 3 models/);

      const options = await openSelect(user, 'Supervisor model name');
      const ids = options.map((option) => option.getAttribute('data-value'));
      expect(ids).toContain('gpt-5.4');
      expect(ids).not.toContain('claude-opus-4-6');
    });

    it('drops the previous list the moment it asks, not when the answer lands', async () => {
      // The requirement is that a list never outlives the provider it belongs
      // to, and the window where that can go wrong is the one BETWEEN asking
      // and being answered — where the previous vendor's models would sit,
      // selectable, under a provider that no longer matches them. So the
      // second answer is gated open by the test, and the assertion happens
      // while it is still in flight.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls = { count: 0 };

      server.use(
        http.get(
          `${API_BASE}/operator-settings/supervisor-models`,
          async () => {
            calls.count += 1;
            if (calls.count === 1) {
              return HttpResponse.json({
                data: supervisorModelCatalogFixture(),
              });
            }
            await gate;
            return HttpResponse.json({
              data: supervisorModelCatalogFixture({
                provider: 'openai',
                minimumVersion: '5.4',
                detail:
                  'OpenAI listed 3 models; 1 is at or above the 5.4 floor.',
                models: OPENAI_MODELS,
              }),
            });
          },
        ),
      );
      recordPatch(
        operatorSettingsFixture({
          revision: 8,
          settings: withEntry('supervisor.model.provider', {
            value: 'openai',
            source: 'database',
          }),
        }),
      );

      const user = userEvent.setup();
      renderSection();
      await panel();
      expect(
        await screen.findByText(/Anthropic listed 4 models/),
      ).toBeInTheDocument();

      await openSelect(user, 'Supervisor model provider');
      await user.click(screen.getByRole('option', { name: 'openai' }));

      // Mid-flight: the Anthropic answer is gone and nothing has replaced it.
      await screen.findByRole('button', { name: 'Asking the provider…' });
      expect(
        screen.queryByText(/Anthropic listed 4 models/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('option', { name: /claude-opus-4-6/ }),
      ).not.toBeInTheDocument();

      release();
      expect(
        await screen.findByText(/OpenAI listed 3 models/),
      ).toBeInTheDocument();
    });

    it('re-resolves after the key is replaced, too', async () => {
      // A new credential reaches a different set of models. Leaving the
      // previous list up would make the dropdown a claim about a key that is
      // no longer configured.
      const calls = serveCatalog(supervisorModelCatalogFixture());
      recordPatch();

      const user = userEvent.setup();
      renderSection();
      await panel();
      expect(calls.count).toBe(1);

      const card = screen.getByLabelText('models.anthropic.apiKey');
      await user.click(
        within(card).getByRole('button', { name: 'Set a value' }),
      );
      await user.type(
        within(card).getByLabelText(/New value for/),
        SUPERVISOR_KEY,
      );
      await user.click(
        within(card).getByRole('button', { name: 'Save credential' }),
      );

      await waitFor(() => expect(calls.count).toBe(2));
    });
  });

  describe('The empty state explains itself', () => {
    const cases: Array<{
      status: SupervisorModelCatalog['status'];
      detail: string;
      title: RegExp;
      remedy: RegExp;
    }> = [
      {
        status: 'no_key',
        detail: 'No supervisor model API key is configured.',
        title: /No key is configured yet/,
        remedy: /Nothing is wrong/,
      },
      {
        status: 'invalid_key',
        detail: 'api.anthropic.com rejected the key (401).',
        title: /^The provider rejected the key$/,
        remedy: /wrong, expired or revoked/,
      },
      {
        status: 'wrong_provider',
        detail:
          'api.anthropic.com rejected the key (401), and the key is shaped ' +
          'like an OpenAI key while the configured provider is Anthropic.',
        title: /looks like the other provider/,
        remedy: /Selecting that provider above/,
      },
      {
        status: 'unreachable',
        detail:
          'api.anthropic.com could not be reached: getaddrinfo ENOTFOUND.',
        title: /Nothing answered/,
        remedy: /says nothing at all about the credential/,
      },
      {
        status: 'refused',
        detail: 'api.anthropic.com accepted the key and refused (403).',
        title: /authenticated and was refused/,
        remedy: /project, scope or region restriction/,
      },
      {
        status: 'failed',
        detail: 'api.anthropic.com answered 429: rate limit exceeded.',
        title: /answered something unexpected/,
        remedy: /rate limit, a server error/,
      },
    ];

    for (const testCase of cases) {
      it(`distinguishes ${testCase.status}`, async () => {
        serveCatalog(
          supervisorModelFailureFixture(testCase.status, testCase.detail),
        );

        renderSection();
        await panel();

        expect(await screen.findByText(testCase.title)).toBeInTheDocument();
        expect(screen.getByText(testCase.remedy)).toBeInTheDocument();
        // The API's own sentence, verbatim and beside this build's remedy:
        // it knows which host refused and with what status, and paraphrasing
        // would throw that away.
        expect(screen.getByText(testCase.detail)).toBeInTheDocument();
      });
    }

    it('reports a failed request as a failed request, not as a bad key', async () => {
      server.use(
        http.get(`${API_BASE}/operator-settings/supervisor-models`, () =>
          HttpResponse.json(
            { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
            { status: 403 },
          ),
        ),
      );

      renderSection();
      await screen.findByLabelText('Supervisor model');

      expect(
        await screen.findByText(/The list could not be requested/),
      ).toBeInTheDocument();
      expect(screen.getByText(/not a verdict on the key/)).toBeInTheDocument();
    });
  });

  describe('Listing is free; the Test button is not', () => {
    it('says listing costs nothing, and does not say that of the probe', async () => {
      renderSection();
      await panel();

      expect(
        screen.getByText(/Listing models bills nothing on either provider/),
      ).toBeInTheDocument();
      // The spending one keeps #349's label, unchanged and adjacent.
      expect(
        screen.getByRole('button', { name: 'Test the key (spends money)' }),
      ).toBeInTheDocument();
    });

    it('follows spendsTokens rather than a hard-coded sentence', async () => {
      serveCatalog(supervisorModelCatalogFixture({ spendsTokens: true }));

      renderSection();
      await panel();

      expect(
        await screen.findByText(/this refresh costs money/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Listing models bills nothing/),
      ).not.toBeInTheDocument();
    });
  });

  describe('The base URL’s empty value is an answer', () => {
    it('renders "follows the provider" as a placeholder, not as a value', async () => {
      renderSection();
      await panel();

      const field = screen.getByLabelText('Anthropic base URL');
      expect(field).toHaveValue('');
      expect(field).toHaveAttribute(
        'placeholder',
        'Follows the provider selected above',
      );
      expect(
        screen.getByText(/it follows the provider selected above/i),
      ).toBeInTheDocument();
    });

    it('is not written back when something else is saved', async () => {
      // The failure this guards against: a form that submits every field it
      // renders would pin the base URL on the first unrelated save, turning
      // "follow the provider" into a host nobody chose.
      const user = userEvent.setup();
      const patches = recordPatch();
      renderSection();
      await panel();

      await openSelect(user, 'Supervisor model name');
      await user.click(screen.getByRole('option', { name: /claude-opus-4-6/ }));
      await user.click(
        screen.getByRole('button', { name: 'Save model settings' }),
      );

      await waitFor(() => expect(patches.bodies).toHaveLength(1));
      expect(patches.bodies[0]).not.toHaveProperty('models.anthropic.baseUrl');
    });

    it('is sent when the operator actually types one', async () => {
      const user = userEvent.setup();
      const patches = recordPatch();
      renderSection();
      await panel();

      await user.type(
        screen.getByLabelText('Anthropic base URL'),
        'https://gateway.internal/v1',
      );
      await user.click(
        screen.getByRole('button', { name: 'Save model settings' }),
      );

      await waitFor(() => expect(patches.bodies).toHaveLength(1));
      expect(patches.bodies[0]).toEqual({
        'models.anthropic.baseUrl': 'https://gateway.internal/v1',
      });
    });
  });

  describe('The key reaches no rendered node', () => {
    it('holds it in the field it was typed into and nowhere else', async () => {
      // Rooted at `document.body`, NOT at the render container. #386 found a
      // MUI Dialog portals out of the container and made this assertion
      // vacuous; a MUI Select's menu portals the same way, and one is open
      // when this scan runs so the trap is exercised rather than dodged.
      const user = userEvent.setup();
      renderSection();
      await panel();

      const card = screen.getByLabelText('models.anthropic.apiKey');
      await user.click(
        within(card).getByRole('button', { name: 'Set a value' }),
      );
      await user.type(
        within(card).getByLabelText(/New value for/),
        SUPERVISOR_KEY,
      );

      // A portalled menu, live, at the moment of the scan.
      await openSelect(user, 'Supervisor model name');
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);

      expectNoLeak(document.body, SUPERVISOR_KEY, { allowInputValues: true });

      // …and the scan is passing over a real credential rather than over an
      // empty screen: without the allowance it finds exactly the one field.
      const leaks = findLeaks(document.body, SUPERVISOR_KEY);
      expect(leaks).toHaveLength(1);
      expect(leaks[0].where).toContain('.value');
    });

    it('holds nothing back once the save has landed', async () => {
      const user = userEvent.setup();
      recordPatch();
      renderSection();
      await panel();

      const card = screen.getByLabelText('models.anthropic.apiKey');
      await user.click(
        within(card).getByRole('button', { name: 'Set a value' }),
      );
      await user.type(
        within(card).getByLabelText(/New value for/),
        SUPERVISOR_KEY,
      );
      await user.click(
        within(card).getByRole('button', { name: 'Save credential' }),
      );

      await screen.findByText(/Saving is not revoking|Saved at/);
      expectNoLeak(document.body, SUPERVISOR_KEY);
    });

    it('renders no key even if the response carries one', async () => {
      // The API's secret arm has no `value` member at all, so this document
      // cannot come from it. It is served anyway: the guarantee worth having
      // is that this screen does not render a field it was handed, which is
      // what a stray `JSON.stringify(entry)` or an `entry as any` would do
      // long after everybody has stopped thinking about it.
      //
      // The catalogue's `detail` is deliberately NOT part of this test. It is
      // rendered verbatim because the API knows things this build does not —
      // which host refused, with what status — and redaction happens at the
      // source, where the key actually is (`withoutKey` in
      // `model-catalog.service.ts`). This screen never holds the key, so it
      // could not redact it even if it wanted to, and a test that planted one
      // in `detail` would be asserting a guarantee the UI cannot make.
      serve(
        operatorSettingsFixture({
          settings: withEntry('models.anthropic.apiKey', {
            configured: true,
            hint: '********cdef',
            value: SUPERVISOR_KEY,
          }),
        }),
      );
      serveCatalog(
        supervisorModelFailureFixture(
          'invalid_key',
          'api.anthropic.com rejected the key (401).',
        ),
      );

      renderSection();
      await panel();
      await screen.findByText('The provider rejected the key');

      expectNoLeak(document.body, SUPERVISOR_KEY);
      // The masked hint IS shown on this card, so the scan above passed over
      // a rendered credential rather than over an empty screen.
      const card = screen.getByLabelText('models.anthropic.apiKey');
      expect(within(card).getByText('********cdef')).toBeInTheDocument();
    });
  });

  describe('Read-only accounts', () => {
    it('disables the controls without hiding the answer', async () => {
      renderSection({ canWrite: false, canWriteSecret: false });
      await screen.findByLabelText('Supervisor model');

      expect(
        screen.getByRole('combobox', { name: 'Supervisor model provider' }),
      ).toHaveAttribute('aria-disabled', 'true');
      expect(
        screen.getByRole('button', { name: 'Save model settings' }),
      ).toBeDisabled();
      // The list itself is still readable — a reader entitled to see the
      // configuration is entitled to see it, and the API refuses the write
      // regardless.
      expect(
        await screen.findByText(/Anthropic listed 4 models/),
      ).toBeInTheDocument();
    });
  });
});
