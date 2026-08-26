/**
 * An audit row, turned into something a person can read — without ever
 * rendering a credential (#351, epic #332).
 *
 * Pure, like `config/readiness.ts` and for the same reason: the rule this file
 * enforces is the one part of the History section that must be testable
 * without a DOM, because it is the part that is a security property rather
 * than a layout.
 *
 * ## The rule
 *
 * **A secret renders as `set` or `cleared`. Never as a value, never as a
 * partial value, never as a before-and-after.**
 *
 * #337 already redacts on the way into `audit_events.meta` and #338 redacts
 * again on the way out, so what arrives here should carry no plaintext. This
 * module does not rely on that, for two reasons:
 *
 *  1. **The mask is not empty.** `maskSecret` reveals the last four characters
 *     of anything 16 characters or longer, so a redacted row still arrives as
 *     `********Ly5Hs`. That suffix is useful in the Credentials section, where
 *     an operator is matching a value against one they hold. In a history it
 *     is four characters of a credential printed beside the name of the key it
 *     belongs to and the identity of the account that holds it — so this
 *     module drops it, and a masked value is never printed at all.
 *  2. **A denylist fails open, silently.** `redact.ts` says so itself. If a
 *     future writer records a credential under a field name nobody added to
 *     the list, the API would serve it and a UI that printed whatever it was
 *     given would publish it. Deciding here, from the FIELD NAME and the
 *     SETTING KEY rather than from whether the server happened to mask it,
 *     means the browser is a second independent judge rather than an echo.
 *
 * ## Where `set` and `cleared` come from
 *
 * From the ACTION, never from the value. This matters: a secret's `from` is
 * masked whether it held a token or nothing at all —
 * `maskSecretValue(null)` is the same `********` as `maskSecretValue('ghp_…')`
 * — so "was there a value before?" is genuinely unanswerable from the row, and
 * inferring one would be inventing a fact. `operator_settings:clear` says the
 * override was removed; `operator_settings:set` says one was written. That is
 * the whole of what is known, and it is what gets rendered.
 */

/** The fixed-width mask `apps/api/src/common/crypto/redact.ts` writes. */
export const MASK = '********';

/**
 * Field-name fragments that mean "this is a credential".
 *
 * A deliberate mirror of `SECRET_NAME_FRAGMENTS` in
 * `apps/api/src/common/crypto/redact.ts`. Duplicated rather than shared
 * because no endpoint publishes that list to a browser and inventing one to
 * carry it would put a network round trip between this component and its own
 * safety rule.
 *
 * Drift here fails in the safe direction as long as this list is a SUPERSET,
 * which is why it keeps the API's entries verbatim and adds none of its own
 * exclusions. If the two ever disagree, the API masks the value and this file
 * refuses to print the mask: both of those are refusals.
 *
 * Bare `key` is absent for the reason `redact.ts` gives — it would swallow
 * `keyVersion`, `settingKey` and `publicKey`, and an over-masked audit log is
 * a log nobody can read, which is its own failure.
 */
const SECRET_NAME_FRAGMENTS: readonly string[] = [
  'secret',
  'token',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'apikey',
  'privatekey',
  'signingkey',
  'encryptionkey',
  'accesskey',
  'authorization',
  'ciphertext',
  'encrypted',
];

/** `API_KEY`, `apiKey` and `github.token` all normalise to one comparable form. */
function normaliseFieldName(name: string): string {
  return name.toLowerCase().replace(/[-_.\s]/g, '');
}

/**
 * Is this field name one whose value must never be printed?
 *
 * Takes any number of names because a settings row's value lives under `from`
 * and `to` — names that say nothing about what they hold — while the thing
 * that knows is the setting key beside them (`github.token`). Both are asked,
 * and one match is enough.
 */
export function isSecretFieldName(...names: (string | null | undefined)[]) {
  return names.some((name) => {
    if (!name) return false;
    const normalised = normaliseFieldName(name);
    return SECRET_NAME_FRAGMENTS.some((fragment) =>
      normalised.includes(fragment),
    );
  });
}

