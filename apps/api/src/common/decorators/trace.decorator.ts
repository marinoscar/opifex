import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('opifex-api');

/**
 * Decorator to add tracing to a method
 */
export function Trace(spanName?: string) {
  return function (
    // The decorated method's host: a prototype for instance methods, a
    // constructor for static ones. `object` is all this needs — it reads
    // `constructor.name` and nothing else.
    target: object,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;
    const name = spanName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      return tracer.startActiveSpan(
        name,
        { kind: SpanKind.INTERNAL },
        async (span) => {
          try {
            const result = await originalMethod.apply(this, args);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'Unknown error',
            });
            span.recordException(error as Error);
            throw error;
          } finally {
            span.end();
          }
        },
      );
    };

    return descriptor;
  };
}
