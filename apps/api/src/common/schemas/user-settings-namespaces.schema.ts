import { z } from 'zod';

// =============================================================================
// User Settings Namespaces: `dataTables` and `navigation`
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// The user-settings shape is currently hand-maintained in five separate zod
// declarations (common/schemas/settings.schema.ts x2,
// settings/dto/update-user-settings.dto.ts x2, and
// settings/dto/user-settings-response.dto.ts) plus one plain TS interface in
// common/types/settings.types.ts. Adding a namespace to only some of them means
// the payload is silently stripped by `userSettingsSchema.parse()` and never
// round-trips through a subsequent GET.
//
// These two namespaces are therefore declared ONCE, here, and imported by every
// copy. Deduplicating the pre-existing `theme` / `profile` declarations is
// deliberately out of scope (no behaviour change in this pass), but any NEW
// namespace should be added here rather than copy-pasted five times.
//
// SECURITY: THE BOUNDS BELOW ARE A CONTROL, NOT ERGONOMICS
// --------------------------------------------------------
// `user_settings.value` is a JSONB blob that the user themselves writes via
// PUT/PATCH /api/user-settings. An unbounded user-controlled record is a
// storage-exhaustion vector: without a cap on the number of table entries, the
// number of column ids per entry, and the length of each id, an authenticated
// user can inflate a single row without limit. Every limit below exists to
// close that, and must not be relaxed for convenience.
//
// CRITICAL: NO `.default()` ANYWHERE IN THIS FILE
// ------------------------------------------------
// Absent MUST mean "use the application's built-in defaults", computed at read
// time by the consumer. This is load-bearing, not style.
//
// Concretely: if `visibleColumns` defaulted to `[]` (or to today's column list),
// then the first time a user merely opened a density menu — touching a totally
// unrelated preference — the persisted entry would materialise a frozen column
// set. Every column added to that table afterwards would be silently invisible
// to that user forever, with no error and no signal that anything was wrong,
// and the only remedy would be a manual settings reset. The same argument
// applies to `density`, `pageSize`, `sort`, and `railCollapsed`. Persist only
// what the user actually chose.
//
// =============================================================================

/**
 * Maximum number of per-table entries a single user may persist.
 *
 * NOTE: this cap CANNOT be expressed in `z.record()` — zod has no "max number
 * of keys" refinement that survives the record type. It is enforced in
 * UserSettingsService after the merge instead. See that service for why
 * enforcing it here would produce a 500 rather than a 400.
 */
export const DATA_TABLE_MAX_TABLES = 40;

/** Allowed shape of a table identifier (lowercase slug). */
export const DATA_TABLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Maximum length of a table identifier and of a column identifier. */
export const DATA_TABLE_MAX_ID_LENGTH = 64;

/** Maximum number of column ids that may be persisted for a single table. */
export const DATA_TABLE_MAX_VISIBLE_COLUMNS = 60;

/** Maximum persisted page size for a single table. */
export const DATA_TABLE_MAX_PAGE_SIZE = 500;

/** Row density options exposed by the data table component. */
export const dataTableDensitySchema = z.enum([
  'compact',
  'standard',
  'comfortable',
]);

/** Sort direction options. */
export const dataTableSortDirectionSchema = z.enum(['asc', 'desc']);

/** Persisted sort state for a single table. */
export const dataTableSortSchema = z
  .object({
    field: z.string().min(1).max(DATA_TABLE_MAX_ID_LENGTH),
    direction: dataTableSortDirectionSchema,
  })
  .strict();

/**
 * Persisted preferences for a single data table.
 *
 * Every key is optional and NONE has a `.default()` — see the file header.
 */
export const dataTableEntrySchema = z
  .object({
    visibleColumns: z
      .array(z.string().min(1).max(DATA_TABLE_MAX_ID_LENGTH))
      .max(DATA_TABLE_MAX_VISIBLE_COLUMNS)
      .optional(),
    density: dataTableDensitySchema.optional(),
    sort: dataTableSortSchema.optional(),
    pageSize: z.number().int().min(1).max(DATA_TABLE_MAX_PAGE_SIZE).optional(),
  })
  .strict();

/** Table identifier key schema, shared by the full and patch record schemas. */
export const dataTableIdSchema = z
  .string()
  .min(1)
  .max(DATA_TABLE_MAX_ID_LENGTH)
  .regex(DATA_TABLE_ID_PATTERN);

/**
 * Full `dataTables` namespace: a map of table id -> preferences.
 *
 * zod v4 requires BOTH a key and a value schema for `z.record`.
 */
export const dataTablesSchema = z.record(
  dataTableIdSchema,
  dataTableEntrySchema,
);

/**
 * PATCH form of the `dataTables` namespace.
 *
 * The value is nullable because JSON Merge Patch uses `null` to mean "delete":
 * `{ dataTables: { jobs: null } }` removes the `jobs` entry. A non-null entry
 * REPLACES the stored entry for that table wholesale (it is not deep-merged) —
 * see UserSettingsService.mergeDataTables.
 */
export const dataTablesPatchSchema = z.record(
  dataTableIdSchema,
  dataTableEntrySchema.nullable(),
);

/**
 * Full `navigation` namespace.
 *
 * `railCollapsed` absent means "use the built-in default" — deliberately NOT
 * `.default(false)`, so that a future change to the default rail state reaches
 * users who never expressed a preference.
 */
export const navigationSchema = z
  .object({
    railCollapsed: z.boolean().optional(),
  })
  .strict();

/**
 * PATCH form of the `navigation` namespace: each field may additionally be
 * `null`, meaning "delete this field and fall back to the built-in default".
 */
export const navigationPatchSchema = z
  .object({
    railCollapsed: z.boolean().nullable().optional(),
  })
  .strict();

// =============================================================================
// Inferred types — derived from the schemas above so they can never drift.
// =============================================================================

export type DataTableDensity = z.infer<typeof dataTableDensitySchema>;
export type DataTableSort = z.infer<typeof dataTableSortSchema>;
export type DataTableEntry = z.infer<typeof dataTableEntrySchema>;
export type DataTablesValue = z.infer<typeof dataTablesSchema>;
export type DataTablesPatchValue = z.infer<typeof dataTablesPatchSchema>;
export type NavigationValue = z.infer<typeof navigationSchema>;
export type NavigationPatchValue = z.infer<typeof navigationPatchSchema>;