/**
 * Has this value already been masked by the API?
 *
 * The last line of defence: a field the denylist does not recognise, holding a
 * value the API DID recognise. Treating a masked value as secret means the two
 * judgements are OR-ed rather than either being trusted alone.
 */
export function looksMasked(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(MASK);
}

/**
 * What happened to a secret, as far as the row actually records it.
 *
 * `changed` is the honest answer for any action that is not one of the
 * settings verbs: something moved, and the row does not say in which
 * direction.
 */
export type SecretEffect = 'set' | 'cleared' | 'changed';

/** One field that the recorded action changed. */
export interface AuditChange {
  /** The field or setting key. Always safe to print — it is a name. */
  field: string;
  /**
   * True when this field's VALUE must not be rendered. When true, `from` and
   * `to` are `null` and `effect` carries the whole of what is known.
   */
  secret: boolean;
  /** The value before, already formatted. `null` when the row did not record one. */
  from: string | null;
  /** The value after, already formatted. `null` when the row did not record one. */
  to: string | null;
  /** Only for a secret field. Never derived from a value — see the header. */
  effect: SecretEffect | null;
  /** `default` / `env` / `database`, when the writer recorded where it came from. */
  fromSource?: string;
  toSource?: string;
}

/** `operator_settings:clear` → `cleared`; `…:set` → `set`; anything else → `changed`. */
export function secretEffectOf(action: string): SecretEffect {
  if (action.endsWith(':clear')) return 'cleared';
  if (action.endsWith(':set')) return 'set';
  return 'changed';
}

/** The sentence a secret change gets INSTEAD of a value. */
export function describeSecretEffect(effect: SecretEffect): string {
  switch (effect) {
    case 'set':
      return 'Secret set';
    case 'cleared':
      return 'Secret cleared';
    default:
      return 'Secret changed';
  }
}

/**
 * How long a formatted value may get before it is cut.
 *
 * A settings document nested inside a `meta` can serialise to kilobytes, and a
 * table cell is not where that is read. The truncation is visible (`…`) rather
 * than silent.
 */
const MAX_VALUE_LENGTH = 120;

/**
 * A JSON value as one line of text.
 *
 * `null` in, `'not set'` out — and that is a formatting choice with teeth
 * elsewhere in this file: it is only ever reached for a NON-secret field,
 * because a secret's absence is exactly the thing the row cannot prove.
 */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'string') return truncate(value === '' ? '""' : value);
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  try {
    return truncate(JSON.stringify(value) ?? String(value));
  } catch {
    // A cycle, or a BigInt. The row still gets a cell.
    return '[unprintable]';
  }
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_LENGTH
    ? `${value.slice(0, MAX_VALUE_LENGTH)}…`
    : value;
}

