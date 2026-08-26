/**
 * The sign-in hook's refusal paths (#386, epic #332).
 *
 * The happy path is covered where it belongs, through the rendered flow in
 * `components/controlcenter/ClaudeAuthPanel.test.tsx`. What is left is the set
 * of ways a CALL can fail, which the component reaches only by contriving one
 * HTTP status at a time — and each of those failures has a different sentence
 * precisely because the operator's next move differs. Asserting them here keeps
 * that promise checkable without a dozen renders.
 *
 * `problem` is the subject throughout. It is deliberately not the same thing as
 * `session.error`: a 409 from a sign-in already running means nothing was
 * started, and reporting it as "the code was rejected" would be the mistake
 * this split exists to prevent.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useClaudeAuth } from '../../hooks/useClaudeAuth';
import { ApiError } from '../../services/api';
import * as api from '../../services/api';
import type { ClaudeAuthSession } from '../../types/claudeAuth';

const SESSION_ID = 'd6a7f1b2-3c4d-5e6f-8a9b-0c1d2e3f4a5b';

function awaiting(): ClaudeAuthSession {
  return {
    sessionId: SESSION_ID,
    status: 'awaiting_code',
    url: 'https://claude.com/cai/oauth/authorize?code=true&state=Xy7',
    startedAt: '2026-08-23T10:00:00.000Z',
    expiresAt: '2026-08-23T10:10:00.000Z',
    configured: false,
    error: null,
  };
}

/** A hook already holding a live sign-in. */
async function withLiveSession() {
  vi.spyOn(api, 'startClaudeAuth').mockResolvedValue(awaiting());
  const rendered = renderHook(() => useClaudeAuth());
  await act(async () => {
    await rendered.result.current.start();
  });
  return rendered;
}

