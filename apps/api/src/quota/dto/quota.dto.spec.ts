import { quotaReadingSchema, quotaSummarySchema } from './quota.dto';

/**
 * The schema is the contract the cockpit reads, so the refusals worth having
 * are the ones a well-meaning change would quietly undo.
 */
describe('quotaReadingSchema', () => {
  const reading = {
    runnerKey: 'claude-code-local',
    windowKind: 'five_hour',
    resetsAt: '2026-08-25T15:00:00.000Z',
    startedAt: '2026-08-25T10:00:00.000Z',
    startedAtBasis: 'vendor-window-length',
    partialWindow: false,
    pressure: 'allowed',
    peakPressure: 'warning',
    lastObservedAt: '2026-08-25T11:55:00.000Z',
    observations: 12,
    opifexConsumption: {
      runs: 4,
      runsWithoutCost: 1,
      reportedUsd: 4.25,
      tokensInput: 1000,
      tokensOutput: 250,
    },
    burnFraction: null,
    basis: 'Opifex’s own runs against the vendor’s "five_hour" window.',
  };

  it('accepts a reading with everything measured', () => {
    expect(quotaReadingSchema.parse(reading)).toMatchObject({
      pressure: 'allowed',
      burnFraction: null,
    });
  });

  it('refuses a burn fraction, which is the point of the type', () => {
    // The one assertion this file exists for. A future change that computes a
    // ratio has to come through here and argue with `quota-window.ts` first,
    // rather than widening a number field nobody re-reads.
    expect(() =>
      quotaReadingSchema.parse({ ...reading, burnFraction: 0.62 }),
    ).toThrow();
  });

  it('keeps an unreported cost as null rather than coercing it to zero', () => {
    const parsed = quotaReadingSchema.parse({
      ...reading,
      opifexConsumption: {
        ...reading.opifexConsumption,
        reportedUsd: null,
        tokensInput: null,
        tokensOutput: null,
      },
    });

    expect(parsed.opifexConsumption.reportedUsd).toBeNull();
  });

  it('refuses a pressure word outside the ordinal', () => {
    // The vocabulary is normalized at the adapter (`stream-json-mapper.ts`),
    // and an unrecognized vendor status becomes `unknown` there. A raw vendor
    // word reaching this far means that normalization was bypassed.
    expect(() =>
      quotaReadingSchema.parse({ ...reading, pressure: 'allowed_warning' }),
    ).toThrow();
  });
});

describe('quotaSummarySchema', () => {
  it('accepts a fleet that has observed no quota at all', () => {
    // #231's last acceptance criterion: a fleet whose runners report no quota
    // still works, with the metric null throughout. An empty list is the
    // honest answer — not a runner reported with zeroes.
    expect(
      quotaSummarySchema.parse({
        generatedAt: '2026-08-25T12:00:00.000Z',
        runners: [],
      }).runners,
    ).toEqual([]);
  });
});
