/**
 * Credentials — the secrets, their Test buttons, and the spend ceilings
 * (#349, epic #332).
 *
 * ## Which rows appear here is decided by the response, not by a list
 *
 * Every setting the API marks `secret` gets a card, in the order the registry
 * lists them. A credential added to the backend registry therefore appears
 * here with a working Replace and Clear and no frontend change — the same
 * property #348 established for the Configuration section. What cannot be
 * derived from the response is which PROBE tests which key, and
 * `config/credentialProbes.ts` says so where it declares that map.
 *
 * ## Why the secrets and the ceilings save separately
 *
 * A secret write additionally needs `operator_settings:write_secret`, and the
 * API applies a multi-key patch key by key rather than in one transaction. A
 * combined save would fail an operator's ceiling edit because of a permission
 * that has nothing to do with it — or worse, apply half of it. Each card
 * sends its own key.
 *
 * ## The model credentials are not on cards of their own, and that is the point
 *
 * Every `models.<provider>.apiKey` is rendered INSIDE `SupervisorModelPanel`
 * (#394, epic #391) rather than in the list above it. The key on its own was
 * never the operator's problem: they saved it here, pressed Test, and were
 * told a model name they had never heard of was unset — on another tab, in a
 * free-text box. So the key, the provider and the model are one control, and
 * the cards themselves are passed into that control rather than
 * reimplemented, so the write-only discipline below holds for them unchanged.
 *
 * Since #422 there is one such key per provider rather than one in total, and
 * ALL of them go into the panel: the selected provider's beside the model list
 * it fills, the rest below it as stored-and-idle. Splitting them — one in the
 * panel, the other up here between the GitHub token and the runner's — would
 * put two halves of one decision on one screen in two places, which is the
 * shape of the problem this panel was built to remove.
 *
 * ## One panel per consumer, and exactly one of them holds the keys (#423)
 *
 * There is a panel for every consumer the API publishes — the supervisor's and
 * the chat's today, discovered from the `<consumer>.model.provider` keys
 * rather than listed here. They are rendered together because the question an
 * operator answers on this screen is which model each consumer asks, and the
 * two are read against each other.
 *
 * The credential cards go to `credentialOwner` alone. A key belongs to a
 * PROVIDER and every consumer that selects that provider sends the same one,
 * so a second card on the chat's panel would be two editors over one secret —
 * with two Replace buttons, two Clear buttons and no way to tell which one
 * last wrote it.
 *
 * ## Nothing here shows a secret, because nothing here has one
 *
 * The response has no `value` on the secret arm at all, so there is no value
 * in this component tree to leak. What an operator types is held in the DOM
 * node they typed it into and read once, at submit — see
 * `SecretCredentialCard`.
 */

import {
  Alert,
  AlertTitle,
  Box,
  Divider,
  Stack,
  Typography,
} from '@mui/material';

import { LoadingSpinner } from '../common/LoadingSpinner';
import { ClaudeAuthPanel } from './ClaudeAuthPanel';
import { SecretCredentialCard } from './SecretCredentialCard';
import { SpendCeilingsPanel } from './SpendCeilingsPanel';
import { ModelConsumerPanel } from './ModelConsumerPanel';
import { supportsGuidedSignIn } from '../../config/claudeAuth';
import {
  credentialOwner,
  modelConsumers,
  modelSlotProvider,
  selectedSlot,
  unselectedSlots,
} from '../../config/supervisorModel';
import type {
  ProbeDescriptor,
  ProbeObservation,
} from '../../config/credentialProbes';
import type { CeilingSpendProblem } from '../../hooks/useCeilingSpend';
import type { CostSummary } from '../../types/cockpit';
import type { OperatorProbeName } from '../../types/operatorProbes';
import type {
  OperatorSettingsDocument,
  OperatorSettingsPatch,
  SecretOperatorSetting,
} from '../../types/operatorSettings';
import type { ModelCatalogState } from '../../hooks/useModelCatalogs';
import { catalogStateFor } from '../../hooks/useModelCatalogs';

export interface CredentialsSectionProps {
  document: OperatorSettingsDocument | null;
  isLoading: boolean;
  /** Why the read or the last write failed, if either did. */
  error: string | null;
  isSaving: boolean;
  /** `system_settings:write` — the writes AND the probes. */
  canWrite: boolean;
  /** `operator_settings:write_secret` — the credentials only. */
  canWriteSecret: boolean;
  observations: Partial<Record<OperatorProbeName, ProbeObservation>>;
  runningProbe: OperatorProbeName | null;
  onRunProbe: (descriptor: ProbeDescriptor) => void;
  spend: CostSummary | null;
  spendIsLoading: boolean;
  spendProblem: CeilingSpendProblem | null;
  onSave: (patch: OperatorSettingsPatch) => Promise<void>;
  /**
   * The provider's answer to "what can this key reach?", per consumer (#394,
   * #423).
   *
   * A map rather than one catalogue, keyed by the consumer the API named in
   * its answer: two lists are in flight at once and each belongs to a
   * different question. A consumer with no entry has not been asked yet.
   */
  catalogs: Record<string, ModelCatalogState>;
  /** Ask one consumer's provider again. */
  onRefreshCatalog: (consumer: string) => void;
  /**
   * Re-read the document after a guided sign-in wrote a credential (#386).
   *
   * Separate from `onSave` because nothing was patched from here: the API
   * sealed the token itself at the end of the sign-in, so there is no body to
   * send and nothing to diff — only a document that is now out of date.
   */
  onConnected: () => void;
}

