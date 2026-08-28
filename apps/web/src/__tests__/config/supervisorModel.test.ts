/**
 * The rules behind the supervisor model control (#394, epic #391).
 *
 * The component test renders these through a real request path; this suite
 * pins the decisions themselves, where a wrong one is a sentence rather than a
 * layout: which keys a save sends, what happens to a configured model the
 * provider did not list, and what an unrecognised version is allowed to be
 * called.
 */

import { describe, expect, it } from 'vitest';

import {
  BASE_URL_PLACEHOLDER,
  admissionPresentation,
  buildSupervisorModelPatch,
  catalogStatusPresentation,
  configuredModelState,
  isModelPanelSetting,
  listingCostNote,
  modelApiKeySettingKey,
  modelBaseUrlSettingKey,
  modelCredentialSlots,
  modelLabel,
  modelOptions,
  seedSupervisorModelDraft,
  selectedSlot,
  unselectedSlots,
} from '../../config/supervisorModel';
import {
  ANTHROPIC_MODELS,
  supervisorModelCatalogFixture,
  supervisorModelFailureFixture,
} from '../mocks/supervisorModels';
import { OPERATOR_SETTINGS_FIXTURE } from '../mocks/operatorSettings';
import type { OperatorSetting } from '../../types/operatorSettings';

/** The fixture with one entry replaced — used to move the provider. */
function withEntry(key: string, change: Partial<OperatorSetting>) {
  return OPERATOR_SETTINGS_FIXTURE.map((entry) =>
    entry.key === key ? ({ ...entry, ...change } as OperatorSetting) : entry,
  );
}

/** The fixture with OpenAI selected instead of the default Anthropic. */
const OPENAI_SELECTED = withEntry('supervisor.model.provider', {
  value: 'openai',
});

/** An entry the fixture carries, by key. */
function entry(settings: readonly OperatorSetting[], key: string) {
  const found = settings.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`the fixture has no ${key}`);
  return found;
}

