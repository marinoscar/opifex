import {
  explainErrors,
  validatorFor,
} from '../../../test/schemas/contract-validators';
import {
  INIT_LINE,
  PERMISSION_DENIED_LINE,
  QUOTA_EXHAUSTED_LINE,
  RATE_LIMIT_ALLOWED_LINE,
  RATE_LIMIT_BLOCKED_LINE,
  RESULT_ERROR_LINE,
  RESULT_SUCCESS_LINE,
  TEXT_LINE,
  THINKING_LINE,
  TOOL_RESULT_ERROR_LINE,
  TOOL_RESULT_LINE,
  TOOL_USE_LINE,
  TOOL_USE_LINE_REORDERED_ARGS,
  TOOL_USE_LINE_REPEATED,
  UNMAPPED_LINES,
} from './stream-json-fixtures';
import {
  mapStreamLine,
  SUMMARY_MAX_LENGTH,
  toolSignature,
  type MapperContext,
  type StreamMapping,
} from './stream-json-mapper';

const CONTEXT: MapperContext = {
  runId: '3f1d9d3e-6b1a-4f8e-9c2a-8b5a4f0c1d22',
  workOrderId: 'wo_acme-widgets_42_abc1234_a1',
  runnerKey: 'claude-code-local@2.1.240',
  receivedAt: new Date('2026-08-22T22:05:00.000Z'),
};

const map = (line: unknown): StreamMapping => mapStreamLine(line, CONTEXT);

function expectEvent(mapping: StreamMapping) {
  if (mapping.kind !== 'event') {
    throw new Error(`expected an event, got ${mapping.kind}`);
  }
  return mapping.event;
}

