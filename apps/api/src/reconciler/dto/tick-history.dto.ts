import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const tickHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** Filter to one outcome — `completed`, `partial`, `skipped-locked`, ... */
  outcome: z.string().min(1).max(40).optional(),
  /**
   * Only ticks that computed at least one action.
   *
   * The review filter: a week is ~10,000 ticks, and in a healthy factory
   * almost all of them did nothing. Reading the week means reading the ones
   * that decided something.
   */
  actionsOnly: z.stringbool().optional(),
});

export class TickHistoryQueryDto extends createZodDto(tickHistoryQuerySchema) {}

export const tickRecordSchema = z.object({
  id: z.uuid(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().int(),
  outcome: z.string(),
  repositoriesObserved: z.number().int(),
  actionsComputed: z.number().int(),
  /**
   * GitHub writes this tick issued — everything that got past
   * `GITHUB_WRITES_ENABLED` and was sent, whether it changed anything, found
   * the state already correct, or failed.
   *
   * Zero for the whole observation week because the kill switch is off, and
   * that is the point: a non-zero value there means something is enabled that
   * should not be. NOT a subset of `actionsComputed` — a spec-feedback comment
   * and a dispatch branch are writes with no computed action behind them.
   */
  actionsExecuted: z.number().int(),
  allFromCache: z.boolean(),
  rateLimitRemaining: z.number().int().nullable(),
  /**
   * The tick-scoped settings snapshot this tick actually ran under — `{
   * retryCeiling, rateLimitReserve, writesEnabled }` — read once at the top
   * of `tick()` rather than frozen at process construction, so it is safe to
   * compare across ticks: two rows can legitimately disagree on
   * `retryCeiling` if the setting changed between them, and that disagreement
   * is the point, not a bug (#342).
   *
   * `null` means this tick predates the column, never "the defaults" and
   * never "whatever the setting is now" — neither is what that tick actually
   * ran under. `.describe`, not just the comment, for the same OpenAPI
   * reason `executionFailures` below carries one.
   */
  settings: z
    .unknown()
    .nullable()
    .describe(
      'The tick-scoped settings snapshot this tick ran under — { retryCeiling, ' +
        'rateLimitReserve, writesEnabled } — read once at the top of tick() rather than frozen ' +
        'at process construction, so two rows can legitimately disagree on retryCeiling if the ' +
        'setting changed between them. null means this tick predates the column: it is not the ' +
        'defaults and not the current live value, since neither is what that tick actually ran ' +
        'under.',
    ),
  /** Repositories that could not be OBSERVED, `[{ repository, reason }]`. */
  failures: z.unknown(),
  /**
   * Failures from the tick's ACTING phase — mirror-label writes and
   * spec-feedback comments — as `[{ source, actionType, repository,
   * issueNumber, reason }]`. Unrelated to `failures` above, which is
   * observation-only.
   *
   * `null` and `[]` mean different things and the difference matters: `null`
   * means no acting-phase executor ran on this tick at all, which is the
   * normal state while `GITHUB_WRITES_ENABLED` is off and nothing is being
   * acted on; `[]` means one ran and reported nothing wrong. A clean tick is
   * `[]`; a tick that never tried is `null`. Do not treat them as the same.
   *
   * A `reason` is not necessarily a GitHub error — a label action that
   * carried no label is reported here too, and that is a defect in the diff
   * engine rather than a refused write.
   *
   * Scoped to the reconciler's own executors. A dispatch that failed to post
   * its authorization record or create its branch is counted in
   * `actionsExecuted` but reported on the RUN, not here.
   */
  executionFailures: z
    .unknown()
    .nullable()
    // `.describe`, not just the comment above: a JSDoc comment on a zod field
    // does NOT reach the generated OpenAPI document (verified against
    // `npm run openapi:dump`), and this distinction is one an API consumer has
    // to be told about rather than infer.
    .describe(
      "Failures from the tick's ACTING phase — mirror-label writes and spec-feedback " +
        'comments — as [{ source, actionType, repository, issueNumber, reason }]. Unrelated ' +
        'to failures, which is observation-only. null and [] are NOT the same: null means no ' +
        'acting-phase executor ran on this tick at all, [] means one ran and reported nothing ' +
        'wrong. A reason is not necessarily a GitHub error — a label action that carried no ' +
        'label is reported here too, and that is a defect in the diff engine rather than a ' +
        "refused write. Scoped to the reconciler's own executors: a dispatch that failed to " +
        'post its authorization record or create its branch is counted in actionsExecuted but ' +
        'reported on the run, not here.',
    ),
  /** Null on a quiet tick — see the retention note on the Prisma model. */
  projections: z.unknown().nullable(),
  actions: z.unknown().nullable(),
});

export class TickRecordDto extends createZodDto(tickRecordSchema) {}
