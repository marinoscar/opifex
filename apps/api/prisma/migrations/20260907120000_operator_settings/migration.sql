-- Operator settings (#332, #336): durable storage for operator-managed
-- configuration, kept out of `system_settings.value` because
-- `systemSettingsSchema.parse()` strips unknown keys and would silently
-- delete anything stored there the next time the settings form was saved.
-- See the doc comments on `OperatorSetting` and `OperatorSettingsRevision`
-- in prisma/schema.prisma for the full reasoning.

-- CreateTable
CREATE TABLE "operator_settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB,
    "secret_ciphertext" TEXT,
    "secret_iv" TEXT,
    "secret_auth_tag" TEXT,
    "secret_key_version" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_settings_pkey" PRIMARY KEY ("id")
);

-- Hand-written: Prisma's schema language cannot express a multi-column CHECK,
-- so this constraint exists only here, not in schema.prisma (see the doc
-- comment on `OperatorSetting` for why a CHECK is worth the resulting
-- `migrate diff` drift).
--
-- Exactly one of the two storage shapes may be populated on any row:
--   - `value` alone, for a non-secret setting, or
--   - the full ciphertext group (`secret_ciphertext`, `secret_iv`,
--     `secret_auth_tag`, `secret_key_version`) together, for a secret.
-- A row with both is ambiguous about which one a reader should trust; a row
-- with neither is a key with nothing in it, which is not the same thing as
-- the key being unset (that is the ABSENCE of a row - see prisma/seed.ts).
-- The ciphertext group is also required to be all-or-nothing, so a partially
-- written secret (e.g. ciphertext present, iv missing) can never be
-- committed - it is corrupt either way, and this stops it at the boundary
-- instead of at decrypt time in #337's secret box.
ALTER TABLE "operator_settings" ADD CONSTRAINT "operator_settings_value_xor_secret_check" CHECK (
  (
    "value" IS NOT NULL
    AND "secret_ciphertext" IS NULL
    AND "secret_iv" IS NULL
    AND "secret_auth_tag" IS NULL
    AND "secret_key_version" IS NULL
  )
  OR
  (
    "value" IS NULL
    AND "secret_ciphertext" IS NOT NULL
    AND "secret_iv" IS NOT NULL
    AND "secret_auth_tag" IS NOT NULL
    AND "secret_key_version" IS NOT NULL
  )
);

-- CreateTable
CREATE TABLE "operator_settings_revision" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "operator_settings_revision_pkey" PRIMARY KEY ("id")
);

-- Hand-written, same reason as above: pins this table to exactly one row, at
-- id 1, so a stray INSERT with a different id fails at the database rather
-- than merely going unreached by every `findUnique({ where: { id: 1 } })`
-- call site.
ALTER TABLE "operator_settings_revision" ADD CONSTRAINT "operator_settings_revision_id_check" CHECK ("id" = 1);

-- The one row this table will ever hold, created by the migration itself
-- rather than lazily on first write. `operator_settings` having zero rows is
-- a normal, meaningful state (every key falls through to `.env`), but the
-- COLLECTION still has a version - 0 - that the very first `GET
-- /api/operator-settings` must be able to report without a "no revision row
-- yet" special case in the resolver.
INSERT INTO "operator_settings_revision" ("id", "revision", "updated_at")
VALUES (1, 0, CURRENT_TIMESTAMP);

-- CreateIndex
CREATE UNIQUE INDEX "operator_settings_key_key" ON "operator_settings"("key");

-- AddForeignKey
ALTER TABLE "operator_settings" ADD CONSTRAINT "operator_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
