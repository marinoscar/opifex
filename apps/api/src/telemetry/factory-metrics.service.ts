import { Injectable } from '@nestjs/common';
import {
  isSpanContextValid,
  type Histogram,
  metrics,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

import { workOrderContext } from './work-order-trace';

/** The instrumentation scope. Matches the tracer name already in use. */
const SCOPE = 'opifex-api';

/**
 * Attributes every detection measurement carries.
 *
 * `detectionSource` is not optional decoration: VISION §9 runs two
 * INDEPENDENT liveness sources, and a git-derived detection is structurally
 * slower than a runner-reported one. An aggregate that blends them reports a
 * number that describes neither, and hides which half needs work.
 */
export interface DetectionMeasurement {
  workOrderIdentity: string | null;
  repository: string;
  kind: string;
  detectionSource: 'runner' | 'git' | 'control_plane' | null;
  /** When the run actually stopped making progress. */
  progressStoppedAt: Date;
  /** When Opifex concluded it had stopped. */
  raisedAt: Date;
  /** When a human was actually told. Null until a transport delivers. */
  deliveredAt?: Date | null;
}

/**
 * Success metric 1, as instruments rather than log lines.
 *
 * VISION §10 sets detection latency's target in **seconds**, and §1 names it
 * as the metric that defines the problem. A target nobody measures is a wish.
 *
 * ## Two histograms, because there are two numbers and only one is the metric
 *
 * `opifex.detection.detect_latency` is stop-to-noticed. It is the one that is
 * easy to make look good, because it excludes everything between noticing and
 * telling somebody.
 *
 * `opifex.detection.latency` is stop-to-**notified**, which is the definition
 * VISION §10 actually gives: *"the elapsed time between a run ceasing to make
 * progress and a human being informed."* Reporting the first as if it were
 * the second would show success while the operator still learns about it four
 * hours later — the original failure, now with a dashboard.
 *
 * ## Why raised-but-never-delivered is counted, not dropped
 *
 * An escalation that no transport ever delivered has infinite stop-to-notified
 * latency. Leaving it out of the histogram would make a totally broken
 * notification path look like perfect latency over a small sample, so it is
 * counted separately and loudly instead.
 */
@Injectable()
export class FactoryMetrics {
  private readonly meter = metrics.getMeter(SCOPE);
  private readonly tracer = trace.getTracer(SCOPE);

  /** Stop to noticed. The easy number. */
  private readonly detectLatency: Histogram = this.meter.createHistogram(
    'opifex.detection.detect_latency',
    {
      description: 'Milliseconds from a run ceasing to make progress to Opifex noticing',
      unit: 'ms',
    },
  );

  /** Stop to notified. The success metric. */
  private readonly notifyLatency: Histogram = this.meter.createHistogram(
    'opifex.detection.latency',
    {
      description:
        'Milliseconds from a run ceasing to make progress to a human being informed ' +
        '(VISION success metric 1)',
      unit: 'ms',
    },
  );

  private readonly raised = this.meter.createCounter('opifex.escalations.raised', {
    description: 'Escalations recorded',
  });

  private readonly notified = this.meter.createCounter('opifex.escalations.notified', {
    description:
      'Escalations a transport confirmed delivered. The gap against ' +
      'opifex.escalations.raised is how many stalls nobody was told about.',
  });

  /**
   * Record that Opifex noticed a stop, and emit the span that shows it.
   *
   * The span covers stop → raised, inside the work order's trace, so the gap
   * is visible next to the run's own events rather than only as a percentile.
   */
  recordDetected(measurement: DetectionMeasurement): void {
    const latencyMs = elapsed(measurement.progressStoppedAt, measurement.raisedAt);

    this.detectLatency.record(latencyMs, this.attributes(measurement));
    this.raised.add(1, this.attributes(measurement));

    if (!measurement.workOrderIdentity) return;

    const span = this.tracer.startSpan(
      'opifex.detection',
      {
        startTime: measurement.progressStoppedAt,
        attributes: {
          ...this.attributes(measurement),
          'opifex.detection.latency_ms': latencyMs,
        },
      },
      workOrderContext(measurement.workOrderIdentity),
    );
    // An error status, deliberately: a detection span means something went
    // wrong with the run. A trace where the only red span is the detection is
    // exactly the view an operator wants.
    span.setStatus({ code: SpanStatusCode.ERROR, message: measurement.kind });
    span.end(measurement.raisedAt);
  }

  /**
   * Record that a human was actually told.
   *
   * Called by the notification transport, never by the detector — which is
   * the point. The detector cannot know, and a metric that let it guess would
   * be measuring stop-to-detected under the other name.
   */
  recordNotified(measurement: DetectionMeasurement & { deliveredAt: Date }): void {
    const latencyMs = elapsed(measurement.progressStoppedAt, measurement.deliveredAt);

    this.notifyLatency.record(latencyMs, this.attributes(measurement));
    this.notified.add(1, this.attributes(measurement));

    if (!measurement.workOrderIdentity) return;

    const span = this.tracer.startSpan(
      'opifex.notification',
      {
        startTime: measurement.raisedAt,
        attributes: {
          ...this.attributes(measurement),
          'opifex.detection.latency_ms': latencyMs,
        },
      },
      workOrderContext(measurement.workOrderIdentity),
    );
    span.end(measurement.deliveredAt);
  }

  /**
   * One span per turn or tool call, in the work order's trace.
   *
   * VISION §9 maps run events onto exactly this, with *"cost and tokens as
   * span attributes"*. Point-in-time spans: an event reports when something
   * happened, not how long it took, and inventing a duration would put a
   * number on the dashboard that no source produced.
   *
   * Returns nulls when no span was actually emitted — `OTEL_ENABLED` off, a
   * unit test, or a sampling decision that dropped it. The API hands back a
   * non-recording span in all three cases, and it inherits the work order's
   * parent context verbatim, so the ids LOOK real: storing them would leave
   * the run detail linking to a trace with nothing in it. Null says the true
   * thing.
   */
  recordRunEvent(event: {
    workOrderIdentity: string;
    repository?: string;
    type: string;
    source: string;
    occurredAt: Date;
    summary?: string | null;
    toolSignature?: string | null;
    costUsd?: number | null;
    tokensInput?: number | null;
    tokensOutput?: number | null;
  }): { traceId: string | null; spanId: string | null } {
    const span = this.tracer.startSpan(
      event.toolSignature ? `tool ${event.toolSignature}` : event.type,
      {
        startTime: event.occurredAt,
        attributes: {
          'opifex.work_order.identity': event.workOrderIdentity,
          'opifex.run_event.type': event.type,
          'opifex.run_event.source': event.source,
          ...(event.repository ? { 'opifex.repository': event.repository } : {}),
          ...(event.toolSignature ? { 'opifex.tool.signature': event.toolSignature } : {}),
          ...(event.summary ? { 'opifex.run_event.summary': event.summary } : {}),
          // Omitted rather than zeroed when not reported. VISION §6 makes cost
          // reporting a DECLARED capability, so "unknown" and "zero" are
          // genuinely different and a dashboard that sums them is wrong.
          ...(event.costUsd != null ? { 'opifex.cost.usd': event.costUsd } : {}),
          ...(event.tokensInput != null ? { 'opifex.tokens.input': event.tokensInput } : {}),
          ...(event.tokensOutput != null ? { 'opifex.tokens.output': event.tokensOutput } : {}),
        },
      },
      workOrderContext(event.workOrderIdentity),
    );

    const spanContext = span.spanContext();
    const emitted = span.isRecording() && isSpanContextValid(spanContext);
    span.end(event.occurredAt);

    return emitted
      ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
      : { traceId: null, spanId: null };
  }

  private attributes(measurement: DetectionMeasurement): Record<string, string> {
    return {
      'opifex.repository': measurement.repository,
      'opifex.escalation.kind': measurement.kind,
      // `unknown` rather than omitted: a missing attribute silently merges
      // into whichever series the backend defaults to, and an unattributable
      // detection is itself worth seeing.
      'opifex.detection.source': measurement.detectionSource ?? 'unknown',
      ...(measurement.workOrderIdentity
        ? { 'opifex.work_order.identity': measurement.workOrderIdentity }
        : {}),
    };
  }
}

/**
 * Never negative.
 *
 * Clock skew between a runner's `occurredAt` and the control plane's clock is
 * ordinary, and a negative latency in a histogram is not a small error — it
 * drags the aggregate below the truth and can make the target look met.
 */
function elapsed(from: Date, to: Date): number {
  return Math.max(0, to.getTime() - from.getTime());
}
