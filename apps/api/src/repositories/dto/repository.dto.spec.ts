import {
  listRepositoriesQuerySchema,
  repositoryResponseSchema,
  retireRepositorySchema,
} from './repository.dto';

/**
 * The boundary for retirement (#405).
 *
 * These parse the wire shape, which the service tests never see: they call the
 * service directly with already-typed objects, so a query string that does not
 * coerce would go unnoticed there.
 */
describe('repository DTOs (#405)', () => {
  describe('the retired filter', () => {
    it('coerces the string a query string actually carries', () => {
      // `?retired=true` arrives as the STRING "true". A plain `z.boolean()`
      // here would reject every real request from a browser.
      expect(
        listRepositoriesQuerySchema.parse({ retired: 'true' }).retired,
      ).toBe(true);
      expect(
        listRepositoriesQuerySchema.parse({ retired: 'false' }).retired,
      ).toBe(false);
    });

    it('is undefined when omitted, which the service reads as BOTH', () => {
      // Not defaulted to `false`. A default would hide every retired
      // repository from the list, leaving an operator unable to find the one
      // they just retired in order to un-retire it.
      expect(listRepositoriesQuerySchema.parse({}).retired).toBeUndefined();
    });
  });

  describe('the retire body', () => {
    it('accepts an empty body', () => {
      // Requiring a justification produces the string "asdf".
      expect(retireRepositorySchema.parse({})).toEqual({});
    });

    it('carries nothing about the resulting state', () => {
      // The point of #405 is that the ladder is not the caller's to compose:
      // retiring is one act, not four flags posted in a different shape. Any
      // flag in the body is stripped, so it can never be mistaken for input.
      const parsed = retireRepositorySchema.parse({
        reason: 'superseded',
        dispatchEnabled: true,
        retiredAt: '2026-08-20T09:00:00.000Z',
      });

      expect(parsed).toEqual({ reason: 'superseded' });
    });

    it('rejects a reason that is blank or absurdly long', () => {
      expect(retireRepositorySchema.safeParse({ reason: '   ' }).success).toBe(
        false,
      );
      expect(
        retireRepositorySchema.safeParse({ reason: 'x'.repeat(501) }).success,
      ).toBe(false);
    });
  });

  describe('the response', () => {
    const base = {
      id: '0f14e0a1-8b2c-4d3e-9f01-2a3b4c5d6e7f',
      projectId: null,
      owner: 'acme',
      name: 'app',
      fullName: 'acme/app',
      defaultBranch: 'main',
      observeEnabled: false,
      dispatchEnabled: false,
      mirrorLabelsEnabled: false,
      specFeedbackEnabled: false,
      budgetCeilingUsd: null,
      wallClockTimeoutMinutes: null,
      pathConstraints: [],
      lastObservedAt: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };

    it('requires the retirement fields to be present, not merely allowed', () => {
      // A client decides between "Retire" and "Un-retire" by reading
      // `retiredAt`. If the field could be absent it would have to guess from
      // the flags, which is exactly the derived reading #405 rejected.
      expect(repositoryResponseSchema.safeParse(base).success).toBe(false);
      expect(
        repositoryResponseSchema.safeParse({
          ...base,
          retiredAt: null,
          retiredById: null,
        }).success,
      ).toBe(true);
    });

    it('carries the timestamp and the actor when retired', () => {
      const parsed = repositoryResponseSchema.parse({
        ...base,
        retiredAt: '2026-08-20T09:00:00.000Z',
        retiredById: '3f6d9e5a-2b1c-4a7e-9c8d-5e4f3a2b1c0d',
      });

      expect(parsed.retiredAt).toBe('2026-08-20T09:00:00.000Z');
      expect(parsed.retiredById).toBe('3f6d9e5a-2b1c-4a7e-9c8d-5e4f3a2b1c0d');
    });
  });
});
