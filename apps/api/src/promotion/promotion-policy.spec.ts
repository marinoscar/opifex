import {
  DEMOTION_MIN_SAMPLE,
  DEMOTION_RATE,
  MIN_SAMPLE,
  PROMOTION_RATE,
  REGRESSION_WINDOW_DAYS,
  type ClassEvidence,
  emptyEvidence,
  evaluateLadder,
  expectedPromotionOrder,
  holdDetail,
  isRegressing,
  pct,
  promotionOrderAnomaly,
  rateOf,
  rungFor,
  shortfallCount,
} from './promotion-policy';

/**
 * Build evidence from counts, deriving the rates the way the service does.
 *
 * A helper rather than literals, so a test cannot accidentally assert on an
 * inconsistent record — 5 approved, 5 rejected, rate 0.9 — and pass for the
 * wrong reason.
 */
function evidence(
  counts: {
    approved?: number;
    rejected?: number;
    recentApproved?: number;
    recentRejected?: number;
    fromProposals?: number;
    fromApprovals?: number;
  } = {},
  actionClass = 're-dispatch',
): ClassEvidence {
  const approved = counts.approved ?? 0;
  const rejected = counts.rejected ?? 0;
  const recentApproved = counts.recentApproved ?? 0;
  const recentRejected = counts.recentRejected ?? 0;

  return {
    ...emptyEvidence(actionClass),
    approved,
    rejected,
    sample: approved + rejected,
    rate: rateOf(approved, rejected),
    recentApproved,
    recentRejected,
    recentSample: recentApproved + recentRejected,
    recentRate: rateOf(recentApproved, recentRejected),
    fromProposals: counts.fromProposals ?? approved + rejected,
    fromApprovals: counts.fromApprovals ?? 0,
  };
}

describe('promotion policy thresholds', () => {
  it('sets the demotion rate strictly below the promotion rate', () => {
    // The hysteresis band. Equal thresholds would make a class near the line
    // cross it on single decisions, promoting and demoting on alternate days —
    // and an operator who gets four contradictory notifications about one
    // class in a week learns to ignore all of them.
    expect(DEMOTION_RATE).toBeLessThan(PROMOTION_RATE);
  });

  it('demands less evidence to demote than to promote', () => {
    // Asymmetric costs, asymmetric evidence. Wrongly demoting costs a
    // re-promotion; wrongly staying promoted costs unsupervised action.
    expect(DEMOTION_MIN_SAMPLE).toBeLessThan(MIN_SAMPLE);
  });

  it('keeps PROMOTION_RATE below 1, so a shortfall is always finite', () => {
    // shortfallCount divides by (1 - PROMOTION_RATE). A threshold of exactly
    // 1.0 would make "how many more approvals do you need" unanswerable for
    // any class that has ever been rejected once, which is its own argument
    // against setting one.
    expect(PROMOTION_RATE).toBeLessThan(1);
  });
});

describe('rateOf', () => {
  it('returns null, not 0, for a class with no evidence', () => {
    // 0/0 is NO EVIDENCE. Rendering it as a 0% approval rate says the
    // opposite — that humans reject this class every time they see it.
    expect(rateOf(0, 0)).toBeNull();
    expect(emptyEvidence('re-dispatch').rate).toBeNull();
    expect(emptyEvidence('re-dispatch').recentRate).toBeNull();
  });

  it('renders null as "no evidence" rather than "0%"', () => {
    expect(pct(null)).toBe('no evidence');
    expect(pct(0)).toBe('0%');
    expect(pct(0.9)).toBe('90%');
  });
});

describe('evaluateLadder: rule 1, ineligible beats everything', () => {
  const perfect = evidence(
    { approved: 500, rejected: 0, recentApproved: 100, recentRejected: 0 },
    'quarantine-decision',
  );

  it('never promotes an ineligible class, whatever its record', () => {
    const verdict = evaluateLadder('measure', perfect, false, false);
    expect(verdict.action).toBe('hold');
    expect(verdict).toMatchObject({
      detail: expect.stringContaining('not autonomy-eligible'),
    });
  });

  it('demotes an ineligible class that is somehow promoted', () => {
    const verdict = evaluateLadder('promoted', perfect, false, false);
    expect(verdict).toMatchObject({
      action: 'demote',
      reason: 'demoted_ineligible',
    });
  });

  it('beats a perfect record that would otherwise clear both thresholds', () => {
    // Sanity check that the record really would have promoted, so the test
    // above is proving precedence rather than an insufficient sample.
    expect(evaluateLadder('measure', perfect, true, false).action).toBe(
      'promote',
    );
  });

  it('demotes an ineligible promoted class even while paused', () => {
    // Ineligibility is a hardcoded declaration about what may ever run
    // unattended, not a ladder judgement on a record. A pause suspends
    // judgements; it does not suspend declarations.
    const verdict = evaluateLadder('promoted', perfect, false, true);
    expect(verdict).toMatchObject({
      action: 'demote',
      reason: 'demoted_ineligible',
    });
  });
});