describe('supervisorModel', () => {
  describe('The keys the composite control owns', () => {
    it('claims the decision, and every credential slot with it', () => {
      const owned = OPERATOR_SETTINGS_FIXTURE.filter(isModelPanelSetting).map(
        (candidate) => candidate.key,
      );

      expect(owned).toEqual([
        'models.anthropic.apiKey',
        'models.anthropic.baseUrl',
        'models.openai.apiKey',
        'models.openai.baseUrl',
        'supervisor.model.provider',
        'supervisor.model.name',
      ]);
    });

    it('claims a provider slot this build has never heard of', () => {
      // The rule is the GROUP, not a list of vendors — so the day the API
      // grows a third adapter, its key and its endpoint arrive on the
      // Credentials tab rather than as a second editor on Configuration.
      expect(
        isModelPanelSetting({
          ...entry(OPERATOR_SETTINGS_FIXTURE, 'models.openai.apiKey'),
          key: 'models.mistral.apiKey',
        }),
      ).toBe(true);
    });

    it('claims nothing else, including the neighbouring supervisor keys', () => {
      // The ceiling and the timeout live in the same registry group and are
      // ordinary settings. Over-claiming here would silently remove rows from
      // the Configuration section that nothing replaced.
      for (const key of [
        'supervisor.hardSpendCeilingUsd',
        'supervisor.hardSpendCeilingWindowDays',
        'github.token',
      ]) {
        expect(
          isModelPanelSetting(entry(OPERATOR_SETTINGS_FIXTURE, key)),
          key,
        ).toBe(false);
      }
    });
  });

  describe('One slot per provider, and both of them real (#422)', () => {
    it('builds the API’s own key shapes', () => {
      expect(modelApiKeySettingKey('openai')).toBe('models.openai.apiKey');
      expect(modelBaseUrlSettingKey('openai')).toBe('models.openai.baseUrl');
    });

    it('discovers every slot the response carried', () => {
      expect(
        modelCredentialSlots(OPERATOR_SETTINGS_FIXTURE).map((slot) => ({
          provider: slot.provider,
          apiKey: slot.apiKey?.key ?? null,
          baseUrl: slot.baseUrl?.key ?? null,
        })),
      ).toEqual([
        {
          provider: 'anthropic',
          apiKey: 'models.anthropic.apiKey',
          baseUrl: 'models.anthropic.baseUrl',
        },
        {
          provider: 'openai',
          apiKey: 'models.openai.apiKey',
          baseUrl: 'models.openai.baseUrl',
        },
      ]);
    });

    it('follows the selected provider from one slot to the other', () => {
      expect(selectedSlot(OPERATOR_SETTINGS_FIXTURE)?.apiKey?.key).toBe(
        'models.anthropic.apiKey',
      );
      expect(selectedSlot(OPENAI_SELECTED)?.apiKey?.key).toBe(
        'models.openai.apiKey',
      );
    });

    it('keeps the unselected provider’s key, whichever one is selected', () => {
      // The bug this issue removes: selecting a provider used to leave the
      // other credential unreachable. Both directions are asserted, because an
      // implementation that simply returned "the one that is not anthropic"
      // would pass only one of them.
      const otherThanAnthropic = unselectedSlots(OPERATOR_SETTINGS_FIXTURE);
      expect(otherThanAnthropic.map((slot) => slot.provider)).toEqual([
        'openai',
      ]);
      expect(otherThanAnthropic[0].apiKey?.configured).toBe(true);

      const otherThanOpenai = unselectedSlots(OPENAI_SELECTED);
      expect(otherThanOpenai.map((slot) => slot.provider)).toEqual([
        'anthropic',
      ]);
    });

    it('reports an unpublished slot as absent rather than inventing one', () => {
      const without = OPERATOR_SETTINGS_FIXTURE.filter(
        (candidate) => candidate.key !== 'models.anthropic.apiKey',
      );
      const slot = selectedSlot(without);

      expect(slot?.provider).toBe('anthropic');
      expect(slot?.apiKey).toBeNull();
      // The endpoint is still published, and is still that provider's.
      expect(slot?.baseUrl?.key).toBe('models.anthropic.baseUrl');
    });
  });

  describe('What a save sends', () => {
    it('sends nothing when nothing moved', () => {
      const draft = seedSupervisorModelDraft(OPERATOR_SETTINGS_FIXTURE);
      expect(
        buildSupervisorModelPatch(OPERATOR_SETTINGS_FIXTURE, draft),
      ).toEqual({});
    });

    it('does not write the base URL back when only the model changed', () => {
      // The failure this guards: the base URL's stored value is the empty
      // string and its MEANING is "follow the provider". A form that submitted
      // every field it rendered would pin it on the first unrelated save.
      const draft = {
        ...seedSupervisorModelDraft(OPERATOR_SETTINGS_FIXTURE),
        name: 'claude-opus-4-6',
      };

      expect(
        buildSupervisorModelPatch(OPERATOR_SETTINGS_FIXTURE, draft),
      ).toEqual({ 'supervisor.model.name': 'claude-opus-4-6' });
    });

    it('sends the base URL when the operator actually typed one', () => {
      const draft = {
        ...seedSupervisorModelDraft(OPERATOR_SETTINGS_FIXTURE),
        baseUrl: 'https://gateway.internal/v1',
      };

      expect(
        buildSupervisorModelPatch(OPERATOR_SETTINGS_FIXTURE, draft),
      ).toEqual({
        'models.anthropic.baseUrl': 'https://gateway.internal/v1',
      });
    });

    it('sends it to the SELECTED provider’s slot and never the other', () => {
      // The endpoint is where the key is posted, so writing this field to the
      // slot the operator was not looking at would send one vendor's
      // credential to another vendor's proxy — the confusion #422 removed
      // from the key, rebuilt one field over.
      const draft = {
        ...seedSupervisorModelDraft(OPENAI_SELECTED),
        baseUrl: 'https://gateway.internal/v1',
      };

      expect(buildSupervisorModelPatch(OPENAI_SELECTED, draft)).toEqual({
        'models.openai.baseUrl': 'https://gateway.internal/v1',
      });
    });

    it('sends an empty model as an empty string, which stores "no model"', () => {
      const draft = {
        ...seedSupervisorModelDraft(OPERATOR_SETTINGS_FIXTURE),
        name: '',
      };

      expect(
        buildSupervisorModelPatch(OPERATOR_SETTINGS_FIXTURE, draft),
      ).toEqual({ 'supervisor.model.name': '' });
    });

    it('never sends a key the response did not carry', () => {
      const without = OPERATOR_SETTINGS_FIXTURE.filter(
        (candidate) => candidate.key !== 'models.anthropic.baseUrl',
      );

      expect(
        buildSupervisorModelPatch(without, { name: 'x', baseUrl: 'y' }),
      ).toEqual({ 'supervisor.model.name': 'x' });
    });

    it('never sends the placeholder, whatever else happens', () => {
      const draft = seedSupervisorModelDraft(OPERATOR_SETTINGS_FIXTURE);
      expect(draft.baseUrl).toBe('');
      expect(draft.baseUrl).not.toBe(BASE_URL_PLACEHOLDER);
    });
  });

  describe('A configured model that is not in the list', () => {
    it('is reported as missing when a list did arrive', () => {
      const state = configuredModelState(
        'claude-opus-3-5-retired',
        supervisorModelCatalogFixture(),
      );

      expect(state.missingFromList).toBe(true);
      expect(state.listed).toBeNull();
    });

    it('is NOT reported as missing when nothing was listed', () => {
      // "The provider did not answer" is not evidence that a model does not
      // exist. Saying so would be the screen inventing a finding.
      const state = configuredModelState(
        'claude-opus-3-5-retired',
        supervisorModelFailureFixture('unreachable', 'nothing answered'),
      );

      expect(state.missingFromList).toBe(false);
    });

    it('is NOT reported as missing before the first answer', () => {
      expect(configuredModelState('anything', null).missingFromList).toBe(
        false,
      );
    });

    it('is not reported when nothing is configured', () => {
      expect(
        configuredModelState('', supervisorModelCatalogFixture())
          .missingFromList,
      ).toBe(false);
    });

    it('is prepended to the options so it stays selectable', () => {
      const options = modelOptions(
        'claude-opus-3-5-retired',
        supervisorModelCatalogFixture(),
      );

      expect(options[0].model.id).toBe('claude-opus-3-5-retired');
      expect(options[0].listed).toBe(false);
      // Its `listed` flag is what the renderer branches on, NOT its admission:
      // "the provider did not list this" and "the version could not be read"
      // are different findings and must not share a chip.
      expect(options.slice(1).every((option) => option.listed)).toBe(true);
    });
  });

  describe('The API’s order is the order', () => {
    it('does not re-sort what arrived', () => {
      const options = modelOptions('', supervisorModelCatalogFixture());

      expect(options.map((option) => option.model.id)).toEqual(
        ANTHROPIC_MODELS.map((model) => model.id),
      );
      // Which is admitted, admitted, unrecognised, below-threshold — the
      // middle position is the deliberate one, because an id that did not
      // parse may well be the newest model the vendor has.
      expect(options.map((option) => option.model.admission)).toEqual([
        'admitted',
        'admitted',
        'version_unrecognised',
        'below_threshold',
      ]);
    });
  });

  describe('The three admission marks', () => {
    it('puts no chip on an admitted model', () => {
      // A mark on every row is a mark on none.
      expect(admissionPresentation('admitted', '4.6').label).toBeNull();
    });

    it('reads an unrecognised version as unjudged, not as broken', () => {
      const mark = admissionPresentation('version_unrecognised', '4.6');

      expect(mark.label).toBe('version not recognised');
      // The tone is the requirement. The likeliest reason an id fails to parse
      // is that it is NEWER than the rule, and wording it as a defect inverts
      // the meaning and pushes an operator away from the model they came for.
      expect(mark.help).toMatch(/NEWER/);
      expect(mark.help).toMatch(/offered normally/);
      expect(mark.help).not.toMatch(
        /invalid|broken|unsupported|not supported/i,
      );
      // Informational, never an error colour.
      expect(mark.color).toBe('info');
    });

    it('says a below-threshold model still works', () => {
      const mark = admissionPresentation('below_threshold', '4.6');

      expect(mark.label).toBe('older than the floor');
      expect(mark.help).toMatch(/selecting it will work/i);
    });

    it('names an admission state this build has never heard of', () => {
      const mark = admissionPresentation('quarantined', '4.6');

      expect(mark.label).toBe('quarantined');
      expect(mark.help).toMatch(/does not recognise/);
    });
  });

  describe('The six failures name six remedies', () => {
    it('does not treat "no key yet" as an error', () => {
      const presentation = catalogStatusPresentation('no_key');
      expect(presentation.severity).toBe('info');
      expect(presentation.remedy).toMatch(/Nothing is wrong/);
    });

    it('points wrong_provider at the provider setting, not at the key', () => {
      // The mistake that only became possible once there were two providers,
      // and the one `invalid_key` would describe misleadingly — sending an
      // operator off to reissue a credential that was never the problem.
      const presentation = catalogStatusPresentation('wrong_provider');
      // Two remedies since #422, because there are now two places the mistake
      // can be: the wrong provider is selected, or the key was pasted into the
      // wrong vendor's slot. Neither is "get a new key".
      expect(presentation.remedy).toMatch(/Selecting that provider/);
      expect(presentation.remedy).toMatch(/wrong slot/);
      expect(presentation.remedy).toMatch(/never the problem/);
    });

    it('refuses to make unreachable a verdict on the key', () => {
      expect(catalogStatusPresentation('unreachable').remedy).toMatch(
        /says nothing at all about the credential/,
      );
    });

    it('tells refused apart from invalid', () => {
      expect(catalogStatusPresentation('refused').remedy).toMatch(
        /valid and is not permitted/,
      );
      expect(catalogStatusPresentation('invalid_key').remedy).toMatch(
        /wrong, expired or revoked/,
      );
    });

    it('gives every published status its own remedy', () => {
      const statuses = [
        'ok',
        'no_key',
        'invalid_key',
        'wrong_provider',
        'unreachable',
        'refused',
        'failed',
      ];
      const remedies = statuses.map(
        (status) => catalogStatusPresentation(status).remedy,
      );

      expect(new Set(remedies).size).toBe(statuses.length);
    });

    it('names a status this build has never heard of instead of guessing', () => {
      const presentation = catalogStatusPresentation('throttled');
      expect(presentation.title).toContain('throttled');
      expect(presentation.remedy).toMatch(/will not guess/);
    });
  });

  describe('Listing is free, and that is read off the response', () => {
    it('says so when the API says so', () => {
      expect(listingCostNote(supervisorModelCatalogFixture())).toMatch(
        /bills nothing on either provider/,
      );
    });

    it('follows spendsTokens rather than hard-coding it', () => {
      // A field rather than a sentence, so the day a vendor starts charging
      // for a catalogue read this changes with the API instead of lying.
      expect(
        listingCostNote(supervisorModelCatalogFixture({ spendsTokens: true })),
      ).toMatch(/costs money/);
    });

    it('claims nothing before the first answer', () => {
      expect(listingCostNote(null)).toBeNull();
    });
  });

  describe('Labelling a model', () => {
    it('shows the vendor’s label where it published one', () => {
      expect(modelLabel(ANTHROPIC_MODELS[0])).toBe(
        'claude-opus-4-6 — Claude Opus 4.6',
      );
    });

    it('shows the id alone where it did not', () => {
      expect(
        modelLabel({
          id: 'gpt-5.4',
          displayName: null,
          version: '5.4',
          admission: 'admitted',
          createdAt: null,
        }),
      ).toBe('gpt-5.4');
    });

    it('does not print the id twice when the label repeats it', () => {
      expect(
        modelLabel({
          id: 'gpt-5.4',
          displayName: 'gpt-5.4',
          version: '5.4',
          admission: 'admitted',
          createdAt: null,
        }),
      ).toBe('gpt-5.4');
    });
  });
});
