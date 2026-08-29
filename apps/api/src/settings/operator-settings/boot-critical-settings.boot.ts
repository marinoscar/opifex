import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import {
  BOOT_CRITICAL_SETTING_KEYS,
  OPERATOR_SETTINGS,
  type OperatorSettingKey,
} from './operator-settings.registry';
import { OperatorSettingsService } from './operator-settings.service';

/**
 * Settings whose rejected value refuses the boot instead of falling back
 * (#441).
 *
 * ## Why any key gets this, when `invalidFallback` exists
 *
 * `invalidFallback` answers "a rejected value must not reach the declared
 * default, because the default is more permissive than anything the operator
 * could have written". It needs somewhere safe to land. For
 * `github.apiBaseUrl` there is nowhere: its default names A HOST A CREDENTIAL
 * IS SENT TO, and every substitute is a guess about where somebody's
 * fine-grained token should go.
 *
 * `GITHUB_API_BASE_URL=github.corp.example` — no scheme, so rejected — is a
 * GitHub Enterprise operator naming their own host. Falling back sends their
 * token to public GitHub. Falling back to *anything else* is this process
 * choosing a destination for a secret. So it refuses to start, names the
 * variable and the value, and lets somebody who knows decide.
 *
 * ## Why this is a refusal when an unreadable credential is only an `error`
 *
 * `config/env.validation.ts` and `unreadable-secrets.boot.ts` agree on the
 * test, and it is not importance: it is whether the rest of the service is
 * still telling the truth without the thing that failed. An unreadable model
 * credential voids nothing — every other request is answered correctly and
 * the adapter refuses per call. A misread API base URL is different in kind:
 * the process would go on running, believing it was talking to the host the
 * operator named, and the first thing it does with that belief is transmit a
 * credential. There is no arm of that where staying up is the safer choice.
 *
 * ## It reads through the resolver, not through `process.env`
 *
 * So a stored Control Center row is covered exactly as an environment
 * variable is — since #349 either can be the supplied value, and a check that
 * only read the environment would pass a deployment whose database row is the
 * broken one.
 *
 * ## Every offending key at once
 *
 * `validateEnv`'s property, for `validateEnv`'s reason: an operator fixing a
 * boot failure should learn everything wrong in one restart rather than
 * discovering the second problem after fixing the first.
 */

/** One boot-critical setting whose supplied value was refused. */
export interface BootCriticalRejection {
  readonly key: OperatorSettingKey;
  /** The whole operator-facing sentence, remedy included. */
  readonly message: string;
}

/**
 * Every boot-critical key whose supplied value the registry rejected.
 *
 * PURE — it asks the resolver and formats, nothing else — so the wording an
 * operator will actually read is testable without a Nest container, for
 * `unreadableSecrets`' reason.
 *
 * Driven off the registry's own `bootCritical` flag rather than a list, so a
 * key marked tomorrow is covered without anyone remembering this file.
 */
export function bootCriticalRejections(
  settings: OperatorSettingsService,
  keys: readonly OperatorSettingKey[] = BOOT_CRITICAL_SETTING_KEYS,
): BootCriticalRejection[] {
  const found: BootCriticalRejection[] = [];

  for (const key of keys) {
    const definition = OPERATOR_SETTINGS[key];
    const resolved = settings.resolve(key);
    if (resolved.invalid === undefined) continue;

    const where =
      resolved.invalid.source === 'database'
        ? `the stored Control Center value for ${key}`
        : `${definition.envVar}`;

    found.push({
      key,
      // The VALUE is deliberately absent. `github.apiBaseUrl` is not marked
      // `secret`, but the reason this key refuses the boot at all is that it
      // decides where a credential is sent, and a startup banner is the most
      // widely pasted text a deployment produces. The operator does not need
      // it quoted back: they are looking at the variable they just set.
      message:
        `${where} is not a valid value for "${definition.label}" ` +
        `(${resolved.invalid.reason}). This setting decides where a ` +
        `credential is sent, so there is no safe value to fall back to — ` +
        `the declared default (${JSON.stringify(definition.default)}) is a ` +
        `different host from the one that was named. Correct it and start ` +
        `again.`,
    });
  }

  return found;
}

/**
 * Refuses the boot if any of the above holds.
 *
 * `onApplicationBootstrap`, not `onModuleInit` and not a constructor, for
 * `UnreadableSecretsBootCheck`'s reason: it reads the database overlay, which
 * `OperatorSettingsService` loads in ITS `onModuleInit`, and Nest starts every
 * provider hook within a module together and awaits them with `Promise.all`.
 * A sibling hook would see an overlay that has not loaded; a constructor would
 * never see one at all (#436, #437).
 */
@Injectable()
export class BootCriticalSettingsCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootCriticalSettingsCheck.name);

  constructor(private readonly settings: OperatorSettingsService) {}

  onApplicationBootstrap(): void {
    const rejected = bootCriticalRejections(this.settings);
    if (rejected.length === 0) return;

    // Logged individually as well as thrown: the thrown message is what Nest
    // prints, and a deployment that captures the logger's output separately
    // (the reference one does) should have the same sentences there.
    for (const rejection of rejected) {
      this.logger.error(rejection.message);
    }

    throw new Error(
      `The API cannot start with ${rejected.length} invalid ` +
        `boot-critical setting${rejected.length === 1 ? '' : 's'}:\n` +
        rejected.map((rejection) => `  - ${rejection.message}`).join('\n'),
    );
  }
}