describe('evaluateLadder: rule 2, pausing', () => {
  const promotable = evidence({ approved: 30, rejected: 1 });

  it('never promotes while paused', () => {
    expect(evaluateLadder('measure', promotable, true, true).action).toBe(
      'hold',
    );
    // ... and would have promoted otherwise.
    expect(evaluateLadder('measure', promotable, true, false).action).toBe(
      'promote',
    );
  });

  it('never demotes an already-promoted class while paused', () => {
    // #99: the ladder "can be paused globally without dismantling the grants".
    // If a pause demoted, it would suspend every grant for every promoted
    // class, turning "stop changing things for a moment" into a mass
    // revocation.
    const regressed = evidence({
      approved: 100,
      rejected: 2,
      recentApproved: 1,
      recentRejected: 9,
    });

    expect(evaluateLadder('promoted', regressed, true, true).action).toBe(
      'hold',
    );
    // ... and would have demoted otherwise.
    expect(evaluateLadder('promoted', regressed, true, false)).toMatchObject({
      action: 'demote',
      reason: 'demoted_on_regression',
    });
  });

  it('says in the hold detail that the pause is why nothing moved', () => {
    const verdict = evaluateLadder('promoted', promotable, true, true);
    expect(verdict).toMatchObject({
      detail: expect.stringContaining('PROMOTION_LADDER_ENABLED'),
    });
  });
});

describe('evaluateLadder: promotion requires BOTH rate and sample', () => {
  it('holds at 19 samples with a perfect rate', () => {
    // One short. #99: "three-for-three is not evidence", and neither is
    // nineteen-for-nineteen if the line is drawn at twenty.
    const verdict = evaluateLadder(
      'measure',
      evidence({ approved: 19, rejected: 0 }),
      true,
      false,
    );
    expect(verdict.action).toBe('hold');
    expect(verdict).toMatchObject({
      detail: expect.stringContaining('19 of 20 samples'),
    });
  });

  it('promotes at exactly MIN_SAMPLE with exactly PROMOTION_RATE', () => {
    // 18/20 = 0.9. The boundary is inclusive on both axes; a threshold nobody
    // can ever land on exactly is a threshold with an off-by-one hiding in it.
    const verdict = evaluateLadder(
      'measure',
      evidence({ approved: 18, rejected: 2 }),
      true,
      false,
    );
    expect(verdict.action).toBe('promote');
  });

  it('holds at 20 samples with an 89% rate', () => {
    // Sample is sufficient; the rate is not. 89 of 100 = 0.89.
    const verdict = evaluateLadder(
      'measure',
      evidence({ approved: 89, rejected: 11 }),
      true,
      false,
    );
    expect(verdict.action).toBe('hold');
    expect(verdict).toMatchObject({
      detail: expect.stringContaining('below the 90% promotion threshold'),
    });
  });

  it('holds a class with no evidence at all, and says so in words', () => {
    const verdict = evaluateLadder(
      'observe',
      emptyEvidence('re-dispatch'),
      true,
      false,
    );
    expect(verdict).toMatchObject({
      action: 'hold',
      detail: expect.stringContaining('NO evidence'),
    });
  });

  it('names the numbers in the promotion reason', () => {
    // #99: "both promotion and demotion notify, and both state their
    // evidence." A reason that said "threshold met" would state none.
    const verdict = evaluateLadder(
      'measure',
      evidence({
        approved: 27,
        rejected: 1,
        fromProposals: 20,
        fromApprovals: 8,
      }),
      true,
      false,
    );
    expect(verdict).toMatchObject({ action: 'promote' });
    if (verdict.action !== 'promote') throw new Error('unreachable');
    expect(verdict.reason).toContain('28 human decision(s)');
    expect(verdict.reason).toContain('27 approved, 1 rejected');
    expect(verdict.reason).toContain('20 from the review queue');
    expect(verdict.reason).toContain('8 from the approval gate');
  });
});

