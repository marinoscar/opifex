import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';
import type { CredentialKind } from '../credential-kind';
import {
  InteractiveSessionGuard,
  describeInteractiveOnlyRefusal,
} from './interactive-session.guard';

/**
 * The second of the two barriers ADR-0018 §6 requires (#346, epic #332).
 *
 * The cases below are the acceptance criteria of #346 stated against the
 * guard itself; `test/auth/interactive-only-settings.integration.spec.ts`
 * states the same ones over real HTTP against the real route, which is what
 * proves the guard is actually WIRED. Both are needed: a guard that refuses
 * correctly and is attached to nothing is the exact shape of failure VISION §8
 * calls "the appearance of guardrails and none of the substance".
 */

interface FakeRequest {
  method?: string;
  url?: string;
  body?: unknown;
  user?: { id?: string | null } | null;
  credentialKind?: CredentialKind;
}

describe('InteractiveSessionGuard (#346)', () => {
  let auditCreate: jest.Mock;
  let guard: InteractiveSessionGuard;

  function contextFor(request: FakeRequest): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function patchRequest(overrides: FakeRequest = {}): FakeRequest {
    return {
      method: 'patch',
      url: '/api/operator-settings',
      body: { 'dispatch.enabled': true },
      user: { id: 'admin-1' },
      ...overrides,
    };
  }

  /**
   * The exception the guard threw, or a failure if it admitted the request.
   *
   * The explicit throw at the end matters: a `.catch(e => e)` helper returns
   * `undefined` when nothing was thrown, and every `expect(...).toContain(...)`
   * below would then fail with a confusing message instead of the true one —
   * or worse, pass, if the assertion were ever loosened.
   */
  async function refusalFrom(
    request: FakeRequest,
  ): Promise<ForbiddenException> {
    try {
      await guard.canActivate(contextFor(request));
    } catch (thrown) {
      return thrown as ForbiddenException;
    }

    throw new Error(
      'Expected the guard to refuse, but it admitted the request',
    );
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    auditCreate = jest.fn().mockResolvedValue({});
    guard = new InteractiveSessionGuard({
      auditEvent: { create: auditCreate },
    } as unknown as PrismaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('admits an interactive session', async () => {
    await expect(
      guard.canActivate(
        contextFor(patchRequest({ credentialKind: 'interactive' })),
      ),
    ).resolves.toBe(true);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a personal access token', async () => {
    await expect(
      guard.canActivate(
        contextFor(patchRequest({ credentialKind: 'personal-access-token' })),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a device-flow token', async () => {
    await expect(
      guard.canActivate(
        contextFor(patchRequest({ credentialKind: 'device-code' })),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a credential whose kind nothing resolved', async () => {
    // The fail-closed direction: no `credentialKind` on the request at all.
    await expect(guard.canActivate(contextFor(patchRequest()))).rejects.toThrow(
      ForbiddenException,
    );
  });

  describe('the refusal message', () => {
    it('names the credential, the reason and VISION §8', async () => {
      const message = (
        await refusalFrom(
          patchRequest({ credentialKind: 'personal-access-token' }),
        )
      ).message;

      // The whole phrase, not just the noun. The generic half of this message
      // mentions both a personal access token and a device-flow token as the
      // things it refuses, so `toContain('a personal access token')` passes
      // even when the message has stopped naming the credential actually
      // presented — found by breaking that line and watching this test go on
      // passing.
      expect(message).toContain(
        'Refused: PATCH /api/operator-settings from a personal access token.',
      );
      expect(message).toContain('budget, quota and credential configuration');
      expect(message).toContain('VISION §8');
      expect(message).toContain(
        'the appearance of guardrails and none of the substance',
      );
      // The operator's own tooling is the most likely caller to hit this, so
      // the message has to end somewhere actionable rather than at "denied".
      expect(message).toContain('Sign in interactively and retry');
      expect(message).toContain('is not restricted');
    });

    it('names a device-flow token as such', async () => {
      const refusal = await refusalFrom(
        patchRequest({ credentialKind: 'device-code' }),
      );

      expect(refusal.message).toContain(
        'Refused: PATCH /api/operator-settings from a device-flow token.',
      );
    });

    it('is built by a pure function, so it can be asserted without a request', () => {
      expect(
        describeInteractiveOnlyRefusal({
          kind: 'device-code',
          method: 'PATCH',
          path: '/api/operator-settings',
        }),
      ).toContain('VISION §8');
    });
  });

  describe('the audit row', () => {
    it('records the attempt in the shape never-trustable.service.ts uses', async () => {
      await refusalFrom(
        patchRequest({ credentialKind: 'personal-access-token' }),
      );

      expect(auditCreate).toHaveBeenCalledTimes(1);
      const { data } = auditCreate.mock.calls[0][0];

      expect(data.actorUserId).toBe('admin-1');
      expect(data.action).toBe('auth.non-interactive-refused');
      expect(data.targetType).toBe('endpoint');
      expect(data.targetId).toBe('PATCH /api/operator-settings');
      expect(data.meta.credentialKind).toBe('personal-access-token');
      expect(data.meta.reason).toContain('VISION §8');
    });

    it('records which settings were targeted, and never their values', async () => {
      // #337 established that a plaintext secret written into
      // `audit_events.meta` is permanent — nothing added later removes it from
      // the history — and `github.token` is a key this route accepts.
      await refusalFrom(
        patchRequest({
          credentialKind: 'personal-access-token',
          body: { 'github.token': 'ghp_a_real_looking_secret' },
        }),
      );

      const { data } = auditCreate.mock.calls[0][0];

      expect(data.meta.bodyKeys).toEqual(['github.token']);
      expect(JSON.stringify(data.meta)).not.toContain(
        'ghp_a_real_looking_secret',
      );
    });

    it('tolerates a body that is not an object', async () => {
      await refusalFrom(
        patchRequest({ credentialKind: 'device-code', body: undefined }),
      );

      expect(auditCreate.mock.calls[0][0].data.meta.bodyKeys).toEqual([]);
    });

    it('records no actor when the request carries no user', async () => {
      await refusalFrom(
        patchRequest({ credentialKind: 'device-code', user: null }),
      );

      expect(auditCreate.mock.calls[0][0].data.actorUserId).toBeNull();
    });

    it('still refuses when the audit write fails', async () => {
      // The same policy as NeverTrustableService.record: the refusal is
      // already decided, so a database that is down must not turn it into a
      // permission. The cost — the log is a lower bound on attempts rather
      // than a count — is the right side of that trade.
      auditCreate.mockRejectedValue(new Error('database is away'));

      await expect(
        guard.canActivate(
          contextFor(patchRequest({ credentialKind: 'device-code' })),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
