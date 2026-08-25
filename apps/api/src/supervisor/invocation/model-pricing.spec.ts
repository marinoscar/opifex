import { MODEL_RATES, priceUsd } from './model-pricing';

describe('priceUsd (ADR-0015)', () => {
  it('prices a call from its token counts', () => {
    // claude-haiku-4-5 at $1/$5 per million: 1000 in and 500 out is
    // 0.001 + 0.0025.
    expect(priceUsd('claude-haiku-4-5', 1000, 500)).toBe(0.0035);
  });

  it('prices input and output at different rates', () => {
    // Reversing the counts must not give the same number, which is the whole
    // reason the table has two columns.
    expect(priceUsd('claude-haiku-4-5', 500, 1000)).not.toBe(
      priceUsd('claude-haiku-4-5', 1000, 500),
    );
  });

  it('reports null, never zero, for a model it has no rate for', () => {
    // THE test that protects metric 5. `SupervisorInvocation.costUsd` is
    // nullable because VISION §6 makes "unknown" and "free" different facts,
    // and this table WILL fall behind Anthropic's catalogue — ADR-0015 accepts
    // that drift on the condition that it surfaces as a null. A zero here
    // would answer "is the supervisor worth what it costs" with a number
    // nobody measured.
    const cost = priceUsd('claude-model-invented-tomorrow', 1000, 500);

    expect(cost).toBeNull();
    expect(cost).not.toBe(0);
  });

  it('does not price an unknown model at a related model rate', () => {
    // No prefix or family matching. A dated snapshot the table has not been
    // updated for prices at null rather than at its predecessor's rate, so the
    // staleness is visible in the log instead of being papered over.
    expect(priceUsd('claude-haiku-4-5-20991231', 1000, 500)).toBeNull();
  });

  it('reports null when either token count is missing', () => {
    // Half a call priced is a call understated, and an understated cost
    // distorts the metric that a null merely leaves unanswered.
    expect(priceUsd('claude-haiku-4-5', null, 500)).toBeNull();
    expect(priceUsd('claude-haiku-4-5', 1000, null)).toBeNull();
    expect(priceUsd('claude-haiku-4-5', null, null)).toBeNull();
  });

  it('reports zero only for a call that genuinely used no tokens', () => {
    // The one case where zero is the truth rather than a guess.
    expect(priceUsd('claude-haiku-4-5', 0, 0)).toBe(0);
  });

  it('is not fooled by inherited object properties', () => {
    // `MODEL_RATES` is indexed by an operator-supplied string. Without an own
    // -property check, SUPERVISOR_MODEL_NAME=constructor would find something.
    expect(priceUsd('constructor', 1000, 500)).toBeNull();
    expect(priceUsd('toString', 1000, 500)).toBeNull();
  });

  it('states every rate in dollars per million tokens, both directions', () => {
    // Guards the table itself: a rate entered in dollars-per-token, or with
    // one field forgotten, would silently misprice every invocation.
    const entries = Object.entries(MODEL_RATES);
    expect(entries.length).toBeGreaterThan(0);

    for (const [model, rate] of entries) {
      expect(typeof rate.inputPerMillionUsd).toBe('number');
      expect(typeof rate.outputPerMillionUsd).toBe('number');
      expect(rate.inputPerMillionUsd).toBeGreaterThan(0);
      // Output is dearer than input for every model Anthropic has published,
      // so an inverted pair is a transcription error rather than a bargain.
      expect(rate.outputPerMillionUsd).toBeGreaterThan(rate.inputPerMillionUsd);
      expect(model).toMatch(/^claude-/);
    }
  });
});
