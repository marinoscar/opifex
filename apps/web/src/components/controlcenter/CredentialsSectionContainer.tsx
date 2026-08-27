/**
 * The Credentials section's data (#349, epic #332).
 *
 * Kept out of the shell for the reason `SettingsSectionContainer` records: an
 * operator who opens the Control Center on Readiness and never leaves it makes
 * no request for any of this. Two reads happen here — the operator settings
 * and the cost read model — and the second is the one a `system_settings:read`
 * account may not be allowed to make at all, which is reported rather than
 * rendered as zero spend.
 *
 * ## The model catalogue is re-asked where it is known to have moved
 *
 * `useSupervisorModels` reads on mount and then only when asked. The two
 * moments its answer is known to have changed are a provider write and a key
 * write, and both arrive here as a patch — so the refresh is triggered from
 * the patch's keys, in one place, rather than from each control that might
 * cause one. That is also why saving the key re-lists: a new credential
 * reaches a different set of models, and leaving the previous list on screen
 * would make the dropdown a claim about a key that is no longer configured.
 *
 * ## What it says after a save
 *
 * Which key was written, and — separately — that the write is stored and
 * whether it is in force. `reload` is read off the response rather than
 * assumed from the key, the same way the Configuration section does it: a
 * credential whose consumer re-reads it per use is live, and one that is
 * frozen in a constructor is not, and only the API knows which.
 */

import { useCallback } from 'react';

import { CredentialsSection } from './CredentialsSection';
import { useCeilingSpend } from '../../hooks/useCeilingSpend';
import { useCredentialProbes } from '../../hooks/useCredentialProbes';
import { useOperatorSettings } from '../../hooks/useOperatorSettings';
import { useSupervisorModels } from '../../hooks/useSupervisorModels';
import type { ProbeDescriptor } from '../../config/credentialProbes';
import { SUPERVISOR_MODEL_KEYS } from '../../config/supervisorModel';
import type { OperatorSettingsPatch } from '../../types/operatorSettings';

export interface CredentialsSectionContainerProps {
  /** `system_settings:write`. */
  canWrite: boolean;
  /** `operator_settings:write_secret`. */
  canWriteSecret: boolean;
  onSaved: (message: string) => void;
}

export function CredentialsSectionContainer({
  canWrite,
  canWriteSecret,
  onSaved,
}: CredentialsSectionContainerProps) {
  const { document, isLoading, error, isSaving, save, refresh } =
    useOperatorSettings();
  const probes = useCredentialProbes();
  const spend = useCeilingSpend();
  const models = useSupervisorModels();

  const handleSave = useCallback(
    async (patch: OperatorSettingsPatch) => {
      const keys = Object.keys(patch);
      const needRestart = (document?.settings ?? [])
        .filter(
          (entry) => keys.includes(entry.key) && entry.reload === 'restart',
        )
        .map((entry) => entry.key);

      // Rejects to the card, which shows the API's own refusal next to the
      // field that caused it. The page's error snackbar is for reads.
      await save(patch);

      // A ceiling change moves what the cost read model reports as in force,
      // so the observed half is re-read rather than left showing the previous
      // ceiling beside the new configured one.
      void spend.refresh();

      // A provider or a key change moves what the catalogue answers. The
      // previous list is dropped inside the hook before the new one is asked
      // for, so nothing offers the old provider's models in the meantime.
      if (keys.some((key) => SUPERVISOR_MODEL_KEYS.includes(key))) {
        void models.refresh();
      }

      onSaved(
        `Saved ${keys.join(', ')}. ` +
          (needRestart.length > 0
            ? `${needRestart.join(', ')} is stored but needs an API restart before it is in force.`
            : 'The values shown are the API re-resolved after the write.'),
      );
    },
    [document, save, spend, models, onSaved],
  );

  // Nothing was patched from here: the guided sign-in seals the token
  // server-side, so the only thing this side owes is a re-read. The document
  // is re-fetched rather than edited in place for the same reason a save
  // takes the API's re-resolved response — what the key now resolves to is
  // the API's answer to compute.
  const handleConnected = useCallback(() => {
    void refresh();
    onSaved(
      'Claude subscription connected. The token was sealed by the API and ' +
        'never reached this browser; the card below is the API re-read.',
    );
  }, [refresh, onSaved]);

  const refreshCatalog = useCallback(() => {
    void models.refresh();
  }, [models]);

  const runProbe = useCallback(
    (descriptor: ProbeDescriptor) => {
      void probes.run(descriptor, document?.settings ?? []);
    },
    [probes, document],
  );

  return (
    <CredentialsSection
      document={document}
      isLoading={isLoading}
      error={error}
      isSaving={isSaving}
      canWrite={canWrite}
      canWriteSecret={canWriteSecret}
      observations={probes.observations}
      runningProbe={probes.runningProbe}
      onRunProbe={runProbe}
      spend={spend.summary}
      spendIsLoading={spend.isLoading}
      spendProblem={spend.problem}
      catalog={models.catalog}
      catalogIsLoading={models.isLoading}
      catalogError={models.requestError}
      onRefreshCatalog={refreshCatalog}
      onSave={handleSave}
      onConnected={handleConnected}
    />
  );
}

export default CredentialsSectionContainer;
