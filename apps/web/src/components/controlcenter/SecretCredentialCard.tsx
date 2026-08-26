/**
 * One credential: what is configured, how it is replaced, and what replacing
 * it does not do (#349, epic #332).
 *
 * ## Write-only, in the strong sense
 *
 * The API's secret arm has no `value` member at all, so there is nothing to
 * seed a field with and nothing to reveal. This card renders `configured`, the
 * masked `hint`, where the value came from and when it was stored — the four
 * facts the response actually carries.
 *
 * The field the operator types into is UNCONTROLLED. That is the load-bearing
 * decision on this screen and it is not a style preference: a controlled input
 * puts the credential in React state, where it is reachable by anything that
 * spreads props, serialises a component tree, snapshots for a devtools
 * extension, or attaches state to an error report. Here it exists in one DOM
 * node, is read once by a callback when the request body is built, and the
 * node is discarded on save. The only thing this component holds about it is
 * whether it is empty, which is what the Save button needs and is not a
 * credential.
 *
 * ## Saving is not revoking
 *
 * `config/secretRotation.ts` carries the sentence and the reasons. The alert
 * appears AFTER a successful save, because that is the moment an operator
 * concludes the old credential is dead — and for a leaked token, that
 * conclusion being wrong is the whole incident.
 */

import { useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import { ProbeResultPanel } from './ProbeResultPanel';
import {
  probeFreshness,
  probesForSetting,
  type ProbeDescriptor,
  type ProbeObservation,
} from '../../config/credentialProbes';
import {
  provenanceOf,
  reloadPresentation,
} from '../../config/operatorSettings';
import {
  buildSecretWrite,
  rotationNotice,
  type SecretIntent,
} from '../../config/secretRotation';
import type { OperatorProbeName } from '../../types/operatorProbes';
import type {
  OperatorSetting,
  OperatorSettingsPatch,
  SecretOperatorSetting,
} from '../../types/operatorSettings';

export interface SecretCredentialCardProps {
  entry: SecretOperatorSetting;
  /** The whole document's settings — the probe witnesses are taken from it. */
  settings: readonly OperatorSetting[];
  /** `system_settings:write`. Gates the probes as well as the writes. */
  canWrite: boolean;
  /** `operator_settings:write_secret`, which the API additionally requires. */
  canWriteSecret: boolean;
  /** False when no encryption key is configured, so nothing can be stored. */
  storageConfigured: boolean;
  /** A save is in flight anywhere in the section. */
  isSaving: boolean;
  observations: Partial<Record<OperatorProbeName, ProbeObservation>>;
  runningProbe: OperatorProbeName | null;
  onRunProbe: (descriptor: ProbeDescriptor) => void;
  /** Sends the one-key patch. Rejects with the API's own refusal. */
  onSave: (patch: OperatorSettingsPatch) => Promise<void>;
  /**
   * A way of obtaining this credential other than typing it in — today, the
   * Claude sign-in (#386).
   *
   * A slot rather than a flag, and it renders ABOVE the Replace field without
   * disabling it. Which secrets have one is not derivable from the API's
   * response — it is a fact about what this app can drive — so the decision
   * is made once in `CredentialsSection` from `config/claudeAuth.ts`, and
   * this card stays a renderer of whatever the registry publishes.
   */
  guidedSignIn?: ReactNode;
}

export function SecretCredentialCard({
  entry,
  settings,
  canWrite,
  canWriteSecret,
  storageConfigured,
  isSaving,
  observations,
  runningProbe,
  onRunProbe,
  onSave,
  guidedSignIn,
}: SecretCredentialCardProps) {
  const [intent, setIntent] = useState<SecretIntent | null>(null);
  // Whether the field is empty — NOT what is in it. See the header.
  const [hasTyped, setHasTyped] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const notice = rotationNotice(entry.key);
  const provenance = provenanceOf(entry);
  const reload = reloadPresentation(entry.reload);
  const mayWrite = canWrite && canWriteSecret && storageConfigured && !isSaving;
  // A revert only means something when there is a stored row to delete.
  const mayClear = mayWrite && entry.source === 'database';

  // An unsaved replacement makes any probe result about the STORED value
  // rather than about what is on screen. Opening the field is not yet a
  // change; typing into it is.
  const pendingKeys = hasTyped || intent?.kind === 'clear' ? [entry.key] : [];

  const close = () => {
    setIntent(null);
    setHasTyped(false);
    setProblem(null);
  };

  const submit = async () => {
    if (!intent) return;

    // The value is read here and nowhere else: the callback runs inside
    // `buildSecretWrite`, the string it returns goes into the body, and this
    // component never binds it to a name of its own.
    const built = buildSecretWrite(
      entry,
      intent,
      () => inputRef.current?.value ?? '',
    );

    if (!built.ok) {
      setProblem(built.problem);
      return;
    }

    setProblem(null);

    try {
      await onSave(built.patch);
      // Clear the node before anything else can read it. The section re-renders
      // from the API's re-resolved document, so the field is unmounted anyway;
      // this makes the wipe explicit rather than incidental.
      if (inputRef.current) inputRef.current.value = '';
      setSavedAt(new Date().toLocaleTimeString());
      close();
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'The API refused the write.',
      );
    }
  };

  return (
    <Paper
      component="li"
      variant="outlined"
      aria-label={entry.key}
      sx={{ p: { xs: 2, sm: 3 }, listStyle: 'none' }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ justifyContent: 'space-between', alignItems: { sm: 'start' } }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="h4">
            {entry.label}
          </Typography>
          <Typography
            variant="caption"
            component="p"
            color="text.secondary"
            sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
          >
            {entry.key} · {entry.envVar}
          </Typography>
        </Box>
        <Stack
          direction="row"
          spacing={1}
          sx={{ flexWrap: 'wrap', rowGap: 1, justifyContent: 'flex-end' }}
        >
          <Chip size="small" color="secondary" label="secret" />
          <Tooltip title={reload.help}>
            <Chip
              size="small"
              color={reload.color}
              variant="outlined"
              label={reload.label}
            />
          </Tooltip>
          <Tooltip title={provenance.detail}>
            <Chip
              size="small"
              variant={entry.source === 'database' ? 'filled' : 'outlined'}
              label={provenance.label}
            />
          </Tooltip>
        </Stack>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        {entry.help}
      </Typography>

      {entry.error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          <AlertTitle>This stored credential cannot be read</AlertTitle>
          {entry.error.message} ({entry.error.reason}) It does NOT fall back to{' '}
          {entry.envVar}: falling back would put the credential you rotated away
          from back to work.
        </Alert>
      )}

      <Box
        sx={{ mt: 2, p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}
        aria-label={`${entry.key} status`}
      >
        <Typography variant="overline" component="p" color="text.secondary">
          Configured
        </Typography>
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {entry.configured
            ? (entry.hint ?? 'configured (no hint available)')
            : 'not configured'}
        </Typography>
        <Typography variant="caption" component="p" color="text.secondary">
          {provenance.detail}
          {entry.updatedAt
            ? ` Stored ${new Date(entry.updatedAt).toLocaleString()}.`
            : ''}
        </Typography>
        <Typography variant="caption" component="p" color="text.secondary">
          The API never returns this value, so it cannot be shown here — only
          replaced.
        </Typography>
      </Box>

      {!storageConfigured && (
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          Credentials cannot be stored until{' '}
          <code>OPIFEX_SETTINGS_ENCRYPTION_KEY</code> is set. Until then this
          key is read from {entry.envVar} and a write here would answer 503.
        </Alert>
      )}

      {canWrite && !canWriteSecret && (
        <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
          Replacing a credential needs{' '}
          <code>operator_settings:write_secret</code> on top of{' '}
          <code>system_settings:write</code>, and this account does not hold it.
          That separation is deliberate: tuning a timeout should not also carry
          the authority to replace what the factory acts with.
        </Alert>
      )}

      {guidedSignIn}

      {intent === null ? (
        <Stack
          direction="row"
          spacing={1}
          sx={{ mt: 2, flexWrap: 'wrap', rowGap: 1 }}
        >
          <Button
            variant="outlined"
            size="small"
            onClick={() => {
              setSavedAt(null);
              setIntent({ kind: 'replace' });
            }}
            disabled={!mayWrite}
          >
            {entry.configured ? 'Replace' : 'Set a value'}
          </Button>
          <Button
            size="small"
            onClick={() => {
              setSavedAt(null);
              setIntent({ kind: 'clear' });
            }}
            disabled={!mayClear}
          >
            Clear (revert to environment)
          </Button>
          {!mayClear && entry.source !== 'database' && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ alignSelf: 'center' }}
            >
              Nothing is stored here to clear.
            </Typography>
          )}
        </Stack>
      ) : intent.kind === 'replace' ? (
        <Box sx={{ mt: 2 }}>
          <TextField
            // Uncontrolled on purpose — see this file's header. There is no
            // `value` prop, so nothing about what is typed reaches state.
            inputRef={inputRef}
            type="password"
            autoComplete="off"
            label={`New value for ${entry.label}`}
            size="small"
            fullWidth
            error={problem !== null}
            helperText={
              problem ??
              'Paste the new credential. It is sent once and never returned ' +
                'to this screen again.'
            }
            onChange={(event) => setHasTyped(event.target.value !== '')}
            slotProps={{
              htmlInput: {
                autoCapitalize: 'off',
                autoCorrect: 'off',
                spellCheck: false,
                'data-1p-ignore': 'true',
              },
            }}
          />
          <Typography
            variant="caption"
            component="p"
            color="text.secondary"
            sx={{ mt: 1 }}
          >
            {notice.caution}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button
              variant="contained"
              size="small"
              onClick={() => void submit()}
              disabled={!mayWrite || !hasTyped}
            >
              Save credential
            </Button>
            <Button size="small" onClick={close} disabled={isSaving}>
              Cancel
            </Button>
          </Stack>
        </Box>
      ) : (
        <Alert severity="warning" sx={{ mt: 2 }}>
          <AlertTitle>Clear this credential?</AlertTitle>
          The stored row is deleted and this key falls back to {entry.envVar}.
          If that variable is not set either, the credential becomes
          unconfigured and everything that needs it stops working. This does not
          revoke anything at the service that issued it.
          {problem && (
            <Typography variant="body2" color="error" sx={{ mt: 1 }}>
              {problem}
            </Typography>
          )}
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button
              variant="contained"
              color="warning"
              size="small"
              onClick={() => void submit()}
              disabled={!mayClear}
            >
              Clear it
            </Button>
            <Button size="small" onClick={close} disabled={isSaving}>
              Keep it
            </Button>
          </Stack>
        </Alert>
      )}

      {savedAt && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          <AlertTitle>{notice.title}</AlertTitle>
          {notice.body}
          <Typography variant="caption" component="p" sx={{ mt: 1 }}>
            Saved at {savedAt}. What is shown above is the API re-resolved after
            the write.
          </Typography>
        </Alert>
      )}

      {probesForSetting(entry.key).map((descriptor) => {
        const observation = observations[descriptor.name];
        return (
          <ProbeResultPanel
            key={descriptor.name}
            descriptor={descriptor}
            observation={observation}
            freshness={
              observation
                ? probeFreshness(observation, settings, pendingKeys)
                : null
            }
            isRunning={runningProbe === descriptor.name}
            canRun={canWrite && runningProbe === null}
            onRun={() => onRunProbe(descriptor)}
          />
        );
      })}
    </Paper>
  );
}

export default SecretCredentialCard;
