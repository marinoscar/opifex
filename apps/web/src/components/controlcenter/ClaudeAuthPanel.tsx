/**
 * Connect a Claude subscription without a shell (#386, epic #332).
 *
 * ## What this replaces
 *
 * Getting a shell on the host, `docker compose exec` into the API container
 * for a TTY (`claude setup-token` refuses to run without one), copying the
 * token out by hand, pasting it into `infra/compose/.env`, and recreating the
 * container. It was the first thing an operator had to do and the least like
 * anything else in the product — the step where people gave up.
 *
 * ## Alongside the manual paste, never instead of it
 *
 * This panel sits ABOVE the card's own Replace field and does not disable it.
 * An operator who already holds a token — from an earlier deployment, from a
 * password manager, from a colleague — must still be able to paste it, and a
 * guided flow that took that away would be a regression dressed as an
 * improvement. It is also the fallback when the two deployment faults
 * (`cli_missing`, `pty_unavailable`) make this flow impossible at all.
 *
 * ## The URL is the load-bearing element
 *
 * It is offered twice, deliberately. An operator on a headless server copies
 * it to their laptop; one at a desktop clicks it. Neither is the "real" case,
 * so neither is made the awkward one: the whole URL is on screen, selectable,
 * with a Copy button beside it and an open-in-new-tab link under it.
 *
 * ## What is said before anything happens
 *
 * That this sends them to claude.com, and that the resulting token spends
 * THEIR subscription quota on automated runs — VISION §11's point that
 * dispatched work competes with the operator's own interactive use. That is
 * a consequence worth one clear sentence up front rather than a discovery
 * three weeks later when their own session hits a limit.
 *
 * ## Two waits that must not look like a hung page
 *
 * `start` blocks until the CLI prints its URL (a few seconds, forty-five at
 * the ceiling) and `/code` blocks until the vendor exchange settles (up to
 * ninety). Each has its own progress bar and its own sentence saying what is
 * being waited on and roughly how long it can take, because "up to ninety
 * seconds of nothing" is otherwise indistinguishable from broken.
 *
 * ## Nothing here can render a token
 *
 * There is no token in this component tree to render. The API seals it
 * server-side and answers `configured: true`; this panel reads `status`,
 * `url`, `expiresAt`, `configured` and `error` by name and never serialises
 * the session. `ClaudeAuthPanel.test.tsx` proves it by answering with a
 * response that carries a token the real API never sends and scanning every
 * node, attribute and input value for it.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

import { useClaudeAuth } from '../../hooks/useClaudeAuth';
import {
  claudeAuthExpiry,
  claudeAuthFailurePresentation,
} from '../../config/claudeAuth';
import { isTerminalClaudeAuthStatus } from '../../types/claudeAuth';

export interface ClaudeAuthPanelProps {
  /** Whether the credential already resolves to something. Wording only. */
  configured: boolean;
  /**
   * `system_settings:write` + `operator_settings:write_secret`. The API gates
   * these four routes exactly as it gates a secret write, and additionally
   * requires an interactive session — so this is presentation of a rule the
   * API enforces, not the rule itself.
   */
  canStart: boolean;
  /** False when no encryption key is configured — the token would have nowhere to go. */
  storageConfigured: boolean;
  /** Re-read the settings document, so the card shows the new credential. */
  onConnected: () => void;
}

/** How often the countdown moves while a sign-in is waiting for a code. */
const TICK_MS = 1000;

