# 12. The trust digest extends the daily brief rather than competing with it

- Status: Proposed
- Date: 2026-08-24
- Issue: #226
- Epic: #21

## Context

VISION §7 and §8 describe two separate periodic artifacts. §8's daily brief is "the things
that did not warrant waking someone, gathered and ranked" — the batching mechanism behind
its stated goal, which is "not fewer decisions but decisions batched and moved off the
critical path". #100's trust digest is the other one: what ran **under trust**, reported
after the fact, once action classes have been promoted at VISION §7 rung 3.

Read literally, that is two scheduled messages to one operator. #93 names the problem
inside its own proposed solution: "two competing daily summaries is how both get ignored."

The tension is about what each artifact is _for_, not about delivery plumbing.

They answer different questions. The brief asks _what needs you?_ — forward looking, and
its entire value is the ranking. The digest asks _what happened without you?_ — backward
looking, and its value is completeness, because a trust digest that omits an action is
worse than no digest at all.

They also have different audiences in time. The brief matters from Phase 6 onward. The
digest only exists once something has been promoted, which VISION §12 puts at least a month
away and which may never happen for some classes at all.

But they land on the same person, on the same schedule, through the same transport. A
person who receives two daily messages reads one, and it will be whichever arrived first.

The decision cannot be deferred until the digest is built. Trust is granted per action
class, so the digest's content grows one class at a time — and whatever shape the brief
takes now is the shape the digest has to fit into or fight with later.

## Decision

**One daily artifact.** The trust digest is a section of the daily brief, not a second
message.

`rankBrief` returns a `DailyBrief` carrying both parts: `items`, ranked by what needs a
human, and `trustExecuted`, the actions that ran under trust. `trustSection()` renders the
second. Today it renders "Ran under trust: nothing. No action class is promoted, so every
action still went through a human", because that is true and because #100 should arrive to
fill a section rather than invent an artifact.

The two halves carry **different guarantees**, and that difference is the substance of the
decision rather than a detail of it:

- The ranked items are **capped** at `MAX_BRIEF_ITEMS`. Attention is the scarce resource,
  and an unranked list of everything is a log.
- The trust section is **never silently truncated**. It is rendered in full, or the brief
  states how many actions it could not show. A truncated attention list costs an operator
  one look; a truncated trust list silently omits something that happened without them.

Delivery reuses the notification transports (#58) directly, at `normal` priority, with no
escalation row and no receipt.

## Consequences

One thing arrives each day, and the top line is the thing most worth looking at. That is
the property VISION §8 is actually asking for, and two messages cannot have it.

The cost is that the brief's length becomes unbounded in exactly one case: a lot ran under
trust. That is accepted rather than mitigated, because it is the case where an operator
most needs to see the whole list — a system acting on its own at volume is when "what
happened without me" stops being a formality.

The second cost is a real departure from two VISION sections. Anyone reading §7 and §8 will
expect two artifacts and find one, which is why this is an ADR and not a comment. #93's own
acceptance criteria require it be recorded this way.

A smaller consequence, worth stating because it constrains later work: the brief is **not**
an escalation and must never become one. Minting an `Escalation` row to reuse the delivery
path would inflate the escalation lifecycle and the detection-latency percentiles computed
over it — success metric 1 would start counting briefs. `NotificationPayload` therefore
carries `priority` and has optional `escalationId`/`receiptId`, so the transport seam can
carry both kinds without either pretending to be the other.

The deciding argument: **the brief and the digest are read by the same person at the same
moment, and attention is the resource being allocated.** If that stops being true — if the
digest acquires a different audience, or a compliance requirement makes it a separate
record that must be retained on its own terms — this is worth revisiting.

## Alternatives considered

**Two artifacts, exactly as VISION §7/§8 describe.** Literal fidelity, and a clean
separation between "needs you" and "happened without you". Disqualified by #93's own stated
failure mode: two daily summaries to one operator means one of them gets ignored, and
nothing decides which. It would also need a second ranking implementation, since a digest
of any size wants ordering too.

**Merge delivery, keep the artifacts separate inside one message.** One notification
containing two clearly separated documents. Disqualified because it is the first
alternative with a shared envelope — the second document still competes for attention with
the first, and the consolidation buys nothing real.

**One artifact with a uniformly capped body.** Simpler than the split guarantee above, and
tempting. Disqualified because the cap would eventually elide a trust-executed action, and
the whole reason the digest exists is that an operator can see everything that happened
without them. A cap that is usually harmless and occasionally hides an autonomous action is
worse than no digest, because it looks complete.
