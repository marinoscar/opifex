/**
 * What a supervisor invocation cost, in dollars (ADR-0015, #230).
 *
 * The Messages API reports tokens, not money. Nothing in the response says
 * what those tokens are billed at, and there is no endpoint to ask, so the
 * conversion has to live somewhere in this repository — and ADR-0015 accepts
 * that cost explicitly rather than discovering it later: **this table is
 * hand-maintained and it will drift.**
 *
 * ## Why an unknown model is null and never zero
 *
 * `SupervisorInvocation.costUsd` is nullable for the same reason `Run.costUsd`
 * is (VISION §6): "the adapter cannot say" and "the call was free" are
 * different facts, and only one of them is ever true here. A model this table
 * has no rate for therefore prices at `null`. Zero would be worse than
 * useless — VISION §7's promotion ladder asks whether the supervisor is worth
 * what it costs, and a run of zeroes answers yes to a question nobody
 * actually measured.
 *
 * That is also what makes the drift SAFE rather than silent: the day
 * `SUPERVISOR_MODEL_NAME` is pointed at a model added after this table was
 * last touched, the cost column goes null and stays null, which is visible in
 * the decision log. A prefix or family match would paper over exactly that
 * signal by pricing a new model at an old model's rate, so the lookup is by
 * the EXACT configured string and nothing else.
 *
 * ## Maintaining it
 *
 * Rates are USD per million tokens, from Anthropic's published pricing.
 * **Last checked: 2026-08-25.** Both the dated snapshot names and the aliases
 * are listed, because `SUPERVISOR_MODEL_NAME` is sent verbatim and an operator
 * may reasonably configure either.
 *
 * Two things the table deliberately does not model, because the supervisor's
 * request shape does not reach them: the long-context (>200K input) surcharge
 * some models carry, and prompt-cache read/write rates. The supervisor sends
 * one bounded, uncached snapshot per call — `renderSnapshot` truncates — so
 * the standard tier is the rate that applies. A future adapter that starts
 * caching prompts has to revisit this.
 */

/** USD per million tokens, input and output priced separately. */
export interface ModelRate {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const HAIKU_3 = { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.25 };
const HAIKU_3_5 = { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 };
const HAIKU_4_5 = { inputPerMillionUsd: 1, outputPerMillionUsd: 5 };
const SONNET = { inputPerMillionUsd: 3, outputPerMillionUsd: 15 };
const OPUS_4 = { inputPerMillionUsd: 15, outputPerMillionUsd: 75 };

/**
 * The rates, keyed by the exact model string.
 *
 * A model missing from here is not an error and must not be treated as one —
 * it prices at null and the invocation proceeds. See the file header.
 */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = Object.freeze({
  // Haiku — what VISION §7's "a small model" points at in practice.
  'claude-3-haiku-20240307': HAIKU_3,
  'claude-3-5-haiku-20241022': HAIKU_3_5,
  'claude-3-5-haiku-latest': HAIKU_3_5,
  'claude-haiku-4-5': HAIKU_4_5,
  'claude-haiku-4-5-20251001': HAIKU_4_5,

  // Sonnet.
  'claude-3-5-sonnet-20241022': SONNET,
  'claude-3-7-sonnet-20250219': SONNET,
  'claude-3-7-sonnet-latest': SONNET,
  'claude-sonnet-4-20250514': SONNET,
  'claude-sonnet-4-0': SONNET,
  'claude-sonnet-4-5': SONNET,
  'claude-sonnet-4-5-20250929': SONNET,

  // Opus.
  'claude-opus-4-20250514': OPUS_4,
  'claude-opus-4-1': OPUS_4,
  'claude-opus-4-1-20250805': OPUS_4,
});

/**
 * Price one call, or null when this table cannot.
 *
 * Null in three cases, all of them "cannot say" rather than "free": the model
 * is not in the table, or either token count is missing from the response.
 * Pricing half a call would understate it, and an understated cost distorts
 * the same metric a null merely leaves unanswered.
 */
export function priceUsd(
  model: string,
  tokensInput: number | null,
  tokensOutput: number | null,
): number | null {
  if (tokensInput === null || tokensOutput === null) return null;

  const rate = Object.prototype.hasOwnProperty.call(MODEL_RATES, model)
    ? MODEL_RATES[model]
    : undefined;
  if (rate === undefined) return null;

  const usd =
    (tokensInput * rate.inputPerMillionUsd +
      tokensOutput * rate.outputPerMillionUsd) /
    1_000_000;

  // Six decimals: a haiku call costs fractions of a cent, and rounding to
  // cents would record most invocations as free — the one thing this module
  // exists to avoid. Rounding at all is to keep binary-float noise out of a
  // column that gets summed.
  return Math.round(usd * 1_000_000) / 1_000_000;
}
