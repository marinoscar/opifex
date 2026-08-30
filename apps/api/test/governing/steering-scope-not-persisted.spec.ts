import type { z } from 'zod';

import type { EpicChildrenService } from '../../src/github/read/epic-children.service';
import type { GitHubReadService } from '../../src/github/read/github-read.service';
import type { NormalizedIssue } from '../../src/github/read/github-read.types';
import type { GitHubWriteService } from '../../src/github/write/github-write.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { OperatorSettingsService } from '../../src/settings/operator-settings/operator-settings.service';
import {
  applySteeringSchema,
  steeringApplyResultSchema,
  steeringProposalSchema,
} from '../../src/steering/dto/steering.dto';
import { SteeringService } from '../../src/steering/steering.service';

/**
 * ADR-0020's fourth decision, made structural (#462, epic #457).
 *
 * ## Why this file exists, and why it is a governing test
 *
 * ADR-0020 §4 states the commitment in prose: "Nothing about the chosen scope
 * is persisted... never written to a table `apply` or the dispatcher would
 * later consult." `steering.service.spec.ts`'s `touched` assertion
 * (`expect(h.touched).toEqual(['repository.findMany', 'project.findUnique'])`)
 * proves propose reads Prisma and writes nothing, for the ONE call it
 * exercises. It says nothing about a `projectId` added to the `apply` path's
 * audit row, to a response field nobody happened to assert on, or to a
 * schema nobody has written a value into yet — each of those would typecheck,
 * pass every existing suite, and rebuild the two-sources-of-truth bug
 * ADR-0018 §1 forbids, silently.
 *
 * This file makes two independent claims, at the two different points where
 * a project reference could enter:
 *
 * 1. **The response schemas themselves never declare a project-named field.**
 *    This is checked over the zod schema DEFINITIONS, not over one call's
 *    output — so a field added to `steeringOperationSchema` or
 *    `appliedOperationSchema` that no test happens to populate still fails
 *    here, because the walk below reaches every schema nested under
 *    `steeringProposalSchema` and `steeringApplyResultSchema` regardless of
 *    whether anything currently sets it.
 * 2. **The one Prisma write the module makes never carries one either.** Zod
 *    cannot see a `prisma.auditEvent.create` call, so that half is checked by
 *    capturing the actual argument a project-scoped `apply()` passes and
 *    walking ITS keys at every depth — not matching against a fixed list of
 *    expected fields, the way `steering.service.spec.ts`'s `toMatchObject`
 *    assertions do, which would stay green if an unrelated key were added
 *    beside the ones it names.
 *
 * `proposeSteeringSchema` (the request DTO's `project` field) is deliberately
 * NOT walked: that field is the one legitimate place a project id is allowed
 * to appear, because it is a request-time selector that `resolveScope`
 * expands into a repository list before anything is returned or written
 * (ADR-0020's "concrete shape" section). The claim here is about what comes
 * OUT of propose and what `apply` sends to Prisma, not what goes in.
 */

// ---------------------------------------------------------------------------
// Part 1 — the response schemas never declare a project-named field
// ---------------------------------------------------------------------------

/**
 * Every key name reachable inside a zod schema, at any depth.
 *
 * Handles exactly the shapes `steering.dto.ts`'s response schemas are built
 * from — `object`, `array`, `nullable`, `optional`, `union` — and treats
 * everything else (`string`, `number`, `boolean`, `enum`, `literal`, `uuid`,
 * ISO datetime) as a leaf with no keys of its own. A schema shape this file
 * does not recognise is not silently skipped: it falls through to the `[]`
 * default, which is safe for a LEAF but would also hide a container type this
 * walker has not been taught, which is why the "plausible number of keys"
 * sanity check below exists — a walker that stopped early would make every
 * assertion here pass vacuously.
 */
function schemaKeys(schema: z.ZodTypeAny, seen = new Set<unknown>()): string[] {
  const def = (schema as unknown as { def: { type: string } }).def;
  if (seen.has(def)) return [];
  seen.add(def);

  switch (def.type) {
    case 'object': {
      const shape = (def as unknown as { shape: Record<string, z.ZodTypeAny> })
        .shape;
      return Object.entries(shape).flatMap(([key, value]) => [
        key,
        ...schemaKeys(value, seen),
      ]);
    }
    case 'array':
      return schemaKeys(
        (def as unknown as { element: z.ZodTypeAny }).element,
        seen,
      );
    case 'nullable':
    case 'optional':
    case 'default':
      return schemaKeys(
        (def as unknown as { innerType: z.ZodTypeAny }).innerType,
        seen,
      );
    case 'union':
      return (def as unknown as { options: z.ZodTypeAny[] }).options.flatMap(
        (option) => schemaKeys(option, seen),
      );
    default:
      return [];
  }
}