describe('useClaudeAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('passes a 409 through untouched, because it names the live session', async () => {
      const message =
        'A Claude sign-in is already in progress (session abc-123). ' +
        'Finish it or cancel it before starting another.';
      vi.spyOn(api, 'startClaudeAuth').mockRejectedValue(
        new ApiError(message, 409),
      );

      const { result } = renderHook(() => useClaudeAuth());
      await act(async () => {
        await result.current.start();
      });

      // Verbatim. The session id in it is the one fact that makes it
      // actionable, and any rewording here would drop it.
      expect(result.current.problem).toBe(message);
      expect(result.current.session).toBeNull();
    });

    it('names both requirements on a 403, including the interactive one', async () => {
      vi.spyOn(api, 'startClaudeAuth').mockRejectedValue(
        new ApiError('Forbidden', 403),
      );

      const { result } = renderHook(() => useClaudeAuth());
      await act(async () => {
        await result.current.start();
      });

      // A PAT is refused however it is scoped, which is not something an
      // operator can guess from "Forbidden".
      expect(result.current.problem).toMatch(/operator_settings:write_secret/);
      expect(result.current.problem).toMatch(/personal access token/i);
    });

    it('points an older API at the manual paste rather than at a retry', async () => {
      vi.spyOn(api, 'startClaudeAuth').mockRejectedValue(
        new ApiError('Cannot POST', 404),
      );

      const { result } = renderHook(() => useClaudeAuth());
      await act(async () => {
        await result.current.start();
      });

      expect(result.current.problem).toMatch(/does not offer the guided/i);
      expect(result.current.problem).toMatch(/setup-token/);
    });

    it('reports a transport failure as one, not as a refusal', async () => {
      vi.spyOn(api, 'startClaudeAuth').mockRejectedValue(
        new TypeError('Failed to fetch'),
      );

      const { result } = renderHook(() => useClaudeAuth());
      await act(async () => {
        await result.current.start();
      });

      expect(result.current.problem).toMatch(/could not be reached/i);
    });
  });

  describe('submitCode', () => {
    it('explains a 503 as the token having had nowhere to be sealed', async () => {
      const { result } = await withLiveSession();
      vi.spyOn(api, 'submitClaudeAuthCode').mockRejectedValue(
        new ApiError('No encryption key', 503),
      );

      await act(async () => {
        await result.current.submitCode('a-code');
      });

      // The distinction that matters: a token WAS minted and then discarded,
      // so the account has spent a sign-in and the operator must know why
      // nothing was stored.
      expect(result.current.problem).toMatch(/OPIFEX_SETTINGS_ENCRYPTION_KEY/);
      expect(result.current.problem).toMatch(/discarded/i);
    });

    it('says a restart ended the sign-in when the API has never heard of it', async () => {
      const { result } = await withLiveSession();
      vi.spyOn(api, 'submitClaudeAuthCode').mockRejectedValue(
        new ApiError('Not found', 404),
      );

      await act(async () => {
        await result.current.submitCode('a-code');
      });

      expect(result.current.problem).toMatch(/no longer holds this sign-in/i);
    });

    it('re-reads the session when the API says it is not awaiting a code', async () => {
      const { result } = await withLiveSession();
      vi.spyOn(api, 'submitClaudeAuthCode').mockRejectedValue(
        new ApiError('This sign-in is expired', 409),
      );
      const get = vi.spyOn(api, 'getClaudeAuthSession').mockResolvedValue({
        ...awaiting(),
        status: 'expired',
        url: null,
        error: { reason: 'timed_out', message: 'It expired.' },
      });

      await act(async () => {
        await result.current.submitCode('a-code');
      });

      // Guessing which of the several 409 causes it was would be inventing a
      // fact; the API is asked instead.
      expect(get).toHaveBeenCalledWith(SESSION_ID);
      await waitFor(() =>
        expect(result.current.session?.status).toBe('expired'),
      );
    });

    it('sends nothing when there is no session to send it to', async () => {
      const submit = vi.spyOn(api, 'submitClaudeAuthCode');
      const { result } = renderHook(() => useClaudeAuth());

      await act(async () => {
        await result.current.submitCode('a-code');
      });

      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('DELETEs a live session and forgets it', async () => {
      const { result } = await withLiveSession();
      const cancel = vi
        .spyOn(api, 'cancelClaudeAuth')
        .mockResolvedValue({ ...awaiting(), status: 'cancelled', url: null });

      await act(async () => {
        await result.current.cancel();
      });

      expect(cancel).toHaveBeenCalledWith(SESSION_ID);
      expect(result.current.session).toBeNull();
      expect(result.current.problem).toBeNull();
    });

    it('warns that a process may still be running when the DELETE fails', async () => {
      const { result } = await withLiveSession();
      vi.spyOn(api, 'cancelClaudeAuth').mockRejectedValue(
        new ApiError('Boom', 500),
      );

      await act(async () => {
        await result.current.cancel();
      });

      // Swallowing this would leave the next `start` answering 409 for a
      // reason the operator has no way to connect to this moment.
      expect(result.current.problem).toMatch(/may still be running/i);
      expect(result.current.session).toBeNull();
    });

    it('says nothing about a 404, which only means it is already gone', async () => {
      const { result } = await withLiveSession();
      vi.spyOn(api, 'cancelClaudeAuth').mockRejectedValue(
        new ApiError('Not found', 404),
      );

      await act(async () => {
        await result.current.cancel();
      });

      expect(result.current.problem).toBeNull();
    });

    it('does not DELETE a session that has already finished', async () => {
      vi.spyOn(api, 'startClaudeAuth').mockResolvedValue(awaiting());
      vi.spyOn(api, 'submitClaudeAuthCode').mockResolvedValue({
        ...awaiting(),
        status: 'completed',
        url: null,
        configured: true,
      });
      const cancel = vi.spyOn(api, 'cancelClaudeAuth');

      const { result } = renderHook(() => useClaudeAuth());
      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        await result.current.submitCode('a-code');
      });
      await act(async () => {
        await result.current.cancel();
      });

      expect(cancel).not.toHaveBeenCalled();
    });
  });
});
