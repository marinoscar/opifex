import { createHash } from 'node:crypto';

import { type Context, context, trace, TraceFlags } from '@opentelemetry/api';

/**
 * One trace per work order, without a trace context to pass around.
 *
 * VISION §9: *"One trace per work order. One span per turn or tool call."*
 *
 * ## Why the ids are derived rather than generated
 *
 * The spans that belong to a work order are produced in places that never
 * share a call stack: a runner posts events minutes apart over HTTP, the git
 * watcher derives its own events on a tick, and the watchdog emits a
 * detection span from a third process entirely. There is no live context for
 * OpenTelemetry's normal propagation to carry.
 *
 * The alternative — storing a generated trace id on the work order and
 * reading it back — makes every span emission a database read, and leaves
 * spans un-correlated for any event that arrives before the row is written.
 * Deriving the id from the work order identity means any component that knows
 * WHICH work order it is talking about can join the trace, with no lookup and
 * no coordination.
 *
 * The identity is already stable and globally unique (`wo_<repo>_<issue>_<base>_<n>`),
 * which is exactly the property a trace id needs.
 */
const TRACE_NAMESPACE = 'opifex/work-order/';

/**
 * A 32-hex-character trace id for a work order.
 *
 * SHA-256 truncated to 128 bits. Collision resistance at that width is not
 * the point — trace ids are 128 bits by specification and a birthday
 * collision would need on the order of 10^19 work orders — but determinism
 * is.
 */
export function traceIdForWorkOrder(identity: string): string {
  const digest = createHash('sha256').update(TRACE_NAMESPACE + identity).digest('hex');
  return nonZero(digest.slice(0, 32), 32);
}

/**
 * The 16-hex-character id of the work order's notional root span.
 *
 * Nothing ever emits this span: it is a parent that exists only so every real
 * span has somewhere to hang. A trace whose spans all claim to be roots
 * renders as N separate traces in most backends, which would defeat the whole
 * point.
 */
export function rootSpanIdForWorkOrder(identity: string): string {
  const digest = createHash('sha256').update(TRACE_NAMESPACE + identity).digest('hex');
  return nonZero(digest.slice(32, 48), 16);
}

/**
 * An OpenTelemetry context whose active span is the work order's root.
 *
 * Marked `isRemote`, which is accurate rather than cosmetic: the parent was
 * genuinely not created in this process, and sampling decisions treat a
 * remote parent differently.
 */
export function workOrderContext(identity: string, parent: Context = context.active()): Context {
  return trace.setSpanContext(parent, {
    traceId: traceIdForWorkOrder(identity),
    spanId: rootSpanIdForWorkOrder(identity),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

/**
 * An all-zero id is invalid per the OpenTelemetry specification and is
 * silently dropped by exporters. Astronomically unlikely from SHA-256, and
 * handled anyway, because "silently dropped" is the failure mode this whole
 * epic exists to eliminate.
 */
function nonZero(hex: string, width: number): string {
  return /^0+$/.test(hex) ? hex.slice(0, width - 1) + '1' : hex;
}
