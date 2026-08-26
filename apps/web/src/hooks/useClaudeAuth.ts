/**
 * The guided Claude sign-in's state (#386, epic #332).
 *
 * ## Why there is no polling loop
 *
 * Both interesting calls BLOCK. `start` does not answer until the CLI has
 * printed its authorize URL, and `/code` does not answer until the vendor
 * exchange has settled — so the response to each one already is the session's
 * next state, and a poll on top would only re-read what the caller is holding.
 * What the screen still has to do is the other half of that bargain: two waits
 * of up to forty-five and ninety seconds, each of which must look like work in
 * progress rather than a hung page. That is what `busy` is for.
 *
 * `refresh` exists for the one case where the client's idea of the session can
 * be wrong: the API answers 409 because the session is no longer awaiting a
 * code — it expired, or another tab finished it — and the honest response is
 * to go and read what it actually is rather than guess.
 *
 * ## `problem` and `session.error` are different things
 *
 * `session.error` is a sign-in that ran and failed: the code was refused, the
 * account has no plan, the CLI is missing. `problem` is a CALL that did not
 * happen — a 403, a 409 from a sign-in already live, a 503 because no
 * encryption key is configured, a dead network. Collapsing them would let the
 * screen tell an operator their code was rejected when in fact nothing was
 * ever sent, which is the same class of mistake `runOperatorProbe` splits
 * `answered` from `unreachable` to avoid.
 *
 * ## A live session is cancelled when this unmounts
 *
 * Not tidiness. An abandoned session leaves a `claude` process holding a
 * pseudo-terminal for the full ten minutes, and no second sign-in can start
 * until it goes. Closing the dialog calls `cancel` explicitly; navigating away
 * from the Control Center entirely is caught here instead, best-effort and
 * without touching state, since by then there is nothing left to render into.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  cancelClaudeAuth,
  getClaudeAuthSession,
  startClaudeAuth,
  submitClaudeAuthCode,
} from '../services/api';
import {
  isTerminalClaudeAuthStatus,
  type ClaudeAuthSession,
} from '../types/claudeAuth';
import { useIsMounted } from './useIsMounted';

/** Which blocking call is in flight, if any. */
export type ClaudeAuthBusy = 'starting' | 'submitting' | 'cancelling' | null;

export interface UseClaudeAuthResult {
  session: ClaudeAuthSession | null;
  busy: ClaudeAuthBusy;
  /** Why a CALL failed. Never why a sign-in failed — see the header. */
  problem: string | null;
  start: () => Promise<void>;
  submitCode: (code: string) => Promise<void>;
  /** DELETEs the session, then forgets it. */
  cancel: () => Promise<void>;
  /** Re-reads the session the API holds. */
  refresh: () => Promise<void>;
  /** Forgets a finished session locally. Sends nothing. */
  reset: () => void;
}