describe('evaluateLadder: hysteresis', () => {
  it('neither promotes nor demotes a class sitting at 0.85', () => {
    // The whole point of two thresholds. 0.85 is below PROMOTION_RATE and
    // above DEMOTION_RATE, so it holds wherever it currently stands.
    const band = evidence({
      approved: 85,
      rejected: 15,
      recentApproved: 85,
      recentRejected: 15,
    });
    expect(band.rate).toBeCloseTo(0.85, 10);

    expect(evaluateLadder('measure', band, true, false).action).toBe('hold');
    expect(evaluateLadder('promoted', band, true, false).action).toBe('hold');
  });

  it('holds a promoted class at exactly DEMOTION_RATE', () => {
    // Inclusive at the bottom: "below the threshold" means below it.
    const atLine = evidence({
      approved: 70,
      rejected: 30,
      recentApproved: 7,
      recentRejected: 3,
    });
    expect(atLine.recentRate).toBeCloseTo(DEMOTION_RATE, 10);
    expect(evaluateLadder('promoted', atLine, true, false).action).toBe('hold');
  });
});

describe('evaluateLadder: demotion reads the RECENT window, not the lifetime', () => {
  // A year of excellent history and a terrible fortnight. This is the case
  // REGRESSION_WINDOW_DAYS exists for: a lifetime average of 97.6% would hide
  // a recent 20% completely.
  const regressed = evidence({
    approved: 400,
    rejected: 10,
    recentApproved: 2,
    recentRejected: 8,
  });

  it('demotes despite an excellent lifetime record', () => {
    expect(regressed.rate).toBeGreaterThan(PROMOTION_RATE);
    expect(regressed.recentRate).toBeLessThan(DEMOTION_RATE);

    const verdict = evaluateLadder('promoted', regressed, true, false);
    expect(verdict).toMatchObject({
      action: 'demote',
      reason: 'demoted_on_regression',
    });
  });

  it('states both windows in the demotion detail', () => {
    const verdict = evaluateLadder('promoted', regressed, true, false);
    if (verdict.action !== 'demote') throw new Error('unreachable');
    expect(verdict.detail).toContain('20%');
    expect(verdict.detail).toContain('10 human decision(s)');
    expect(verdict.detail).toContain(`${REGRESSION_WINDOW_DAYS} days`);
    // The lifetime number, so a reader can see why the window is what is
    // being measured.
    expect(verdict.detail).toContain('97.6%');
  });

  it('does NOT re-promote the demoted class on the next evaluation', () => {
    // The oscillation guard. Without it, rule 4 would promote this class back
    // on its lifetime rate, rule 3 would demote it an hour later, and the
    // operator would get one HIGH-priority notification an hour forever.
    const verdict = evaluateLadder('measure', regressed, true, false);
    expect(verdict.action).toBe('hold');
    expect(verdict).toMatchObject({
      detail: expect.stringContaining('undone by the next evaluation'),
    });
  });

  it('does not demote on too little recent evidence', () => {
    // Silence is not a regression. A class nobody has decided on lately has
    // not got worse; it has gone quiet.
    const quiet = evidence({
      approved: 400,
      rejected: 10,
      recentApproved: 0,
      recentRejected: DEMOTION_MIN_SAMPLE - 1,
    });
    expect(quiet.recentRate).toBe(0);
    expect(evaluateLadder('promoted', quiet, true, false).action).toBe('hold');
  });

  it('demotes at exactly DEMOTION_MIN_SAMPLE', () => {
    const justEnough = evidence({
      approved: 400,
      rejected: 10,
      recentApproved: 0,
      recentRejected: DEMOTION_MIN_SAMPLE,
    });
    expect(evaluateLadder('promoted', justEnough, true, false)).toMatchObject({
      action: 'demote',
      reason: 'demoted_on_regression',
    });
  });
});

describe('isRegressing', () => {
  it('is false when there is too little recent evidence to judge', () => {
    expect(
      isRegressing(evidence({ recentApproved: 0, recentRejected: 4 })),
    ).toBe(false);
  });

  it('is false for a class with no recent evidence at all', () => {
    expect(isRegressing(evidence({ approved: 100, rejected: 0 }))).toBe(false);
  });

  it('is true below DEMOTION_RATE with enough recent evidence', () => {
    expect(
      isRegressing(evidence({ recentApproved: 1, recentRejected: 9 })),
    ).toBe(true);
  });
});

