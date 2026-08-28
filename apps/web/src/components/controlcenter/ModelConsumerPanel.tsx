/**
 * One model consumer's provider, model and credential — one decision, one
 * screen (#394, epic #391; parameterised per consumer by #423, epic #419).
 *
 * ## The split this removes
 *
 * An operator saved `SUPERVISOR_MODEL_API_KEY` on this tab, pressed Test, and
 * was told `SUPERVISOR_MODEL_NAME` was not set. That setting lived on the
 * Configuration tab and was a free-text box, so configuring one coherent thing
 * — which model answers, using which credential — was split across two
 * screens, and the half that is hardest to get right was the one with no
 * validation and no list. Their question was "where do I set the model?", and
 * the answer this panel gives is "here, next to the key that lists them".
 *
 * ## Why it lives on Credentials rather than in the generated Configuration
 *
 * The Configuration section is generated from `GET /api/operator-settings` and
 * names no key anywhere in `apps/web`; that is #348's acceptance criterion and
 * hand-writing a composite into it would spend exactly the property it bought.
 * The Credentials section is already the bespoke half — every card is a secret
 * the generated renderer cannot draw, `config/credentialProbes.ts` already
 * declares key-by-key which probe tests what, and `SpendCeilingsPanel` is
 * already a hand-written composite over registry keys. The irreducible fact is
 * that this control needs a SECRET, and a secret is only ever rendered here.
 * So the composite goes where the bespoke already is, and the generated
 * section says where these keys went (see `SettingsSection`).
 *
 * ## One credential is selected; the others are still here (#422, epic #419)
 *
 * There is no single model key any more. The API holds one slot per provider
 * — `models.<provider>.apiKey` and its `baseUrl` — and reads the slot that
 * `supervisor.model.provider` names, so this panel shows the SELECTED
 * provider's credential beside the model list it fills, and every other
 * provider's card underneath it.
 *
 * Showing only the selected one was the alternative and it is the wrong
 * trade. The operator's stated requirement is to HOLD both keys, and the bug
 * being fixed is that switching provider used to destroy the other one — so a
 * screen that quietly stopped displaying the unselected credential would be
 * indistinguishable, at a glance, from the failure it replaced. Showing both
 * with a hierarchy — one in use, above, next to the list it produces; the
 * rest stored and idle, below — says the true thing without pretending two
 * keys are one decision. Only the selected card carries the billed Test
 * button, because that is the only credential anything is currently asking.
 *
 * ## Three separate writes, on purpose
 *
 * The key is its own write because it needs `operator_settings:write_secret`
 * on top of `system_settings:write` and the API applies a multi-key patch key
 * by key — bundling it would fail a model change over a permission that has
 * nothing to do with it. The provider is its own write because the catalogue
 * is resolved SERVER-SIDE from the stored provider: an unsaved provider cannot
 * produce a list at all, so offering one behind a second button would leave
 * the other vendor's models on screen, selectable, which is precisely the
 * stale list this issue forbids. The model and the base URL share a Save,
 * because they are two plain keys behind one permission.
 *
 * ## Listing is free; testing is not
 *
 * The refresh here reads a catalogue, which bills nothing on either provider.
 * The Test button on the key card below makes one real, billed call and is
 * rate limited for it. They are not the same kind of action and are not
 * presented as one — and which of them is free is read off `spendsTokens`
 * rather than hard-coded, so the day a vendor starts charging for a catalogue
 * read this sentence changes with the API instead of lying.
 *
 * ## One component, one instance per consumer (#423, epic #419)
 *
 * The supervisor is no longer the only thing that asks a model a question, and
 * the second one — the chat — selects its provider and its model
 * INDEPENDENTLY. So `consumer` is a prop and the section renders this panel
 * once per consumer the API publishes, rather than a second component being
 * written for the chat. What would have been duplicated is not a form: it is
 * #391's whole answer to choosing a model — the admission marks, the
 * fail-open tone of `version_unrecognised`, the configured-but-unlisted model
 * that stays selected, the six catalogue statuses and their six remedies. Two
 * copies of that would be two places to fix the day a vendor renames a model
 * family, and the copy that gets missed is the one that quietly starts
 * hiding the model somebody came for. An operator typing a model name for one
 * consumer and picking it from a list for the other is precisely the
 * asymmetry this issue removes.
 *
 * ## The credential half is NOT per consumer, and this panel says so
 *
 * A credential belongs to a PROVIDER; a consumer selects one. So exactly one
 * instance carries the key cards — `credentialOwner`, the supervisor, where
 * the billed Test button belongs — and every other instance renders no key
 * field at all, only a statement of which shared credential it resolves to and
 * whether that credential is stored. A second key input on the chat's panel
 * would be two editors over one secret, and the base URL is the same fact:
 * the host is where the key is sent, so it is edited once, beside the key.
 *
 * ## An unconfigured consumer is inert, and reads as an off state (#324)
 *
 * The chat has no `chat.enabled`. An empty `chat.model.name` IS its off
 * switch, and that is the default every deployment starts on — so the panel
 * for a consumer whose credential lives elsewhere leads with
 * `modelConsumerReadiness`, in the API's own `available` /
 * `unavailableReason` vocabulary, at `info` severity. Not a warning and not an
 * error: nothing is wrong with a deployment that has not decided to run a
 * chat, and a screen that shouted at it would teach operators to ignore the
 * one case where something really is misconfigured.
 */

