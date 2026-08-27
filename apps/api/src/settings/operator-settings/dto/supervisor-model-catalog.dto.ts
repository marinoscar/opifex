import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MODEL_CATALOG_STATUSES } from '../../../supervisor/invocation/model-catalog.service';
import { MODEL_ADMISSIONS } from '../../../supervisor/invocation/model-version';
import { SUPERVISOR_MODEL_PROVIDERS } from '../../../supervisor/invocation/supervisor-model.config';

/**
 * What `GET /api/operator-settings/supervisor-models` answers (#393, epic
 * #391).
 *
 * ## Every vocabulary here is imported, none is restated
 *
 * The provider list, the three admission states and the seven statuses all
 * come from `supervisor/invocation/`. That is not tidiness: `supervisor-model
 * .port.ts` says "nothing outside `invocation/` may name a model provider" and
 * `test/governing/supervisor-provider-seam.spec.ts` asserts it over the
 * source, so a DTO that spelled `'anthropic'` into a `z.enum` would fail the
 * build. The same discipline is applied to the other two enums for the weaker
 * but real reason: a copy is a second thing to update, and the one that gets
 * missed is a response the schema rejects at runtime.
 *
 * ## Why a failure is a 200 with a `status`
 *
 * The same rule the probes follow. "The request failed" and "the request found
 * a failure" are the two things this endpoint exists to tell apart, and behind
 * one HTTP status they are indistinguishable to the client. So an invalid key,
 * an unreachable host and a key for the other provider are all successful
 * responses carrying a finding — and the client renders one shape, always.
 */

export const catalogModelSchema = z.object({
  /** The exact string to write to `supervisor.model.name`. Verbatim. */
  id: z.string(),
  /** The vendor's own label, where it publishes one. */
  displayName: z.string().nullable(),
  /**
   * The version read out of the id, e.g. `"4.6"`.
   *
   * **Null is not a failure and never a reason to hide the model.** It means
   * the id did not match a scheme this API knows, which is expected the moment
   * a vendor changes its naming — and the model that would fail to parse first
   * is precisely the newest one. See `admission`.
   */
  version: z.string().nullable(),
  /**
   * One of three states. **A model is never omitted for its version.**
   *
   * `admitted` clears the floor, `below_threshold` does not, and
   * `version_unrecognised` could not be read. A client is free to collapse the
   * last two into "not recommended", but it must not drop them silently: an
   * operator who cannot find the model they came for needs to see it listed
   * and marked, not absent and unexplained.
   */
  admission: z.enum(MODEL_ADMISSIONS),
  /** When the vendor published it, or null when it did not say. */
  createdAt: z.iso.datetime().nullable(),
});

export const supervisorModelCatalogSchema = z.object({
  /** Which provider was asked — `supervisor.model.provider`, as resolved. */
  provider: z.enum(SUPERVISOR_MODEL_PROVIDERS),
  /**
   * What happened, in one word the UI can branch on.
   *
   * Each value names a different remedy, which is the point: `invalid_key`
   * means get another key, `wrong_provider` means the key is probably fine and
   * the provider setting is not, `unreachable` means nothing was even asked.
   */
  status: z.enum(MODEL_CATALOG_STATUSES),
  /** One human sentence, safe to render. Never contains the API key. */
  detail: z.string(),
  /** The version floor applied for this provider, e.g. `"4.6"`. */
  minimumVersion: z.string(),
  /**
   * Always `false`. Listing models bills nothing on either provider.
   *
   * A field rather than a line of documentation, so that a UI can show this
   * apart from the Test button — which makes a real, billed call and is rate
   * limited for it — without hard-coding which of this API's routes are free.
   */
  spendsTokens: z.boolean(),
  /** Empty on every failure, and possibly empty on success. */
  models: z.array(catalogModelSchema),
  checkedAt: z.iso.datetime(),
});

export class SupervisorModelCatalogDto extends createZodDto(
  supervisorModelCatalogSchema,
) {}
