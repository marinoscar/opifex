import {
  quotaPositionSchema,
  quotaRunnerReadingSchema,
  quotaSummarySchema,
  quotaWindowReadingSchema,
} from './quota.dto';

/**
 * The schema is the contract the cockpit reads, so the refusals worth having
 * are the ones a well-meaning change would quietly undo.
 */
describe('quotaWindowReadingSchema', () => {
  const reading = {
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
    expect(quotaWindowReadingSchema.parse(reading)).toMatchObject({
      pressure: 'allowed',
      burnFraction: null,
    });
  });

  it('refuses a burn fraction, which is the point of the type', () => {
    // The one assertion this file exists for. A future change that computes a
    // ratio has to come through here and argue with `quota-window.ts` first,
    // rather than widening a number field nobody re-reads.
    expect(() =>
      quotaWindowReadingSchema.parse({ ...reading, burnFraction: 0.62 }),
    ).toThrow();
  });

  it('keeps an unreported cost as null rather than coercing it to zero', () => {
    const parsed = quotaWindowReadingSchema.parse({
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
      quotaWindowReadingSchema.parse({
        ...reading,
        pressure: 'allowed_warning',
      }),
    ).toThrow();
  });
});

describe('quotaPositionSchema', () => {
  const position = {
    exhausted: true,
    resumesAt: '2026-08-25T15:00:00.000Z',
    basis:
      'runner reported rate-limit status "exhausted" for its five_hour window',
  };

  it('accepts a fully-stated position', () => {
    expect(quotaPositionSchema.parse(position)).toEqual(position);
  });

  it('accepts a null resumesAt for a position that could not be dated', () => {
    expect(
      quotaPositionSchema.parse({ ...position, resumesAt: null }).resumesAt,
    ).toBeNull();
  });

  it('refuses a position missing resumesAt outright, rather than defaulting it', () => {
    // `resumesAt` is required, not optional-with-a-default: a caller that
    // forgot the field must not silently get `null`, since `null` is itself
    // a meaningful claim here (UNKNOWN, not "resumes now").
    const { resumesAt: _resumesAt, ...withoutResumesAt } = position;

    expect(() => quotaPositionSchema.parse(withoutResumesAt)).toThrow();
  });

  it('refuses a position missing exhausted', () => {
    const { exhausted: _exhausted, ...withoutExhausted } = position;

    expect(() => quotaPositionSchema.parse(withoutExhausted)).toThrow();
  });
});

describe('quotaRunnerReadingSchema', () => {
  const windowReading = {
    windowKind: 'five_hour',
    resetsAt: '2026-08-25T15:00:00.000Z',
    startedAt: '2026-08-25T10:00:00.000Z',
    startedAtBasis: 'vendor-window-length',
    partialWindow: false,
    pressure: 'allowed',
    peakPressure: 'allowed',
    lastObservedAt: '2026-08-25T11:55:00.000Z',
    observations: 3,
    opifexConsumption: {
      runs: 1,
      runsWithoutCost: 0,
      reportedUsd: 1.5,
      tokensInput: 500,
      tokensOutput: 100,
    },
    burnFraction: null,
    basis: 'Opifex’s own runs against the vendor’s "five_hour" window.',
  };

  it('parses position: null — UNKNOWN, not healthy (#301)', () => {
    // Null is the honest answer when every live window reads `unknown`, or
    // the only non-exhausted readings are staler than the meter's health
    // horizon. It must not be confused with an absent field or a healthy
    // position by the type that carries it.
    const parsed = quotaRunnerReadingSchema.parse({
      runnerKey: 'claude-code-local',
      position: null,
      windows: [windowReading],
    });

    expect(parsed.position).toBeNull();
    expect(parsed.windows).toHaveLength(1);
  });

  it('accepts a runner whose position binds, carrying both halves', () => {
    const parsed = quotaRunnerReadingSchema.parse({
      runnerKey: 'claude-code-local',
      position: {
        exhausted: true,
        resumesAt: '2026-08-25T15:00:00.000Z',
        basis: 'runner reported rate-limit status "exhausted"',
      },
      windows: [windowReading],
    });

    expect(parsed.position?.exhausted).toBe(true);
  });

  it('refuses a position missing resumesAt, even nested under a runner', () => {
    // The same refusal as `quotaPositionSchema`'s own test, pinned again at
    // the shape a client actually receives — this is the object #301's
    // acceptance criterion is about, not the bare schema in isolation.
    expect(() =>
      quotaRunnerReadingSchema.parse({
        runnerKey: 'claude-code-local',
        position: {
          exhausted: true,
          basis: 'runner reported rate-limit status "exhausted"',
        },
        windows: [windowReading],
      }),
    ).toThrow();
  });

  it('accepts a runner with no windows at all', () => {
    expect(
      quotaRunnerReadingSchema.parse({
        runnerKey: 'claude-code-local',
        position: null,
        windows: [],
      }).windows,
    ).toEqual([]);
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
