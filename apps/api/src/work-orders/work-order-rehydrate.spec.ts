import { serializeWorkOrder } from './work-order-document';
import {
  generateWorkOrder,
  type GeneratedWorkOrder,
  type GenerationInput,
  type IssueProjection,
} from './work-order-generator';
import {
  KNOWN_NEEDS,
  RehydrationError,
  rehydrateWorkOrder,
  type StoredWorkOrder,
} from './work-order-rehydrate';

/**
 * The round trip is the whole test.
 *
 * #63's design rests on the authorization record and the execution record
 * carrying *verifiably identical* bytes, and on both being the document that
 * was actually approved. That holds trivially while the only `GeneratedWorkOrder`
 * in existence is the one just built in memory. It stops holding the moment a
 * work order is dispatched from a database row — and nothing checked it,
 * because nothing could: the row was missing three of the fields.
 *
 * So the assertion that matters here is not "the fields come back", it is
 * "the SERIALIZED DOCUMENT is byte-identical". A field that survives the round
 * trip in a different type, or in a different key order, would pass a
 * field-by-field comparison and produce a different record.
 */
describe('rehydrateWorkOrder', () => {
  /** The generator's own output, so nothing here is hand-assembled. */
  function generated(
    issue: Partial<IssueProjection> = {},
    input: Partial<GenerationInput> = {},
  ): GeneratedWorkOrder {
    const result = generateWorkOrder({
      issue: {
        repository: { owner: 'marinoscar', name: 'opifex' },
        issueNumber: 312,
        title: 'Add a permit search prompt builder',
        issueUrl: 'https://github.com/marinoscar/opifex/issues/312',
        taskSpec: 'Add a permit search prompt builder to the chat surface.',
        acceptanceCriteria: [
          'Searching by address returns the matching permits',
          'An empty result set renders the empty state',
        ],
        pathConstraints: ['apps/api/**'],
        decisionRefs: ['ADR-0042'],
        needs: ['full-streaming', 'own-infrastructure'],
        ...issue,
      },
      baseCommit: 'a3f91c2000000000000000000000000000000000',
      attempt: 1,
      budgetCeilingUsd: 5,
      wallClockTimeoutMinutes: 30,
      ...input,
    });

    if (!result.ok)
      throw new Error(`fixture did not generate: ${result.message}`);
    return result.workOrder;
  }

  /** What the row looks like after the generator's output is persisted. */
  function stored(
    from: GeneratedWorkOrder,
    overrides: Partial<StoredWorkOrder> = {},
  ): StoredWorkOrder {
    return {
      identity: from.identity,
      branch: from.branch,
      issueNumber: from.issueNumber,
      issueUrl: from.issueUrl,
      issueTitle: from.issueTitle,
      baseCommit: from.baseCommit,
      attempt: from.attempt,
      taskSpec: from.taskSpec,
      acceptanceCriteria: from.acceptanceCriteria,
      pathConstraints: from.pathConstraints,
      decisionRefs: from.decisionRefs,
      needs: from.needs,
      // What the column holds: the tier, or null when none was asked for.
      modelTier: from.modelTier ?? null,
      budgetCeilingUsd: from.budgetCeilingUsd,
      wallClockTimeoutMinutes: from.wallClockTimeoutMinutes,
      repository: { owner: from.repositoryOwner, name: from.repositoryName },
      ...overrides,
    };
  }

  describe('the document survives the round trip', () => {
    it('serializes byte-identically after generate → persist → rebuild', () => {
      // The property #63's "verifiably identical records" rests on, and the
      // one nothing could check until the row carried every field.
      const original = generated();
      const rebuilt = rehydrateWorkOrder(stored(original));

      expect(serializeWorkOrder(rebuilt)).toBe(serializeWorkOrder(original));
    });

    it('survives it with every optional field absent', () => {
      // The other shape a real row takes: no budget, no timeout, no ADRs, no
      // path constraints, no title.
      const original = generated(
        { pathConstraints: [], decisionRefs: [], needs: [] },
        { budgetCeilingUsd: null, wallClockTimeoutMinutes: null },
      );

      const rebuilt = rehydrateWorkOrder(
        stored(original, { issueTitle: null }),
      );
      expect(serializeWorkOrder(rebuilt)).toBe(serializeWorkOrder(original));
    });

    it('keeps the identity, which is the idempotency key', () => {
      const original = generated();
      expect(rehydrateWorkOrder(stored(original)).identity).toBe(
        original.identity,
      );
    });

    it('rebuilds the coordinates rather than storing them', () => {
      // They are derivable, and a stored copy is one more thing that can
      // disagree with the identity it is supposed to describe.
      //
      // This test earned its keep immediately: the first version of
      // `rehydrateWorkOrder` composed `owner/name` here, which the branch
      // check could not catch because the branch does not encode the
      // repository — so the row rebuilt into a DIFFERENT identity while every
      // other field looked right.
      const original = generated();
      expect(rehydrateWorkOrder(stored(original)).coordinates).toEqual(
        original.coordinates,
      );
    });

    it('refuses a row whose identity its own coordinates do not derive', () => {
      // The identity is the idempotency key and it encodes the repository,
      // which the branch does not. Checking only the branch would let a row
      // through that rebuilds as something else entirely.
      const original = generated();

      expect(() =>
        rehydrateWorkOrder(
          stored(original, { identity: 'wo_something-else_312_a3f91c2_a1' }),
        ),
      ).toThrow(/disagrees with itself/);
    });
  });

  describe('the budget column', () => {
    it('accepts the Decimal Prisma actually returns', () => {
      // Prisma hands back a Decimal, not a number. Left unconverted it would
      // serialize as an object and the document would stop matching.
      const original = generated({}, { budgetCeilingUsd: 5 });
      const asDecimal = stored(original, {
        budgetCeilingUsd: { toNumber: () => 5 },
      });

      expect(serializeWorkOrder(rehydrateWorkOrder(asDecimal))).toBe(
        serializeWorkOrder(original),
      );
    });

    it('keeps null as null rather than zero', () => {
      // "No ceiling" and "a ceiling of nothing" are different authorizations.
      const original = generated({}, { budgetCeilingUsd: null });
      expect(rehydrateWorkOrder(stored(original)).budgetCeilingUsd).toBeNull();
    });
  });

  describe('rows it refuses', () => {
    it('refuses a branch that disagrees with the coordinates', () => {
      // The branch is derived from the coordinates (#62). A stored one that
      // disagrees means the row was written by something that did not use the
      // generator, and dispatching it would put a run on a branch the identity
      // does not name.
      const original = generated();

      expect(() =>
        rehydrateWorkOrder(
          stored(original, { branch: 'factory/999-deadbee-a1' }),
        ),
      ).toThrow(RehydrationError);
    });

    it('refuses a row with no issue URL', () => {
      // work-order.schema.json requires issue.url. Failing here names the row;
      // failing at serialization names a schema keyword and a JSON path.
      const original = generated();

      expect(() =>
        rehydrateWorkOrder(stored(original, { issueUrl: '' })),
      ).toThrow(/no issue URL/);
    });

    it('refuses a need this build does not understand, rather than dropping it', () => {
      // Silently discarding it would route the work order as though it had
      // never asked — a work order requiring own-infrastructure could be sent
      // to a vendor cloud, which is the exact routing error the needs
      // mechanism exists to prevent.
      const original = generated();

      expect(() =>
        rehydrateWorkOrder(
          stored(original, { needs: ['full-streaming', 'gpu-attached'] }),
        ),
      ).toThrow(/gpu-attached/);
    });

    it('names the row in every refusal, since the caller has only an id', () => {
      const original = generated();

      for (const bad of [
        { branch: 'factory/999-deadbee-a1' },
        { issueUrl: '' },
        { needs: ['nonsense'] },
      ]) {
        expect(() => rehydrateWorkOrder(stored(original, bad))).toThrow(
          original.identity,
        );
      }
    });
  });

  describe('the needs vocabulary', () => {
    it('matches the seam is closed union', () => {
      // The column stores free strings because Postgres cannot express the
      // union; this list is what turns them back into it. A need added to
      // RunnerNeed and not here would be refused at rehydration.
      expect([...KNOWN_NEEDS].sort()).toEqual(
        [
          'cost-reporting',
          'full-streaming',
          'own-infrastructure',
          'structured-rate-limits',
        ].sort(),
      );
    });

    it.each(KNOWN_NEEDS)('round-trips %s', (need) => {
      const original = generated({ needs: [need] });
      expect(rehydrateWorkOrder(stored(original)).needs).toEqual([need]);
    });
  });
});
