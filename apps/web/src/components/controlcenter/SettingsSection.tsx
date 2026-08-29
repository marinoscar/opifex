/**
 * The Configuration section — every operator-managed key, generated from
 * `GET /api/operator-settings` (#348, epic #332).
 *
 * ## Generated, in the strong sense
 *
 * The groups, their order, the rows, the controls, the chips and the bounds
 * all come from the response. There is no list of keys in `apps/web`, and
 * `config/operatorSettings.ts` puts a title-cased heading on a group this
 * build has never seen rather than dropping it. Adding
 * `notifications.somethingNew` to the backend registry therefore puts a
 * labelled, bounded, correctly-chipped control on this screen with no frontend
 * change — which is the acceptance criterion, and the reason a hand-listed
 * field set was not an option: it drifts from the registry the first time
 * somebody adds a key, and nothing fails when it does.
 *
 * ## Four keys are shown here as a signpost rather than as controls
 *
 * `supervisor.model.{provider,apiKey,name,baseUrl}` are configured together on
 * the Credentials tab (#394, epic #391). Rendering a second, free-text editor
 * for the model here would recreate at half scale the exact split that epic
 * exists to remove — an operator setting a key on one tab and being told about
 * a model setting on another. So this section names them, says where they
 * went, and offers a way to get there.
 *
 * That is a NAMED exception to the paragraph above, not a hole in it: the list
 * lives in `config/supervisorModel.ts` with its justification, every other key
 * the registry publishes still renders here with no frontend change, and a key
 * on that list which the response does not carry simply produces no signpost.
 *
 * ## The draft is re-seeded during render, not in an effect
 *
 * A save returns the registry re-resolved, so a new document object means the
 * screen is now showing the API's answer and every draft against the previous
 * one is spent. That reset happens during render, the way `InterfaceSection`
 * does it: React re-renders with the cleared draft before committing, so no
 * control paints a stale value for a frame, and the repo's
 * `react-hooks/set-state-in-effect` lint stays satisfied.
 *
 * A 409 also produces a new document — `useOperatorSettings` refetches before
 * it throws — so a stale-revision save discards the drafts too. That is the
 * intended behaviour and the thrown message says so: the values on screen
 * changed underneath the operator, and re-applying an edit to a value nobody
 * has looked at is how two administrators overwrite each other.
 *
 * ## A `dangerous` key is confirmed here too (#381)
 *
 * The registry's `dangerous` flag used to draw a chip on this screen and gate
 * nothing, while the Credentials section put the same four ceiling keys behind
 * a confirmation that says what moves. That was one flag meaning two different
 * things on two screens, and it took the argument out from under ADR-0018 §6:
 * the ceilings are editable at all because the write is a DELIBERATE ACT, and
 * a field that saves on blur beside `github.maxRetries` is not obviously one.
 *
 * The gate is keyed off the flag the response carries and nothing else, so it
 * costs this section no list of keys and the generic rendering promise above
 * survives intact — a key the backend marks `dangerous` tomorrow is confirmed
 * here with no frontend change, the same way it is rendered with none. The
 * DESCRIPTION is the part that varies: `config/dangerousChanges.ts` reuses the
 * ceiling panel's own raise/lower sentences for the four keys that have them
 * and builds a generic one from `help`, `reload` and the two values for every
 * other key, so a `dangerous` key with no bespoke wording still gets a
 * confirmation that says something rather than an empty dialog.
 *
 * ## `hasChanges` is derived on every render
 *
 * Never stored. The patch is rebuilt from `(response, draft)` each time, which
 * is also what the Save button reads to decide whether it is enabled — so the
 * thing tested (`buildPatch`) is the same thing the button acts on, rather
 * than a boolean that could drift from it.
 */