import { useState, type ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import {
  BASE_URL_PLACEHOLDER,
  buildModelPatch,
  catalogStatusPresentation,
  configuredModelState,
  consumerLabel,
  consumersSelecting,
  findPlainSetting,
  listingCostNote,
  markFor,
  missingModelExplanation,
  modelApiKeySettingKey,
  modelConsumerReadiness,
  modelLabel,
  modelNameSettingKey,
  modelOptions,
  modelProviderSettingKey,
  seedModelDraft,
  selectedSlot,
  stringValue,
  unselectedSlots,
} from '../../config/supervisorModel';
import { provenanceOf } from '../../config/operatorSettings';
import type {
  OperatorSettingsDocument,
  OperatorSettingsPatch,
} from '../../types/operatorSettings';
import type { SupervisorModelCatalog } from '../../types/supervisorModels';

export interface ModelConsumerPanelProps {
  /**
   * Which consumer this instance configures — `supervisor`, `chat`, or one
   * this build has never heard of.
   *
   * A string rather than a union, for the reason `provider` is one: the
   * consumers are declared once in the API and reach this build as the
   * `<consumer>.model.provider` keys the settings response carries, so a
   * union here would be a second, silent declaration of that list.
   */
  consumer: string;
  document: OperatorSettingsDocument;
  /** `system_settings:write` — the provider, the model and the base URL. */
  canWrite: boolean;
  /** A save is in flight anywhere in the section. */
  isSaving: boolean;
  /** The provider's answer, whatever it was. Null before the first one. */
  catalog: SupervisorModelCatalog | null;
  catalogIsLoading: boolean;
  /** Why the REQUEST failed. Never a verdict on the credential. */
  catalogError: string | null;
  onRefreshCatalog: () => void;
  /** Sends only the keys given. Rejects with the API's own refusal. */
  onSave: (patch: OperatorSettingsPatch) => Promise<void>;
  /**
   * The credential cards, given to the ONE instance that owns them (#423).
   *
   * Absent for every other consumer, and that absence is the whole of the
   * credential/consumer split as this screen renders it: a key belongs to a
   * provider and is shared by whoever selects it, so it is edited once. A
   * consumer without this prop shows no key field and no endpoint field —
   * only which shared credential it resolves to, and whether that credential
   * is stored.
   *
   * The cards are passed in as nodes rather than built here:
   * `SecretCredentialCard` holds the write-only discipline this whole screen
   * rests on — an uncontrolled field, read once at submit, never bound to
   * state — and re-implementing a key input inside this panel would be the
   * one place that discipline could quietly not hold.
   */
  credentials?: {
    /** The selected provider's `models.<provider>.apiKey` card. */
    keyCard: ReactNode;
    /**
     * The same card for every provider this consumer has NOT selected (#422).
     *
     * Rendered rather than hidden, and that is this panel's answer to the
     * question the credential split raises. An operator holds one key per
     * vendor; if selecting Anthropic made the OpenAI key disappear from the
     * screen, the fix would look exactly like the bug it replaced — where
     * switching provider really did leave the other credential unreachable.
     * Whether one of them is nevertheless IN USE is read from the document,
     * because since #423 another consumer may have selected it.
     */
    otherKeyCards: ReactNode;
  };
}

export function ModelConsumerPanel({
  consumer,
  document,
  canWrite,
  isSaving,
  catalog,
  catalogIsLoading,
  catalogError,
  onRefreshCatalog,
  onSave,
  credentials,
}: ModelConsumerPanelProps) {
  // Whether this instance edits the shared credential, decided by the section
  // and expressed as the presence of the cards themselves — so there is no
  // second boolean that could disagree with what is actually rendered.
  const ownsCredentials = credentials !== undefined;
  const label = consumerLabel(consumer);
  const providerKey = modelProviderSettingKey(consumer);
  const nameKey = modelNameSettingKey(consumer);

  const [draft, setDraft] = useState(() =>
    seedModelDraft(document.settings, consumer, ownsCredentials),
  );
  /** The provider being written, while it is being written. Not derived state. */
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Re-seed on a fresh document — a save landing, or a 409's refetch. During
  // render rather than in an effect, the way `SettingsSection` and
  // `SpendCeilingsPanel` do it, so no control paints a stale value for a frame
  // and the repo's `react-hooks/set-state-in-effect` lint stays satisfied.
  const [seededFrom, setSeededFrom] = useState(document);
  if (document !== seededFrom) {
    setSeededFrom(document);
    setDraft(seedModelDraft(document.settings, consumer, ownsCredentials));
  }

  const providerEntry = findPlainSetting(document.settings, providerKey);
  const nameEntry = findPlainSetting(document.settings, nameKey);

  // The credential and its endpoint are looked up BY the stored provider
  // (#422). Not by the pending selection: the API resolves the slot from what
  // is stored, so a panel that followed the select would show one key while
  // the supervisor used the other.
  const slot = selectedSlot(document.settings, consumer);
  const keyEntry = slot?.apiKey ?? null;
  const baseUrlEntry = slot?.baseUrl ?? null;
  // Only the slots that actually have a key card to show: a provider whose
  // endpoint is published while its credential is not would otherwise get a
  // heading and a paragraph about a card that is not there.
  const otherSlots = unselectedSlots(document.settings, consumer).filter(
    (other) => other.apiKey !== null,
  );
  // Which of those another consumer is nevertheless asking. "Stored and not in
  // use" stopped being true the moment a second consumer could select the
  // provider this one did not (#423), and a screen that kept saying it would
  // be lying about a key that is currently being billed.
  const otherSlotsInUse = otherSlots.filter(
    (other) => consumersSelecting(document.settings, other.provider).length > 0,
  );
  const idleSlots = otherSlots.filter(
    (other) =>
      consumersSelecting(document.settings, other.provider).length === 0,
  );
  // What this consumer would do if asked right now, in the API's own
  // vocabulary. Rendered only where the credential is NOT on the panel: the
  // owner's own key card already states whether a key is stored, in place,
  // and a second sentence saying it would be one more thing to keep in step.
  const readiness = modelConsumerReadiness(document.settings, consumer);

  const storedProvider = stringValue(providerEntry);
  const providerValue = pendingProvider ?? storedProvider;
  const providers = providerEntry?.constraints.values ?? [];

  const options = modelOptions(draft.name, catalog);
  const state = configuredModelState(stringValue(nameEntry), catalog);
  const selected = options.find((option) => option.model.id === draft.name);

  // Derived on every render, never stored: the button acts on the same patch
  // the tests assert, rather than on a boolean that could drift from it.
  const patch = buildModelPatch(document.settings, consumer, draft);
  const changedKeys = Object.keys(patch);
  const mayWrite = canWrite && !isSaving;

  const chooseProvider = async (next: string) => {
    if (next === storedProvider) return;

    setPendingProvider(next);
    setProblem(null);
    setSavedAt(null);

    try {
      // Stored before the catalogue is asked for, because the API resolves the
      // provider itself. The refresh is the caller's, so that saving the key
      // re-lists by the same path saving the provider does.
      await onSave({ [providerKey]: next });
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'The API refused the provider change.',
      );
    } finally {
      // The select falls back to what the document says, which after a
      // failure is still the old provider — so nothing on screen claims a
      // change that was refused.
      setPendingProvider(null);
    }
  };

  const save = async () => {
    setProblem(null);

    try {
      await onSave(patch);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'The API refused the change.',
      );
    }
  };

  return (
    <Paper
      variant="outlined"
      // `<label> model settings` rather than `<label> model`, which is the
      // registry's own label for the model NAME field on the chat's panel —
      // two nodes with one accessible name is a control a screen reader
      // cannot tell apart from its container.
      aria-label={`${label} model settings`}
      sx={{ p: { xs: 2, sm: 3 }, mb: 4 }}
    >
      <Typography variant="h6" component="h3" gutterBottom>
        {label} model
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {ownsCredentials
          ? 'Which model answers, and which credential it answers with. These ' +
            'were two settings on two tabs, and the one with no list was the ' +
            'one that had to be typed from memory — so they are one control ' +
            'here. The list below is what the saved key can actually reach ' +
            'right now.'
          : `Which model ${consumer} asks, and on which provider — chosen ` +
            'independently of every other consumer. The credential is not: a ' +
            'key belongs to a vendor and is shared by whoever selects it, so ' +
            'it is stored once, above. The list below is what that stored key ' +
            'can actually reach right now.'}
      </Typography>

      {problem && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {problem}
        </Alert>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 0. Whether this consumer could answer anything at all          */}
      {/* ------------------------------------------------------------- */}
      {!ownsCredentials && (
        <Alert
          // INFO on both arms, deliberately. An unconfigured consumer is an
          // off state somebody has not opted into, not a fault — and this is
          // the state every deployment starts in. Warning severity here would
          // train an operator to ignore the colour that matters.
          severity="info"
          variant="outlined"
          sx={{ mb: 3 }}
          aria-label={`${label} model readiness`}
        >
          <AlertTitle>
            {readiness.available
              ? `The ${consumer} is configured and would ask a model`
              : `The ${consumer} is unconfigured, so it asks nothing`}
          </AlertTitle>
          {readiness.available
            ? `It asks ${readiness.model} on ${readiness.provider}, with the ` +
              `${readiness.provider} credential stored above.`
            : readiness.unavailableReason}
        </Alert>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 1. Provider                                                    */}
      {/* ------------------------------------------------------------- */}
      {providerEntry === null ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          This deployment&apos;s API does not publish <code>{providerKey}</code>
          , so there is no provider to choose.
        </Alert>
      ) : (
        <Box sx={{ mb: 3 }}>
          <TextField
            select
            fullWidth
            size="small"
            label={providerEntry.label}
            value={providerValue}
            disabled={!mayWrite}
            onChange={(event) => void chooseProvider(event.target.value)}
            helperText={
              'Saved as soon as you choose it, and the model list is asked ' +
              'again — a list belongs to a provider, so the previous one is ' +
              'dropped rather than left on screen. Each provider keeps its ' +
              'own key and endpoint, so switching selects that provider’s ' +
              'stored credential: nothing is re-entered and nothing is ' +
              'cleared. Any unsaved model' +
              (ownsCredentials ? ' or base URL' : '') +
              ' edit is discarded with it, because ' +
              (ownsCredentials ? 'those belong' : 'it belongs') +
              ' to the provider that was selected when they were typed. ' +
              'Every consumer chooses its own provider, so this changes ' +
              `nothing for anything other than the ${consumer}.`
            }
          >
            {providers.map((value) => (
              <MenuItem key={value} value={value}>
                {value}
              </MenuItem>
            ))}
          </TextField>
          <Typography
            variant="caption"
            component="p"
            color="text.secondary"
            sx={{ mt: 1 }}
          >
            {providerEntry.help} {provenanceOf(providerEntry).detail}
          </Typography>
        </Box>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 2. The credential — edited here by ONE consumer, named by the  */}
      {/*    rest. There is one key per provider, never one per consumer */}
      {/* ------------------------------------------------------------- */}
      {!ownsCredentials ? (
        <Alert severity="info" variant="outlined" sx={{ mb: 3 }}>
          Asked with the{' '}
          <code>{modelApiKeySettingKey(storedProvider || 'provider')}</code>{' '}
          credential above — the provider&apos;s own key, shared by every
          consumer that selects it. There is deliberately no second key field
          here: one vendor, one credential, edited in one place.
        </Alert>
      ) : keyEntry === null ? (
        <Alert severity="info" sx={{ mb: 3 }}>
          This deployment&apos;s API does not publish{' '}
          <code>{modelApiKeySettingKey(storedProvider || 'provider')}</code>, so
          there is no key to set for the selected provider.
        </Alert>
      ) : (
        <Box sx={{ mb: 3 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            The credential for the provider selected above. It is the one the{' '}
            {consumer} sends, the one the list below was asked with, and the one
            every other consumer on this provider uses.
          </Typography>
          {credentials.keyCard}
        </Box>
      )}

      <Divider sx={{ mb: 3 }} />

      {/* ------------------------------------------------------------- */}
      {/* 3. What the key can reach                                      */}
      {/* ------------------------------------------------------------- */}
      <CatalogState
        consumer={consumer}
        label={label}
        catalog={catalog}
        isLoading={catalogIsLoading}
        error={catalogError}
        onRefresh={onRefreshCatalog}
      />

      {/* ------------------------------------------------------------- */}
      {/* 4. The model                                                   */}
      {/* ------------------------------------------------------------- */}
      {nameEntry === null ? (
        <Alert severity="info" sx={{ mt: 3 }}>
          This deployment&apos;s API does not publish <code>{nameKey}</code>.
        </Alert>
      ) : (
        <Box sx={{ mt: 3 }}>
          {options.length > 0 ? (
            <TextField
              select
              fullWidth
              size="small"
              label={nameEntry.label}
              value={draft.name}
              disabled={!mayWrite}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  name: event.target.value,
                }))
              }
              // The closed control shows the id and nothing else. The mark
              // for whatever is selected is rendered below it, so a chip
              // never ends up nested inside the select's own label.
              slotProps={{ select: { renderValue: (value) => String(value) } }}
              helperText={
                'Chosen from what the provider listed, in the order it sent ' +
                'them. Nothing is hidden for its version.'
              }
            >
              <MenuItem value="">
                <em>No model configured</em>
              </MenuItem>
              {options.map((option) => (
                <MenuItem key={option.model.id} value={option.model.id}>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
                  >
                    <span>{modelLabel(option.model)}</span>
                    {!option.listed && (
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label="not in this list"
                      />
                    )}
                    {option.listed &&
                      markFor(option.model, catalog).label !== null && (
                        <Chip
                          size="small"
                          color={markFor(option.model, catalog).color}
                          variant="outlined"
                          label={markFor(option.model, catalog).label}
                        />
                      )}
                  </Stack>
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <TextField
              fullWidth
              size="small"
              label={nameEntry.label}
              value={draft.name}
              disabled={!mayWrite}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  name: event.target.value,
                }))
              }
              helperText={
                'No list is available, so this falls back to the exact ' +
                'catalogue string. It is sent verbatim as the request’s ' +
                'model field.'
              }
            />
          )}

          {selected && (
            <Box sx={{ mt: 1 }}>
              {selected.listed ? (
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
                >
                  {selected.model.version && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`version ${selected.model.version}`}
                    />
                  )}
                  {markFor(selected.model, catalog).label !== null && (
                    <Tooltip title={markFor(selected.model, catalog).help}>
                      <Chip
                        size="small"
                        color={markFor(selected.model, catalog).color}
                        label={markFor(selected.model, catalog).label}
                      />
                    </Tooltip>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {markFor(selected.model, catalog).help}
                  </Typography>
                </Stack>
              ) : (
                catalog && (
                  <Alert severity="warning" variant="outlined">
                    <AlertTitle>
                      This model is not in the list, and stays selected
                    </AlertTitle>
                    {missingModelExplanation(selected.model.id, catalog)}
                  </Alert>
                )
              )}
            </Box>
          )}

          {state.missingFromList && draft.name !== state.configured && (
            <Typography
              variant="caption"
              component="p"
              color="text.secondary"
              sx={{ mt: 1 }}
            >
              {state.configured} is still what is stored. It remains in the list
              above until you save something else.
            </Typography>
          )}
        </Box>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 5. The base URL, whose empty value is an answer — and which    */}
      {/*    belongs to the credential, so only its owner edits it       */}
      {/* ------------------------------------------------------------- */}
      {ownsCredentials && baseUrlEntry !== null && draft.baseUrl !== null && (
        <Box sx={{ mt: 3 }}>
          <TextField
            fullWidth
            size="small"
            label={baseUrlEntry.label}
            value={draft.baseUrl}
            // A PLACEHOLDER, never a value. Empty means "follow the provider",
            // which is a real answer rather than an unfilled field — and a
            // form that wrote its own placeholder back would pin the base URL
            // to it forever on the first unrelated save.
            placeholder={BASE_URL_PLACEHOLDER}
            disabled={!mayWrite}
            onChange={(event) =>
              setDraft((previous) => ({
                ...previous,
                baseUrl: event.target.value,
              }))
            }
            helperText={
              draft.baseUrl === ''
                ? 'Empty, which means it follows the provider selected above. ' +
                  'Set it only for a proxy, a gateway or a test server — the ' +
                  'key above is sent to whatever host is named here, and this ' +
                  'endpoint belongs to that provider alone.'
                : baseUrlEntry.help
            }
          />
        </Box>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 6. Save — the two plain keys, and only the ones that moved     */}
      {/* ------------------------------------------------------------- */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ mt: 3, alignItems: { sm: 'center' } }}
      >
        <Button
          variant="contained"
          size="small"
          onClick={() => void save()}
          disabled={!mayWrite || changedKeys.length === 0}
        >
          {/* Named for its consumer, because there is now more than one of
              these on the screen and two buttons with the same accessible
              name are two buttons a screen-reader user cannot tell apart. */}
          Save {consumer} model settings
        </Button>
        <Box>
          <Typography variant="body2" color="text.secondary">
            {changedKeys.length === 0
              ? 'No changes to send.'
              : `${changedKeys.join(', ')} will be sent. Nothing else is included.`}
          </Typography>
          {savedAt && (
            <Typography variant="caption" color="text.secondary">
              Saved at {savedAt}. The values above are the API re-resolved after
              the write.
            </Typography>
          )}
        </Box>
      </Stack>

      {/* ------------------------------------------------------------- */}
      {/* 7. The keys for the providers that are NOT selected            */}
      {/* ------------------------------------------------------------- */}
      {ownsCredentials && otherSlots.length > 0 && (
        <Box sx={{ mt: 4 }} aria-label="Other providers’ credentials">
          <Divider sx={{ mb: 2 }} />
          <Typography variant="subtitle1" component="h4" gutterBottom>
            Other providers’ credentials
          </Typography>
          {idleSlots.length > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {idleSlots.map((other) => other.provider).join(', ')} —{' '}
              {idleSlots.length === 1 ? 'not' : 'neither'} selected by any
              consumer, so{' '}
              {idleSlots.length === 1 ? 'this key is' : 'these keys are'} stored
              and not in use. A key belongs to a vendor, so it is kept whichever
              provider is selected: choosing one above does not clear{' '}
              {idleSlots.length === 1 ? 'the other' : 'the others'}, and
              selecting it again uses the same credential without asking for it
              twice.
            </Typography>
          )}
          {/* The sentence that stopped being true when a second consumer
              arrived (#423). One of these keys may be the one the chat is
              currently billing, and calling it idle would be a claim about
              spending that is simply false. */}
          {otherSlotsInUse.map((other) => (
            <Typography
              key={other.provider}
              variant="body2"
              color="text.secondary"
              sx={{ mb: 2 }}
            >
              {other.provider} — not selected by the {consumer}, but in use by{' '}
              {consumersSelecting(document.settings, other.provider).join(', ')}
              . One credential per vendor is shared by every consumer that
              selects it, so this key is stored here and sent by them.
            </Typography>
          ))}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            There is no Test button on{' '}
            {otherSlots.length === 1 ? 'this card' : 'these cards'}: the test
            makes a real, billed call through the {consumer}&apos;s own adapter,
            which reads the provider selected above.
          </Typography>
          {credentials.otherKeyCards}
        </Box>
      )}
    </Paper>
  );
}

