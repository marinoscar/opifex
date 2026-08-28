import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  type OperatorSettingKey,
} from './operator-settings.registry';
import { OperatorSettingsService } from './operator-settings.service';

/**
 * Every stored credential that will not decrypt, said at boot (#422).
 *
 * ## What was wrong with only reporting it lazily
 *
 * `OperatorSettingsService.resolveSecretSetting` has always refused to fall
 * back to the environment for a ciphertext that fails to open, and it warns —
 * once, on the first READ of that key. For a model credential the first read
 * is the first model call, which for the supervisor is the next scheduled tick
 * and for a chat is whenever somebody types something. So the interval between
 * "this deployment's credential is unreadable" and "anybody is told" was up to
 * an hour, and the telling happened in the middle of an unrelated failure.
 *
 * #422's acceptance criterion is explicit that this fails loudly at boot
 * rather than at the first model call, so the read happens here, eagerly, for
 * every secret key at once.
 *
 * ## Loud is `error`, not a refusal to start
 *
 * `secret-box.ts`'s header and `config/env.validation.ts` agree on the test,
 * and it is not importance: it is whether the rest of the service is still
 * telling the truth without the missing thing. Without `JWT_SECRET` every
 * authorization decision the process makes is void and there is nothing safe
 * left to serve. An unreadable model credential voids nothing — every other
 * request is answered correctly, the adapter refuses per call and records the
 * refusal, and the Control Center can show the operator which slot is broken
 * and why. A process that stays up is the one that can be asked. So this logs
 * at `error` with the remedy named and returns.
 *
 * ## It says nothing when there is nothing to say
 *
 * No line per secret key, and no line for a key that is simply unset. A boot
 * that printed a status line for every credential slot would teach an operator
 * to skim exactly the messages this file exists to make visible — the same
 * argument `operator-settings.env-disagreement.ts` makes for warning only on
 * disagreement.
 */

/** One credential that is stored and cannot be read. */
export interface UnreadableSecret {
  readonly key: OperatorSettingKey;
  readonly reason: string;
  /** The whole operator-facing sentence, remedy included. */
  readonly message: string;
}

/**
 * Every secret key whose stored value will not open.
 *
 * PURE — it asks the resolver and formats, nothing else — so the wording an
 * operator will actually read is testable without a Nest container, the same
 * reason `retiredSupervisorWarnings` and `operatorEnvDisagreements` are
 * separate from the services that hold them.
 *
 * Driven off the registry's own `secret` flag rather than a list, so a
 * credential added later is covered without anyone remembering this file.
 */
export function unreadableSecrets(
  settings: OperatorSettingsService,
  keys: readonly OperatorSettingKey[] = OPERATOR_SETTING_KEYS,
): UnreadableSecret[] {
  const found: UnreadableSecret[] = [];

  for (const key of keys) {
    const definition = OPERATOR_SETTINGS[key];
    if (!definition.secret) continue;

    const resolved = settings.resolve(key);
    if (resolved.error === undefined) continue;

    found.push({
      key,
      reason: resolved.error.reason,
      message:
        `${key} has a stored credential that cannot be decrypted ` +
        `(${resolved.error.reason}). It is NOT in force and nothing falls ` +
        `back to it: "${definition.label}" reads as unconfigured, and every ` +
        `caller that needs it will refuse. ${resolved.error.message} ` +
        `Either restore the OPIFEX_SETTINGS_ENCRYPTION_KEY this value was ` +
        `sealed with and restart, or save the credential again from the ` +
        `Control Center — ${definition.envVar} in the environment will NOT ` +
        `be used while the unreadable row exists.`,
    });
  }

  return found;
}

/**
 * Says the above once, at boot.
 *
 * `onModuleInit` rather than the constructor — unlike
 * `RetiredSupervisorConfigService`, which reads `process.env` and can answer
 * from a constructor, this has to read the database OVERLAY, and the overlay
 * is loaded by `OperatorSettingsService.onModuleInit`. Nest resolves that
 * dependency first and runs its hook first, so by the time this runs the rows
 * have been read once.
 */
@Injectable()
export class UnreadableSecretsBootCheck implements OnModuleInit {
  private readonly logger = new Logger(UnreadableSecretsBootCheck.name);

  constructor(private readonly settings: OperatorSettingsService) {}

  onModuleInit(): void {
    // An overlay that never loaded has no rows to judge, and would report
    // every credential as absent rather than as broken. The overlay's own
    // warning already covers that case, in its own words.
    if (this.settings.overlay().status !== 'loaded') return;

    for (const found of unreadableSecrets(this.settings)) {
      this.logger.error(found.message);
    }
  }
}