import { useCallback, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  DialogContentText,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';

import { SettingRow } from './SettingRow';
import { DangerousChangeDialog } from './DangerousChangeDialog';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { groupSettings, observedFor } from '../../config/operatorSettings';
import {
  dangerousChanges,
  type DangerousChange,
} from '../../config/dangerousChanges';
import { ceilingFieldOf } from '../../config/spendCeilings';
import { isModelPanelSetting } from '../../config/supervisorModel';
import {
  buildPatch,
  type DraftFieldValue,
  type SettingsDraft,
} from '../../config/operatorSettingsDraft';
import type { ControlCenterSectionKey } from '../../config/controlCenter';
import type { FleetHealth } from '../../types/health';
import type {
  OperatorSettingsDocument,
  OperatorSettingsPatch,
} from '../../types/operatorSettings';

export interface SettingsSectionProps {
  document: OperatorSettingsDocument | null;
  isLoading: boolean;
  /** Why the read or the last write failed, if either did. */
  error: string | null;
  isSaving: boolean;
  canWrite: boolean;
  /** The fleet, for the observed counterparts. Null when it could not be read. */
  fleet: FleetHealth | null;
  /** Sends exactly the keys given. Rejects to the caller's handler. */
  onSave: (changes: OperatorSettingsPatch) => Promise<void>;
  /** Takes the operator to the tab that owns the promoted keys (#394). */
  onNavigateToSection: (key: ControlCenterSectionKey) => void;
}

export function SettingsSection({
  document,
  isLoading,
  error,
  isSaving,
  canWrite,
  fleet,
  onSave,
  onNavigateToSection,
}: SettingsSectionProps) {
  const [draft, setDraft] = useState<SettingsDraft>({});
  /** The dangerous rows awaiting confirmation. Null means nothing is asked. */
  const [confirming, setConfirming] = useState<DangerousChange[] | null>(null);

  // Re-seed on a fresh document — a save landing, or a 409's refetch. During
  // render, not in an effect; see this file's header. The pending confirmation
  // goes with the draft it was describing: a dialog left open across a 409
  // would be asking about values nobody is looking at any more.
  const [seededFrom, setSeededFrom] = useState(document);
  if (document !== seededFrom) {
    setSeededFrom(document);
    setDraft({});
    setConfirming(null);
  }

  const change = useCallback((key: string, value: DraftFieldValue) => {
    setDraft((previous) => ({ ...previous, [key]: { kind: 'edit', value } }));
  }, []);

  const revert = useCallback((key: string) => {
    setDraft((previous) => ({ ...previous, [key]: { kind: 'revert' } }));
  }, []);

  const discard = useCallback((key: string) => {
    setDraft((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);

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

  const { changes, problems } = buildPatch(document.settings, draft);
  const changedKeys = Object.keys(changes);
  const problemKeys = Object.keys(problems);
  // The promoted keys are removed from the generated rows and accounted for by
  // a signpost in whichever group they came from. `groupSettings` still sees
  // the whole document, so a group that consists ONLY of promoted keys still
  // gets its heading and its signpost rather than vanishing.
  const groups = groupSettings(document.settings);

  // Every `dangerous` key this draft would send, described. Derived on each
  // render from (response, draft), like the patch itself, so the dialog can
  // never be asking about a different set of keys than the one that travels.
  const dangerous = dangerousChanges(document.settings, draft);

  const send = () => {
    // The patch, and nothing else. `buildPatch` iterates the response and
    // keeps only rows that actually differ — see its header for why sending
    // an untouched key would be a correctness bug rather than waste.
    setConfirming(null);
    void onSave(changes);
  };

  const save = () => {
    // Nothing is sent until a dangerous change is confirmed. The flag comes
    // off the response; this section knows no keys.
    if (dangerous.length > 0) {
      setConfirming(dangerous);
      return;
    }
    send();
  };

  return (
    <Box>
      {document.status !== 'loaded' && <OverlayBanner document={document} />}

      {!document.secretStorage.configured && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>Secret storage is not configured</AlertTitle>
          Credentials cannot be stored here until
          <code> OPIFEX_SETTINGS_ENCRYPTION_KEY</code> is set; they are read
          from the environment meanwhile.
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

      {!canWrite && (
        <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
          Changing these needs <code>system_settings:write</code>, which this
          account does not hold. Everything below is read-only.
        </Alert>
      )}

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{
          mb: 2,
          alignItems: { sm: 'center' },
          flexWrap: 'wrap',
          rowGap: 1,
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {document.settings.length} managed keys,{' '}
          {document.overlay.overriddenKeys} overridden here. Document revision{' '}
          {document.revision ?? '—'}.
        </Typography>
      </Stack>

      {groups.map((group) => (
        <Box key={group.group} sx={{ mb: 4 }}>
          <Typography variant="h6" component="h3" gutterBottom>
            {group.label}
          </Typography>
          <Divider sx={{ mb: 2 }} />
          {group.entries.some(isModelPanelSetting) && (
            <PromotedKeysSignpost
              keys={group.entries
                .filter(isModelPanelSetting)
                .map((entry) => entry.key)}
              onNavigateToSection={onNavigateToSection}
            />
          )}
          <Stack component="ul" spacing={2} sx={{ p: 0, m: 0 }}>
            {group.entries
              .filter((entry) => !isModelPanelSetting(entry))
              .map((entry) => (
                <SettingRow
                  key={entry.key}
                  entry={entry}
                  draft={draft[entry.key]}
                  observed={observedFor(entry, fleet)}
                  canWrite={canWrite}
                  disabled={isSaving}
                  problem={problems[entry.key]}
                  onChange={change}
                  onRevert={revert}
                  onDiscard={discard}
                />
              ))}
          </Stack>
        </Box>
      ))}

      <Paper
        variant="outlined"
        sx={{
          p: 2,
          position: 'sticky',
          bottom: 0,
          bgcolor: 'background.paper',
          zIndex: 1,
        }}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
        >
          <Box>
            <Typography variant="body2">
              {changedKeys.length === 0
                ? 'No changes to send.'
                : `${changedKeys.length} key${changedKeys.length === 1 ? '' : 's'} will be sent. Nothing else is included.`}
            </Typography>
            <Stack
              direction="row"
              spacing={0.5}
              sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.5 }}
            >
              {changedKeys.map((key) => (
                <Chip key={key} size="small" label={key} />
              ))}
            </Stack>
            {problemKeys.length > 0 && (
              <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                {problemKeys.length} value
                {problemKeys.length === 1 ? '' : 's'} cannot be sent as written:{' '}
                {problemKeys.join(', ')}.
              </Typography>
            )}
          </Box>
          <Button
            variant="contained"
            onClick={save}
            disabled={
              !canWrite ||
              isSaving ||
              changedKeys.length === 0 ||
              problemKeys.length > 0
            }
          >
            Save changes
          </Button>
        </Stack>
      </Paper>

      <DangerousChangeDialog
        open={confirming !== null}
        title={
          (confirming?.length ?? 0) === 1
            ? `Change ${confirming?.[0].label}?`
            : `Change ${confirming?.length ?? 0} settings marked dangerous?`
        }
        changes={confirming ?? []}
        confirmLabel="Save these changes"
        disabled={isSaving}
        onCancel={() => setConfirming(null)}
        onConfirm={send}
      >
        {changedKeys.length > (confirming?.length ?? 0) && (
          <DialogContentText variant="body2">
            {changedKeys.length - (confirming?.length ?? 0)} other key
            {changedKeys.length - (confirming?.length ?? 0) === 1
              ? ' is'
              : 's are'}{' '}
            sent in the same write:{' '}
            {changedKeys
              .filter((key) => !(confirming ?? []).some((c) => c.key === key))
              .join(', ')}
            .
          </DialogContentText>
        )}
        {(confirming ?? []).some((change) => ceilingFieldOf(change.key)) && (
          <DialogContentText variant="body2">
            What has been spent against a ceiling&apos;s window is not read on
            this screen. The Credentials tab&apos;s Spend ceilings panel shows
            it from <code>GET /api/cost/summary</code>, beside these same
            figures.
          </DialogContentText>
        )}
      </DangerousChangeDialog>
    </Box>
  );
}

/**
 * The overlay banner: what is on screen is not what is stored.
 *
 * A first-class state rather than an error toast, because it is not a failed
 * action — the read succeeded and told the truth. The database overlay could
 * not be loaded, so `.env` is what the API is actually running on, and a save
 * from this screen will not be in force even if it is stored. `stale`
 * distinguishes "loaded once and possibly out of date" from "never loaded at
 * all", which are different amounts of bad news.
 */
function OverlayBanner({ document }: { document: OperatorSettingsDocument }) {
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      <AlertTitle>
        These values are being served from the environment
      </AlertTitle>
      The stored settings overlay could not be read, so what the API is running
      on right now is <code>.env</code> and the code&apos;s defaults. Changes
      saved here are not in force until the overlay loads again.
      {document.overlay.stale
        ? ' The overlay did load earlier, so some of these values may be stale rather than absent.'
        : ' The overlay has not loaded in this process, so no stored override is being applied at all.'}
      {document.overlay.problem ? ` ${document.overlay.problem}` : ''}
      <Typography variant="caption" component="p" sx={{ mt: 1 }}>
        {document.overlay.loadedAt
          ? `Last loaded ${new Date(document.overlay.loadedAt).toLocaleString()}.`
          : 'Never loaded in this process.'}{' '}
        {document.overlay.attemptedAt
          ? `Last attempted ${new Date(document.overlay.attemptedAt).toLocaleString()}.`
          : 'No load has been attempted yet.'}
      </Typography>
    </Alert>
  );
}

/**
 * Where these keys went, and why they are not editable here.
 *
 * Named rather than hidden. An operator who came looking for
 * `supervisor.model.name` — the setting the Test button on the other tab used
 * to name at them — finds the string they were looking for, in the group they
 * expected it in, with a way to get to it. Silently omitting the rows would
 * make this section quietly incomplete, which is worse than a duplicate
 * editor, not better.
 *
 * Since #422 the set is not four fixed keys but "everything in the model
 * credentials group, plus the provider and the model name", so a provider
 * added to the API lands on the Credentials tab with the rest of them rather
 * than appearing here as a second, worse editor for a base URL that decides
 * where a credential is sent.
 */
function PromotedKeysSignpost({
  keys,
  onNavigateToSection,
}: {
  keys: readonly string[];
  onNavigateToSection: (key: ControlCenterSectionKey) => void;
}) {
  return (
    <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
      <AlertTitle>Configured on the Credentials tab</AlertTitle>
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ flexWrap: 'wrap', rowGap: 0.5, mb: 1 }}
      >
        {keys.map((key) => (
          <Chip key={key} size="small" label={key} />
        ))}
      </Stack>
      Choosing a model means asking the provider what the key can reach, so
      these are one control there rather than a free-text box here. That split —
      the key on one tab, the model name on another — is what sent an operator
      looking for a setting the Test button had just named at them. Each
      provider&apos;s key and endpoint are held separately and are all on that
      one screen, so selecting a provider neither asks for a credential again
      nor discards the one you had.
      <Box sx={{ mt: 1 }}>
        <Button size="small" onClick={() => onNavigateToSection('credentials')}>
          Go to Credentials
        </Button>
      </Box>
    </Alert>
  );
}

export default SettingsSection;
