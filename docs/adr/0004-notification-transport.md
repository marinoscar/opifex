# 4. Web Push for notifications, with a configurable webhook as the second path

- Status: Accepted
- Date: 2026-08-22
- Issue: #58
- Epic: #17

## Context

#58 is the last link in the chain VISION §1 complains about, and before this
change **nothing in the codebase did it**. No web-push, no FCM, no ntfy, no
Twilio — only an `enableNotifications` boolean in a settings test fixture.
Everything upstream can work perfectly and detection latency is still measured
in hours if the operator is not actually told.

The issue names three candidates — Web Push, ntfy, Pushover — and asks for one
to be picked and the reason recorded. It also sets two bars that narrow the
field more than the candidate list suggests:

- **Delivery receipts are not optional.** *"An escalation that silently failed
  to send is indistinguishable from no escalation — it reintroduces exactly the
  failure this project exists to eliminate, while appearing on a dashboard as
  handled."*
- **A delivery failure must itself escalate through a different path.**
- **Secrets via environment variables only.**

VISION §8 sets the bar for content: *"one tap from a phone, with enough context
to decide — what, why, blast radius, and what happens if ignored."*

## Decision

**Web Push (RFC 8030) with VAPID (RFC 8292) is the primary transport.**

**A generic JSON webhook (`NOTIFY_FALLBACK_WEBHOOK_URL`) is the second path**,
tried only when Web Push did not deliver, and **off unless configured**.

**Delivery is confirmed by the device, not by the push service.** The
notification payload carries a 32-byte receipt token; the service worker POSTs
it back to `POST /api/notifications/receipts`. That is what turns `dispatched`
into `delivered`.

## Consequences

**Why Web Push and not ntfy or Pushover.** Both alternatives are good tools and
both fail the same test: they put a third party between Opifex and the operator
for no capability Web Push lacks.

| | Account needed | Credential | Payload visible to a third party |
|---|---|---|---|
| Web Push | none | a VAPID key pair you generate | **no** — encrypted end to end |
| ntfy (hosted) | none for a public topic | the topic name, which *is* the secret | yes |
| ntfy (self-hosted) | a server to run and keep running | server credentials | no |
| Pushover | yes, paid | an app token and a user key | yes |

The encryption row is the one that decided it. Web Push encrypts the payload to
the subscription's own key material, so the push service relays bytes it cannot
read. That is what makes it acceptable to put the escalation's actual reason —
repository, issue number, why the watchdog concluded what it did — in the
notification body rather than a "something happened, open the app" stub. A stub
fails VISION §8's *"enough context to decide"* outright, and an operator who has
to open a laptop to find out whether to get up has not really been notified.

The account row is the reason this could ship without asking anyone for
anything: `npx web-push generate-vapid-keys` produces the key pair, and it lives
in the environment like every other secret.

**The cost: iOS requires an installed web app.** Safari only allows push from a
web app added to the home screen. That is a real limitation and the settings
card says so in those words rather than reporting "unsupported browser", which
would send an operator to buy a different phone over a fixable setup step.

**A push service accepting a message is not a phone ringing.** This is the
sharpest consequence of the decision, and the reason the escalation lifecycle
has three statuses rather than two:

- `dispatched` — a push service returned 201. It has taken custody. Nothing
  more is known.
- `delivered` — a device posted a receipt back. Somebody's phone rang.
- `failed` — no transport would take it, **or** the receipt never arrived
  within `NOTIFY_RECEIPT_TIMEOUT_MS`.

Collapsing the first two would put a green tick next to a notification nobody
saw, which is the exact failure #58 describes. The timeout sweep is what stops a
`dispatched` escalation sitting forever looking handled.

**The receipt token is a capability, and that is deliberate.** A service worker
has no session and no bearer token. The alternatives were no receipts at all, or
storing a credential somewhere a service worker can read it. A 32-byte random id
that arrives inside an end-to-end encrypted payload and grants exactly one thing
— marking one escalation delivered — is a strictly better credential than either.
The endpoint returns the same 404 for an unknown token and an already-used one,
so it cannot be used as an oracle. It is never sent to the fallback webhook: a
third-party receiver is not the device and has no business confirming a
notification it cannot display.

**The fallback is a different path, not a retry.** If the push service is down
or no device is subscribed, sending again produces the same silence. A generic
POST rather than an ntfy or Slack client keeps one seam covering all of them.

It is **off by default**, and that is not laziness: it sends escalation text to a
third party the operator chooses, and defaulting it on would make that choice for
them. When it is off, a Web Push failure ends at a `failed` escalation, an
`error`-level log line marked `NOTIFICATION FAILED`, and the cockpit's failed
list. The settings card says so plainly rather than implying a second path
exists.

**What is still missing, stated rather than implied.** There is no email or SMS
transport. Both need credentials and an account, which is a decision for the
operator and not one to be made in a commit. The seam
(`NotificationTransport`) is thin enough that adding one is a class and a
provider, and the `notified`/`raised` counter gap in #59's metric is what would
make the need visible.

**Everything sends to every registered device.** VISION §11 designs for a single
operator; routing notifications to the right person is a problem this system does
not have yet, and building it now would be a configuration surface with nothing
behind it.
