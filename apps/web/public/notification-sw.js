/**
 * The service worker that turns an escalation into something on a lock screen.
 *
 * Two jobs, and the second is the one #58 is really about:
 *
 *  1. Show the notification.
 *  2. POST the receipt back, so the control plane knows a device actually
 *     displayed it. Web Push gives no delivery guarantee — a push service
 *     answering 201 has taken custody of a message, not made a phone ring —
 *     and #58 is explicit that an escalation which silently failed to send is
 *     indistinguishable from no escalation while looking handled on a
 *     dashboard.
 *
 * Deliberately plain JavaScript in `public/`, not a bundled module. A service
 * worker is fetched by URL at a fixed scope, so putting it through the bundler
 * would buy a hashed filename — which is precisely the thing a registered
 * worker must not have.
 */

const RECEIPT_ENDPOINT = '/api/notifications/receipts';

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every tab to close. An
  // operator who just enabled notifications should be covered by the version
  // they enabled, not the one from their last visit.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const payload = readPayload(event);

  // `waitUntil` around BOTH: a service worker is terminated the moment its
  // handler returns, so a receipt fired without awaiting it would be killed
  // in flight — and an escalation that was shown but never confirmed is
  // recorded as a failure, which would then be wrong.
  event.waitUntil(Promise.all([show(payload), confirm(payload.receiptId)]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data && event.notification.data.url;
  if (!url) return;

  // VISION §8's "one tap": focus the tab that is already open on this page
  // rather than stacking another one, and only open a new window if none is.
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url === url && 'focus' in client) return client.focus();
        }
        return self.clients.openWindow(url);
      }),
  );
});

/**
 * Never throws.
 *
 * A malformed payload must still produce a visible notification: a browser
 * that receives a push and shows nothing may revoke the subscription
 * entirely, and "we stopped being able to tell you anything" is a far worse
 * outcome than one ugly notification.
 */
function readPayload(event) {
  try {
    const parsed = event.data ? event.data.json() : null;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through
  }
  return {
    title: 'Opifex',
    body: 'An escalation arrived that could not be displayed. Open the cockpit.',
    url: '/',
  };
}

function show(payload) {
  // All four of VISION §8's fields, in the order an operator reads them:
  // what, why, what it touches, what happens if they roll over. The body is
  // the only part a locked phone shows, so `body` leads and the rest follows
  // when the notification is expanded.
  const lines = [
    payload.body,
    payload.why,
    payload.blastRadius,
    payload.ifIgnored,
  ]
    .filter(Boolean)
    .join('\n\n');

  return self.registration.showNotification(payload.title || 'Opifex', {
    body: lines,
    tag: payload.escalationId,
    // Stays on screen until acted on. An escalation that auto-dismisses while
    // the operator is asleep is the four-hours-dead case again.
    requireInteraction: true,
    renotify: false,
    timestamp: payload.raisedAt ? Date.parse(payload.raisedAt) : undefined,
    data: { url: payload.url, escalationId: payload.escalationId },
  });
}

/**
 * Confirm the notification reached this device.
 *
 * The receipt token is the only credential: a service worker has no session,
 * and it arrived inside an end-to-end encrypted payload. Failure here is
 * swallowed — the notification is already on screen, and throwing would lose
 * that to no benefit. An unconfirmed escalation is recorded as failed by the
 * server's own sweep, which is the correct conservative outcome.
 */
function confirm(receiptId) {
  if (!receiptId) return Promise.resolve();

  return fetch(RECEIPT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receiptId }),
  }).catch(() => undefined);
}