describe('holdDetail', () => {
  it('says how many more samples are needed, and names both numbers', () => {
    // #101 renders this as "what would be needed to promote". "2 more needed"
    // alone would not tell an operator whether the rate is also a problem.
    const detail = holdDetail(
      'measure',
      evidence({ approved: 17, rejected: 1 }),
    );
    expect(detail).toContain('18 of 20 samples');
    expect(detail).toContain('2 more needed');
    expect(detail).toContain('94.4%');
  });

  it('warns that a sufficient sample with a low rate needs the rate too', () => {
    const detail = holdDetail(
      'measure',
      evidence({ approved: 10, rejected: 5 }),
    );
    expect(detail).toContain('5 more needed');
    expect(detail).toContain('the rate must also reach 90%');
  });

  it('tells a promoted class with thin recent evidence that nobody has checked it', () => {
    const detail = holdDetail(
      'promoted',
      evidence({ approved: 100, rejected: 0, recentApproved: 2 }),
    );
    expect(detail).toContain('below the 5 a demotion must rest on');
  });
});

describe('shortfallCount', () => {
  it('is 0 for a class already at or above the threshold', () => {
    expect(shortfallCount(evidence({ approved: 18, rejected: 2 }))).toBe(0);
  });

  it('returns the smallest n that reaches PROMOTION_RATE', () => {
    // 10 approved, 5 rejected. Need (10+n)/(15+n) >= 0.9 -> n >= 35.
    const need = shortfallCount(evidence({ approved: 10, rejected: 5 }));
    expect(need).toBe(35);
    expect((10 + need) / (15 + need)).toBeGreaterThanOrEqual(PROMOTION_RATE);
    expect((10 + need - 1) / (15 + need - 1)).toBeLessThan(PROMOTION_RATE);
  });
});

describe('promotionOrderAnomaly', () => {
  it('is silent when nothing is promoted', () => {
    expect(promotionOrderAnomaly([])).toBeNull();
  });

  it('is silent on VISION §7 order', () => {
    expect(promotionOrderAnomaly(['re-dispatch'])).toBeNull();
    expect(promotionOrderAnomaly(['re-dispatch', 'decomposition'])).toBeNull();
    expect(
      promotionOrderAnomaly(['re-dispatch', 'decomposition', 'issue-shaping']),
    ).toBeNull();
  });

  it('ignores the classes VISION does not rank', () => {
    // run-diagnosis, spec-quality-feedback and daily-brief change nothing
    // outside the decision log, so they have no position in an order that
    // ranks blast radius. Giving them one would produce false anomalies.
    expect(
      promotionOrderAnomaly([
        'daily-brief',
        'run-diagnosis',
        'spec-quality-feedback',
      ]),
    ).toBeNull();
  });

  it('flags issue-shaping promoted ahead of re-dispatch', () => {
    const anomaly = promotionOrderAnomaly(['issue-shaping']);
    expect(anomaly).toContain('"issue-shaping" is promoted');
    expect(anomaly).toContain('"re-dispatch"');
    expect(anomaly).toContain('"decomposition"');
  });

  it('flags quarantine-decision unconditionally', () => {
    // #99: "A system that promotes quarantine decisions first has a
    // measurement bug, not a breakthrough." Flagged even when every class
    // ahead of it is also promoted, which the ordering rule alone would miss.
    const anomaly = promotionOrderAnomaly([
      're-dispatch',
      'decomposition',
      'issue-shaping',
      'quarantine-decision',
    ]);
    expect(anomaly).toContain('quarantine-decision');
    expect(anomaly).toContain('measurement bug');
  });

  it('exposes VISION §7 order as data', () => {
    expect(expectedPromotionOrder()).toEqual([
      're-dispatch',
      'decomposition',
      'issue-shaping',
      'quarantine-decision',
    ]);
  });
});

describe('rungFor', () => {
  it('puts a class nobody has judged on observe', () => {
    expect(rungFor(false, emptyEvidence('re-dispatch'))).toBe('observe');
  });

  it('puts a class with any evidence on measure', () => {
    expect(rungFor(false, evidence({ approved: 1 }))).toBe('measure');
  });

  it('lands a demoted class on measure, not observe', () => {
    // `observe` means "no human has judged this even once", which is false of
    // a class that just regressed — the regression is made of judgements. It
    // also would not survive the next tick, so a demotion to `observe` would
    // silently un-demote its own rung within the hour.
    const regressed = evidence({
      approved: 400,
      rejected: 10,
      recentApproved: 2,
      recentRejected: 8,
    });
    expect(rungFor(false, regressed)).toBe('measure');
  });

  it('is idempotent: the rung is a function of state, not of history', () => {
    const item = evidence({ approved: 30, rejected: 1 });
    expect(rungFor(true, item)).toBe(rungFor(true, item));
    expect(rungFor(true, item)).toBe('promoted');
  });
});
