/**
 * The Configuration section's data, kept out of the shell (#348, epic #332).
 *
 * ## Why the hook lives here and not in `ControlCenterPage`
 *
 * The page resolves what every section shares — the permission, the system
 * settings document, the readiness read. `GET /api/operator-settings` is not
 * shared: only this section reads it. Calling the hook here means an operator
 * who opens the Control Center on Readiness and never leaves it makes no
 * request for it, which is the same reasoning that splits the permission gate
 * from the page body.
 *
 * ## What it says after a save
 *
 * The count of keys that were sent, and — separately — the names of any whose
 * `reload` is `restart`, because those are stored and NOT in force. Saying
 * "Saved" alone would be the screen implying a change took effect that
 * demonstrably has not, which is the thing epic #332's second rule is about.
 * The list is read off the response, never assumed from the key's name.
 */

import { useCallback } from 'react';

import { SettingsSection } from './SettingsSection';
import { useOperatorSettings } from '../../hooks/useOperatorSettings';
import type { FleetHealth } from '../../types/health';
import type { OperatorSettingsPatch } from '../../types/operatorSettings';

export interface SettingsSectionContainerProps {
  canWrite: boolean;
  fleet: FleetHealth | null;
  onSaved: (message: string) => void;
  onSaveError: (message: string) => void;
}

export function SettingsSectionContainer({
  canWrite,
  fleet,
  onSaved,
  onSaveError,
}: SettingsSectionContainerProps) {
  const { document, isLoading, error, isSaving, save } = useOperatorSettings();

  const handleSave = useCallback(
    async (changes: OperatorSettingsPatch) => {
      const keys = Object.keys(changes);
      const needRestart = (document?.settings ?? [])
        .filter(
          (entry) => keys.includes(entry.key) && entry.reload === 'restart',
        )
        .map((entry) => entry.key);

      try {
        await save(changes);
        onSaved(
          `Saved ${keys.length} key${keys.length === 1 ? '' : 's'}. ` +
            (needRestart.length > 0
              ? `${needRestart.join(', ')} is stored but needs an API restart before it is in force.`
              : 'The values below are the API re-resolved after the write.'),
        );
      } catch (err) {
        onSaveError(err instanceof Error ? err.message : 'Failed to save');
      }
    },
    [document, save, onSaved, onSaveError],
  );

  return (
    <SettingsSection
      document={document}
      isLoading={isLoading}
      error={error}
      isSaving={isSaving}
      canWrite={canWrite}
      fleet={fleet}
      onSave={handleSave}
    />
  );
}

export default SettingsSectionContainer;