describe('stream-json mapper', () => {
  describe('tool calls', () => {
    it('maps a tool_use to progress carrying the tool name and a digest', () => {
      // The whole basis of `streamingFidelity: 'full'`. Loop detection (#55)
      // is built entirely on this field.
      const event = expectEvent(map(TOOL_USE_LINE));

      expect(event.type).toBe('run.progress');
      expect(event.tool?.name).toBe('Bash');
      expect(event.tool?.signature).toMatch(/^[0-9a-f]{32}$/);
    });

    it('never puts the raw arguments in the signature', () => {
      // A `Bash` command line is the obvious case: arguments can be enormous
      // and can contain secrets, and loop detection only ever compares them
      // for equality, so it loses nothing by comparing a digest.
      const event = expectEvent(map(TOOL_USE_LINE));

      expect(event.tool?.signature).not.toContain('note.txt');
      expect(JSON.stringify(event)).not.toContain('find . -iname');
    });

    it('gives the same call the same signature, so a loop looks like a loop', () => {
      const first = expectEvent(map(TOOL_USE_LINE));
      const again = expectEvent(map(TOOL_USE_LINE_REPEATED));

      expect(again.tool?.signature).toBe(first.tool?.signature);
      // Different events, though — two identical calls a minute apart are two
      // events, and collapsing them would hide the loop rather than reveal it.
      expect(again.eventId).not.toBe(first.eventId);
    });

    it('ignores argument key order', () => {
      // Without recursive key sorting, two identical calls serialised
      // differently would hash differently and a loop would look like
      // progress — precisely the failure #55 exists to catch.
      expect(
        expectEvent(map(TOOL_USE_LINE_REORDERED_ARGS)).tool?.signature,
      ).toBe(expectEvent(map(TOOL_USE_LINE)).tool?.signature);
    });

    it('distinguishes calls that differ only deep inside their arguments', () => {
      expect(toolSignature({ a: { b: { c: 1 } } })).not.toBe(
        toolSignature({ a: { b: { c: 2 } } }),
      );
      expect(toolSignature([1, 2, 3])).not.toBe(toolSignature([3, 2, 1]));
    });

    it('handles a tool call with no arguments at all', () => {
      expect(toolSignature(undefined)).toMatch(/^[0-9a-f]{32}$/);
      expect(toolSignature({})).toMatch(/^[0-9a-f]{32}$/);
      expect(toolSignature(undefined)).not.toBe(toolSignature({}));
    });
  });

  describe('prose and thinking', () => {
    it('maps assistant text to progress', () => {
      const event = expectEvent(map(TEXT_LINE));
      expect(event.type).toBe('run.progress');
      expect(event.summary).toBe('The word is: **hello**');
    });

    it('maps thinking to a heartbeat, not to progress', () => {
      // Thinking says the run is alive and says nothing about it having
      // moved. A progress feed full of it would drown the tool calls.
      const event = expectEvent(map(THINKING_LINE));
      expect(event.type).toBe('run.heartbeat');
    });

    it('never copies the thinking content into the summary', () => {
      // It is the model's reasoning, it can be long, and it is the last place
      // anyone should be reading a run's state from.
      const event = expectEvent(map(THINKING_LINE));
      expect(event.summary).toBe('Thinking');
      expect(JSON.stringify(event)).not.toContain(
        'Working out where the file is',
      );
    });

    it('truncates long prose to something a timeline can hold', () => {
      const long = {
        ...TEXT_LINE,
        message: {
          ...TEXT_LINE.message,
          content: [{ type: 'text', text: 'x'.repeat(5_000) }],
        },
      };
      const event = expectEvent(map(long));

      expect(event.summary!.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH);
      expect(event.summary!.endsWith('…')).toBe(true);
    });
  });

  describe('tool results', () => {
    it('maps a tool result to a heartbeat', () => {
      expect(expectEvent(map(TOOL_RESULT_LINE)).type).toBe('run.heartbeat');
    });

    it('does not fail the run when a TOOL fails', () => {
      // Agents recover from failed tool calls constantly. Emitting run.failed
      // here would make the control plane abandon runs that were about to
      // succeed.
      const event = expectEvent(map(TOOL_RESULT_ERROR_LINE));

      expect(event.type).toBe('run.heartbeat');
      expect(event.summary).toContain('error');
    });
  });

  describe('rate limits', () => {
    it('does not park a run that is not actually limited', () => {
      // The CLI emits one of these near the start of every run. Treating it
      // as a block would park a run that is working perfectly — and nothing
      // in the system notices a WRONGLY parked run, whereas a missed block
      // eventually surfaces as silence.
      expect(map(RATE_LIMIT_ALLOWED_LINE).kind).not.toBe('event');
    });

    it('keeps the window off a served line instead of dropping it (#231)', () => {
      // This used to be a `drop`, and dropping it meant the reset instant was
      // only ever learnt by hitting the wall. A served line carries the same
      // `resetsAt` a refused one does, which is the whole basis of #113's
      // reset-window-aware scheduling.
      const mapping = map(RATE_LIMIT_ALLOWED_LINE);
      expect(mapping.kind).toBe('quota');
      if (mapping.kind !== 'quota') throw new Error('expected a quota mapping');

      expect(mapping.quota).toEqual({
        runnerKey: CONTEXT.runnerKey,
        kind: 'five_hour',
        resetsAt: new Date(1787438400 * 1000),
        pressure: 'allowed',
        observedAt: CONTEXT.receivedAt,
      });
    });

    it('reads allowed_warning as pressure, which arrives before any park', () => {
      // The only signal in the system that precedes exhaustion. #89's
      // supervisor gate stands down on observed parks today; this is what
      // could let it stand down earlier.
      const warned = {
        ...RATE_LIMIT_ALLOWED_LINE,
        rate_limit_info: {
          ...RATE_LIMIT_ALLOWED_LINE.rate_limit_info,
          status: 'allowed_warning',
        },
      };
      const mapping = map(warned);
      if (mapping.kind !== 'quota') throw new Error('expected a quota mapping');
      expect(mapping.quota.pressure).toBe('warning');
    });

    it('records an unrecognized status as unknown, keeping the window', () => {
      // Version skew, not a stalled run — ADR-0006's posture. The reset
      // instant on that line is as good as any other line's; only the
      // pressure reading is lost.
      const strange = {
        ...RATE_LIMIT_ALLOWED_LINE,
        rate_limit_info: {
          ...RATE_LIMIT_ALLOWED_LINE.rate_limit_info,
          status: 'throttled_soft',
        },
      };
      const mapping = map(strange);
      if (mapping.kind !== 'quota') throw new Error('expected a quota mapping');
      expect(mapping.quota.pressure).toBe('unknown');
    });

    it('drops an undated served line, since a window has no other identity', () => {
      // `resetsAt` IS the window's identity. Without one there is nothing for
      // the sighting to be a sighting OF, and an invented instant would put a
      // row in front of an operator naming a moment that means nothing.
      const undated = {
        ...RATE_LIMIT_ALLOWED_LINE,
        rate_limit_info: {
          ...RATE_LIMIT_ALLOWED_LINE.rate_limit_info,
          resetsAt: 0,
        },
      };
      expect(map(undated)).toEqual({
        kind: 'drop',
        reason: 'rate limit status is allowed and undated',
      });
    });

    it('carries the window alongside the block on a refused line', () => {
      // One line says both things at once: the run is parked, and the window
      // it is parked on rolls at a known time. The event is about the RUN, the
      // observation is about the SUBSCRIPTION, which outlives it.
      const mapping = map(RATE_LIMIT_BLOCKED_LINE);
      if (mapping.kind !== 'event') throw new Error('expected an event');
      expect(mapping.quota?.pressure).toBe('exhausted');
      expect(mapping.quota?.resetsAt).toEqual(new Date(1787438400 * 1000));
    });

    it('maps a real limit to blocked with a dated reset', () => {
      // resetsAt is unix SECONDS, and it is the difference between #56
      // parking with a date and #57 escalating to a human.
      const event = expectEvent(map(RATE_LIMIT_BLOCKED_LINE));

      expect(event.type).toBe('run.blocked');
      expect(event.blocked?.reason).toBe('rate-limit');
      expect(event.blocked?.resetAt).toBe(
        new Date(1787438400 * 1000).toISOString(),
      );
      expect(event.blocked?.detail).toBe('five_hour');
    });

    it('separates an exhausted quota from a window to wait out', () => {
      // #56 treats them differently and must: one clears at a known time, the
      // other needs a human to buy more.
      expect(expectEvent(map(QUOTA_EXHAUSTED_LINE)).blocked?.reason).toBe(
        'quota-exhausted',
      );
    });

    it('omits resetAt rather than inventing one', () => {
      // The schema says an absent resetAt means "the runner cannot say", and
      // #56 escalates rather than parking forever on that. An invented time
      // would park a run until a moment that means nothing.
      const undated = {
        ...RATE_LIMIT_BLOCKED_LINE,
        rate_limit_info: {
          ...RATE_LIMIT_BLOCKED_LINE.rate_limit_info,
          resetsAt: 0,
        },
      };
      expect(expectEvent(map(undated)).blocked?.resetAt).toBeUndefined();
    });

    it('drops a rate_limit_event with no info rather than guessing', () => {
      expect(map({ type: 'rate_limit_event', uuid: 'x' }).kind).toBe('drop');
    });
  });

  describe('system lines', () => {
    it('maps init to progress, not to a second run.started', () => {
      // The runner already emitted run.started when it spawned the process. A
      // second would be two answers to "when did this begin", which is the
      // number detection latency (#59) is measured from.
      //
      // The model on this line is the other half of #420's run record, and the
      // authoritative half: `run.started` says which model the control plane
      // ASKED for, and this says which one the CLI actually resolved. An
      // untiered run passes no `--model` at all, so this is the only place its
      // model is ever recorded — which is why the summary carries it.
      const event = expectEvent(map(INIT_LINE));

      expect(event.type).toBe('run.progress');
      expect(event.summary).toContain('claude-sonnet-5');
    });

    it('keeps a permission refusal as progress, not as blocked', () => {
      // Nobody is being awaited: under a non-interactive permission mode the
      // request is refused outright and the agent carries on. Parking here
      // would stall a run that is still working, and #56 would then wait for
      // an approval no one has been asked for.
      const event = expectEvent(map(PERMISSION_DENIED_LINE));

      expect(event.type).toBe('run.progress');
      expect(event.summary).toContain('Permission denied for Read');
      expect(event.summary).toContain('outside allowed working directories');
    });
  });

  describe('the result line', () => {
    it('does not end the run', () => {
      // The exit code ends a run. VISION §8 puts the runner on the
      // never-trustable list, so a run that prints success and exits 2 failed.
      const mapping = map(RESULT_SUCCESS_LINE);

      expect(mapping.kind).toBe('result');
      expect(mapping.kind === 'result' && mapping.result.isError).toBe(false);
    });

    it('carries the cost the run actually incurred', () => {
      const mapping = map(RESULT_SUCCESS_LINE);
      if (mapping.kind !== 'result') throw new Error('expected a result');

      expect(mapping.result.costUsd).toBeCloseTo(0.2030522);
      expect(mapping.result.tokensInput).toBe(8);
      expect(mapping.result.tokensOutput).toBe(362);
      expect(mapping.result.numTurns).toBe(4);
    });

    it('counts permission denials, since a refused run reads differently', () => {
      const mapping = map(RESULT_SUCCESS_LINE);
      expect(
        mapping.kind === 'result' && mapping.result.permissionDenials,
      ).toBe(1);
    });

    it('reports an errored result as an error', () => {
      const mapping = map(RESULT_ERROR_LINE);
      if (mapping.kind !== 'result') throw new Error('expected a result');

      expect(mapping.result.isError).toBe(true);
      expect(mapping.result.subtype).toBe('error_during_execution');
    });

    it('leaves cost absent rather than zero when the CLI did not say', () => {
      // The schema keeps "not reported" and "spent nothing" distinct, and a
      // runner that could not report cost must not look like one that was
      // free.
      const mapping = map({
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'x',
      });
      if (mapping.kind !== 'result') throw new Error('expected a result');

      expect(mapping.result.costUsd).toBeUndefined();
      expect(mapping.result.tokensInput).toBeUndefined();
    });
  });

  describe('lines that do not map', () => {
    it.each(UNMAPPED_LINES)('drops $type/$subtype with a reason', (line) => {
      // ADR 0006: "drop what does not map, rather than inventing a type. An
      // unmappable line is logged once per run, not escalated: a new CLI
      // event type is a version skew, not a stalled run."
      const mapping = map(line);

      expect(mapping.kind).toBe('drop');
      expect(mapping.kind === 'drop' && mapping.reason.length).toBeGreaterThan(
        0,
      );
    });

    it('drops anything that is not a stream-json object', () => {
      for (const junk of [
        null,
        undefined,
        42,
        'a string',
        [],
        { no: 'type' },
      ]) {
        expect(map(junk).kind).toBe('drop');
      }
    });

    it('never invents a seventh event type', () => {
      // The closed set is the contract. A parser deciding on a new one at
      // three in the morning is how a schema version bump gets skipped.
      const SIX = [
        'run.started',
        'run.heartbeat',
        'run.progress',
        'run.blocked',
        'run.completed',
        'run.failed',
      ];
      const lines = [
        INIT_LINE,
        TOOL_USE_LINE,
        TEXT_LINE,
        THINKING_LINE,
        TOOL_RESULT_LINE,
        TOOL_RESULT_ERROR_LINE,
        RATE_LIMIT_BLOCKED_LINE,
        QUOTA_EXHAUSTED_LINE,
        PERMISSION_DENIED_LINE,
        ...UNMAPPED_LINES,
      ];

      for (const line of lines) {
        const mapping = map(line);
        if (mapping.kind === 'event') expect(SIX).toContain(mapping.event.type);
      }
    });

    it('never emits a terminal event, whatever it is given', () => {
      // The mapper cannot end a run. Only the exit code can, and a mapper
      // that could would give ingestion two contradictory endings.
      const lines = [
        INIT_LINE,
        TOOL_USE_LINE,
        RESULT_SUCCESS_LINE,
        RESULT_ERROR_LINE,
      ];

      for (const line of lines) {
        const mapping = map(line);
        if (mapping.kind === 'event') {
          expect(['run.completed', 'run.failed']).not.toContain(
            mapping.event.type,
          );
        }
      }
    });
  });

  describe('event identity and timing', () => {
    it('reuses the CLI uuid, so a redelivered line is recognised', () => {
      // Ingestion is idempotent on (runId, eventId) (#53). Reusing the CLI's
      // own id means a re-poll that returns the same line costs nothing.
      expect(expectEvent(map(TOOL_USE_LINE)).eventId).toBe(TOOL_USE_LINE.uuid);
    });

    it('still produces an id when a line carries none', () => {
      const event = expectEvent(map({ ...TOOL_USE_LINE, uuid: undefined }));
      expect(event.eventId.length).toBeGreaterThan(0);
    });

    it('prefers the CLI timestamp over receipt time', () => {
      // occurredAt is when it HAPPENED per its source, and the gap between
      // that and storage is detection latency — success metric 1.
      expect(expectEvent(map(TOOL_USE_LINE)).occurredAt).toBe(
        '2026-08-22T22:02:45.080Z',
      );
    });

    it('falls back to receipt time for the lines the CLI does not stamp', () => {
      // Only assistant and user lines carry a timestamp; for the rest,
      // receipt time is within milliseconds and is the honest best available.
      expect(expectEvent(map(INIT_LINE)).occurredAt).toBe(
        CONTEXT.receivedAt.toISOString(),
      );
    });

    it('ignores an unparseable timestamp rather than emitting one', () => {
      const event = expectEvent(
        map({ ...TOOL_USE_LINE, timestamp: 'not a date' }),
      );
      expect(event.occurredAt).toBe(CONTEXT.receivedAt.toISOString());
    });

    it('stamps every event as runner-reported', () => {
      // VISION §9: a synthesized event must never masquerade as a report.
      for (const line of [
        TOOL_USE_LINE,
        THINKING_LINE,
        RATE_LIMIT_BLOCKED_LINE,
        INIT_LINE,
      ]) {
        expect(expectEvent(map(line)).source).toBe('runner-reported');
      }
    });

    it('correlates every event with the run and the work order', () => {
      const event = expectEvent(map(TOOL_USE_LINE));
      expect(event.runId).toBe(CONTEXT.runId);
      expect(event.workOrderId).toBe(CONTEXT.workOrderId);
      expect(event.runner).toBe('claude-code-local@2.1.240');
    });
  });

  describe('conformance (#36)', () => {
    it('emits only events that validate against run-event.schema.json', () => {
      const validate = validatorFor('run-event');
      const lines = [
        INIT_LINE,
        TOOL_USE_LINE,
        TEXT_LINE,
        THINKING_LINE,
        TOOL_RESULT_LINE,
        TOOL_RESULT_ERROR_LINE,
        RATE_LIMIT_BLOCKED_LINE,
        QUOTA_EXHAUSTED_LINE,
        PERMISSION_DENIED_LINE,
      ];

      let emitted = 0;
      for (const line of lines) {
        const mapping = map(line);
        if (mapping.kind !== 'event') continue;
        emitted += 1;
        expect(validate(mapping.event)).toBe(true);
        expect(explainErrors(validate)).toBe('');
      }

      // Guards against the block passing vacuously if the mapper started
      // dropping everything.
      expect(emitted).toBe(lines.length);
    });
  });
});
