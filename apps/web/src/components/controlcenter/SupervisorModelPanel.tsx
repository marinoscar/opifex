/**
 * The supervisor's model, its provider and its key — one decision, one screen
 * (#394, epic #391).
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
 * section says where these four keys went (see `SettingsSection`).
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
  SUPERVISOR_API_KEY_KEY,
  SUPERVISOR_BASE_URL_KEY,
  SUPERVISOR_MODEL_NAME_KEY,
  SUPERVISOR_PROVIDER_KEY,
  buildSupervisorModelPatch,
  catalogStatusPresentation,
  configuredModelState,
  findPlainSetting,
  findSecretSetting,
  listingCostNote,
  markFor,
  missingModelExplanation,
  modelLabel,
  modelOptions,
  seedSupervisorModelDraft,
  stringValue,
} from '../../config/supervisorModel';
import { provenanceOf } from '../../config/operatorSettings';
import type {
  OperatorSettingsDocument,
  OperatorSettingsPatch,
} from '../../types/operatorSettings';
import type { SupervisorModelCatalog } from '../../types/supervisorModels';

export interface SupervisorModelPanelProps {
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
   * The `supervisor.model.apiKey` card, rendered by the section that owns
   * every other secret card.
   *
   * A slot rather than a second implementation: `SecretCredentialCard` holds
   * the write-only discipline this whole screen rests on — an uncontrolled
   * field, read once at submit, never bound to state — and re-implementing a
   * key input inside this panel would be the one place that discipline could
   * quietly not hold.
   */
  keyCard: ReactNode;
}

export function SupervisorModelPanel({
  document,
  canWrite,
  isSaving,
  catalog,
  catalogIsLoading,
  catalogError,
  onRefreshCatalog,
  onSave,
  keyCard,
}: SupervisorModelPanelProps) {
  const [draft, setDraft] = useState(() =>
    seedSupervisorModelDraft(document.settings),
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
    setDraft(seedSupervisorModelDraft(document.settings));
  }

  const providerEntry = findPlainSetting(
    document.settings,
    SUPERVISOR_PROVIDER_KEY,
  );
  const keyEntry = findSecretSetting(document.settings, SUPERVISOR_API_KEY_KEY);
  const nameEntry = findPlainSetting(
    document.settings,
    SUPERVISOR_MODEL_NAME_KEY,
  );
  const baseUrlEntry = findPlainSetting(
    document.settings,
    SUPERVISOR_BASE_URL_KEY,
  );

  const storedProvider = stringValue(providerEntry);
  const providerValue = pendingProvider ?? storedProvider;
  const providers = providerEntry?.constraints.values ?? [];

  const options = modelOptions(draft.name, catalog);
  const state = configuredModelState(stringValue(nameEntry), catalog);
  const selected = options.find((option) => option.model.id === draft.name);

  // Derived on every render, never stored: the button acts on the same patch
  // the tests assert, rather than on a boolean that could drift from it.
  const patch = buildSupervisorModelPatch(document.settings, draft);
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
      await onSave({ [SUPERVISOR_PROVIDER_KEY]: next });
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
      aria-label="Supervisor model"
      sx={{ p: { xs: 2, sm: 3 }, mb: 4 }}
    >
      <Typography variant="h6" component="h3" gutterBottom>
        Supervisor model
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Which model answers, and which credential it answers with. These were
        two settings on two tabs, and the one with no list was the one that had
        to be typed from memory — so they are one control here. The list below
        is what the saved key can actually reach right now.
      </Typography>

      {problem && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {problem}
        </Alert>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 1. Provider                                                    */}
      {/* ------------------------------------------------------------- */}
      {providerEntry === null ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          This deployment&apos;s API does not publish{' '}
          <code>{SUPERVISOR_PROVIDER_KEY}</code>, so there is no provider to
          choose.
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
              'dropped rather than left on screen. Switching without also ' +
              'replacing the key sends that credential to a host that will ' +
              'reject it, which the list below will say plainly.'
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
      {/* 2. The key — the card the rest of this screen already uses     */}
      {/* ------------------------------------------------------------- */}
      {keyEntry === null ? (
        <Alert severity="info" sx={{ mb: 3 }}>
          This deployment&apos;s API does not publish{' '}
          <code>{SUPERVISOR_API_KEY_KEY}</code>, so there is no key to set here.
        </Alert>
      ) : (
        <Box sx={{ mb: 3 }}>{keyCard}</Box>
      )}

      <Divider sx={{ mb: 3 }} />

      {/* ------------------------------------------------------------- */}
      {/* 3. What the key can reach                                      */}
      {/* ------------------------------------------------------------- */}
      <CatalogState
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
          This deployment&apos;s API does not publish{' '}
          <code>{SUPERVISOR_MODEL_NAME_KEY}</code>.
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
      {/* 5. The base URL, whose empty value is an answer                */}
      {/* ------------------------------------------------------------- */}
      {baseUrlEntry !== null && (
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
                  'key is sent to whatever host is named here.'
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
          Save model settings
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
  catalog,
  isLoading,
  error,
  onRefresh,
}: {
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
    <Box aria-label="Supervisor model list">
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
          {isLoading ? 'Asking the provider…' : 'List models'}
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

export default SupervisorModelPanel;
