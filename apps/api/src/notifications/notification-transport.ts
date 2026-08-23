import type { NotificationPayload } from './notification-payload';

/**
 * One device a notification can be sent to.
 *
 * Deliberately not the Prisma row: a transport should be testable without a
 * database, and a second transport (#58 keeps the seam thin on purpose) will
 * not necessarily have a `p256dh` at all.
 */
export interface NotificationTarget {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * What happened to one send.
 *
 * `accepted` is NOT `delivered`, and keeping the two words apart in the type
 * is the whole reason this interface exists. Web Push answers 201 when the
 * push service has taken custody of the message — not when a phone has shown
 * it. #58: *"An escalation that silently failed to send is indistinguishable
 * from no escalation."* Treating acceptance as delivery would reintroduce
 * that failure while showing green on a dashboard.
 */
export interface SendOutcome {
  targetId: string;
  accepted: boolean;
  /**
   * The target is permanently gone — the push service said 404 or 410.
   *
   * Distinguished from an ordinary failure because the response differs:
   * a gone subscription is pruned, a failing one is retried.
   */
  gone: boolean;
  /** Why it failed, in the push service's own words where there are any. */
  error?: string;
  /** The push service's status code, when there was a response at all. */
  statusCode?: number;
}

export interface NotificationTransport {
  /** `push`, `webhook` — recorded on the escalation as `transport`. */
  readonly name: string;

  /**
   * Whether this transport is configured well enough to try.
   *
   * Asked rather than discovered by failing, so an unconfigured install
   * records a `failed` escalation naming the missing configuration instead of
   * a stack trace nobody reads.
   */
  isConfigured(): boolean;

  send(
    target: NotificationTarget,
    payload: NotificationPayload,
  ): Promise<SendOutcome>;
}
