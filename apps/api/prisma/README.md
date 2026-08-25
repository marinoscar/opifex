# Prisma schema and migrations

## Ids are application-generated, not database-generated

Every UUID-keyed model in `schema.prisma` uses `@default(uuid())` — Prisma 7
generates the id **client-side**, in the `@prisma/adapter-pg` driver adapter,
before the `INSERT` is ever sent. No model uses `@default(dbgenerated(...))`.

Do **not** add a database-side default (`DEFAULT gen_random_uuid()`,
`DEFAULT uuid_generate_v4()`, or similar) to an `id` column in a new
migration. It is not required, and it will not do what it looks like it does:
Prisma Client always supplies `id` on insert, so a database-side default only
ever fires on a row inserted by raw SQL — and this codebase has none. See
`grep -rn "INSERT INTO" apps/api/src apps/api/prisma/seed.ts scripts/`, which
turns up nothing but the seed and service code calling into Prisma Client.

### Why this needed writing down (#134)

The original `20260124223146_initial` migration gave all twelve of its tables
a database-side `DEFAULT uuid_generate_v4()`. That was drift from day one —
`schema.prisma` never described it — and it went unnoticed until Prisma 7's
diffing started proposing `ALTER TABLE ... ALTER COLUMN "id" DROP DEFAULT`
for all twelve every time `prisma migrate dev` ran, because Prisma diffs the
database against the schema and the schema has never claimed that default.

Rather than fix the twelve, six more tables independently picked up the same
pattern with `DEFAULT gen_random_uuid()`, each written by hand to match the
_previous_ hand-written migration instead of the schema. `20260830120000_drop_id_defaults`
drops the default on all eighteen affected columns and closes the gap for
good. The tables it covers:

- `users`, `user_identities`, `roles`, `permissions`, `system_settings`,
  `user_settings`, `audit_events`, `refresh_tokens`, `allowed_emails`,
  `device_codes`, `storage_objects`, `storage_object_chunks` — all from
  `20260124223146_initial`
- `supervisor_invocations`, `supervisor_proposals` — from
  `20260824120000_supervisor_decision_log`
- `trust_grants` — from `20260825120000_trust_grants`
- `approval_requests` — from `20260826120000_approval_requests`
- `promotion_states` — from `20260827120000_promotion_state`
- `dead_intervals` — from `20260829120000_dead_intervals`

### What a future `migrate dev` run will (and won't) try to do

With `20260830120000_drop_id_defaults` applied, `npx prisma migrate diff
--from-config-datasource --to-schema prisma/schema.prisma --script` against
an unchanged schema should produce an **empty** script — that emptiness is
the actual acceptance test for this convention, not just for this one
migration. If a future migration adds a new UUID-keyed table and someone
writes `DEFAULT gen_random_uuid()` into its `CREATE TABLE` by hand (to match
older migrations by eye, as happened here), the drift comes right back for
that one table, and the next `migrate dev` will propose exactly one
`ALTER TABLE "<new_table>" ALTER COLUMN "id" DROP DEFAULT` line. That line is
not spurious — it means the new table needs the same treatment as
`schema.prisma` already describes: no database-side default, full stop.

### The stray empty migration

`migrations/20260822062112_add_run_event_external_id/` is a zero-byte
`migration.sql`; the real DDL for that change landed sixteen seconds later in
`migrations/20260822062128_add_run_event_external_id/`. It looks untidy but
it is left in place deliberately: every applied migration directory has a
corresponding checksummed row in `_prisma_migrations`, and removing the
directory on a database that has already recorded that row turns a harmless
no-op into a missing-migration failure on the next `migrate deploy`. Don't
delete it.
