/**
 * How the supervisor's model configuration is PRESENTED (#394, epic #391).
 *
 * ## Why this file names setting keys when #348 forbade it
 *
 * `config/operatorSettings.ts` renders the Configuration section from the
 * response alone, so a key added to the backend registry needs no frontend
 * edit. That property cannot hold for this control and the reason is worth
 * stating rather than quietly breaking: **the API does not publish that these
 * four keys are one decision.** The registry says `supervisor.model.provider`
 * is an enum and `supervisor.model.name` is a string; nothing in the response
 * says that the second is only choosable once the first and the key are set,
 * or that the fourth's empty value means "follow the first". That edge exists
 * in an operator's head and in `supervisor/invocation/`, and guessing it from
 * key names would be worse than declaring it — the same argument
 * `config/credentialProbes.ts` makes where it declares which settings a probe
 * reads.
 *
 * The declaration degrades safely: every consumer looks each key up in the
 * response and renders nothing for one that is absent, so a deployment whose
 * API does not publish these keys shows a shorter panel rather than crashing,
 * and the Configuration section keeps showing whatever this file does not
 * claim.
 *
 * ## The three admission marks, and the tone of the middle one
 *
 * `version_unrecognised` must read as *the filter could not judge this*, never
 * as *this is broken*. The most likely reason an id fails to parse is that it
 * is NEWER than the rule — the day a vendor changes its naming scheme, the
 * model that stops parsing is the flagship. Wording it as a defect inverts the
 * meaning and pushes an operator away from the model they came for, which is
 * the exact failure the API's fail-open decision exists to prevent. So it is
 * offered, marked, and described as a gap in this build's knowledge.
 *
 * ## The six failures, and why they are six
 *
 * Each names a different remedy. `invalid_key` means get another key.
 * `wrong_provider` means the key is probably fine and the provider setting is
 * not — the mistake that only became possible once there were two providers,
 * and the one `invalid_key` would describe misleadingly. `unreachable` means
 * nothing was even asked, so the key was never judged. `refused` means it
 * authenticated and was not permitted. `no_key` is not a failure at all.
 * `failed` is everything else, with the provider's own status in `detail`.
 */

import type {
  CatalogModel,
  SupervisorModelCatalog,
  SupervisorModelCatalogStatus,
} from '../types/supervisorModels';
import type {
  OperatorSetting,
  PlainOperatorSetting,
  SecretOperatorSetting,
} from '../types/operatorSettings';

// ---------------------------------------------------------------------------
// The four keys this control owns
// ---------------------------------------------------------------------------

export const SUPERVISOR_PROVIDER_KEY = 'supervisor.model.provider';
export const SUPERVISOR_API_KEY_KEY = 'supervisor.model.apiKey';
export const SUPERVISOR_MODEL_NAME_KEY = 'supervisor.model.name';
export const SUPERVISOR_BASE_URL_KEY = 'supervisor.model.baseUrl';

/**
 * The keys the composite control takes over from the generated sections.
 *
 * Declared as one list so that the Configuration section can say where they
 * went instead of rendering a second, worse editor for the same decision — a
 * free-text model field on another tab is the precise split epic #391 exists
 * to remove, and leaving one behind would recreate it at half scale.
 */
export const SUPERVISOR_MODEL_KEYS: readonly string[] = [
  SUPERVISOR_PROVIDER_KEY,
  SUPERVISOR_API_KEY_KEY,
  SUPERVISOR_MODEL_NAME_KEY,
  SUPERVISOR_BASE_URL_KEY,
];

/** Whether a row belongs to the composite control rather than to a list. */
export function isSupervisorModelKey(key: string): boolean {
  return SUPERVISOR_MODEL_KEYS.includes(key);
}

/** The entry for a key, or null when this deployment does not publish it. */
export function findSetting(
  settings: readonly OperatorSetting[],
  key: string,
): OperatorSetting | null {
  return settings.find((entry) => entry.key === key) ?? null;
}

/** The entry for a key, only if it is a plain (non-secret) one. */
export function findPlainSetting(
  settings: readonly OperatorSetting[],
  key: string,
): PlainOperatorSetting | null {
  const entry = findSetting(settings, key);
  return entry !== null && !entry.secret ? entry : null;
}

/** The entry for a key, only if it is a secret one. */
export function findSecretSetting(
  settings: readonly OperatorSetting[],
  key: string,
): SecretOperatorSetting | null {
  const entry = findSetting(settings, key);
  return entry !== null && entry.secret ? entry : null;
}