export function CredentialsSection({
  document,
  isLoading,
  error,
  isSaving,
  canWrite,
  canWriteSecret,
  observations,
  runningProbe,
  onRunProbe,
  spend,
  spendIsLoading,
  spendProblem,
  catalogs,
  onRefreshCatalog,
  onSave,
  onConnected,
}: CredentialsSectionProps) {
  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!document) {
    return (
      <Alert severity="error">
        {error ?? 'The operator settings could not be read.'}
      </Alert>
    );
  }

  const secrets = document.settings.filter(
    (entry): entry is SecretOperatorSetting => entry.secret,
  );

  // The model credentials are not listed with the others; they are composed
  // into the panel that also owns the provider and the model. Filtering by
  // GROUP rather than by a list of key names is what keeps this a named
  // exception instead of a lost property: a provider added to the API arrives
  // with its card in the panel, and every other secret the registry publishes
  // still gets a card here with no frontend change.
  const listedSecrets = secrets.filter(
    (entry) => modelSlotProvider(entry.key) === null,
  );
  // The consumers, in the order the registry lists them, and the one that
  // carries the shared credential cards. Both discovered from the response —
  // `apps/web` names no consumer, the same way it names no provider.
  const consumers = modelConsumers(document.settings);
  const owner = credentialOwner(consumers);
  const ownerKey = selectedSlot(document.settings, owner ?? '')?.apiKey ?? null;
  const otherKeys = unselectedSlots(document.settings, owner ?? '').flatMap(
    (slot) => (slot.apiKey === null ? [] : [slot.apiKey]),
  );

  const secretCard = (entry: SecretOperatorSetting) => (
    <SecretCredentialCard
      key={entry.key}
      entry={entry}
      settings={document.settings}
      canWrite={canWrite}
      canWriteSecret={canWriteSecret}
      storageConfigured={document.secretStorage.configured}
      isSaving={isSaving}
      observations={observations}
      runningProbe={runningProbe}
      onRunProbe={onRunProbe}
      onSave={onSave}
      guidedSignIn={
        supportsGuidedSignIn(entry.key) ? (
          <ClaudeAuthPanel
            configured={entry.configured}
            canStart={canWrite && canWriteSecret}
            storageConfigured={document.secretStorage.configured}
            onConnected={onConnected}
          />
        ) : undefined
      }
    />
  );

  return (
    <Box>
      {document.status !== 'loaded' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>
            These values are being served from the environment
          </AlertTitle>
          The stored settings overlay could not be read, so a credential saved
          here is stored and not in force. {document.overlay.problem ?? ''}
        </Alert>
      )}

      {!document.secretStorage.configured && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>Secret storage is not configured</AlertTitle>
          Credentials cannot be stored until{' '}
          <code>OPIFEX_SETTINGS_ENCRYPTION_KEY</code> is set (32 bytes, base64);
          they are read from the environment meanwhile, and a write answers 503
          naming the variable. Losing that key is unrecoverable — the sealed
          credentials cannot be opened again.
          {document.secretStorage.problem
            ? ` ${document.secretStorage.problem}`
            : ''}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        A credential is write-only here: the API returns whether one is
        configured, a masked hint and when it was stored, and never the value —
        the response schema has no field for it. Testing is a separate act from
        saving, because a stored credential and a working one are different
        claims and only one of them can be observed.
      </Typography>

      <Stack component="ul" spacing={2} sx={{ p: 0, m: 0, mb: 4 }}>
        {listedSecrets.map((entry) => secretCard(entry))}
      </Stack>

      {secrets.length === 0 && (
        <Alert severity="info" sx={{ mb: 4 }}>
          This deployment&apos;s API publishes no secret settings, so there is
          nothing to rotate here.
        </Alert>
      )}

      <Divider sx={{ mb: 3 }} />

      {consumers.map((consumer) => {
        const state = catalogStateFor(catalogs, consumer);

        return (
          <ModelConsumerPanel
            key={consumer}
            consumer={consumer}
            document={document}
            canWrite={canWrite}
            isSaving={isSaving}
            catalog={state.catalog}
            catalogIsLoading={state.isLoading}
            catalogError={state.requestError}
            onRefreshCatalog={() => onRefreshCatalog(consumer)}
            onSave={onSave}
            credentials={
              consumer === owner
                ? {
                    // The card, not a second key input. See this file's
                    // header and `ModelConsumerPanel`'s `credentials` prop.
                    keyCard: ownerKey ? (
                      <Stack component="ul" sx={{ p: 0, m: 0 }}>
                        {secretCard(ownerKey)}
                      </Stack>
                    ) : null,
                    // Every other provider's key — shown so that holding one
                    // per vendor is visibly a thing this deployment does, and
                    // so that a key another consumer is using is never
                    // unreachable.
                    otherKeyCards:
                      otherKeys.length > 0 ? (
                        <Stack component="ul" spacing={2} sx={{ p: 0, m: 0 }}>
                          {otherKeys.map((entry) => secretCard(entry))}
                        </Stack>
                      ) : null,
                  }
                : undefined
            }
          />
        );
      })}

      {consumers.length === 0 && (
        <Alert severity="info" sx={{ mb: 4 }}>
          This deployment&apos;s API publishes no{' '}
          <code>&lt;consumer&gt;.model.provider</code> setting, so there is no
          model to choose here.
        </Alert>
      )}

      <Divider sx={{ mb: 3 }} />

      <SpendCeilingsPanel
        document={document}
        canWrite={canWrite}
        isSaving={isSaving}
        spend={spend}
        spendIsLoading={spendIsLoading}
        spendProblem={spendProblem}
        onSave={onSave}
      />
    </Box>
  );
}

export default CredentialsSection;
