import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import {
  describeCredentialKind,
  readCredentialKind,
  type CredentialKind,
} from '../credential-kind';

/**
 * The second barrier on the operator-settings write path (#346, epic #332).
 *
 * ## The hole this fills
 *
 * `autonomy/never-trustable.ts` refuses writes to any `.env` file, because
 * that is where the budget ceilings, quota limits and credentials used to
 * live, and a file write is an effect the guard can name. #339 moved that
 * configuration into `operator_settings`. There is no file write any more, so
 * that rule stops applying — silently, with nothing in its place. VISION §8 is
 * explicit about what that leaves: an agent that can edit the check enforcing
 * its own rules "has the appearance of guardrails and none of the substance".
 *
 * ## Why this is not the same barrier as #334
 *
 * #334 removed every credential from the agent subprocess's environment, so an
 * agent has nothing to authenticate with. This guard refuses the request even
 * if it somehow does. The two are INDEPENDENT, and ADR-0018 §6 requires both:
 * "either one missing is sufficient to invalidate this decision, not merely
 * weaken it". #334 alone fails the first time some future code path
 * legitimately hands an agent a token — which would reopen the hole with
 * nothing left to catch it. This alone fails if an agent reaches a live human
 * session. Neither is a restatement of the other.
 *
 * ## Writes only
 *
 * Reads stay open to every credential. Automation observing configuration is
 * exactly the thing this system wants more of — a dashboard, a drift check, a
 * runbook verifier — and none of it changes a limit. Restricting reads would
 * buy nothing and would teach operators to route around the guard, which is
 * how a guard stops being one.
 *
 * ## Refusal, not silence
 *
 * The refusal is a 403 that names the credential kind, the reason, and VISION
 * §8, and it files an audit row. The operator's own tooling is the most likely
 * thing to hit this, and at that moment the message is the only thing that
 * will explain why a token that has always worked no longer does. The audit
 * row exists because "blocked" and "nobody ever tried" look identical from the
 * outside, and it is the difference between them that is worth watching.
 */
@Injectable()
export class InteractiveSessionGuard implements CanActivate {
  private readonly logger = new Logger(InteractiveSessionGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const kind = readCredentialKind(request);

    if (kind === 'interactive') {
      return true;
    }

    const method = (request.method ?? 'REQUEST').toUpperCase();
    const path = request.url ?? request.originalUrl ?? 'this endpoint';
    const reason = describeInteractiveOnlyRefusal({ kind, method, path });

    this.logger.warn(reason);

    await this.record({ request, kind, method, path, reason });

    throw new ForbiddenException(reason);
  }

  /**
   * One `audit_events` row per refused attempt.
   *
   * The same shape and the same failure policy as
   * `NeverTrustableService.record` (`never-trustable.service.ts:113`): the
   * refusal has already been decided by the time this runs and stands whether
   * or not the write lands, so a database that is down does not turn a refusal
   * into a permission. The cost, named rather than hidden, is that the log is
   * a lower bound on attempts rather than a count.
   */
  private async record(refusal: {
    request: GuardedRequest;
    kind: CredentialKind;
    method: string;
    path: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: refusal.request.user?.id ?? null,
          action: 'auth.non-interactive-refused',
          targetType: 'endpoint',
          targetId: `${refusal.method} ${refusal.path}`,
          meta: {
            credentialKind: refusal.kind,
            reason: refusal.reason,
            // KEYS ONLY, NEVER VALUES. A body reaching this guard on the
            // operator-settings route may carry a GitHub token or an
            // Anthropic key, and #337 already established that a plaintext
            // secret written into `audit_events.meta` is permanent — nothing
            // added later removes it from the history. Which settings were
            // targeted is the part worth keeping.
            bodyKeys: bodyKeysOf(refusal.request.body),
          } as never,
        },
      });
    } catch (error) {
      this.logger.error(
        `Refusal recorded in memory only — audit write failed for ` +
          `${refusal.method} ${refusal.path}: ${describeError(error)}`,
      );
    }
  }
}

/** The subset of the request this guard reads. */
interface GuardedRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  body?: unknown;
  user?: { id?: string | null } | null;
}

/**
 * The sentence a refused caller reads, and the one written to the audit row.
 *
 * A pure function, exported, because it is the part of this guard most worth
 * asserting on directly: "names the reason and cites VISION §8" is an
 * acceptance criterion of #346, and a criterion that can only be checked
 * through an HTTP round trip tends to get checked as `toBe(403)` instead.
 */
export function describeInteractiveOnlyRefusal(refusal: {
  kind: CredentialKind;
  method: string;
  path: string;
}): string {
  return (
    `Refused: ${refusal.method} ${refusal.path} from ` +
    `${describeCredentialKind(refusal.kind)}. This endpoint writes budget, ` +
    'quota and credential configuration, so a write must come from an ' +
    'interactive human session: a personal access token and a device-flow ' +
    'token are both usable with nobody at a keyboard, and in an audit row ' +
    'neither is distinguishable from the admin who created it acting ' +
    'deliberately. VISION §8 — an agent that can edit the check enforcing ' +
    'its own rules "has the appearance of guardrails and none of the ' +
    'substance". Sign in interactively and retry; reading this configuration ' +
    'is not restricted.'
  );
}

/** Top-level keys of a JSON object body, or `[]` for anything else. */
function bodyKeysOf(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }

  return Object.keys(body as Record<string, unknown>);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
