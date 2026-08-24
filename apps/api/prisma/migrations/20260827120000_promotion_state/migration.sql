-- The promotion ladder (#99, epic #22): where each action class stands on
-- VISION §7's "earned autonomy" rungs, and on what evidence.

-- Three rungs, not four. VISION §7 lists Observe/Measure/Promote/Demote, but
-- demotion is a transition rather than a place to stand: a demoted class is
-- one that is measuring again. What was demoted, and how often, lives in
-- "change_reason" and "demotion_count" below.
CREATE TYPE "PromotionRung" AS ENUM (
  'observe',
  'measure',
  'promoted'
);

-- Why a class last changed rung. A category; the sentence lives in
-- "change_detail" and the numbers in "evidence_json".
--
-- 'demoted_manually' and 'paused_globally' are reserved for #101's operator
-- surface. The ladder itself never writes 'paused_globally', and that is the
-- guarantee rather than an omission: #99 requires the ladder be pausable
-- "without dismantling the grants", so a pause changes no rung.
CREATE TYPE "PromotionChangeReason" AS ENUM (
  'promoted_on_evidence',
  'demoted_on_regression',
  'demoted_ineligible',
  'demoted_manually',
  'paused_globally'
);

CREATE TABLE "promotion_states" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- An ActionClassId from apps/api/src/supervisor/action-classes.ts, validated
  -- at the boundary rather than by a database enum (ADR-0011), matching
  -- trust_grants.action_class and approval_requests.action_class.
  "action_class"   TEXT NOT NULL,

  "rung"           "PromotionRung" NOT NULL DEFAULT 'observe',

  -- When the RUNG changed, not when the ladder last ran. An hourly evaluation
  -- that concluded nothing must not move this.
  "changed_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "change_reason"  "PromotionChangeReason",
  "change_detail"  TEXT,

  -- The evidence the decision was made from, FROZEN at decision time and never
  -- recomputed. #99 requires promotion and demotion to state their evidence,
  -- and evidence recomputed later describes a different factory from the one
  -- the decision was made in.
  "evidence_json"  JSONB,

  -- Most recent promotion and most recent demotion. Both retained after a
  -- demotion: "promoted for six weeks then demoted" and "promoted and demoted
  -- within a day" are different facts about the measurement.
  "promoted_at"    TIMESTAMPTZ,
  "demoted_at"     TIMESTAMPTZ,

  -- Promoting something for the fourth time is a different act from promoting
  -- it once, and a rung alone cannot tell the two apart.
  "demotion_count" INTEGER NOT NULL DEFAULT 0,

  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL
);

-- ONE ROW PER CLASS, enforced here rather than by convention. Two rows for
-- 're-dispatch' would be two answers to "may this run unattended", and the
-- reader that picked the wrong one would be granting autonomy nobody measured.
CREATE UNIQUE INDEX "promotion_states_action_class_key"
  ON "promotion_states" ("action_class");

-- #101's read: what is promoted right now.
CREATE INDEX "promotion_states_rung_idx"
  ON "promotion_states" ("rung");
