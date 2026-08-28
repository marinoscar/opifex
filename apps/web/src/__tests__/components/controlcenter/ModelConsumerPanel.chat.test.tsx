/**
 * The second consumer: the chat picks its own model (#423, epic #419).
 *
 * `CredentialsSectionContainer` is exercised rather than the panel in
 * isolation — same reasoning as the supervisor's suite next door — so
 * `useOperatorSettings`, `useModelCatalogs`, `services/api` and MSW are all in
 * the path. Every claim here is about a request: which consumer was asked for,
 * which provider answered, and which panel the answer landed in. A mocked hook
 * would let all of them be true of nothing.
 *
 * ## The four things this file exists to pin
 *
 * 1. **Two consumers, two providers, at once.** The chat on OpenAI while the
 *    supervisor is on Anthropic is the whole point of the issue, and the
 *    failure it guards against is a screen that reads one
 *    `supervisor.model.provider` and renders both dropdowns from it.
 * 2. **The answer is filed under the consumer it NAMES.** Both requests go out
 *    on mount and either may settle first. The test that carries this makes
 *    the chat's answer land FIRST, which is the ordering a client that keyed
 *    by arrival would get wrong.
 * 3. **An unconfigured chat is inert and says why.** There is no
 *    `chat.enabled`; an empty `chat.model.name` is the off switch and is the
 *    default, so it has to read as a deliberate off state rather than as a
 *    fault — `info`, in the API's own `available` / `unavailableReason`
 *    vocabulary.
 * 4. **One credential, one editor.** The chat resolves the shared
 *    `models.<provider>.apiKey` and offers no key field of its own. The
 *    assertion is scoped to the chat's panel and counts the cards on the whole
 *    screen, because "no second field" is a claim about the document rather
 *    than about one subtree.
 */