/** Fields of the settings-shaped `meta` that are not the change itself. */
const SETTINGS_META_FIELDS = new Set([
  'key',
  'from',
  'to',
  'fromSource',
  'toSource',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * The changes an audit row records, in a form that can be rendered directly.
 *
 * Two shapes are understood, and an unknown third is handled rather than
 * dropped:
 *
 *  1. **The settings shape** — `{ key, from, to, fromSource?, toSource? }`,
 *     which `operator-settings.service.ts` writes for every `set` and `clear`.
 *     One change, named by `key`, with both sides.
 *  2. **Anything else that is an object** — one change per top-level field,
 *     with no "before". `{ email }` from the allowlist, `{ roles }` from a
 *     role update. A `from` of `null` here says the row did not record one;
 *     it does not claim the field was previously empty.
 *  3. **A scalar or an absent `meta`** — no changes. The caller renders the
 *     action and the target, which is still the whole of what happened.
 */
export function auditChangesOf(event: {
  action: string;
  targetId?: string;
  meta: unknown;
}): AuditChange[] {
  const meta = event.meta;
  if (!isPlainRecord(meta)) return [];

  if (typeof meta.key === 'string' && ('from' in meta || 'to' in meta)) {
    return [
      settingsChange(
        meta.key,
        meta.from,
        meta.to,
        event.action,
        stringOrUndefined(meta.fromSource),
        stringOrUndefined(meta.toSource),
      ),
      ...Object.entries(meta)
        .filter(([field]) => !SETTINGS_META_FIELDS.has(field))
        .map(([field, value]) => plainChange(field, value, event.action)),
    ];
  }

  return Object.entries(meta).map(([field, value]) =>
    plainChange(field, value, event.action),
  );
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The settings shape's one change.
 *
 * The secret decision is made from THREE independent signals, OR-ed: the
 * setting key's own name (`github.token`), and whether either side arrived
 * masked. Any one of them is enough, and no value is printed when any fires.
 */
function settingsChange(
  key: string,
  from: unknown,
  to: unknown,
  action: string,
  fromSource: string | undefined,
  toSource: string | undefined,
): AuditChange {
  const secret = isSecretFieldName(key) || looksMasked(from) || looksMasked(to);

  return {
    field: key,
    secret,
    from: secret ? null : formatAuditValue(from),
    to: secret ? null : formatAuditValue(to),
    effect: secret ? secretEffectOf(action) : null,
    ...(fromSource ? { fromSource } : {}),
    ...(toSource ? { toSource } : {}),
  };
}

/** A bare `field: value` pair from any other writer's `meta`. */
function plainChange(
  field: string,
  value: unknown,
  action: string,
): AuditChange {
  const secret = isSecretFieldName(field) || looksMasked(value);

  return {
    field,
    secret,
    from: null,
    to: secret ? null : formatAuditValue(value),
    effect: secret ? secretEffectOf(action) : null,
  };
}

/**
 * The changes as ONE line of plain text — for a CSV export and for a tooltip.
 *
 * Built from `AuditChange`, never from the raw `meta`, so the export cannot
 * carry a value the screen refused to draw. A CSV is the easier of the two to
 * leak by accident, because nobody reads it before it lands in a downloads
 * folder.
 */
export function describeAuditChanges(changes: AuditChange[]): string {
  return changes
    .map((change) => {
      if (change.secret && change.effect) {
        return `${change.field}: ${describeSecretEffect(change.effect).toLowerCase()}`;
      }
      if (change.from !== null && change.to !== null) {
        return `${change.field}: ${change.from} → ${change.to}`;
      }
      return `${change.field}: ${change.to ?? change.from ?? 'not recorded'}`;
    })
    .join('; ');
}

/**
 * Who acted, as a fact rather than a guess.
 *
 * The three cases are three different claims, and the audit log's whole job is
 * to keep them apart — see `types/audit.ts`.
 */
export function describeAuditActor(event: {
  actorUserId: string | null;
  actor: { email: string; displayName: string | null } | null;
}): string {
  if (event.actor) return event.actor.displayName ?? event.actor.email;
  if (event.actorUserId) return 'Deleted account';
  return 'Opifex itself';
}

/**
 * A target type an operator can choose from, for the filter.
 *
 * Read off the nine writers of `audit_events` in the API
 * (`grep -rn 'targetType:' apps/api/src`). The endpoint's own parameter is a
 * free string and deliberately so — a closed enum server-side would stop
 * matching the first time a writer added a kind — so this list is an
 * affordance, not a contract: it is what an operator can pick WITHOUT typing,
 * and a value outside it simply returns whatever the server has.
 *
 * `operator_settings` is first because it is what this section is for.
 */
export const AUDIT_TARGET_TYPES: readonly { value: string; label: string }[] = [
  { value: 'operator_settings', label: 'Operator settings' },
  { value: 'system_settings', label: 'System settings' },
  { value: 'user', label: 'Users' },
  { value: 'allowed_email', label: 'Allowlist' },
  { value: 'repository', label: 'Repositories' },
  { value: 'work_order', label: 'Work orders' },
  { value: 'storage_object', label: 'Storage objects' },
  { value: 'action-class', label: 'Action classes' },
];

/** The target type shown when the row names one this app has no label for. */
export function auditTargetTypeLabel(targetType: string): string {
  return (
    AUDIT_TARGET_TYPES.find((entry) => entry.value === targetType)?.label ??
    targetType
  );
}