/**
 * What the provider said, or why nothing was asked.
 *
 * Six statuses, each with its own remedy, and the API's own `detail` quoted
 * verbatim underneath — the API knows things this build does not, such as
 * which host refused and with what status, and paraphrasing it would throw
 * that away. `no_key` is `info` rather than an error because nothing is wrong:
 * there is simply nothing to ask yet.
 */
function CatalogState({
  consumer,
  label,
  catalog,
  isLoading,
  error,
  onRefresh,
}: {
  consumer: string;
  label: string;
  catalog: SupervisorModelCatalog | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const presentation = catalog
    ? catalogStatusPresentation(catalog.status)
    : null;
  const costNote = listingCostNote(catalog);

  return (
    <Box aria-label={`${label} model list`}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: { sm: 'center' }, mb: 1 }}
      >
        <Button
          variant="outlined"
          size="small"
          onClick={onRefresh}
          disabled={isLoading}
          startIcon={isLoading ? <CircularProgress size={14} /> : undefined}
        >
          {isLoading ? 'Asking the provider…' : `List ${consumer} models`}
        </Button>
        {costNote && (
          <Typography variant="caption" color="text.secondary">
            {costNote}
          </Typography>
        )}
      </Stack>

      {error !== null && (
        <Alert severity="error" sx={{ mb: 1 }}>
          <AlertTitle>The list could not be requested</AlertTitle>
          {error} This is a failure of the request, not a verdict on the key.
        </Alert>
      )}

      {catalog && presentation && (
        <Alert severity={presentation.severity} sx={{ mb: 1 }}>
          <AlertTitle>{presentation.title}</AlertTitle>
          {presentation.remedy}
          <Typography variant="body2" sx={{ mt: 1 }}>
            {catalog.detail}
          </Typography>
          <Typography variant="caption" component="p" sx={{ mt: 1 }}>
            {catalog.provider} · {catalog.models.length} model
            {catalog.models.length === 1 ? '' : 's'} · floor{' '}
            {catalog.minimumVersion} · asked{' '}
            {new Date(catalog.checkedAt).toLocaleString()}
          </Typography>
        </Alert>
      )}
    </Box>
  );
}

export default ModelConsumerPanel;