export function ClaudeAuthPanel({
  configured,
  canStart,
  storageConfigured,
  onConnected,
}: ClaudeAuthPanelProps) {
  const { session, busy, problem, start, submitCode, cancel, reset } =
    useClaudeAuth();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  /**
   * The URL the clipboard last accepted, or `'refused'`.
   *
   * The URL rather than a boolean, so "Copied" is derived at render by
   * comparing it with the URL on screen: a new sign-in has a new URL and the
   * confirmation stops applying by itself, with no effect to reset it.
   */
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [copyRefused, setCopyRefused] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const status = session?.status ?? null;
  const isAwaiting = status === 'awaiting_code';

  // A clock sample, not derived state: everything about the deadline is
  // recomputed from it at render. Only ticks while there is a countdown on
  // screen, so a closed dialog costs nothing.
  useEffect(() => {
    if (!open || !isAwaiting) return;

    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [open, isAwaiting]);

  const expiry = session ? claudeAuthExpiry(session.expiresAt, now) : null;
  const failure =
    session?.error != null
      ? claudeAuthFailurePresentation(session.error.reason)
      : null;
  const isBusy = busy !== null;
  const mayStart = canStart && storageConfigured && !isBusy;

  const openDialog = () => {
    setCode('');
    setCopiedUrl(null);
    setCopyRefused(false);
    reset();
    setOpen(true);
  };

  const closeDialog = async () => {
    if (status === 'completed') onConnected();

    // A live session is DELETEd rather than dropped. Walking away from it
    // leaves a `claude` process holding a pseudo-terminal for the full ten
    // minutes, and the next sign-in is refused until it dies.
    if (session !== null && !isTerminalClaudeAuthStatus(session.status)) {
      await cancel();
    } else {
      reset();
    }

    setCode('');
    setOpen(false);
  };

  const copyUrl = (url: string) => {
    const clipboard = navigator.clipboard;

    if (!clipboard) {
      // Reported rather than silently doing nothing. The URL is the one thing
      // this screen exists to hand over, and a Copy button that quietly failed
      // would leave the operator waiting for a paste that never comes.
      setCopyRefused(true);
      return;
    }

    void clipboard.writeText(url).then(
      () => {
        setCopiedUrl(url);
        setCopyRefused(false);
      },
      () => setCopyRefused(true),
    );
  };

  return (
    <Box
      sx={{
        mt: 2,
        p: { xs: 1.5, sm: 2 },
        borderRadius: 1,
        bgcolor: 'action.hover',
      }}
      aria-label="Connect a Claude account"
    >
      <Typography variant="subtitle2" component="h5">
        Connect with your Claude account
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        Instead of running <code>claude setup-token</code> in a shell inside the
        API container and copying the result into <code>.env</code>, this runs
        it for you and seals the token it produces straight into this
        credential. You never see the token and neither does this browser.
      </Typography>

      <Button
        variant="contained"
        size="small"
        sx={{ mt: 1.5 }}
        onClick={openDialog}
        disabled={!mayStart}
      >
        {configured ? 'Connect again' : 'Connect'}
      </Button>

      <Typography
        variant="caption"
        component="p"
        color="text.secondary"
        sx={{ mt: 1 }}
      >
        Already hold a token? This does not replace the manual route — paste it
        with Replace below and skip all of this.
      </Typography>

      {!storageConfigured && (
        <Typography
          variant="caption"
          component="p"
          color="text.secondary"
          sx={{ mt: 1 }}
        >
          Unavailable until <code>OPIFEX_SETTINGS_ENCRYPTION_KEY</code> is set:
          the sign-in would succeed and then have nowhere to seal the token, so
          it is refused before it spends anyone&apos;s time.
        </Typography>
      )}

      <Dialog
        open={open}
        onClose={() => void closeDialog()}
        fullWidth
        maxWidth="sm"
        aria-labelledby="claude-auth-dialog-title"
      >
        <DialogTitle id="claude-auth-dialog-title">
          Connect a Claude account
        </DialogTitle>
        <DialogContent dividers>
          {problem !== null && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {problem}
            </Alert>
          )}

          {session === null && busy !== 'starting' && (
            <Box>
              <Typography variant="body2" gutterBottom>
                Before you start, here is what is about to happen.
              </Typography>
              <Typography
                variant="body2"
                component="p"
                color="text.secondary"
                sx={{ mb: 2 }}
              >
                Opifex starts Claude Code&apos;s own sign-in inside the API
                container and gives you the link it prints. You open that link,
                sign in <strong>with your own Claude account</strong> at
                claude.com, authorise it, and paste the code it hands back into
                this dialog. The token is sealed on the server; it is never sent
                to this browser and never shown here.
              </Typography>
              <Alert severity="info" variant="outlined">
                <AlertTitle>This spends that account&apos;s quota</AlertTitle>
                The token authenticates every run this factory dispatches, and
                those runs draw on the same subscription allowance as your own
                interactive use of Claude Code. A busy queue will be felt in
                your own sessions. Use an account whose plan you are willing to
                spend that way.
              </Alert>
              {configured && (
                <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
                  Completing this replaces the credential already stored here.
                  It does not revoke the old token — that happens only at
                  Anthropic — and a run already under way was handed the old
                  one.
                </Alert>
              )}
            </Box>
          )}

          {busy === 'starting' && (
            <Box aria-label="Starting the sign-in">
              <Typography variant="body2" gutterBottom>
                Starting Claude Code on a terminal inside the API container…
              </Typography>
              <LinearProgress sx={{ my: 1.5 }} />
              <Typography variant="body2" color="text.secondary">
                This waits for the CLI to print its sign-in link — usually a few
                seconds, up to forty-five at the outside. Nothing has been
                changed yet.
              </Typography>
            </Box>
          )}

          {isAwaiting && session?.url != null && expiry !== null && (
            <Box>
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  rowGap: 1,
                  mb: 1,
                }}
              >
                <Typography variant="subtitle2" component="h6">
                  Step 1 — open this link and authorise
                </Typography>
                <Chip
                  size="small"
                  color={expiry.expired ? 'error' : 'default'}
                  variant="outlined"
                  label={
                    expiry.countdown === null
                      ? 'expiry unknown'
                      : expiry.expired
                        ? 'expired'
                        : `expires in ${expiry.countdown}`
                  }
                />
              </Stack>

              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  bgcolor: 'background.paper',
                  border: 1,
                  borderColor: 'divider',
                }}
              >
                <Typography
                  variant="body2"
                  sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                  aria-label="Claude sign-in link"
                >
                  {session.url}
                </Typography>
              </Box>

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                sx={{ mt: 1.5 }}
              >
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ContentCopyIcon />}
                  onClick={() => copyUrl(session.url ?? '')}
                >
                  {copiedUrl === session.url ? 'Copied' : 'Copy link'}
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  endIcon={<OpenInNewIcon />}
                  component={Link}
                  href={session.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open in a new tab
                </Button>
              </Stack>

              {copyRefused && (
                <Typography
                  variant="caption"
                  component="p"
                  color="text.secondary"
                  sx={{ mt: 1 }}
                >
                  This browser would not give the page clipboard access. Select
                  the link above and copy it by hand — it is the whole link, not
                  a truncated one.
                </Typography>
              )}

              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 1.5 }}
              >
                On a machine with no browser, copy the link to one that has one.
                The sign-in happens in your browser, not in this container.
              </Typography>

              <Typography variant="subtitle2" component="h6" sx={{ mt: 3 }}>
                Step 2 — paste the code it gives you back
              </Typography>

              {expiry.expired ? (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  <AlertTitle>This sign-in has expired</AlertTitle>
                  {expiry.label} Nothing was changed.
                </Alert>
              ) : (
                <Typography
                  variant="caption"
                  component="p"
                  color="text.secondary"
                >
                  {expiry.label} The code itself is good for only a few minutes
                  after the browser gives it to you, so paste it straight away.
                </Typography>
              )}

              <TextField
                label="Authorization code"
                size="small"
                fullWidth
                sx={{ mt: 1.5 }}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={busy !== null || expiry.expired}
                autoComplete="off"
                helperText={
                  'Paste the whole code. It goes to the API and is written ' +
                  'to the waiting CLI; it is not stored anywhere.'
                }
                slotProps={{
                  htmlInput: {
                    autoCapitalize: 'off',
                    autoCorrect: 'off',
                    spellCheck: false,
                    'data-1p-ignore': 'true',
                  },
                }}
              />

              {busy === 'submitting' && (
                <Box sx={{ mt: 2 }} aria-label="Completing the sign-in">
                  <Typography variant="body2">
                    Completing the sign-in with Claude…
                  </Typography>
                  <LinearProgress sx={{ my: 1.5 }} />
                  <Typography variant="body2" color="text.secondary">
                    The exchange can take up to ninety seconds. Leave this open
                    — closing it now cancels the sign-in.
                  </Typography>
                </Box>
              )}
            </Box>
          )}

          {status === 'completed' && (
            <Alert severity="success">
              <AlertTitle>Connected</AlertTitle>
              The token was sealed into this credential the same way a pasted
              one is, so History records it and the readiness step flips. It was
              never sent to this browser, so there is nothing here to copy or
              lose.
            </Alert>
          )}

          {session !== null &&
            failure !== null &&
            session.error !== null &&
            status !== 'completed' && (
              <Alert
                severity={failure.severity}
                aria-label={`Sign-in failed: ${session.error.reason}`}
              >
                <AlertTitle>{failure.title}</AlertTitle>
                <Typography variant="body2" component="p" sx={{ mb: 1 }}>
                  {session.error.message}
                </Typography>
                <Typography variant="body2">{failure.nextStep}</Typography>
                {!failure.retryable && (
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    Retrying is not offered here because it would fail in
                    exactly the same way. Until the deployment is fixed, paste a
                    token into the field below this panel instead.
                  </Typography>
                )}
              </Alert>
            )}
        </DialogContent>

        <DialogActions sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          {session === null && busy === null && (
            <Button variant="contained" onClick={() => void start()}>
              Start sign-in
            </Button>
          )}

          {isAwaiting && (
            <Button
              variant="contained"
              onClick={() => void submitCode(code.trim())}
              disabled={
                busy !== null ||
                code.trim() === '' ||
                (expiry?.expired ?? false)
              }
            >
              Complete sign-in
            </Button>
          )}

          {session !== null &&
            isTerminalClaudeAuthStatus(session.status) &&
            status !== 'completed' &&
            (failure?.retryable ?? true) && (
              <Button
                variant="contained"
                onClick={() => {
                  setCode('');
                  reset();
                  void start();
                }}
              >
                Start a new sign-in
              </Button>
            )}

          <Button onClick={() => void closeDialog()} disabled={isBusy}>
            {status === 'completed'
              ? 'Done'
              : session === null
                ? 'Not now'
                : 'Cancel sign-in'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default ClaudeAuthPanel;
