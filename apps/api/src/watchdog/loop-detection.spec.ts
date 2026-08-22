import { DEFAULT_LOOP_REPEATS, detectLoop } from './loop-detection';
import type { ToolObservation } from './loop-detection';

function signatures(...names: string[]): ToolObservation[] {
  return names.map((signature, i) => ({
    signature,
    occurredAt: new Date(Date.UTC(2026, 7, 21, 12, i)),
  }));
}

/** N identical calls in a row. */
function repeated(signature: string, times: number): ToolObservation[] {
  return signatures(...Array.from({ length: times }, () => signature));
}

describe('detectLoop', () => {
  describe('availability, not a false clean bill of health', () => {
    it.each(['partial', 'none', null] as const)(
      'reports UNAVAILABLE for %s fidelity',
      (fidelity) => {
        // #55: "Runners without the required streaming fidelity report that
        // this check is unavailable, rather than appearing to pass it." A
        // looping run on such a runner is undetectable here, and "no loop
        // found" would be a false negative dressed as a result.
        const verdict = detectLoop(fidelity, repeated('Bash:x', 50));

        expect(verdict.available).toBe(false);
        expect(verdict.looping).toBe(false);
        expect(verdict.reason).toContain('unavailable');
      },
    );

    it('names why it is unavailable', () => {
      expect(detectLoop('none', []).reason).toContain('per-tool progress events');
    });

    it('is available for a full-fidelity runner', () => {
      expect(detectLoop('full', signatures('Bash:x')).available).toBe(true);
    });
  });

  describe('detecting a loop', () => {
    it('fires on the threshold number of consecutive repeats', () => {
      const verdict = detectLoop('full', repeated('Bash:sha256:abc', DEFAULT_LOOP_REPEATS));

      expect(verdict.looping).toBe(true);
      expect(verdict.repeats).toBe(DEFAULT_LOOP_REPEATS);
    });

    it('records the signature that triggered it', () => {
      // #55: "The triggering signature is recorded on every kill", so a false
      // positive is diagnosable rather than a mystery.
      const verdict = detectLoop('full', repeated('Bash:sha256:abc', 8));

      expect(verdict.signature).toBe('Bash:sha256:abc');
      expect(verdict.reason).toContain('Bash:sha256:abc');
      expect(verdict.reason).toContain('repeated 8 times consecutively');
    });

    it('does not fire one repeat below the threshold', () => {
      const verdict = detectLoop('full', repeated('Bash:x', DEFAULT_LOOP_REPEATS - 1));

      expect(verdict.looping).toBe(false);
    });

    it('is tunable', () => {
      expect(detectLoop('full', repeated('Bash:x', 3), { repeats: 3 }).looping).toBe(true);
      expect(detectLoop('full', repeated('Bash:x', 3), { repeats: 4 }).looping).toBe(false);
    });
  });

  describe('a legitimate test-fix-retest cycle is NOT killed', () => {
    it('spares an alternating cycle even when it runs long', () => {
      // The requirement #55 states outright. The cycle runs tests, edits a
      // file, runs tests again — so the test signature recurs OFTEN but never
      // consecutively. Counting frequency instead of consecutiveness would
      // kill exactly this.
      const cycle = signatures(
        ...Array.from({ length: 30 }, (_, i) =>
          i % 2 === 0 ? 'Bash:test' : 'Edit:src/thing.ts',
        ),
      );

      const verdict = detectLoop('full', cycle);

      expect(verdict.looping).toBe(false);
      expect(verdict.reason).toContain('below the threshold');
    });

    it('spares a three-step cycle', () => {
      const cycle = signatures(
        ...Array.from({ length: 30 }, (_, i) => ['Read:a', 'Edit:a', 'Bash:test'][i % 3]),
      );

      expect(detectLoop('full', cycle).looping).toBe(false);
    });

    it('spares a run that repeated a signature and then MOVED ON', () => {
      // A loop that has since broken is not a loop. Killing a run for a
      // pattern it already escaped destroys work for nothing.
      const observations = [...repeated('Bash:stuck', 10), ...signatures('Edit:progress.ts')];

      expect(detectLoop('full', observations).looping).toBe(false);
    });

    it('spares the same signature recurring far apart', () => {
      const observations = signatures(
        'Bash:test',
        'Edit:a',
        'Bash:test',
        'Edit:b',
        'Bash:test',
        'Edit:c',
        'Bash:test',
      );

      expect(detectLoop('full', observations).looping).toBe(false);
    });
  });

  describe('the window', () => {
    it('only examines recent events', () => {
      // An unbounded scan grows with the run, and a signature repeated an hour
      // ago is not evidence about what the run is doing now.
      const observations = [...repeated('Bash:old', 20), ...signatures('Edit:a', 'Edit:b')];

      const verdict = detectLoop('full', observations, { window: 2 });

      expect(verdict.looping).toBe(false);
      expect(verdict.repeats).toBeLessThanOrEqual(2);
    });

    it('detects a loop inside the window', () => {
      const observations = [...signatures('Edit:a'), ...repeated('Bash:stuck', 10)];

      expect(detectLoop('full', observations, { window: 10 }).looping).toBe(true);
    });
  });

  describe('thin evidence', () => {
    it('concludes nothing from an empty stream', () => {
      const verdict = detectLoop('full', []);

      expect(verdict.looping).toBe(false);
      expect(verdict.reason).toContain('fewer than the');
    });

    it('concludes nothing from fewer events than the threshold', () => {
      expect(detectLoop('full', repeated('Bash:x', 2)).looping).toBe(false);
    });
  });

  describe('the properties this must hold', () => {
    it('is deterministic', () => {
      const observations = repeated('Bash:x', 8);

      expect(detectLoop('full', observations)).toEqual(detectLoop('full', observations));
    });

    it('does not mutate its input', () => {
      const observations = repeated('Bash:x', 8);
      const before = JSON.stringify(observations);

      detectLoop('full', observations);

      expect(JSON.stringify(observations)).toBe(before);
    });

    it('always explains itself, loop or not', () => {
      // A verdict a human cannot check is one they will stop trusting — the
      // same rule the silence verdicts follow.
      for (const verdict of [
        detectLoop('full', repeated('Bash:x', 8)),
        detectLoop('full', repeated('Bash:x', 2)),
        detectLoop('none', repeated('Bash:x', 8)),
      ]) {
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    });
    describe('when the run stopped making real progress (#59)', () => {
    it('reports the FIRST repeat of the streak, not the newest event', () => {
      // A looping run is not silent — events keep arriving — so measuring
      // detection latency from its last event would report a few seconds for
      // a run that has been going nowhere for an hour.
      // Distinct timestamps throughout, so returning the event BEFORE the
      // streak would fail rather than coincide.
      const observations = signatures('Bash:setup', ...Array(8).fill('Bash:x'));

      const verdict = detectLoop('full', observations);

      expect(verdict.startedRepeatingAt).toEqual(observations[1].occurredAt);
      expect(verdict.startedRepeatingAt).not.toEqual(observations[0].occurredAt);
    });

    it('reports nothing when there is no loop to date', () => {
      // Including when the check could not run at all: a time for a streak
      // that was never established would be an invented measurement.
      expect(detectLoop('full', repeated('Bash:x', 2)).startedRepeatingAt).toBeNull();
      expect(detectLoop('none', repeated('Bash:x', 50)).startedRepeatingAt).toBeNull();
    });
  });
});
});