import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import {
  OPERATOR_SETTINGS_FIXTURE,
  operatorSettingsFixture,
} from '../../mocks/operatorSettings';
import {
  openaiCatalogFixture,
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

function renderSection() {
  const onSaved = vi.fn();

  render(
    <CredentialsSectionContainer canWrite canWriteSecret onSaved={onSaved} />,
  );

  return { onSaved };
}

/** Serve this settings document instead of the default fixture. */
function serve(document: OperatorSettingsDocument) {
  server.use(
    http.get(`${API_BASE}/operator-settings`, () =>
      HttpResponse.json({ data: document }),
    ),
  );
}

/** The default fixture with some entries replaced. */
function withValues(values: Record<string, unknown>): OperatorSetting[] {
  return OPERATOR_SETTINGS_FIXTURE.map((entry) =>
    entry.key in values
      ? ({
          ...entry,
          value: values[entry.key],
          source: 'database',
        } as OperatorSetting)
      : entry,
  );
}

/**
 * Answer each consumer's catalogue read with its own body.
 *
 * Keyed by the `consumer` query parameter, which is the only thing that tells
 * the two requests apart — and counted per consumer, so a test can say "the
 * supervisor was asked once" without the chat's own request making it true.
 */
function serveByConsumer(bodies: Record<string, SupervisorModelCatalog>) {
  const asked: string[] = [];

  server.use(
    http.get(
      `${API_BASE}/operator-settings/supervisor-models`,
      ({ request }) => {
        const consumer =
          new URL(request.url).searchParams.get('consumer') ?? 'supervisor';
        asked.push(consumer);

        return HttpResponse.json({
          data: bodies[consumer] ?? supervisorModelCatalogFixture({ consumer }),
        });
      },
    ),
  );

  return asked;
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

/** The chat's panel, once its first catalogue answer has landed. */
async function chatPanel() {
  const found = await screen.findByLabelText('Chat model settings');
  await within(found).findByRole('button', { name: 'List chat models' });
  return found;
}

/** The supervisor's, for the tests that hold both at once. */
async function supervisorPanel() {
  const found = await screen.findByLabelText('Supervisor model settings');
  await within(found).findByRole('button', { name: 'List supervisor models' });
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

describe('ModelConsumerPanel — the chat', () => {
  describe('A panel per consumer, from the response alone', () => {
    it('renders one for every consumer the API publishes', async () => {
      renderSection();

      expect(await supervisorPanel()).toBeInTheDocument();
      expect(await chatPanel()).toBeInTheDocument();
    });

    it('asks the catalogue once per consumer, naming which', async () => {
      // The parameter is what makes the two lists different questions. A
      // client that omitted it would read the supervisor's provider twice and
      // render the chat's dropdown from somebody else's answer.
      const asked = serveByConsumer({});

      renderSection();
      await chatPanel();

      await waitFor(() => expect(asked).toHaveLength(2));
      expect([...asked].sort()).toEqual(['chat', 'supervisor']);
    });

    it('does not render a chat panel when the API publishes no chat keys', async () => {
      // The consumers are discovered, not listed: a deployment whose API
      // predates the chat gets the screen it had before, rather than a panel
      // for a consumer that does not exist.
      serve(
        operatorSettingsFixture({
          settings: OPERATOR_SETTINGS_FIXTURE.filter(
            (entry) => !entry.key.startsWith('chat.'),
          ),
        }),
      );

      renderSection();
      await supervisorPanel();

      expect(
        screen.queryByLabelText('Chat model settings'),
      ).not.toBeInTheDocument();
    });
  });

  describe('Two consumers, two providers, at the same time', () => {
    /** The supervisor on Anthropic, the chat on OpenAI. */
    function split() {
      serve(
        operatorSettingsFixture({
          settings: withValues({
            'supervisor.model.provider': 'anthropic',
            'chat.model.provider': 'openai',
          }),
        }),
      );

      return serveByConsumer({
        supervisor: supervisorModelCatalogFixture({ consumer: 'supervisor' }),
        chat: openaiCatalogFixture('chat'),
      });
    }

    it('filters each dropdown by that consumer’s own provider', async () => {
      // The acceptance criterion, stated as a dropdown: selecting OpenAI for
      // the chat while the supervisor is on Anthropic must show the OpenAI
      // models. An implementation that read one provider setting for both
      // panels shows Anthropic's here, twice.
      split();
      const user = userEvent.setup();
      renderSection();
      await chatPanel();

      const chatOptions = await openSelect(user, 'Chat model');
      expect(chatOptions.map((option) => option.textContent)).toEqual([
        'No model configured',
        'gpt-5.4',
        // Concatenated without a space: the id and its admission chip are
        // two nodes inside one option, which is #391's own rendering.
        'o5-previewversion not recognised',
        'gpt-4.1older than the floor',
      ]);

      await user.keyboard('{Escape}');

      const supervisorOptions = await openSelect(user, 'Supervisor model name');
      expect(
        supervisorOptions.some((option) =>
          option.textContent?.includes('claude-opus-4-6'),
        ),
      ).toBe(true);
      expect(
        supervisorOptions.some((option) =>
          option.textContent?.includes('gpt-5.4'),
        ),
      ).toBe(false);
    });

    it('says which provider each panel asked, side by side', async () => {
      split();
      renderSection();

      expect(
        await within(await supervisorPanel()).findByText(
          /Anthropic listed 4 models/,
        ),
      ).toBeInTheDocument();
      expect(
        await within(await chatPanel()).findByText(/OpenAI listed 3 models/),
      ).toBeInTheDocument();
    });

    it('files each answer under the consumer the ANSWER names', async () => {
      // Both requests are in flight at once and either may settle first. The
      // chat's is released first here, which is the ordering that a client
      // keying by arrival — or by the order it asked — gets wrong: the
      // supervisor would show OpenAI's models and the chat Anthropic's.
      serve(
        operatorSettingsFixture({
          settings: withValues({
            'supervisor.model.provider': 'anthropic',
            'chat.model.provider': 'openai',
          }),
        }),
      );

      let releaseSupervisor = () => {};
      const supervisorHeld = new Promise<void>((resolve) => {
        releaseSupervisor = resolve;
      });

      server.use(
        http.get(
          `${API_BASE}/operator-settings/supervisor-models`,
          async ({ request }) => {
            const consumer =
              new URL(request.url).searchParams.get('consumer') ?? 'supervisor';

            if (consumer === 'supervisor') await supervisorHeld;

            return HttpResponse.json({
              data:
                consumer === 'chat'
                  ? openaiCatalogFixture('chat')
                  : supervisorModelCatalogFixture({ consumer }),
            });
          },
        ),
      );

      renderSection();

      // The chat's answer lands while the supervisor's is still outstanding.
      expect(
        await within(await chatPanel()).findByText(/OpenAI listed 3 models/),
      ).toBeInTheDocument();

      releaseSupervisor();

      expect(
        await within(await supervisorPanel()).findByText(
          /Anthropic listed 4 models/,
        ),
      ).toBeInTheDocument();
      // …and the late answer did not overwrite the early one.
      expect(
        within(await chatPanel()).queryByText(/Anthropic listed 4 models/),
      ).not.toBeInTheDocument();
    });

    it('refuses an answer that is not for the consumer it asked about', async () => {
      // The mixed-version case, and the reason the echo is load-bearing
      // rather than decorative: an API that predates #423 ignores the
      // `consumer` parameter and answers for the supervisor every time. A
      // client that filed a response under the consumer it ASKED for would
      // then show the chat a list of Anthropic models it cannot reach, with
      // nothing on screen saying so. Filing it under the consumer the answer
      // NAMES leaves the chat with no list — which is the truth, and which
      // falls back to the verbatim field.
      serve(
        operatorSettingsFixture({
          settings: withValues({
            'supervisor.model.provider': 'anthropic',
            'chat.model.provider': 'openai',
          }),
        }),
      );
      server.use(
        http.get(`${API_BASE}/operator-settings/supervisor-models`, () =>
          HttpResponse.json({
            data: supervisorModelCatalogFixture({ consumer: 'supervisor' }),
          }),
        ),
      );

      renderSection();
      const chat = await chatPanel();

      expect(
        await within(await supervisorPanel()).findByText(
          /Anthropic listed 4 models/,
        ),
      ).toBeInTheDocument();
      expect(
        within(chat).queryByText(/Anthropic listed 4 models/),
      ).not.toBeInTheDocument();
      // No list, so the model is the verbatim field rather than a dropdown
      // over another consumer's models.
      expect(
        within(chat).getByRole('textbox', { name: 'Chat model' }),
      ).toBeInTheDocument();
    });

    it('re-lists only the consumer whose provider was changed', async () => {
      const asked = split();
      const user = userEvent.setup();
      recordPatch();
      renderSection();
      await chatPanel();
      await waitFor(() => expect(asked).toHaveLength(2));

      await openSelect(user, 'Chat model provider');
      await user.click(screen.getByRole('option', { name: 'anthropic' }));

      await waitFor(() => expect(asked).toHaveLength(3));
      expect(asked[2]).toBe('chat');
      // The supervisor's list is still the answer it already had: dropping it
      // would empty a dropdown that nothing had invalidated.
      expect(
        within(await supervisorPanel()).getByText(/Anthropic listed 4 models/),
      ).toBeInTheDocument();
    });

    it('sends only the chat’s own model key when the chat is saved', async () => {
      split();
      const user = userEvent.setup();
      const patches = recordPatch();
      renderSection();
      await chatPanel();

      await user.click(screen.getByRole('combobox', { name: 'Chat model' }));
      await user.click(screen.getByRole('option', { name: /gpt-5\.4/ }));
      await user.click(
        screen.getByRole('button', { name: 'Save chat model settings' }),
      );

      await waitFor(() => expect(patches.bodies).toHaveLength(1));
      expect(patches.bodies[0]).toEqual({ 'chat.model.name': 'gpt-5.4' });
    });
  });

  describe('An unconfigured chat is inert, and says so', () => {
    it('reads as an off state rather than a fault', async () => {
      // The default every deployment starts on: a provider selected, no model
      // named. `info`, never `warning` — nothing is wrong with a deployment
      // that has not decided to run a chat, and shouting here would teach an
      // operator to ignore the colour that matters.
      serve(
        operatorSettingsFixture({
          settings: withValues({ 'models.anthropic.apiKey': undefined }),
        }),
      );
      renderSection();
      const chat = await chatPanel();

      const readiness = within(chat).getByLabelText('Chat model readiness');
      // The severity is the claim: `info`, and specifically NOT a warning or
      // an error. A deployment that has not configured a chat has not made a
      // mistake, and a screen that says it has teaches an operator to ignore
      // the colour that means something.
      expect(readiness).toHaveClass('MuiAlert-colorInfo');
      expect(readiness).not.toHaveClass('MuiAlert-colorWarning');
      expect(readiness).not.toHaveClass('MuiAlert-colorError');
      expect(
        within(readiness).getByText(/the chat is unconfigured/i),
      ).toBeInTheDocument();
    });

    it('names the missing key before the missing model', async () => {
      // The API's own order (`unavailableReason`): a deployment with neither
      // has configured nothing, and naming a model first is the second step
      // of a two-step remedy. The fixture's Anthropic slot is empty.
      renderSection();
      const chat = await chatPanel();

      const readiness = within(chat).getByLabelText('Chat model readiness');
      expect(
        within(readiness).getByText(/No API key is stored for anthropic/),
      ).toBeInTheDocument();
      expect(
        within(readiness).queryByText(/no model is named/),
      ).not.toBeInTheDocument();
    });

    it('says an empty model is the off switch once a key is stored', async () => {
      serve(
        operatorSettingsFixture({
          settings: OPERATOR_SETTINGS_FIXTURE.map((entry) =>
            entry.key === 'models.anthropic.apiKey'
              ? ({
                  ...entry,
                  configured: true,
                  hint: '********abcd',
                } as OperatorSetting)
              : entry,
          ),
        }),
      );
      renderSection();
      const chat = await chatPanel();

      const readiness = within(chat).getByLabelText('Chat model readiness');
      expect(
        within(readiness).getByText(/no model is named, so the chat is inert/i),
      ).toBeInTheDocument();
      // The sentence that makes it an off state rather than a gap: there is
      // no separate switch, so choosing a model is what turns it on.
      expect(
        within(readiness).getByText(/There is no separate switch/),
      ).toBeInTheDocument();
    });

    it('reports itself configured once a key and a model are both set', async () => {
      serve(
        operatorSettingsFixture({
          settings: OPERATOR_SETTINGS_FIXTURE.map((entry) => {
            if (entry.key === 'models.anthropic.apiKey') {
              return {
                ...entry,
                configured: true,
                hint: '********abcd',
              } as OperatorSetting;
            }
            if (entry.key === 'chat.model.name') {
              return {
                ...entry,
                value: 'claude-sonnet-4-6',
                source: 'database',
              } as OperatorSetting;
            }
            return entry;
          }),
        }),
      );
      renderSection();
      const chat = await chatPanel();

      const readiness = within(chat).getByLabelText('Chat model readiness');
      expect(
        within(readiness).getByText(/would ask a model/),
      ).toBeInTheDocument();
      expect(
        within(readiness).getByText(/claude-sonnet-4-6 on anthropic/),
      ).toBeInTheDocument();
    });

    it('still offers the list when the provider has no key', async () => {
      // Inert is not the same as unusable: the catalogue says `no_key`, which
      // is `info` for the same reason, and the panel keeps working so the key
      // can be stored and the model chosen without a reload.
      serveByConsumer({
        chat: supervisorModelFailureFixture(
          'no_key',
          'No API key is configured for Anthropic.',
          { consumer: 'chat' },
        ),
      });
      renderSection();
      const chat = await chatPanel();

      expect(
        within(chat).getByText(/No key is configured yet/),
      ).toBeInTheDocument();
    });
  });

  describe('One credential per provider, and one editor for it', () => {
    it('offers no key field of its own', async () => {
      renderSection();
      const chat = await chatPanel();

      // Not "no card in this subtree" only: the whole screen must still hold
      // exactly one editor per slot, which is what makes this a claim about
      // duplication rather than about layout.
      expect(
        within(chat).queryByLabelText('models.anthropic.apiKey'),
      ).not.toBeInTheDocument();
      expect(screen.getAllByLabelText('models.anthropic.apiKey')).toHaveLength(
        1,
      );
      expect(screen.getAllByLabelText('models.openai.apiKey')).toHaveLength(1);
      expect(
        within(chat).queryByRole('button', { name: 'Replace' }),
      ).not.toBeInTheDocument();
    });

    it('names the shared slot it resolves to instead', async () => {
      serve(
        operatorSettingsFixture({
          settings: withValues({ 'chat.model.provider': 'openai' }),
        }),
      );
      renderSection();
      const chat = await chatPanel();

      expect(
        within(chat).getByText('models.openai.apiKey'),
      ).toBeInTheDocument();
      expect(
        within(chat).getByText(/one vendor, one credential/i),
      ).toBeInTheDocument();
    });

    it('offers no endpoint field either, because the host is the key’s', async () => {
      serve(
        operatorSettingsFixture({
          settings: withValues({ 'chat.model.provider': 'openai' }),
        }),
      );
      renderSection();
      const chat = await chatPanel();

      expect(
        within(chat).queryByLabelText('OpenAI base URL'),
      ).not.toBeInTheDocument();
      // And exactly one editor for it on the screen — the supervisor's.
      expect(screen.getAllByLabelText('Anthropic base URL')).toHaveLength(1);
    });

    it('stops calling a key idle when another consumer is asking with it', async () => {
      // "Stored and not in use" was true when the supervisor was the only
      // consumer. With the chat on OpenAI it is a false claim about a key
      // that is currently being billed.
      serve(
        operatorSettingsFixture({
          settings: withValues({ 'chat.model.provider': 'openai' }),
        }),
      );
      renderSection();
      await chatPanel();

      const others = screen.getByLabelText('Other providers’ credentials');
      expect(within(others).getByText(/in use by chat/i)).toBeInTheDocument();
      expect(
        within(others).queryByText(/stored and not in use/i),
      ).not.toBeInTheDocument();
    });
  });
});