export function useClaudeAuth(): UseClaudeAuthResult {
  const [session, setSession] = useState<ClaudeAuthSession | null>(null);
  const [busy, setBusy] = useState<ClaudeAuthBusy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Every `setState` past an `await` is guarded: these calls take up to ninety
  // seconds, which is ample time for the section to be closed under them.
  const isMounted = useIsMounted();

  // The id to kill on unmount, or null when there is nothing live. Written in
  // an effect rather than during render — a render React discards must not
  // publish a session id that the tree on screen does not have.
  const liveSessionId = useRef<string | null>(null);

  useEffect(() => {
    liveSessionId.current =
      session !== null && !isTerminalClaudeAuthStatus(session.status)
        ? session.sessionId
        : null;
  }, [session]);

  useEffect(
    () => () => {
      const id = liveSessionId.current;
      // Fire and forget: the component is gone, so there is nowhere to report
      // a failure to, and leaving the process running is strictly worse than
      // an unobserved DELETE.
      if (id !== null) void cancelClaudeAuth(id).catch(() => undefined);
    },
    [],
  );

  const start = useCallback(async () => {
    if (busy !== null) return;

    setBusy('starting');
    setProblem(null);

    try {
      const started = await startClaudeAuth();
      if (isMounted()) setSession(started);
    } catch (error) {
      if (isMounted()) setProblem(startProblem(error));
    } finally {
      if (isMounted()) setBusy(null);
    }
  }, [busy, isMounted]);

  const refresh = useCallback(async () => {
    const current = liveSessionId.current ?? session?.sessionId ?? null;
    if (current === null) return;

    try {
      const latest = await getClaudeAuthSession(current);
      if (isMounted()) setSession(latest);
    } catch (error) {
      if (isMounted()) setProblem(callProblem(error));
    }
  }, [session, isMounted]);

  const submitCode = useCallback(
    async (code: string) => {
      if (busy !== null || session === null) return;

      setBusy('submitting');
      setProblem(null);

      try {
        const finished = await submitClaudeAuthCode(session.sessionId, code);
        if (isMounted()) setSession(finished);
      } catch (error) {
        if (isMounted()) setProblem(submitProblem(error));

        // A 409 means this screen's idea of the session is stale — it expired,
        // or something else finished it. Read the real one rather than leave
        // a paste field open on a session that is no longer asking.
        if (error instanceof ApiError && error.status === 409) {
          await refresh();
        }
      } finally {
        if (isMounted()) setBusy(null);
      }
    },
    [busy, session, refresh, isMounted],
  );

  const cancel = useCallback(async () => {
    const current = session;
    if (current === null) {
      setProblem(null);
      return;
    }

    // Forgotten locally either way. A cancel that the API refuses still means
    // the operator is done with this sign-in, and leaving the dialog on a
    // session they abandoned would be answering a question they did not ask.
    setBusy('cancelling');

    try {
      if (!isTerminalClaudeAuthStatus(current.status)) {
        await cancelClaudeAuth(current.sessionId);
      }
      if (isMounted()) setProblem(null);
    } catch (error) {
      // Reported, not swallowed: if the DELETE really failed, a `claude`
      // process may still be holding a terminal, and the next `start` will
      // answer 409 for a reason the operator would otherwise have no way to
      // connect to this moment.
      if (isMounted() && !(error instanceof ApiError && error.status === 404)) {
        setProblem(cancelProblem(error));
      }
    } finally {
      if (isMounted()) {
        setSession(null);
        setBusy(null);
      }
    }
  }, [session, isMounted]);

  const reset = useCallback(() => {
    setSession(null);
    setProblem(null);
  }, []);

  return { session, busy, problem, start, submitCode, cancel, refresh, reset };
}

/**
 * Why `start` did not produce a session.
 *
 * The 409 is passed through verbatim on purpose: the API's message names the
 * session that is already live, which is the one fact that makes it
 * actionable, and rewriting it here would drop that.
 */
function startProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return error.message;
    if (error.status === 403) {
      return (
        'This account may not start a Claude sign-in. It needs ' +
        'operator_settings:write_secret as well as system_settings:write, ' +
        'and the request must come from a signed-in browser session — a ' +
        'personal access token is refused here however it is scoped.'
      );
    }
    if (error.status === 404 || error.status === 501) {
      return (
        "This deployment's API does not offer the guided sign-in " +
        `(${error.status}). Paste a token obtained with "claude ` +
        'setup-token" into the field below instead.'
      );
    }
    return `The sign-in could not be started: ${error.message}`;
  }

  return callProblem(error);
}

/** Why `/code` did not settle the session. */
function submitProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) {
      return (
        'A token was produced but there is nowhere to seal it: no ' +
        'OPIFEX_SETTINGS_ENCRYPTION_KEY is configured, so the credential was ' +
        'discarded rather than stored in the clear. Set that key and sign in ' +
        'again.'
      );
    }
    if (error.status === 400) {
      return `That code was not accepted: ${error.message}`;
    }
    if (error.status === 404) {
      return (
        'The API no longer holds this sign-in. Sign-ins live in the API ' +
        'process, so a restart ends them — start a new one.'
      );
    }
    return `The code could not be submitted: ${error.message}`;
  }

  return callProblem(error);
}

function cancelProblem(error: unknown): string {
  const detail = error instanceof ApiError ? error.message : callProblem(error);
  return (
    `This sign-in was dropped from this screen, but the API did not confirm ` +
    `it stopped: ${detail} The Claude Code process may still be running ` +
    `until the ten-minute expiry, and a new sign-in may be refused until it ` +
    `does.`
  );
}

function callProblem(error: unknown): string {
  return error instanceof Error
    ? `The API could not be reached: ${error.message}`
    : 'The API could not be reached.';
}

export default useClaudeAuth;