/** A plain setting's value as a string, with null and numbers flattened. */
export function stringValue(entry: PlainOperatorSetting | null): string {
  if (entry === null || entry.value === null) return '';
  return String(entry.value);
}

// ---------------------------------------------------------------------------
// Admission — three states, never two
// ---------------------------------------------------------------------------

export interface AdmissionPresentation {
  /** The chip beside the model, or null when there is nothing to say. */
  label: string | null;
  /** MUI palette key for that chip. */
  color: 'default' | 'info' | 'warning';
  /** What the mark means, in the operator's terms. */
  help: string;
}

/**
 * The mark for one admission state.
 *
 * `admitted` gets NO chip. A mark on every row is a mark on none, and the
 * chips here exist to draw the eye to the two rows that need a sentence.
 */
export function admissionPresentation(
  admission: string,
  minimumVersion: string,
): AdmissionPresentation {
  if (admission === 'admitted') {
    return {
      label: null,
      color: 'default',
      help: `At or above the ${minimumVersion} floor this build applies.`,
    };
  }

  if (admission === 'below_threshold') {
    return {
      label: 'older than the floor',
      color: 'warning',
      help:
        `Older than the ${minimumVersion} floor this build applies. It is ` +
        'offered rather than hidden, because the floor is a recommendation ' +
        'and not a capability check — selecting it will work.',
    };
  }

  if (admission === 'version_unrecognised') {
    return {
      label: 'version not recognised',
      color: 'info',
      help:
        'This build could not read a version out of that model id, so it ' +
        'could not judge it against the ' +
        `${minimumVersion} floor. That usually means the model is NEWER ` +
        'than the naming rule this build knows — it is offered normally and ' +
        'is very likely the one you want.',
    };
  }

  // A state this build has never heard of. Shown and named rather than
  // guessed at: claiming a model is admitted because the word is unfamiliar
  // is the one thing this mark exists not to do.
  return {
    label: admission,
    color: 'info',
    help:
      'This build does not recognise that admission state, so it will not ' +
      'guess whether the model clears the floor. The model is offered as the ' +
      'API sent it.',
  };
}

/** `gpt-5.4 — GPT-5.4` where the vendor published a label, else just the id. */
export function modelLabel(model: CatalogModel): string {
  return model.displayName && model.displayName !== model.id
    ? `${model.id} — ${model.displayName}`
    : model.id;
}

// ---------------------------------------------------------------------------
// The empty state — six situations, six remedies
// ---------------------------------------------------------------------------

export interface CatalogStatusPresentation {
  /** The alert's severity. `no_key` is not an error; the others are. */
  severity: 'info' | 'warning' | 'error' | 'success';
  /** The heading. Names the situation, never "Error". */
  title: string;
  /** What to do about it, in this build's words. The API's `detail` is
   * rendered separately and verbatim beside it. */
  remedy: string;
}

const STATUS_PRESENTATION: Record<
  SupervisorModelCatalogStatus,
  CatalogStatusPresentation
> = {
  ok: {
    severity: 'success',
    title: 'The provider answered',
    remedy: 'Choose the model the supervisor should ask.',
  },
  no_key: {
    severity: 'info',
    title: 'No key is configured yet',
    remedy:
      'Save a supervisor model API key below and the list fills in. Nothing ' +
      'is wrong: there is simply nothing to ask yet.',
  },
  invalid_key: {
    severity: 'error',
    title: 'The provider rejected the key',
    remedy:
      'The key is wrong, expired or revoked. Replace it below. The provider ' +
      'answered, so this is a verdict on the credential and not on the ' +
      'network.',
  },
  wrong_provider: {
    severity: 'warning',
    title: 'That key looks like the other provider’s',
    remedy:
      'The key was rejected AND it is shaped like a key for the provider you ' +
      'have not selected. Changing the provider above is far more likely to ' +
      'fix this than reissuing the credential — which was probably never the ' +
      'problem.',
  },
  unreachable: {
    severity: 'warning',
    title: 'Nothing answered',
    remedy:
      'The request never got a reply, so the key was never judged — this ' +
      'says nothing at all about the credential. Check the network, the ' +
      'proxy, and the base URL below.',
  },
  refused: {
    severity: 'warning',
    title: 'The key authenticated and was refused',
    remedy:
      'The credential is valid and is not permitted to list models — usually ' +
      'a project, scope or region restriction rather than a bad key. A ' +
      'different key may not help; check what this one is allowed to do.',
  },
  failed: {
    severity: 'error',
    title: 'The provider answered something unexpected',
    remedy:
      'Neither a key verdict nor a network failure — a rate limit, a server ' +
      'error, or a body that could not be read. The provider’s own answer is ' +
      'quoted below. Trying again shortly is usually the right move.',
  },
};

