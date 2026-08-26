import { Injectable, Logger } from '@nestjs/common';

import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  parseOperatorSetting,
  type OperatorSettingKey,
} from './operator-settings.registry';
import { OperatorSettingsService } from './operator-settings.service';

/**
 * Managed settings whose environment variable is still exported and no longer
 * agrees with the value actually in force (#340, epic #332).
 *
 * ## The confusion this exists to stop
 *
 * Before #340 an operator changed a setting by editing `infra/compose/.env`
 * and recreating the container. After it, the same variable may be overridden
 * by a database row written from the Control Center — and the file still says
 * what it always said. The failure mode is precise and quiet: someone edits
 * `.env`, restarts, watches nothing change, and has no way to find out why
 * short of reading this repository. It is the single likeliest operator
 * confusion in the whole epic.
 *
 * `supervisor/retired-config.ts` is the established precedent — that file
 * announces that a variable an operator supplied is NOT in force, for a
 * setting that was retired. This announces the same thing for a setting that
 * merely moved.
 *
 * ## Only on DISAGREEMENT, never on mere presence
 *
 * A variable that is still exported and still names the value in force is not
 * a problem and gets no line. That is not a nicety: nearly every deployment
 * exports several of these, and a boot that printed one line per exported
 * managed variable would print a dozen lines nobody can act on — which is
 * exactly how operators learn to skim warnings, and how the one line that
 * matters gets skimmed with them.
 *
 * The consequence is that today, before #339's database overlay exists, this
 * is silent by construction: the environment IS the highest-precedence layer,
 * so it can never lose. That is the correct amount of noise for a system where
 * nothing can yet override it, and the check is already in place for the
 * release where something can.
 *
 * ## Warn, not error
 *
 * Nothing is broken and nothing is unbounded. The value in force is the one
 * the operator most recently chose, through the newer of the two mechanisms;
 * the stale one is a leftover. Refusing the boot over it would take a running
 * system down to complain about a line in a file.
 *
 * ## Secrets are named, never printed
 *
 * For a `secret` key the message says the two disagree and stops there. A
 * warning that helpfully printed both the old and the new credential would put
 * two secrets in the log to report one stale line.
 */

/** How a value is rendered in a warning. Secrets are never shown. */
function describe(key: OperatorSettingKey, value: unknown): string {
  return OPERATOR_SETTINGS[key].secret ? '<redacted>' : JSON.stringify(value);
}

/**
 * The warnings an environment earns, in registry order.
 *
 * PURE, so the wording an operator will actually see is testable without a
 * Nest container — the same reason `retiredSupervisorWarnings` is separate
 * from the service that holds it.
 *
 * `env` is passed in rather than read from `process.env` so a test can drive
 * it, and so the value compared is the same one the resolver's own environment
 * layer would see.
 */
export function operatorEnvDisagreements(
  env: NodeJS.ProcessEnv,
  settings: OperatorSettingsService,
  keys: readonly OperatorSettingKey[] = OPERATOR_SETTING_KEYS,
): string[] {
  const warnings: string[] = [];

  for (const key of keys) {
    const definition = OPERATOR_SETTINGS[key];
    const raw = env[definition.envVar];

    // Unset, and empty-means-unset, match `OperatorSettingsService.rawValue`.
    // A variable written `FOO=` to mean "unset" supplies nothing, so there is
    // nothing for it to disagree with.
    if (raw === undefined || raw.trim() === '') continue;

    const supplied = parseOperatorSetting(key, raw.trim());
    // An unparseable value is already reported by the resolver, which names
    // the variable and says the default is being used instead. Saying it again
    // here in different words would be two messages about one mistake.
    if (!supplied.ok) continue;

    const effective = settings.resolve(key);
    if (effective.source === 'env') continue;
    if (Object.is(effective.value, supplied.value)) continue;

    warnings.push(
      `${definition.envVar} is set to ${describe(key, supplied.value)} and is NOT ` +
        `the value in force: ${key} resolves to ${describe(key, effective.value)} ` +
        `from the ${effective.source}, which overrides the environment. ` +
        `Change it in the Control Center, or remove ${definition.envVar} from ` +
        `your environment so the two stop disagreeing.`,
    );
  }

  return warnings;
}

/**
 * Says the above once, at boot.
 *
 * The constructor is the whole of it, exactly as
 * `RetiredSupervisorConfigService`'s is: Nest instantiates the provider once
 * per process, so an operator gets one line per disagreeing variable rather
 * than one per read.
 *
 * It reports the state at BOOT and does not follow later changes. An operator
 * who edits a setting in the Control Center while the process is running just
 * made that change deliberately, and knows it took effect — the confusion this
 * exists to catch is the one that starts with a restart.
 */
@Injectable()
export class OperatorSettingsEnvDisagreementService {
  private readonly logger = new Logger(
    OperatorSettingsEnvDisagreementService.name,
  );

  constructor(settings: OperatorSettingsService) {
    for (const warning of operatorEnvDisagreements(process.env, settings)) {
      this.logger.warn(warning);
    }
  }
}
