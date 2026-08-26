import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The Test buttons (#338, epic #332).
 *
 * Epic #332's own finding is what these exist for: "configured is not
 * effective". #324 saw the fleet report `available: true` beside
 * `enabled: false`, and the deceptive case is worse than that — `claude
 * --version` succeeds with no credential at all, so an unauthenticated CLI
 * registers as an available runner and then fails every single run at auth.
 * A settings screen that shows only what you typed is lying by omission, and a
 * probe that does not exercise the credential proves nothing.
 */

export const PROBE_NAMES = [
  /** `GET /rate_limit` — a wrong, expired or unscoped token. */
  'github-token',
  /** `GET /repos/{owner}/{name}` — a fine-grained PAT missing THIS repo. */
  'github-repo',
  /** `claude --version` — the binary is installed and runnable. */
  'claude-cli',
  /** `git --version` — missing binaries; git fails first. */
  'git',
  /** A minimal non-interactive `claude -p`. The one that costs, and counts. */
  'claude-credential',
  /** A minimal Anthropic call, for the key that leaves the model unbound. */
  'supervisor-model',
] as const;

export type ProbeName = (typeof PROBE_NAMES)[number];

export const probeNameSchema = z.enum(PROBE_NAMES);

export const probeParamsSchema = z.object({ probe: probeNameSchema });

export class ProbeParamsDto extends createZodDto(probeParamsSchema) {}

/**
 * Optionally, which repository `github-repo` should ask about.
 *
 * Absent means "the first registered one", which is what an operator with a
 * single repository — the common case, and the one epic #324 measured — never
 * has to think about.
 */
export const probeRequestSchema = z.object({
  repositoryId: z.uuid().optional(),
});

export class ProbeRequestDto extends createZodDto(probeRequestSchema) {}

/**
 * What an operator is allowed to spend on the two probes that cost money.
 *
 * Present on every result for those two — not only on a refusal — because the
 * UI has to be able to say "4 of 5 left" before the operator runs out, not
 * after. The issue requires the limit be stated in the response for exactly
 * this reason.
 */
export const probeRateLimitSchema = z.object({
  limit: z.number().int(),
  windowSeconds: z.number().int(),
  remaining: z.number().int(),
  resetSeconds: z.number().int(),
});

export const probeResultSchema = z.object({
  probe: probeNameSchema,
  /**
   * Whether the thing being probed actually works.
   *
   * False is an ANSWER, not an error: a rejected token, a missing binary and
   * an unauthenticated CLI are all facts about a deployment that the operator
   * asked this endpoint to go and find out. Only a bug in this code produces a
   * non-2xx here.
   */
  ok: z.boolean(),
  /** One human-readable sentence. Never contains a credential. */
  detail: z.string(),
  checkedAt: z.iso.datetime(),
  /** Present on the two probes that spend real quota. */
  rateLimit: probeRateLimitSchema.optional(),
  /**
   * True when the probe did not run at all — rate limited, or nothing
   * configured to probe. Distinct from `ok: false`, which means it ran and the
   * answer was no.
   */
  skipped: z.boolean(),
});

export class ProbeResultDto extends createZodDto(probeResultSchema) {}

export type ProbeResult = z.infer<typeof probeResultSchema>;