/**
 * How to render one status, including one this build has never heard of.
 *
 * The fallback prints the raw word rather than folding an unknown status into
 * `failed`, for the same reason the reload chip prints an unrecognised value:
 * the API's `detail` is written for a human and is always shown, so a status
 * this build cannot interpret still arrives with its explanation intact.
 */
export function catalogStatusPresentation(
  status: string,
): CatalogStatusPresentation {
  return (
    STATUS_PRESENTATION[status as SupervisorModelCatalogStatus] ?? {
      severity: 'warning',
      title: `The API reported “${status}”`,
      remedy:
        'This build does not recognise that status, so it will not guess at ' +
        'a remedy. The API’s own explanation is below.',
    }
  );
}

// ---------------------------------------------------------------------------
// Listing costs nothing; testing costs money
// ---------------------------------------------------------------------------

/**
 * What pressing the refresh actually costs, read off the response.
 *
 * `spendsTokens` is a field precisely so that this sentence is not a hard-coded
 * fact about which of the API's routes are free — the day a vendor starts
 * billing for a catalogue read, the hard-coded copy is the one that stays
 * wrong. Null before the first answer, because nothing is known yet.
 */
export function listingCostNote(
  catalog: SupervisorModelCatalog | null,
): string | null {
  if (catalog === null) return null;

  return catalog.spendsTokens
    ? 'The API reports that listing models bills tokens on this provider, so ' +
        'this refresh costs money.'
    : 'Listing models bills nothing on either provider, so this can be ' +
        'pressed as often as you like. It is not the Test button below, ' +
        'which makes one real, billed call.';
}

// ---------------------------------------------------------------------------
// The configured model, which is never silently dropped
// ---------------------------------------------------------------------------

export interface ConfiguredModelState {
  /** What `supervisor.model.name` resolves to. Empty when nothing is set. */
  configured: string;
  /** The catalogue entry for it, when the provider listed it. */
  listed: CatalogModel | null;
  /**
   * True when something IS configured, a list did arrive, and the configured
   * id is not in it — the one case that needs a sentence.
   */
  missingFromList: boolean;
}

/**
 * Where the configured model stands against the list that just arrived.
 *
 * The rule this exists to enforce: **a configured model that is not in the
 * list stays selected.** Clearing a working configuration because a filter no
 * longer likes it, or because a provider's catalogue endpoint had a bad day,
 * would be a worse outcome than the free-text field this control replaces.
 * `missingFromList` is false when no list arrived at all, because "the
 * provider did not answer" is not evidence that a model does not exist.
 */
export function configuredModelState(
  configured: string,
  catalog: SupervisorModelCatalog | null,
): ConfiguredModelState {
  const models = catalog?.models ?? [];
  const listed = models.find((model) => model.id === configured) ?? null;

  return {
    configured,
    listed,
    missingFromList: configured !== '' && models.length > 0 && listed === null,
  };
}

/**
 * Why a configured model is not in the list, said out loud.
 *
 * Deliberately does not assert that the model is wrong. Every reason below is
 * one where the configuration may be perfectly good, which is exactly why it
 * stays selected.
 */
export function missingModelExplanation(
  configured: string,
  catalog: SupervisorModelCatalog,
): string {
  return (
    `${configured} is what this deployment is configured to ask, and it is ` +
    `not in the list ${catalog.provider} just returned. It stays selected: ` +
    'the model may be retired, or reachable only by another key or project, ' +
    'or the provider may simply not list it. Nothing here changes what the ' +
    'supervisor sends unless you choose a different model and save.'
  );
}

// ---------------------------------------------------------------------------
// The base URL, whose empty value is a real answer
// ---------------------------------------------------------------------------

/**
 * The placeholder for `supervisor.model.baseUrl`, whose default is empty.
 *
 * Empty means "follow `supervisor.model.provider`" — an answer, not an
 * unfilled field — so it is rendered as that sentence rather than as a blank
 * box that looks required. The provider's own host is deliberately NOT named:
 * which host each vendor publishes lives in `supervisor/invocation/` and
 * `supervisor-model.port.ts` is explicit that nothing outside it may name a
 * provider's endpoint. Repeating one here would be a copy that goes stale
 * silently.
 *
 * The counterpart rule lives in `buildSupervisorModelPatch`: this string is a
 * PLACEHOLDER and is never sent. A form that wrote its own placeholder back
 * would pin the base URL to it forever on the first unrelated save.
 */
