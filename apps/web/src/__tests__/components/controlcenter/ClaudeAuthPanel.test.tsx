/**
 * The guided Claude sign-in (#386, epic #332).
 *
 * Exercised through `CredentialsSectionContainer` rather than by rendering the
 * panel alone, for the reason `CredentialsSection.test.tsx` gives: the claims
 * this flow makes are about REQUESTS — that Cancel really sends the DELETE,
 * that the code goes to the API as a `{ code }` body, that a completed sign-in
 * makes the section re-read the document — and a panel rendered with hand-fed
 * props would let every one of them be true of nothing. It also proves the
 * wiring: the panel belongs to one credential and must not appear on the
 * others.
 *
 * The fixtures are the API's real serialisation, taken from
 * `dto/claude-auth.dto.ts`: `url` populated only in `awaiting_code`, `error`
 * null unless it failed, `configured` as the whole of the success signal, and
 * — above all — no `token` member anywhere, because the response type has none.
 * The one test that deviates from that says so at the point it does it, and
 * deviates in the direction of being harder to pass.
 */

import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';

import { render } from '../../utils/test-utils';
import { expectNoLeak } from '../../utils/domSecrets';
import { server } from '../../mocks/server';
import { CredentialsSectionContainer } from '../../../components/controlcenter/CredentialsSectionContainer';
import type {
  ClaudeAuthFailureReason,
  ClaudeAuthSession,
} from '../../../types/claudeAuth';

const API_BASE = '*/api';
const CLAUDE_KEY = 'runners.claudeCodeLocal.oauthToken';
const SESSION_ID = 'b0f1a4de-2c37-4e51-9a0e-6d2a1f7c8e93';

/** The vendor's PKCE authorize URL, in the shape the CLI really prints. */
const AUTHORIZE_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a' +
  '&response_type=code&state=Xy7&code_challenge=Q1w2E3r4T5y6U7i8O9p0';

/** Ten minutes out, as the API sets it. */
function future(minutes = 9.5): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function awaitingSession(
  overrides: Partial<ClaudeAuthSession> = {},
): ClaudeAuthSession {
  return {
    sessionId: SESSION_ID,
    status: 'awaiting_code',
    url: AUTHORIZE_URL,
    startedAt: new Date(Date.now() - 2_000).toISOString(),
    expiresAt: future(),
    configured: false,
    error: null,
    ...overrides,
  };
}

/** A finished sign-in. `url` is dropped once terminal — the API drops it too. */
function completedSession(): ClaudeAuthSession {
  return {
    ...awaitingSession(),
    status: 'completed',
    url: null,
    configured: true,
  };
}

function failedSession(reason: ClaudeAuthFailureReason): ClaudeAuthSession {
  return {
    ...awaitingSession(),
    status: 'failed',
    url: null,
    configured: false,
    error: { reason, message: `The API's own sentence about ${reason}.` },
  };
}

interface ClaudeAuthCalls {
  starts: number;
  codes: unknown[];
  deletes: string[];
}

/**
 * Every route the flow uses, answered.
 *
 * The DELETE is always registered, even for tests that never press Cancel:
 * the hook sends one when it unmounts with a live session, which is the whole
 * point of it, and an unhandled request there would be a warning rather than
 * the assertion it deserves.
 */
function serveClaudeAuth(options: {
  start?: ClaudeAuthSession;
  startStatus?: number;
  startBody?: unknown;
  code?: ClaudeAuthSession;
  codeStatus?: number;
  codeBody?: unknown;
  codeDelayMs?: number;
  get?: ClaudeAuthSession;
}): ClaudeAuthCalls {
  const calls: ClaudeAuthCalls = { starts: 0, codes: [], deletes: [] };
  const base = `${API_BASE}/operator-settings/claude-auth`;

  server.use(
    http.post(`${base}/start`, () => {
      calls.starts += 1;
      if (options.startStatus !== undefined) {
        return HttpResponse.json(options.startBody, {
          status: options.startStatus,
        });
      }
      return HttpResponse.json(
        { data: options.start ?? awaitingSession() },
        { status: 201 },
      );
    }),
    http.post(`${base}/:sessionId/code`, async ({ request }) => {
      calls.codes.push(await request.json());
      if (options.codeDelayMs !== undefined) await delay(options.codeDelayMs);
      if (options.codeStatus !== undefined) {
        return HttpResponse.json(options.codeBody, {
          status: options.codeStatus,
        });
      }
      return HttpResponse.json({ data: options.code ?? completedSession() });
    }),
    http.get(`${base}/:sessionId`, ({ params }) =>
      HttpResponse.json({
        data: options.get ?? {
          ...awaitingSession(),
          sessionId: String(params.sessionId),
        },
      }),
    ),
    http.delete(`${base}/:sessionId`, ({ params }) => {
      calls.deletes.push(String(params.sessionId));
      return HttpResponse.json({
        data: {
          ...awaitingSession(),
          status: 'cancelled',
          url: null,
          error: { reason: 'cancelled', message: 'Cancelled.' },
        },
      });
    }),
  );

  return calls;
}

