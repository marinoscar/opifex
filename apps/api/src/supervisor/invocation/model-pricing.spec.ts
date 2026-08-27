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
      // Output is dearer than input for every model either vendor has
      // published, so an inverted pair is a transcription error rather than a
      // bargain.
      expect(rate.outputPerMillionUsd).toBeGreaterThan(rate.inputPerMillionUsd);
      // A model string neither vendor could produce is a typo in the table,
      // and a typo in a KEY is invisible: it prices at null exactly like a
      // model that has not been added yet.
      expect(model).toMatch(/^(claude-|gpt-)/);
    }
  });

  it('prices both vendors, so the ceiling means something on either (#392)', () => {
    // Shipping the OpenAI adapter without its rates would have left the
    // supervisor's spend ceiling under-counting every OpenAI call, which is
    // why the epic put them in the same change. A table that lost its OpenAI
    // half would pass every other assertion in this file.
    const models = Object.keys(MODEL_RATES);

    expect(
      models.filter((model) => model.startsWith('claude-')).length,
    ).toBeGreaterThan(10);
    expect(
      models.filter((model) => model.startsWith('gpt-')).length,
    ).toBeGreaterThan(10);
  });

  it('covers the Claude 5 family, which used to price at null', () => {
    // Named individually rather than by prefix: the epic's whole complaint was
    // that "the pricing table is behind the model families", and a prefix
    // assertion would go green on one of them.
    for (const model of [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-mythos-5',
    ]) {
      expect(priceUsd(model, 1_000_000, 0)).not.toBeNull();
    }
  });

  it('prices Sonnet 5 below Sonnet 4.6, which is why family matching is wrong', () => {
    // A concrete instance of the header's argument. Sonnet 5 is CHEAPER than
    // the version before it, so a "claude-sonnet-*" rule would not merely be
    // imprecise — it would over-count by half.
    const sonnet5 = priceUsd('claude-sonnet-5', 1_000_000, 1_000_000);
    const sonnet46 = priceUsd('claude-sonnet-4-6', 1_000_000, 1_000_000);

    expect(sonnet5).not.toBeNull();
    expect(sonnet46).not.toBeNull();
    expect(sonnet5).toBeLessThan(sonnet46 as number);
  });

  it('leaves the repointing aliases unpriced, deliberately', () => {
    // `daybreak-blue-latest` and `daybreak-red-latest` follow whichever model
    // is current AND their price moves with it, so a fixed rate keyed on
    // either would be silently wrong the day the alias moves. Null is the
    // right answer here and is not an omission to be fixed.
    expect(priceUsd('daybreak-blue-latest', 1000, 500)).toBeNull();
    expect(priceUsd('daybreak-red-latest', 1000, 500)).toBeNull();
  });

  it('prices an OpenAI call from its token counts', () => {
    // gpt-5.6-luna at $0.20/$1.20 per million: 1000 in and 500 out is
    // 0.0002 + 0.0006.
    expect(priceUsd('gpt-5.6-luna', 1000, 500)).toBe(0.0008);
  });
});
