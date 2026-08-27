/**
 * `GET /api/operator-settings/supervisor-models`, as the Control Center reads
 * it (#394, epic #391).
 *
 * A mirror of
 * `apps/api/src/settings/operator-settings/dto/supervisor-model-catalog.dto.ts`,
 * and loose in exactly one place for exactly one reason.
 *
 * ## `provider` is a `string`, the other two vocabularies are unions
 *
 * `admission` and `status` are closed sets the UI must BRANCH on — three marks
 * and six explanations, each naming a different remedy — so a union is what
 * makes an unhandled member a compile error rather than a blank panel. Both
 * renderers still fall back on an unrecognised member (see
 * `config/supervisorModel.ts`), because the API may publish a seventh status
 * before this build knows about it, and "we do not recognise this" is a
 * better sentence than nothing at all.
 *
 * `provider` is deliberately NOT a union. The legal providers are declared
 * once, in `supervisor/invocation/supervisor-model.config.ts`, and reach this
 * screen as `constraints.values` on the `supervisor.model.provider` setting —
 * so the picker is populated from the response the same way every other enum
 * control in the Control Center is. A union here would be a second, silent
 * declaration of the vendor list in `apps/web`, and the day a third adapter
 * lands it is the copy that stays wrong.
 *
 * ## A failure is a 200, so there is one shape and never two
 *
 * `no_key`, `invalid_key`, `wrong_provider`, `unreachable`, `refused` and
 * `failed` all arrive as successful responses carrying `models: []`. Nothing
 * in the UI has to tell an HTTP error apart from a finding, which is the whole
 * reason the API answers this way.
 */

/** What the version filter decided about one model id. Three states, never two. */
export type ModelAdmission =
  'admitted' | 'below_threshold' | 'version_unrecognised';

/**
 * Why the list is what it is. Each member names a different remedy.
 *
 * `wrong_provider` is the one that only becomes possible now there are two
 * providers, and it is the reason this is not a boolean: it means the key is
 * probably fine and the provider setting is not.
 */
export type SupervisorModelCatalogStatus =
  | 'ok'
  | 'no_key'
  | 'invalid_key'
  | 'wrong_provider'
  | 'unreachable'
  | 'refused'
  | 'failed';

/** One model, as the provider offered it. Never omitted for its version. */
export interface CatalogModel {
  /** The exact string written to `supervisor.model.name`. Verbatim. */
  id: string;
  /** The vendor's own label, where it publishes one. */
  displayName: string | null;
  /** `"4.6"`, or null when the id did not parse. Null is not a failure. */
  version: string | null;
  admission: ModelAdmission;
  /** ISO-8601, or null when the vendor did not say. */
  createdAt: string | null;
}

/** The whole answer. One object, whatever happened. */
export interface SupervisorModelCatalog {
  /** Which provider was asked — `supervisor.model.provider`, as resolved. */
  provider: string;
  status: SupervisorModelCatalogStatus;
  /** One human sentence, safe to render. The key is redacted out of it. */
  detail: string;
  /** The floor applied for this provider, e.g. `"4.6"`. */
  minimumVersion: string;
  /**
   * Whether listing bills anything. False on both providers today.
   *
   * Read rather than assumed: the Test button beside this one spends real
   * money, and a UI that hard-coded which of the two is free would be the copy
   * that stays wrong the day a vendor starts charging for a catalogue read.
   */
  spendsTokens: boolean;
  /**
   * Empty on every failure, and possibly empty on success.
   *
   * **Pre-sorted by the API** — admitted, then `version_unrecognised`, then
   * `below_threshold` — and that order is deliberate. Nothing in `apps/web`
   * re-sorts it.
   */
  models: CatalogModel[];
  checkedAt: string;
}
