/**
 * What a supervisor invocation cost, in dollars (ADR-0015, #230).
 *
 * Every provider's API reports tokens, not money. Nothing in a response says
 * what those tokens are billed at, and neither vendor has an endpoint to ask,
 * so the conversion has to live somewhere in this repository — and ADR-0015
 * accepts that cost explicitly rather than discovering it later: **this table
 * is hand-maintained and it will drift.**
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
 * Rates are USD per million tokens, from each vendor's published pricing.
 * **Last checked: 2026-08-27**, against
 * `platform.claude.com/docs/en/about-claude/pricing` and
 * `platform.openai.com/docs/pricing`. Both the dated snapshot names and the
 * aliases are listed, because `SUPERVISOR_MODEL_NAME` is sent verbatim and an
 * operator may reasonably configure either. (Anthropic's IDs are dateless from
 * the 4.6 generation on; before it they carry a snapshot date and have a short
 * alias beside them.)
 *
 * Since #392 there are two vendors here, and the argument above is unchanged
 * by that: an OpenAI model this table has no rate for prices at `null`, and
 * the supervisor's spend ceiling reports it as an unpriced call rather than as
 * a free one. Shipping the adapter without the rates would have let the
 * ceiling silently under-count every OpenAI call, which is why the epic put
 * them in the same change.
 *
 * Three things the table deliberately does not model, because the
 * supervisor's request shape does not reach them:
 *
 * - **The long-context surcharge.** Both vendors charge more above a context
 *   threshold — Anthropic above 200K input, OpenAI above 272K on the models
 *   that carry the tier at all. The supervisor sends one bounded snapshot per
 *   call, `renderSnapshot` truncates, and the standard tier is the rate that
 *   applies.
 * - **Prompt-cache read and write rates.** Nothing here caches. A future
 *   adapter that starts caching prompts has to revisit this for BOTH vendors.
 * - **The discounted service tiers** — batch, flex, and OpenAI's fast mode.
 *   `ask()` sends no `service_tier` and no batch envelope, so standard is what
 *   is billed.
 *
 * ## Two aliases that are deliberately absent
 *
 * `daybreak-blue-latest` and `daybreak-red-latest` point at whichever model is
 * current, and OpenAI documents that their PRICING moves with the target. A
 * fixed rate keyed on either would be silently wrong on the day the alias is
 * repointed — which is the one failure this file's whole design exists to
 * avoid, since a wrong rate makes the spend ceiling confidently incorrect
 * where a missing one merely reports itself. Anthropic's dateless aliases are
 * a different thing and are listed: they resolve within one minor version, at
 * one price.
 */

/** USD per million tokens, input and output priced separately. */
export interface ModelRate {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const HAIKU_3 = { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.25 };
const HAIKU_3_5 = { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 };
const HAIKU_4_5 = { inputPerMillionUsd: 1, outputPerMillionUsd: 5 };
const SONNET = { inputPerMillionUsd: 3, outputPerMillionUsd: 15 };
const SONNET_5 = { inputPerMillionUsd: 2, outputPerMillionUsd: 10 };
const OPUS_4 = { inputPerMillionUsd: 15, outputPerMillionUsd: 75 };
/** Opus 4.5 through Opus 5, all at the same published rate. */
const OPUS_4_5 = { inputPerMillionUsd: 5, outputPerMillionUsd: 25 };
/** The Fable/Mythos tier. */
const FABLE_5 = { inputPerMillionUsd: 10, outputPerMillionUsd: 50 };

// ---------------------------------------------------------------------------
// OpenAI
//
// Short-context standard rates. See the header for the tiers and surcharges
// this table deliberately does not carry.
// ---------------------------------------------------------------------------

const GPT_5 = { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10 };
const GPT_5_MINI = { inputPerMillionUsd: 0.25, outputPerMillionUsd: 2 };
const GPT_5_NANO = { inputPerMillionUsd: 0.05, outputPerMillionUsd: 0.4 };
const GPT_5_PRO = { inputPerMillionUsd: 15, outputPerMillionUsd: 120 };

/**
 * The rates, keyed by the exact model string.
 *
 * A model missing from here is not an error and must not be treated as one —
 * it prices at null and the invocation proceeds. See the file header.
 */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = Object.freeze({
  // -------------------------------------------------------------------------
  // Anthropic
  // -------------------------------------------------------------------------

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
  'claude-sonnet-4-6': SONNET,
  // Sonnet 5 is CHEAPER than Sonnet 4.6, which is why family matching would
  // have been wrong here and not merely imprecise.
  'claude-sonnet-5': SONNET_5,

  // Opus. The 4.x line dropped from $15/$75 to $5/$25 at 4.5, so the two
  // constants are a real price change and not a transcription slip.
  'claude-opus-4-20250514': OPUS_4,
  'claude-opus-4-1': OPUS_4,
  'claude-opus-4-1-20250805': OPUS_4,
  'claude-opus-4-5': OPUS_4_5,
  'claude-opus-4-5-20251101': OPUS_4_5,
  'claude-opus-4-6': OPUS_4_5,
  'claude-opus-4-7': OPUS_4_5,
  'claude-opus-4-8': OPUS_4_5,
  'claude-opus-5': OPUS_4_5,

  // The tier above Opus.
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,

  // -------------------------------------------------------------------------
  // OpenAI (#392)
  // -------------------------------------------------------------------------

  'gpt-5': GPT_5,
  'gpt-5-mini': GPT_5_MINI,
  'gpt-5-nano': GPT_5_NANO,
  'gpt-5-pro': GPT_5_PRO,
  'gpt-5.1': GPT_5,
  'gpt-5.2': { inputPerMillionUsd: 1.75, outputPerMillionUsd: 14 },
  'gpt-5.2-pro': { inputPerMillionUsd: 21, outputPerMillionUsd: 168 },
  'gpt-5.4': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 15 },
  'gpt-5.4-mini': { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5 },
  'gpt-5.4-nano': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.25 },
  'gpt-5.4-pro': { inputPerMillionUsd: 30, outputPerMillionUsd: 180 },
  'gpt-5.5': { inputPerMillionUsd: 5, outputPerMillionUsd: 30 },
  'gpt-5.5-pro': { inputPerMillionUsd: 30, outputPerMillionUsd: 180 },
  'gpt-5.5-cyber': { inputPerMillionUsd: 12.5, outputPerMillionUsd: 75 },
  'gpt-5.6-sol': { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
  'gpt-5.6-terra': { inputPerMillionUsd: 2, outputPerMillionUsd: 12 },
  'gpt-5.6-luna': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2 },
  'gpt-5.6-cyber': { inputPerMillionUsd: 12.5, outputPerMillionUsd: 75 },
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
