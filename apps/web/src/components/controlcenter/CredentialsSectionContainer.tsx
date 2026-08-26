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
import type { ProbeDescriptor } from '../../config/credentialProbes';
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
  const { document, isLoading, error, isSaving, save } = useOperatorSettings();
  const probes = useCredentialProbes();
  const spend = useCeilingSpend();

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

      onSaved(
        `Saved ${keys.join(', ')}. ` +
          (needRestart.length > 0
            ? `${needRestart.join(', ')} is stored but needs an API restart before it is in force.`
            : 'The values shown are the API re-resolved after the write.'),
      );
    },
    [document, save, spend, onSaved],
  );

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
      onSave={handleSave}
    />
  );
}

export default CredentialsSectionContainer;