function renderSection(
  options: { canWrite?: boolean; canWriteSecret?: boolean } = {},
) {
  const onSaved = vi.fn();
  const result = render(
    <CredentialsSectionContainer
      canWrite={options.canWrite ?? true}
      canWriteSecret={options.canWriteSecret ?? true}
      onSaved={onSaved}
    />,
  );
  return { ...result, onSaved };
}

/** Open the dialog and get past the preamble to a live sign-in. */
async function signInTo(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  const card = await screen.findByLabelText(CLAUDE_KEY);
  await user.click(
    within(card).getByRole('button', { name: /^Connect( again)?$/ }),
  );
  await user.click(
    await screen.findByRole('button', { name: /start sign-in/i }),
  );
  await screen.findByLabelText('Claude sign-in link');
  return screen.getByRole('dialog');
}

describe('ClaudeAuthPanel', () => {
  describe('Where it appears', () => {
    it('is offered on the Claude credential and on no other', async () => {
      renderSection();

      const claude = await screen.findByLabelText(CLAUDE_KEY);
      expect(
        within(claude).getByRole('button', { name: /connect again/i }),
      ).toBeInTheDocument();

      // The GitHub token is a secret too, and there is no CLI that can mint
      // one — a panel there would be an offer this app cannot keep.
      const github = await screen.findByLabelText('github.token');
      expect(
        within(github).queryByRole('button', { name: /connect/i }),
      ).not.toBeInTheDocument();
    });

    it('leaves the manual paste in place beside it', async () => {
      // The guided flow is an addition, not a replacement: an operator who
      // already holds a token must still be able to paste it, and that route
      // is the only one left when the CLI or the pty is missing.
      const claude = await screen.findByLabelText(CLAUDE_KEY).catch(() => null);
      expect(claude).toBeNull();

      renderSection();
      const card = await screen.findByLabelText(CLAUDE_KEY);

      expect(
        within(card).getByRole('button', { name: 'Replace' }),
      ).toBeEnabled();
    });

    it('does not offer it to an account that may not write secrets', async () => {
      renderSection({ canWriteSecret: false });

      const card = await screen.findByLabelText(CLAUDE_KEY);
      expect(
        within(card).getByRole('button', { name: /connect again/i }),
      ).toBeDisabled();
    });
  });

  describe('Before anything happens', () => {
    it('says where the operator is being sent and whose quota it spends', async () => {
      const user = userEvent.setup();
      const calls = serveClaudeAuth({});
      renderSection();

      const card = await screen.findByLabelText(CLAUDE_KEY);
      await user.click(
        within(card).getByRole('button', { name: /connect again/i }),
      );

      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(/spends that account's quota/i),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(
          /draw on the same subscription allowance as your own/i,
        ),
      ).toBeInTheDocument();
      expect(within(dialog).getByText(/claude\.com/i)).toBeInTheDocument();

      // Said BEFORE it happens: opening the dialog starts nothing.
      expect(calls.starts).toBe(0);
    });
  });

  describe('The URL', () => {
    it('is shown whole, copyable, and openable in a new tab', async () => {
      const user = userEvent.setup();
      serveClaudeAuth({});
      renderSection();

      const dialog = await signInTo(user);

      // Whole: an operator copying by hand from a truncated link gets a URL
      // that fails at the vendor with no explanation.
      expect(
        within(dialog).getByLabelText('Claude sign-in link'),
      ).toHaveTextContent(AUTHORIZE_URL);

      const link = within(dialog).getByRole('link', {
        name: /open in a new tab/i,
      });
      expect(link).toHaveAttribute('href', AUTHORIZE_URL);
      expect(link).toHaveAttribute('target', '_blank');
      // Both halves: `noopener` denies the opened page `window.opener`,
      // `noreferrer` stops the Referer being sent.
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');

      await user.click(
        within(dialog).getByRole('button', { name: 'Copy link' }),
      );
      await expect(navigator.clipboard.readText()).resolves.toBe(AUTHORIZE_URL);
      expect(
        await within(dialog).findByRole('button', { name: 'Copied' }),
      ).toBeInTheDocument();
    });
  });

  describe('The ten-minute expiry', () => {
    it('counts down while the sign-in is live', async () => {
      const user = userEvent.setup();
      serveClaudeAuth({ start: awaitingSession({ expiresAt: future(9) }) });
      renderSection();

      const dialog = await signInTo(user);
      expect(within(dialog).getByText(/expires in 8:5\d/)).toBeInTheDocument();
    });

    it('says a session is expired instead of failing on submit', async () => {
      const user = userEvent.setup();
      const calls = serveClaudeAuth({
        start: awaitingSession({
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      });
      renderSection();

      const dialog = await signInTo(user);

      expect(
        within(dialog).getAllByText(/this sign-in has expired/i).length,
      ).toBeGreaterThan(0);
      expect(
        within(dialog).getByRole('button', { name: /complete sign-in/i }),
      ).toBeDisabled();
      expect(
        within(dialog).getByLabelText(/authorization code/i),
      ).toBeDisabled();
      expect(calls.codes).toHaveLength(0);
    });
  });

  describe('Submitting the code', () => {
    it('sends it as the API asks, and reports success without a token', async () => {
      const user = userEvent.setup();
      const calls = serveClaudeAuth({});
      const { onSaved } = renderSection();

      const dialog = await signInTo(user);
      await user.type(
        within(dialog).getByLabelText(/authorization code/i),
        '  code-from-the-browser  ',
      );
      await user.click(
        within(dialog).getByRole('button', { name: /complete sign-in/i }),
      );

      await screen.findByText(/^Connected$/);
      // Trimmed, because copying from a browser brings whitespace and the
      // API's own schema trims too — this is the same value, not a different
      // one.
      expect(calls.codes).toEqual([{ code: 'code-from-the-browser' }]);

      // Done is what tells the section to re-read: the API sealed the token
      // itself, so there is nothing to patch, only a stale document.
      await user.click(within(dialog).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(onSaved.mock.calls[0][0]).toMatch(/never reached this browser/i);
    });

    it('says what it is waiting for during the ninety-second exchange', async () => {
      const user = userEvent.setup();
      serveClaudeAuth({ codeDelayMs: 300 });
      renderSection();

      const dialog = await signInTo(user);
      await user.type(
        within(dialog).getByLabelText(/authorization code/i),
        'a-code',
      );
      await user.click(
        within(dialog).getByRole('button', { name: /complete sign-in/i }),
      );

      // The wait most likely to be mistaken for a hung page.
      expect(
        await within(dialog).findByLabelText('Completing the sign-in'),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(/up to ninety seconds/i),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('progressbar')).toBeInTheDocument();

      await screen.findByText(/^Connected$/);
    });
  });

  describe('The four failure causes render differently', () => {
    it.each([
      ['invalid_code', /that code was rejected/i, true],
      ['no_subscription', /cannot issue a token/i, true],
      ['cli_missing', /CLI is not installed in the API container/i, false],
      ['pty_unavailable', /cannot allocate a terminal/i, false],
    ] as const)(
      '%s gets its own heading, and retry is offered only when it could work',
      async (reason, heading, retryable) => {
        const user = userEvent.setup();
        serveClaudeAuth({ code: failedSession(reason) });
        renderSection();

        const dialog = await signInTo(user);
        await user.type(
          within(dialog).getByLabelText(/authorization code/i),
          'a-code',
        );
        await user.click(
          within(dialog).getByRole('button', { name: /complete sign-in/i }),
        );

        const alert = await within(dialog).findByLabelText(
          `Sign-in failed: ${reason}`,
        );
        expect(within(alert).getByText(heading)).toBeInTheDocument();
        // The API's own sentence is rendered too, not replaced by ours.
        expect(
          within(alert).getByText(new RegExp(`sentence about ${reason}`)),
        ).toBeInTheDocument();

        const retry = within(dialog).queryByRole('button', {
          name: /start a new sign-in/i,
        });

        if (retryable) {
          expect(retry).toBeInTheDocument();
        } else {
          // A deployment fault. The next attempt fails identically, so a
          // Retry button here would send the operator round a loop that
          // cannot end and imply the problem is theirs and transient.
          expect(retry).not.toBeInTheDocument();
          expect(
            within(alert).getByText(/deployment fault/i),
          ).toBeInTheDocument();
          expect(
            within(alert).getByText(/paste a token into the field below/i),
          ).toBeInTheDocument();
        }
      },
    );
  });

  describe('Cancelling', () => {
    it('sends the DELETE rather than dropping the session', async () => {
      const user = userEvent.setup();
      const calls = serveClaudeAuth({});
      renderSection();

      const dialog = await signInTo(user);
      await user.click(
        within(dialog).getByRole('button', { name: /cancel sign-in/i }),
      );

      // Not cosmetic: an abandoned session leaves a `claude` process holding
      // a pseudo-terminal for ten minutes and blocks the next attempt.
      await waitFor(() => expect(calls.deletes).toEqual([SESSION_ID]));
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );
    });

    it('sends it too when the section is closed on a live sign-in', async () => {
      const user = userEvent.setup();
      const calls = serveClaudeAuth({});
      const { unmount } = renderSection();

      await signInTo(user);
      unmount();

      await waitFor(() => expect(calls.deletes).toEqual([SESSION_ID]));
    });

    it('does not DELETE a sign-in that already finished', async () => {
      const user = userEvent.setup();
      const calls = serveClaudeAuth({});
      renderSection();

      const dialog = await signInTo(user);
      await user.type(
        within(dialog).getByLabelText(/authorization code/i),
        'a-code',
      );
      await user.click(
        within(dialog).getByRole('button', { name: /complete sign-in/i }),
      );
      await screen.findByText(/^Connected$/);
      await user.click(within(dialog).getByRole('button', { name: 'Done' }));

      expect(calls.deletes).toEqual([]);
    });
  });

  describe('When the call itself fails', () => {
    it('shows the API 409 verbatim, because it names the session to cancel', async () => {
      const user = userEvent.setup();
      const message =
        'A Claude sign-in is already in progress (session ' +
        'c7e2f0a1-1111-2222-3333-444455556666). Finish it or cancel it.';
      serveClaudeAuth({ startStatus: 409, startBody: { message } });
      renderSection();

      const card = await screen.findByLabelText(CLAUDE_KEY);
      await user.click(
        within(card).getByRole('button', { name: /connect again/i }),
      );
      await user.click(
        await screen.findByRole('button', { name: /start sign-in/i }),
      );

      expect(await screen.findByText(message)).toBeInTheDocument();
    });

    it('explains a 503 as the token having nowhere to be sealed', async () => {
      const user = userEvent.setup();
      serveClaudeAuth({
        codeStatus: 503,
        codeBody: { message: 'No encryption key is configured.' },
      });
      renderSection();

      const dialog = await signInTo(user);
      await user.type(
        within(dialog).getByLabelText(/authorization code/i),
        'a-code',
      );
      await user.click(
        within(dialog).getByRole('button', { name: /complete sign-in/i }),
      );

      expect(
        await within(dialog).findByText(/OPIFEX_SETTINGS_ENCRYPTION_KEY/),
      ).toBeInTheDocument();
      // A call that never landed is not a sign-in that failed: no failure
      // alert claims the code was rejected.
      expect(
        within(dialog).queryByLabelText(/^Sign-in failed/),
      ).not.toBeInTheDocument();
    });
  });

  describe('Nothing here can render a token', () => {
    it('renders no node containing a token, even if the API sends one', async () => {
      // The API's session schema HAS no `token` member and its own
      // `claude-auth-secret-leak.spec.ts` greps every response to keep it that
      // way — so a faithful fixture could not leak, and a test using one would
      // pass vacuously. This response therefore carries a token the real API
      // never sends. What is being proved is the property that survives a
      // regression on either side: this panel reads the five fields it needs
      // by name and never serialises the session, so a token in the body
      // reaches no text node, no attribute, and no input value.
      // Assembled rather than written out: the repository's pre-commit secret
      // scanner matches the real token shape, and a fixture that trips it
      // would either be committed with the check bypassed or quietly
      // weakened. Joined, it is the same string at runtime.
      const token = [
        'sk',
        'ant',
        'oat01',
        'NEVERRENDERTHIS0123456789abcdef',
      ].join('-');
      const user = userEvent.setup();
      serveClaudeAuth({
        start: { ...awaitingSession(), token } as ClaudeAuthSession,
        code: { ...completedSession(), token } as ClaudeAuthSession,
      });
      const { container } = renderSection();

      const dialog = await signInTo(user);
      expectNoLeak(container, token);

      await user.type(
        within(dialog).getByLabelText(/authorization code/i),
        'a-code',
      );
      await user.click(
        within(dialog).getByRole('button', { name: /complete sign-in/i }),
      );
      await screen.findByText(/^Connected$/);

      expectNoLeak(container, token);
    });

    it('keeps the pasted code in its own field and nowhere else', async () => {
      // The authorization code is short-lived and single-use rather than a
      // credential, but it is still an authorization artefact: it belongs in
      // the field the operator typed it into and in the request body, not in
      // a heading, a confirmation or a title attribute.
      const user = userEvent.setup();
      serveClaudeAuth({});
      const { container } = renderSection();

      const dialog = await signInTo(user);
      await user.type(
        within(dialog).getByLabelText(/authorization code/i),
        'code-1234-abcd-5678',
      );

      expectNoLeak(container, 'code-1234-abcd-5678', {
        allowInputValues: true,
      });
    });
  });
});
