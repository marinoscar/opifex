import { Injectable } from '@nestjs/common';

import { DispatchService } from '../dispatch/dispatch.service';
import type { DispatchDecision } from '../dispatch/dispatch-policy';
import { PrismaService } from '../prisma/prisma.service';
import type { ModelTier, RunnerNeed } from '../runners/runner.types';
import {
  QUEUE_DEFAULT_LIMIT,
  type QueueEntry,
  type QueueEntryState,
} from './dto/queue.dto';

/**
 * What the factory is about to work on, and what is stopping it.
 *
 * ## Why this is not a `work_orders` dump
 *
 * #80: *"These are read models, not table dumps. The cockpit asks operational
 * questions — what needs attention, what is queued, what did this cost — and
 * the endpoints should answer those directly rather than making the frontend
 * assemble them from normalized rows."*
 *
 * The question here is **"why is this not running yet"**, and the row alone
 * cannot answer it: `status: 'queued'` is true of a work order that is next in
 * line and of one that no runner can take, and those call for opposite
 * responses from the operator. Answering it means asking the dispatch policy,
 * which is what this service does — once per distinct needs set, not once per
 * row.
 *
 * ## Why the browser must not compute this
 *
 * The same reason `getRunsNeedingAttention` filters server-side: routing is
 * the control plane's verdict (#64), and a UI that recomputed it would be a
 * second implementation of dispatch policy, out of date by one poll interval
 * and wrong the moment the rules change.
 */
