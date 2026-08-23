/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written by `npm run contracts:generate` from the schema named below, which
 * is the contract. Edit that, re-run the generator, and commit both.
 * `npm run contracts:check` fails CI when this file and the schema disagree.
 */

// Source: schemas/work-order.schema.json

/**
 * The central artifact of the system (VISION.MD §4). A work order is a PROJECTION of a GitHub issue, pinned to a commit — never an independent source of truth. Its identity is deterministic, which is what makes abandon-and-re-run recovery (§3.4) idempotent: two dispatches of the same work at the same commit compute the same branch name, and the second runner finds the first one's branch already there. This same document is posted to the issue as the authorization record and committed to the branch as the execution record (#63, ADR-0005), and the two must be byte-identical.
 */
export interface WorkOrder {
  /**
   * Version of this schema the work order claims to conform to. Stored with it so an authorization record posted a year ago stays readable after the schema moves on. Any 1.x version is accepted: within a major, every change is an added optional field, so a document written against an earlier minor still validates here (ADR-0010). A 2.x document is rejected by this file — majors get their own.
   */
  schemaVersion: string;
  /**
   * wo_{repo}_{issue}_{commit7}_a{attempt}. Deterministic and content-addressed: the string itself names the repository, issue, base commit and attempt, so it keeps resolving even if every row in the database is deleted. Expressed as a pattern rather than prose because a format nothing enforces is a format that drifts.
   */
  identity: string;
  /**
   * factory/{issue}-{commit7}-a{attempt}. Under the factory/ prefix every runner declares in branchPatterns, so a branch Opifex created is distinguishable from one a human made at a glance and by a glob. Derived from the same coordinates as the identity — the idempotency IS this naming scheme, not a lock.
   */
  branch: string;
  /**
   * Where the work happens. Owner and name are separate because the identity above uses the NAME alone, per §4, and the owner still has to reach whoever reads this document.
   */
  repository: {
    owner: string;
    name: string;
  };
  /**
   * The full 40-character SHA the work starts from, pinned at generation and NEVER resolved later. Resolved at dispatch instead, a work order authorized on Monday and run on Tuesday would start from a tree the authorizer never saw — and the identity, which encodes this commit's first seven characters, would name a commit the run never used. Full rather than abbreviated because an abbreviation is ambiguous the moment the repository grows, and this has to still resolve to one commit in a year.
   */
  baseCommit: string;
  /**
   * 1 for the first go at this issue at this base. The only component a human or the retry policy increments. A retry keeps the same base — abandon-and-re-run means the same starting tree, a fresh run.
   */
  attempt: number;
  /**
   * The issue this work order projects. REQUIRED, and required is the whole point: §4 makes a work order a projection of an issue rather than an independent source of truth, and §5 warns that a missing Issue -> WorkOrder edge is not detectable after the fact. There is no way to express a work order that came from nowhere.
   */
  issue: {
    number: number;
    url: string;
    title?: string;
  };
  /**
   * ADRs this work implements or is constrained by, as ADR-NNNN. Optional, because most work implements no ADR and a required field would be satisfied with a fictional value within a week.
   */
  decisionRefs?: string[];
  /**
   * What to do, in prose. The runner's actual instruction.
   */
  taskSpec: string;
  /**
   * How anyone will know it is done. TESTABLE, per §4 — and at least one, because a work order with no definition of done cannot produce a run that FAILS. It can only produce something nobody can check. §10: throughput ceiling is spec quality, not token budget. The schema enforces presence and non-emptiness; whether a criterion is genuinely testable is a policy question decided in deterministic code (§3.6), not something JSON Schema can express.
   *
   * @minItems 1
   */
  acceptanceCriteria: [string, ...string[]];
  /**
   * Globs the run may write within. An EMPTY ARRAY means the whole repository — present-but-empty rather than absent, so 'unconstrained' is a stated choice rather than a forgotten field.
   */
  pathConstraints: string[];
  /**
   * Hard spend ceiling. REQUIRED, and nullable: null means no ceiling, which is a decision somebody made rather than a field they forgot. Making it optional would let an unbounded work order look identical to one nobody thought about. Enforcement is deterministic policy (#65), never the runner's judgement.
   */
  budgetCeilingUsd: number | null;
  /**
   * Hard time ceiling, on the same required-and-nullable footing and for the same reason.
   */
  wallClockTimeoutMinutes: number | null;
  /**
   * What this work requires OF a runner, matched against advertised capabilities by routing (#64). This is the indirection that makes the seam real: a work order declares needs, never a runner. An empty array means anything enabled will do. A closed enum so a need nothing advertises fails loudly at routing rather than silently matching everything.
   */
  needs: (
    | 'full-streaming'
    | 'cost-reporting'
    | 'structured-rate-limits'
    | 'own-infrastructure'
  )[];
  /**
   * Which class of model this work wants, so a small fix does not spend a large model's quota (VISION §11: 'scheduling and model tiering are first-class concerns, not optimizations'). Vendor-neutral by design — a tier is a size, never a model name, because naming one would put a vendor's catalogue in the contract every runner has to speak. Absent means the runner's own default. Deliberately NOT a value in `needs`: that enum is closed and consumers switch on it exhaustively, so adding to it is a major bump (ADR-0010).
   */
  modelTier?: 'small' | 'standard' | 'large';
}

/** The version a producer should write, from the schema's `default`. */
export const WORK_ORDER_SCHEMA_VERSION = '1.1.0';

/** Every value `modelTier` may take. Closed — adding one is a major bump (ADR-0010). */
export const WORK_ORDER_MODEL_TIER = ['small', 'standard', 'large'] as const;

/** Every value `needs` may take. Closed — adding one is a major bump (ADR-0010). */
export const WORK_ORDER_NEEDS = [
  'full-streaming',
  'cost-reporting',
  'structured-rate-limits',
  'own-infrastructure',
] as const;
