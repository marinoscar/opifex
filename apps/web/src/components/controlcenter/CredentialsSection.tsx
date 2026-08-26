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
import { supportsGuidedSignIn } from '../../config/claudeAuth';
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
        {secrets.map((entry) => (
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
        ))}
      </Stack>

      {secrets.length === 0 && (
        <Alert severity="info" sx={{ mb: 4 }}>
          This deployment&apos;s API publishes no secret settings, so there is
          nothing to rotate here.
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
