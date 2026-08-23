import { metrics, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  FactoryMetrics,
  type DetectionMeasurement,
} from './factory-metrics.service';
import { traceIdForWorkOrder } from './work-order-trace';

const IDENTITY = 'wo_opifex_312_a3f91c2_a1';
const STOPPED = new Date('2026-08-22T10:00:00Z');
const RAISED = new Date('2026-08-22T10:00:04Z');
const DELIVERED = new Date('2026-08-22T10:00:07Z');

function measurement(
  overrides: Partial<DetectionMeasurement> = {},
): DetectionMeasurement {
  return {
    workOrderIdentity: IDENTITY,
    repository: 'marinoscar/opifex',
    kind: 'run_stalled',
    detectionSource: 'runner',
    progressStoppedAt: STOPPED,
    raisedAt: RAISED,
    ...overrides,
  };
}

describe('FactoryMetrics', () => {
  let spans: InMemorySpanExporter;
  let metricExporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let service: FactoryMetrics;

  beforeEach(() => {
    spans = new InMemorySpanExporter();
    trace.disable();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(spans)],
      }),
    );

    metricExporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    reader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 2 ** 30,
    });
    metrics.disable();
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

    // Constructed AFTER the providers: the instruments are captured in field
    // initializers, so a service built against the noop provider stays noop.
    service = new FactoryMetrics();
  });

  afterEach(() => {
    trace.disable();
    metrics.disable();
  });

  async function collected() {
    // Read the reader's own collection rather than the exporter's: the
    // exporter only fills on the periodic push, and a 2^30 ms interval means
    // that never happens inside a test.
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
  }

  async function instrument(name: string) {
    return (await collected()).find(
      (metric) => metric.descriptor.name === name,
    );
  }

  describe('stop to noticed', () => {
    it('records the elapsed time from the stop, not from the tick that noticed', async () => {
      service.recordDetected(measurement());

      const histogram = await instrument('opifex.detection.detect_latency');
      expect(histogram!.dataPoints[0].value).toMatchObject({
        sum: 4_000,
        count: 1,
      });
    });

    it('says which liveness source was carrying the run', async () => {
      // Git-derived detection is structurally slower than runner-reported.
      // An aggregate that blends them describes neither.
      service.recordDetected(measurement({ detectionSource: 'git' }));

      const histogram = await instrument('opifex.detection.detect_latency');
      expect(
        histogram!.dataPoints[0].attributes['opifex.detection.source'],
      ).toBe('git');
    });

    it('labels an unattributable detection rather than dropping the attribute', async () => {
      // A missing attribute silently merges into the backend's default
      // series; `unknown` is a series an operator can actually see.
      service.recordDetected(measurement({ detectionSource: null }));

      const histogram = await instrument('opifex.detection.detect_latency');
      expect(
        histogram!.dataPoints[0].attributes['opifex.detection.source'],
      ).toBe('unknown');
    });

    it('counts the escalation', async () => {
      service.recordDetected(measurement());

      const counter = await instrument('opifex.escalations.raised');
      expect(counter!.dataPoints[0].value).toBe(1);
    });
  });

  describe('stop to notified', () => {
    it('is the metric, and it measures to delivery', async () => {
      // VISION §10: "the elapsed time between a run ceasing to make progress
      // and a human being informed." Seven seconds, not the four it took to
      // notice.
      service.recordNotified({ ...measurement(), deliveredAt: DELIVERED });

      const histogram = await instrument('opifex.detection.latency');
      expect(histogram!.dataPoints[0].value).toMatchObject({
        sum: 7_000,
        count: 1,
      });
    });

    it('is not recorded by noticing alone', async () => {
      // The trap this whole issue is about: a system that reports
      // stop-to-detected as stop-to-notified shows success while the operator
      // still finds out four hours later.
      service.recordDetected(measurement());

      expect(await instrument('opifex.detection.latency')).toBeUndefined();
    });

    it('leaves the raised-versus-notified gap visible', async () => {
      // Three stalls detected, one delivered. The gap is how many stalls
      // nobody was told about, and it has to be countable.
      service.recordDetected(measurement());
      service.recordDetected(measurement({ kind: 'run_looping' }));
      service.recordDetected(measurement({ kind: 'budget_exceeded' }));
      service.recordNotified({ ...measurement(), deliveredAt: DELIVERED });

      const raised = await instrument('opifex.escalations.raised');
      const notified = await instrument('opifex.escalations.notified');
      const total = (points: { value: unknown }[]) =>
        points.reduce((sum, point) => sum + (point.value as number), 0);

      expect(total(raised!.dataPoints)).toBe(3);
      expect(total(notified!.dataPoints)).toBe(1);
    });
  });

  describe('clock skew', () => {
    it('never records a negative latency', async () => {
      // A runner's `occurredAt` comes from the runner's clock. A negative
      // value is not a small error — it drags the aggregate below the truth
      // and can make the target look met.
      service.recordDetected(
        measurement({ progressStoppedAt: RAISED, raisedAt: STOPPED }),
      );

      const histogram = await instrument('opifex.detection.detect_latency');
      expect(histogram!.dataPoints[0].value).toMatchObject({
        sum: 0,
        count: 1,
      });
    });
  });

  describe('the work order trace', () => {
    it('puts the detection span in the work order trace', async () => {
      service.recordDetected(measurement());

      const [span] = spans.getFinishedSpans();
      expect(span.name).toBe('opifex.detection');
      expect(span.spanContext().traceId).toBe(traceIdForWorkOrder(IDENTITY));
    });

    it('spans the gap it measured, rather than the instant it recorded it', async () => {
      service.recordDetected(measurement());

      const [span] = spans.getFinishedSpans();
      expect(hrToMs(span.startTime)).toBe(STOPPED.getTime());
      expect(hrToMs(span.endTime)).toBe(RAISED.getTime());
    });

    it('marks the detection span as an error, because something went wrong', async () => {
      service.recordDetected(measurement());

      expect(spans.getFinishedSpans()[0].status.code).toBe(2);
    });

    it('joins the notification span to the same trace', async () => {
      service.recordDetected(measurement());
      service.recordNotified({ ...measurement(), deliveredAt: DELIVERED });

      const traceIds = new Set(
        spans.getFinishedSpans().map((s) => s.spanContext().traceId),
      );
      expect(traceIds.size).toBe(1);
    });

    it('emits no span for a system escalation with no work order', async () => {
      // A `system` escalation is about the control plane and belongs to no
      // work order. Inventing a trace for it would put control-plane spans in
      // a work order's timeline.
      service.recordDetected(measurement({ workOrderIdentity: null }));

      expect(spans.getFinishedSpans()).toHaveLength(0);
      expect(await instrument('opifex.detection.detect_latency')).toBeDefined();
    });
  });

  describe('one span per turn or tool call', () => {
    const runEvent = {
      workOrderIdentity: IDENTITY,
      repository: 'marinoscar/opifex',
      type: 'tool.call',
      source: 'runner',
      occurredAt: STOPPED,
      toolSignature: 'Bash:npm test',
      costUsd: 0.0142,
      tokensInput: 1200,
      tokensOutput: 340,
    };

    it('lands in the work order trace with no context passed in', () => {
      // The point of deriving the trace id: a runner posting over HTTP shares
      // no call stack with anything else in the trace.
      const result = service.recordRunEvent(runEvent);

      expect(result.traceId).toBe(traceIdForWorkOrder(IDENTITY));
      expect(spans.getFinishedSpans()[0].spanContext().traceId).toBe(
        result.traceId,
      );
    });

    it('returns the span id it actually emitted, for the row to store', () => {
      const result = service.recordRunEvent(runEvent);

      expect(result.spanId).toBe(
        spans.getFinishedSpans()[0].spanContext().spanId,
      );
    });

    it('carries cost and tokens as attributes', () => {
      service.recordRunEvent(runEvent);

      expect(spans.getFinishedSpans()[0].attributes).toMatchObject({
        'opifex.cost.usd': 0.0142,
        'opifex.tokens.input': 1200,
        'opifex.tokens.output': 340,
      });
    });

    it('omits cost entirely when the runner does not report it', () => {
      // VISION §6 makes cost reporting a declared capability, so "unknown"
      // and "zero" are different facts. A dashboard that sums them is wrong.
      service.recordRunEvent({ ...runEvent, costUsd: null, tokensInput: null });

      const { attributes } = spans.getFinishedSpans()[0];
      expect(attributes).not.toHaveProperty('opifex.cost.usd');
      expect(attributes).not.toHaveProperty('opifex.tokens.input');
    });

    it('records a reported zero cost, which is not the same as silence', () => {
      service.recordRunEvent({ ...runEvent, costUsd: 0 });

      expect(spans.getFinishedSpans()[0].attributes['opifex.cost.usd']).toBe(0);
    });

    it('names the span after the tool when there is one', () => {
      service.recordRunEvent(runEvent);

      expect(spans.getFinishedSpans()[0].name).toBe('tool Bash:npm test');
    });

    it('falls back to the event type for a turn', () => {
      service.recordRunEvent({
        ...runEvent,
        toolSignature: null,
        type: 'progress',
      });

      expect(spans.getFinishedSpans()[0].name).toBe('progress');
    });

    it('returns nulls when no OpenTelemetry SDK is running', () => {
      // OTEL_ENABLED off, or a unit test: the API hands back a noop span with
      // an all-zero context. Storing those zeros would leave the run detail
      // linking to a trace that does not exist.
      // The noop span inherits the work order's parent context verbatim, so
      // its ids LOOK real. Storing them would link the run detail to a trace
      // with nothing in it.
      trace.disable();

      expect(new FactoryMetrics().recordRunEvent(runEvent)).toEqual({
        traceId: null,
        spanId: null,
      });
    });

    it('puts BOTH liveness sources in the one work order trace', () => {
      // VISION §9 runs two independent sources, and #59 requires the metric
      // work for both. They are produced by processes that share no call
      // stack — a runner posting over HTTP, the git watcher on a reconciler
      // tick — which is the whole reason the trace id is derived rather than
      // propagated.
      service.recordRunEvent({ ...runEvent, source: 'runner' });
      service.recordRunEvent({
        ...runEvent,
        source: 'git',
        type: 'progress',
        toolSignature: null,
      });
      service.recordDetected(measurement({ detectionSource: 'git' }));

      const traceIds = new Set(
        spans.getFinishedSpans().map((s) => s.spanContext().traceId),
      );
      expect(spans.getFinishedSpans()).toHaveLength(3);
      expect(traceIds).toEqual(new Set([traceIdForWorkOrder(IDENTITY)]));
    });

    it('is a point in time, not an invented duration', () => {
      // An event says when something happened, not how long it took. Giving
      // it a made-up duration would put a number on the dashboard that no
      // source produced.
      const [span] =
        (service.recordRunEvent(runEvent), spans.getFinishedSpans());

      expect(hrToMs(span.endTime)).toBe(hrToMs(span.startTime));
    });
  });
});

function hrToMs([seconds, nanos]: [number, number]): number {
  return seconds * 1_000 + Math.round(nanos / 1_000_000);
}