@Injectable()
export class QueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: DispatchService,
  ) {}

  async list(limit: number = QUEUE_DEFAULT_LIMIT): Promise<QueueEntry[]> {
    const rows = await this.prisma.workOrder.findMany({
      // `queued` and `held` only.
      //
      // NOT `dispatched`: a dispatched work order has a Run against it and
      // belongs to the runs screen. Showing it here too would double-count the
      // same work in two panels and make queue depth — the leading indicator
      // of VISION §11 quota pressure — read high while the factory is in fact
      // busy working through it.
      //
      // NOT `pending` either: nothing writes that status since #155 projects
      // straight to `queued`, and listing a state the system cannot produce
      // would be inventing a queue entry.
      where: { status: { in: ['queued', 'held'] } },
      // The SAME order `DispatchQueueService` drains in, which is what makes
      // `position` a fact rather than a decoration: position 1 is the work
      // order the next tick will actually pick up. `queuedAt` nulls last puts
      // held rows after the queue they are not in.
      orderBy: [
        { queuedAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
      ],
      take: limit,
      select: {
        id: true,
        identity: true,
        branch: true,
        issueNumber: true,
        issueUrl: true,
        issueTitle: true,
        baseCommit: true,
        attempt: true,
        needs: true,
        modelTier: true,
        status: true,
        holdReason: true,
        queuedAt: true,
        createdAt: true,
        repository: { select: { owner: true, name: true } },
      },
    });

    if (rows.length === 0) return [];

    const decisions = await this.decideOncePerRoutingInput(rows);

    // Headroom is consumed as the list is walked: if the fleet can take two
    // runs, the first two queued work orders are `ready` and the third is
    // `waiting`. Reporting all of them `ready` because a runner has capacity
    // would tell the operator three things can start when one cannot.
    const remaining = new Map<string, number>();

    return rows.map((row, index) => {
      const decision = decisions.get(routingKey(row));
      const { state, outOfHeadroom } = this.stateOf(
        row.status,
        decision,
        remaining,
      );

      return {
        id: row.id,
        workOrder: {
          id: row.identity,
          issueNumber: row.issueNumber,
          repository: `${row.repository.owner}/${row.repository.name}`,
          // Shortened HERE. The cockpit's type says "already shortened
          // upstream", and leaving it to the browser would put a second
          // opinion about identity where #62 says there must not be one.
          baseCommit: row.baseCommit.slice(0, 7),
          attempt: row.attempt,
          branch: row.branch,
          title: row.issueTitle ?? `Issue #${row.issueNumber}`,
          issueUrl: row.issueUrl || null,
        },
        state,
        position: index + 1,
        // A held work order has no `queuedAt` — #155 nulls it so releasing one
        // cannot jump the queue. `createdAt` is when it entered the queue in
        // every sense the operator cares about.
        enqueuedAt: (row.queuedAt ?? row.createdAt).toISOString(),
        waitingOn: this.waitingOn(
          row.status,
          state,
          outOfHeadroom,
          row.holdReason,
          decision,
        ),
      };
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Ask the dispatch policy once per DISTINCT ROUTING INPUT on the page.
   *
   * Routing depends on what a work order needs, so the answer genuinely
   * differs between a work order needing `own-infrastructure` and one needing
   * nothing. It does NOT differ between two work orders needing the same
   * thing — and in practice almost every work order declares no needs at all,
   * so this is one call for a page of a hundred.
   *
   * The key is needs AND model tier, because those are exactly the two inputs
   * `decide` routes on (`identity` is only logged). Keyed on needs alone —
   * which is how this was written, harmlessly, while nothing could carry a
   * tier — two work orders with the same needs and different tiers would
   * share one decision, and the operator would be told the wrong reason why
   * one of them is not running. That is #19's honesty contract, not a
   * cosmetic bug: a "waiting on" line that names the wrong constraint sends
   * somebody to fix something that is not broken.
   *
   * Deciding per row instead would be two database queries per row on a panel
   * that polls every thirty seconds, which is how a read model becomes the
   * most expensive thing in the system.
   */
  private async decideOncePerRoutingInput(
    rows: RoutingInput[],
  ): Promise<Map<string, DispatchDecision>> {
    const distinct = new Map<string, RoutingInput>();
    for (const row of rows) {
      distinct.set(routingKey(row), row);
    }

    const decided = await Promise.all(
      [...distinct].map(
        async ([key, row]) =>
          [
            key,
            await this.dispatch.decide(
              row.needs as RunnerNeed[],
              undefined,
              // A tier the column holds but this build does not understand is
              // dropped HERE and only here: this is a read model, and refusing
              // to render the queue over one bad row would hide the ninety-nine
              // good ones. `rehydrateWorkOrder` still refuses to DISPATCH it,
              // which is where refusing matters.
              asModelTier(row.modelTier),
            ),
          ] as const,
      ),
    );

    return new Map(decided);
  }

  /**
   * Which of the four states this row is in.
   *
   * `dispatching` is in the cockpit's vocabulary and is deliberately NEVER
   * returned. A work order stops being `queued` the instant the executor
   * creates its Run row, inside the same pass — there is no committed state
   * between the two for this endpoint to observe. Emitting `dispatching`
   * anyway would mean inventing a transition the database never holds, which
   * is exactly the kind of plausible fiction #19's honesty contract exists to
   * prevent. It stays in the union because the state becomes real the moment
   * dispatch is asynchronous, and removing it would only have to be undone.
   */
  private stateOf(
    status: string,
    decision: DispatchDecision | undefined,
    remaining: Map<string, number>,
  ): { state: QueueEntryState; outOfHeadroom: boolean } {
    if (status === 'held') return { state: 'held', outOfHeadroom: false };
    if (!decision || decision.outcome !== 'dispatch' || !decision.runnerKey) {
      return { state: 'waiting', outOfHeadroom: false };
    }

    const key = decision.runnerKey;
    if (!remaining.has(key)) {
      const chosen = decision.candidates.find(
        (candidate) => candidate.runnerKey === key,
      );
      remaining.set(key, chosen?.headroom ?? 0);
    }

    const left = remaining.get(key) ?? 0;
    // Waiting because the rows AHEAD of it took the free slots, which is a
    // different fact from "the policy refused this work order" — and the
    // reason string has to say which. See `waitingOn`.
    if (left <= 0) return { state: 'waiting', outOfHeadroom: true };

    remaining.set(key, left - 1);
    return { state: 'ready', outOfHeadroom: false };
  }

  /**
   * One line naming what must clear first.
   *
   * ## Two different kinds of waiting
   *
   * When the POLICY queued the work order, its own `reason` string is reused
   * rather than rewritten: #64 requires that *"selection is deterministic and
   * its reasoning is recorded"*, and an operator comparing the queue panel
   * against the dispatch log should read the same sentence in both.
   *
   * When the policy would dispatch and the rows AHEAD took the free slots,
   * that sentence is wrong — it begins *"Dispatch to claude-code-local…"*,
   * which on a row that is not dispatching reads as though it is. A probe
   * against a real fleet is what caught that; the double could not, because
   * the double never had a runner with finite headroom and three rows to fit
   * into it.
   */
  private waitingOn(
    status: string,
    state: QueueEntryState,
    outOfHeadroom: boolean,
    holdReason: string | null,
    decision: DispatchDecision | undefined,
  ): string | null {
    if (status === 'held') {
      // A `factory:hold` label carries no reason of its own — #155 records one
      // only for a quarantine — so name the mechanism rather than returning
      // null, which the panel renders as "nothing is blocking this".
      return (
        holdReason ?? 'Held by a factory:hold label; release it on the issue'
      );
    }
    if (state === 'ready') return null;
    if (outOfHeadroom) {
      const runner = decision?.runnerKey ?? 'the fleet';
      return `Waiting for a free slot on ${runner}; the work orders ahead of it take them all`;
    }
    return (
      decision?.reason ??
      'No dispatch decision is available for this work order'
    );
  }
}

/** Order-insensitive key for a needs set, so `[a,b]` and `[b,a]` decide once. */
/** The two things `decide` actually routes on. */
interface RoutingInput {
  needs: string[];
  modelTier: string | null;
}

function routingKey(row: RoutingInput): string {
  // The tier is appended after a separator that cannot occur in a need or a
  // tier, so `needs: ['a']` with tier `b` and `needs: ['a', 'b']` with no tier
  // cannot collide onto one decision.
  return `${[...row.needs].sort().join(',')}|${row.modelTier ?? ''}`;
}

function asModelTier(value: string | null): ModelTier | undefined {
  return value === 'small' || value === 'standard' || value === 'large'
    ? value
    : undefined;
}
