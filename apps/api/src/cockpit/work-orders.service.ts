import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { toNumberOrNull } from './decimal';
import { toWorkOrderDocument } from '../work-orders/work-order-document';
import { RehydrationError, rehydrateWorkOrder } from '../work-orders/work-order-rehydrate';
import {
  WORK_ORDERS_DEFAULT_PAGE_SIZE,
  type WorkOrderDetail,
  type WorkOrderListItem,
} from './dto/work-orders.dto';

/**
 * Work orders, and the document each of them authorized.
 *
 * ## The detail endpoint rebuilds; it does not re-render
 *
 * `document` comes from `rehydrateWorkOrder` (#154) fed into
 * `toWorkOrderDocument` — the same function that produced the bytes committed
 * to the factory branch and posted to the issue as the authorization record
 * (#63). Assembling the same shape a second time here would make byte-identity
 * a property somebody has to keep testing forever, and it would break
 * silently, because both documents would still look right.
 *
 * That is what makes #84's authorization-record view a COMPARISON rather than
 * an illustration: the operator is looking at the same document from the same
 * serializer. #63's whole premise is that *"the agent did something I did not
 * ask for"* is a checkable claim, and it stops being checkable the moment the
 * cockpit shows a lookalike.
 *
 * ## A row that disagrees with itself is a 422, not a best effort
 *
 * `rehydrateWorkOrder` refuses a row whose stored identity its own coordinates
 * do not derive, or that declares a need this build does not understand.
 * Serving the raw columns anyway would put a document in front of an operator
 * that nothing ever authorized — the precise failure the endpoint exists to
 * make impossible. The list endpoint still shows the row, so the work order
 * does not vanish; only the claim "this is what was authorized" is withheld.
 */
@Injectable()
export class WorkOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: {
    page?: number;
    pageSize?: number;
    status?: string;
    repository?: string;
  }): Promise<{ items: WorkOrderListItem[]; total: number; page: number; pageSize: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? WORK_ORDERS_DEFAULT_PAGE_SIZE;

    const where: Prisma.WorkOrderWhereInput = {
      ...(query.status ? { status: query.status as Prisma.WorkOrderWhereInput['status'] } : {}),
      ...(query.repository ? { repository: splitRepository(query.repository) } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.workOrder.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Newest first. Unlike the queue — which orders by dispatch position
        // because that is its question — a work order list answers "what has
        // the factory been asked to do lately".
        orderBy: { createdAt: 'desc' },
        select: LIST_SELECT,
      }),
      this.prisma.workOrder.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        identity: row.identity,
        issueNumber: row.issueNumber,
        issueTitle: row.issueTitle ?? `Issue #${row.issueNumber}`,
        issueUrl: row.issueUrl || null,
        repository: `${row.repository.owner}/${row.repository.name}`,
        baseCommit: row.baseCommit.slice(0, 7),
        attempt: row.attempt,
        branch: row.branch,
        status: row.status,
        holdReason: row.holdReason,
        queuedAt: row.queuedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        runCount: row._count.runs,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * One work order, with the document it authorized.
   *
   * Accepts either the row id or the IDENTITY (`wo_opifex_312_a3f91c2_a1`),
   * because the identity is the string an operator has: it is what the
   * authorization record shows, what the branch name encodes, and what a run
   * summary quotes. Making them paste a uuid they have never seen would be a
   * lookup key chosen for the database's convenience.
   */
  async findOne(idOrIdentity: string): Promise<WorkOrderDetail> {
    const row = await this.prisma.workOrder.findFirst({
      where: isUuid(idOrIdentity) ? { id: idOrIdentity } : { identity: idOrIdentity },
      select: DETAIL_SELECT,
    });

    if (!row) throw new NotFoundException(`Work order ${idOrIdentity} not found`);

    let document;
    try {
      document = toWorkOrderDocument(rehydrateWorkOrder(row));
    } catch (error) {
      if (error instanceof RehydrationError) {
        // 422, not 500: the request was well-formed and the row is the
        // problem. The message names which row and why, which is what an
        // operator needs to go and look at it.
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }

    return {
      id: row.id,
      status: row.status,
      holdReason: row.holdReason,
      queuedAt: row.queuedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      authorizationCommentUrl: row.authorizationCommentUrl,
      // IN FULL here, unlike everywhere else the cockpit shows a commit.
      //
      // The list shortens to 7 because it is a label in a table. This one is
      // the thing an operator checks out to see what the agent was actually
      // given, and a 7-character prefix is not a git ref you can rely on
      // resolving in a repository with enough history.
      baseCommit: row.baseCommit,
      document,
      runs: row.runs.map((run) => ({
        id: run.id,
        status: run.status,
        runner: run.runnerKey,
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt?.toISOString() ?? null,
        costUsd: toNumberOrNull(run.costUsd),
        pullRequestUrl: run.pullRequestUrl,
      })),
    };
  }
}

// ---------------------------------------------------------------------------

const LIST_SELECT = {
  id: true,
  identity: true,
  issueNumber: true,
  issueUrl: true,
  issueTitle: true,
  baseCommit: true,
  attempt: true,
  branch: true,
  status: true,
  holdReason: true,
  queuedAt: true,
  createdAt: true,
  repository: { select: { owner: true, name: true } },
  _count: { select: { runs: true } },
} as const;

/** Exactly what `rehydrateWorkOrder` reads, plus the row's own state. */
const DETAIL_SELECT = {
  id: true,
  identity: true,
  branch: true,
  issueNumber: true,
  issueUrl: true,
  issueTitle: true,
  baseCommit: true,
  attempt: true,
  taskSpec: true,
  acceptanceCriteria: true,
  pathConstraints: true,
  decisionRefs: true,
  needs: true,
  budgetCeilingUsd: true,
  wallClockTimeoutMinutes: true,
  status: true,
  holdReason: true,
  queuedAt: true,
  createdAt: true,
  authorizationCommentUrl: true,
  repository: { select: { owner: true, name: true } },
  runs: {
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      status: true,
      runnerKey: true,
      startedAt: true,
      endedAt: true,
      costUsd: true,
      pullRequestUrl: true,
    },
  },
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * `owner/name` into a filter.
 *
 * `split` then rejoin on the tail, because a repository name cannot contain a
 * slash but an owner cannot either — so anything after the first slash is the
 * name, and treating a stray one as a third segment would silently match
 * nothing rather than failing.
 */
function splitRepository(repository: string): { owner: string; name: string } {
  const [owner, ...rest] = repository.split('/');
  return { owner, name: rest.join('/') };
}
