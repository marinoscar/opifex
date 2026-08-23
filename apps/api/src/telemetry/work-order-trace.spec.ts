import { trace } from '@opentelemetry/api';

import {
  rootSpanIdForWorkOrder,
  traceIdForWorkOrder,
  workOrderContext,
} from './work-order-trace';

const IDENTITY = 'wo_opifex_312_a3f91c2_a1';

describe('work-order trace ids', () => {
  it('produces a 32-hex-character trace id', () => {
    expect(traceIdForWorkOrder(IDENTITY)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces a 16-hex-character root span id', () => {
    expect(rootSpanIdForWorkOrder(IDENTITY)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives the same work order the same trace every time', () => {
    // The whole design: three processes that never share a call stack must
    // land on the same trace without passing anything to each other.
    expect(traceIdForWorkOrder(IDENTITY)).toBe(traceIdForWorkOrder(IDENTITY));
  });

  it('gives different work orders different traces', () => {
    expect(traceIdForWorkOrder(IDENTITY)).not.toBe(
      traceIdForWorkOrder('wo_opifex_313_a3f91c2_a1'),
    );
  });

  it('separates attempts of the same issue', () => {
    // `_a1` and `_a2` are different attempts at the same issue and are
    // genuinely different work orders. Collapsing them would interleave two
    // runs' spans in one trace.
    expect(traceIdForWorkOrder('wo_opifex_312_a3f91c2_a1')).not.toBe(
      traceIdForWorkOrder('wo_opifex_312_a3f91c2_a2'),
    );
  });

  it('does not reuse the trace id bits as the span id', () => {
    // Different slices of the digest. Overlapping them would make the root
    // span id predictable from the trace id in a way nothing needs and some
    // backends dislike.
    expect(traceIdForWorkOrder(IDENTITY)).not.toContain(
      rootSpanIdForWorkOrder(IDENTITY),
    );
  });

  it('builds a context OpenTelemetry will accept as a parent', () => {
    const spanContext = trace.getSpanContext(workOrderContext(IDENTITY));

    expect(spanContext).toEqual({
      traceId: traceIdForWorkOrder(IDENTITY),
      spanId: rootSpanIdForWorkOrder(IDENTITY),
      traceFlags: 1,
      isRemote: true,
    });
  });

  it('marks the parent remote, because it is', () => {
    // Not cosmetic: the parent really was not created in this process, and
    // sampling treats a remote parent differently.
    expect(trace.getSpanContext(workOrderContext(IDENTITY))?.isRemote).toBe(
      true,
    );
  });
});
