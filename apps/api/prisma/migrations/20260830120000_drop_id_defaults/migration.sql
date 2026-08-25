-- Land the Prisma 7 uuid-default drift deliberately (#134), instead of
-- stripping it table-by-table from every migration that happens to touch one
-- of these tables next.
--
-- Prisma 7 generates `@default(uuid())` ids client-side, in the driver
-- adapter, before the INSERT is sent. Every table below was created with a
-- database-side default as well - `uuid_generate_v4()` from the very first
-- migration, `gen_random_uuid()` from six more that were hand-written later
-- in the repo's own established style - so the database has always declared
-- a default that `schema.prisma` does not describe. `schema.prisma` carries
-- `@default(uuid())` for all thirty-one UUID-keyed models and `dbgenerated`
-- for none, so the database-side defaults are pure drift, not a documented
-- choice, and they are the reason `prisma migrate dev` on an unchanged
-- schema has never produced an empty diff.
--
-- Verified before writing this migration, not assumed:
--   * `grep -rln "DROP DEFAULT" prisma/migrations/` returned nothing - none
--     of the twelve original defaults had been dropped yet, despite four
--     migrations (#131, #133) stripping newly-generated `DROP DEFAULT`
--     statements from their own diffs by hand rather than committing them.
--   * `grep -rn "INSERT INTO" apps/api/src apps/api/prisma/seed.ts scripts/`
--     returned nothing. The only raw SQL in the codebase is an advisory lock
--     (tick-lease.service.ts), a liveness `SELECT 1` (database.indicator.ts),
--     and a test-only TRUNCATE (prisma.service.ts) - no code path inserts a
--     row without going through Prisma Client, which always supplies `id`.
--     Nothing depends on the database-side default, so dropping it costs
--     nothing and there is no reason to pin the schema to a Postgres
--     extension with `@default(dbgenerated(...))` instead.
--
-- Eighteen tables, not the twelve originally scoped, because six more picked
-- up the same drift after the issue was filed:
--   - 12 from 20260124223146_initial (`uuid_generate_v4()`)
--   - supervisor_invocations, supervisor_proposals, from
--     20260824120000_supervisor_decision_log (`gen_random_uuid()`)
--   - trust_grants, from 20260825120000_trust_grants
--   - approval_requests, from 20260826120000_approval_requests
--   - promotion_states, from 20260827120000_promotion_state
--   - dead_intervals, from 20260829120000_dead_intervals
-- Each of those six was written by hand to match the *previous* hand-written
-- migration's `gen_random_uuid()` style rather than the plain
-- `"id" UUID NOT NULL` (no default) style that #131 established for new
-- tables going forward - so the style being matched was itself already
-- drifting from the schema. See `apps/api/prisma/README.md` for the
-- convention this migration is meant to make explicit going forward.

-- 12 tables from the initial migration (uuid_generate_v4())
ALTER TABLE "users"                 ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "user_identities"       ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "roles"                 ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "permissions"           ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "system_settings"       ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "user_settings"         ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "audit_events"          ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "refresh_tokens"        ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "allowed_emails"        ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "device_codes"          ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "storage_objects"       ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "storage_object_chunks" ALTER COLUMN "id" DROP DEFAULT;

-- 6 tables from later hand-written migrations (gen_random_uuid())
ALTER TABLE "supervisor_invocations" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "supervisor_proposals"   ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "trust_grants"           ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "approval_requests"      ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "promotion_states"       ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "dead_intervals"         ALTER COLUMN "id" DROP DEFAULT;