export const BASE_URL_PLACEHOLDER = 'Follows the provider selected above';

// ---------------------------------------------------------------------------
// What a save sends
// ---------------------------------------------------------------------------

export interface SupervisorModelDraft {
  /** The model id to store, or `''` for "no model configured". */
  name: string;
  /** The base URL to store, or `''` for "follow the provider". */
  baseUrl: string;
}

/**
 * The keys that actually changed, and nothing else.
 *
 * Sparseness is a correctness requirement rather than an economy, and the base
 * URL is the field that proves it: its stored value is the empty string and
 * its meaning is "follow the provider". A form that submitted every field it
 * rendered would write the base URL on every save — harmless while the value
 * is genuinely empty, and a silent pin the moment somebody's placeholder text
 * or a normalised host got into the draft. Only a value the operator moved is
 * sent.
 *
 * Note what is NOT here: the provider and the key. The key needs
 * `operator_settings:write_secret` on top of `system_settings:write` and the
 * API applies a multi-key patch key by key, so bundling it would fail an
 * operator's model change over a permission that has nothing to do with it.
 * The provider has to be STORED before the catalogue can be resolved against
 * it, so it is its own immediate write.
 */
export function buildSupervisorModelPatch(
  settings: readonly OperatorSetting[],
  draft: SupervisorModelDraft,
): Record<string, string> {
  const patch: Record<string, string> = {};

  const name = findPlainSetting(settings, SUPERVISOR_MODEL_NAME_KEY);
  if (name !== null && draft.name !== stringValue(name)) {
    patch[SUPERVISOR_MODEL_NAME_KEY] = draft.name;
  }

  const baseUrl = findPlainSetting(settings, SUPERVISOR_BASE_URL_KEY);
  if (baseUrl !== null && draft.baseUrl !== stringValue(baseUrl)) {
    patch[SUPERVISOR_BASE_URL_KEY] = draft.baseUrl;
  }

  return patch;
}

/** The draft a fresh document seeds. Derived, never stored across documents. */
export function seedSupervisorModelDraft(
  settings: readonly OperatorSetting[],
): SupervisorModelDraft {
  return {
    name: stringValue(findPlainSetting(settings, SUPERVISOR_MODEL_NAME_KEY)),
    baseUrl: stringValue(findPlainSetting(settings, SUPERVISOR_BASE_URL_KEY)),
  };
}

export interface SupervisorModelOption {
  model: CatalogModel;
  /**
   * Whether the provider actually listed it.
   *
   * False for exactly one option: a configured model the catalogue did not
   * return. Kept as its own flag rather than folded into `admission`, because
   * "the provider did not list this" and "this build could not read its
   * version" are different findings with different remedies, and giving the
   * first one the second's chip would tell an operator something untrue.
   */
  listed: boolean;
}

/**
 * The options the model dropdown offers, in the API's own order.
 *
 * The list is **pre-sorted by the API** — admitted, then unrecognised, then
 * below the floor — and that order is deliberate, so nothing here re-sorts it.
 * A configured model the provider did not list is prepended, because it is the
 * one that is currently selected and a selected option missing from its own
 * dropdown is a control that silently shows the wrong value.
 */
export function modelOptions(
  configured: string,
  catalog: SupervisorModelCatalog | null,
): SupervisorModelOption[] {
  const models = catalog?.models ?? [];
  const listed = models.map((model) => ({ model, listed: true }));
  const state = configuredModelState(configured, catalog);

  if (!state.missingFromList) return listed;

  return [
    {
      model: {
        id: configured,
        displayName: null,
        version: null,
        // Never read: `listed: false` is what the renderer branches on. The
        // API's floor did not judge this model, because the API never saw it.
        admission: 'version_unrecognised',
        createdAt: null,
      },
      listed: false,
    },
    ...listed,
  ];
}

/** The admission mark for one model, given the catalogue it came from. */
export function markFor(
  model: CatalogModel,
  catalog: SupervisorModelCatalog | null,
): AdmissionPresentation {
  return admissionPresentation(model.admission, catalog?.minimumVersion ?? '—');
}