describe('a project is never a field of what steering returns or accepts on apply (#462, ADR-0020 §4)', () => {
  const surface = [
    ...schemaKeys(steeringProposalSchema),
    ...schemaKeys(applySteeringSchema),
    ...schemaKeys(steeringApplyResultSchema),
  ];

  it('reaches a plausible number of keys, so a broken walker cannot pass vacuously', () => {
    // Without this, a walker that stopped at the top-level object (or one
    // that silently treated an unrecognised container as a leaf) would make
    // the assertion below true for the wrong reason. `repositories` and
    // `writes` only exist nested two and three levels down respectively, so
    // reaching them proves the recursion actually ran.
    expect(surface.length).toBeGreaterThan(30);
    expect(surface).toContain('repositories'); // steeringScopeSchema, nested
    expect(surface).toContain('writes'); // appliedOperationSchema, nested
  });

  it('declares no key naming a project, anywhere in the returned proposal, the apply request, or the apply result', () => {
    // Not "no key called projectId": a future field named `project`,
    // `projectRef` or `projectSlug` would rebuild the same bug under a
    // different spelling, so the match is deliberately loose.
    const offenders = surface.filter((key) => /project/i.test(key));

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the one Prisma write the module makes carries no project reference
// ---------------------------------------------------------------------------

function issue(number: number): NormalizedIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: null,
    state: 'open',
    author: 'someone',
    labels: [],
    inputLabels: [],
    unknownInputLabels: [],
    ignoredLabels: [],
    observedMirrorLabels: [],
    isPullRequest: false,
    url: `https://github.com/acme/app/issues/${number}`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as NormalizedIssue;
}

/** A service instance scoped by a real project, wired with plain jest doubles. */
function buildProjectScopedService() {
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    repository: {
      findMany: jest.fn().mockResolvedValue([
        { owner: 'acme', name: 'app', projectId: 'proj-1' },
        { owner: 'acme', name: 'other', projectId: null },
      ]),
    },
    project: {
      findUnique: jest.fn().mockResolvedValue({ id: 'proj-1' }),
    },
    auditEvent: { create: auditCreate },
  } as unknown as PrismaService;

  const getIssue = jest
    .fn()
    .mockImplementation(async (_repo: unknown, number: number) =>
      issue(number),
    );

  const service = new SteeringService(
    prisma,
    { getIssue, listIssues: jest.fn() } as unknown as GitHubReadService,
    { resolve: jest.fn() } as unknown as EpicChildrenService,
    {
      addLabel: jest.fn().mockResolvedValue({ performed: true, noop: false }),
      removeLabel: jest
        .fn()
        .mockResolvedValue({ performed: true, noop: false }),
      enabled: true,
    } as unknown as GitHubWriteService,
    { get: jest.fn() } as unknown as OperatorSettingsService,
  );
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

  return { service, auditCreate };
}

/** Every enumerable key anywhere inside a plain-object/array value, at any depth. */
function deepKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) deepKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      keys.push(key);
      deepKeys(inner, keys);
    }
  }
  return keys;
}

describe('a project-scoped instruction persists no project reference anywhere (#462, ADR-0020 §4)', () => {
  it('walks a plausible number of keys on both sides, so the deep walker cannot pass vacuously', async () => {
    const { service, auditCreate } = buildProjectScopedService();

    const proposal = await service.propose({
      instruction: 'work on #1',
      project: 'proj-1',
    });
    await service.apply(
      {
        proposalId: proposal.proposalId,
        proposedAt: proposal.proposedAt,
        instruction: proposal.instruction,
        operations: proposal.operations.map((op) => ({
          owner: op.owner,
          name: op.name,
          number: op.number,
          add: op.add,
          remove: op.remove,
          observedInputLabels: op.observedInputLabels,
        })),
      },
      'user-1',
    );

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(deepKeys(proposal).length).toBeGreaterThan(10);
    expect(deepKeys(auditCreate.mock.calls[0][0]).length).toBeGreaterThan(5);
  });

  it('carries no project-named key anywhere in a project-scoped proposal', async () => {
    const { service } = buildProjectScopedService();

    const proposal = await service.propose({
      instruction: 'work on #1',
      project: 'proj-1',
    });

    const offenders = deepKeys(proposal).filter((key) => /project/i.test(key));

    expect(offenders).toEqual([]);
  });

  it('writes no project-named key to the audit row a project-scoped apply produces', async () => {
    // The read side of the same instruction DOES carry `proj-1` — it is what
    // selects `acme/app` out of two registered repositories — so this proves
    // the id is used to EXPAND the scope and then discarded, not that it was
    // never read in the first place.
    const { service, auditCreate } = buildProjectScopedService();

    const proposal = await service.propose({
      instruction: 'work on #1',
      project: 'proj-1',
    });

    await service.apply(
      {
        proposalId: proposal.proposalId,
        proposedAt: proposal.proposedAt,
        instruction: proposal.instruction,
        operations: proposal.operations.map((op) => ({
          owner: op.owner,
          name: op.name,
          number: op.number,
          add: op.add,
          remove: op.remove,
          observedInputLabels: op.observedInputLabels,
        })),
      },
      'user-1',
    );

    const written = auditCreate.mock.calls[0][0];
    const offenders = deepKeys(written).filter((key) => /project/i.test(key));

    expect(offenders).toEqual([]);
  });
});
