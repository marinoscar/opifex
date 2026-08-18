import { allowlistQuerySchema } from './allowlist-query.dto';

describe('AllowlistQueryDto', () => {
  describe('status parameter', () => {
    it('should accept "pending" status value', () => {
      const result = allowlistQuerySchema.parse({
        status: 'pending',
      });

      expect(result.status).toBe('pending');
    });

    it('should accept "claimed" status value', () => {
      const result = allowlistQuerySchema.parse({
        status: 'claimed',
      });

      expect(result.status).toBe('claimed');
    });

    it('should accept "all" status value', () => {
      const result = allowlistQuerySchema.parse({
        status: 'all',
      });

      expect(result.status).toBe('all');
    });

    it('should default to "all" when status is omitted', () => {
      const result = allowlistQuerySchema.parse({});

      expect(result.status).toBe('all');
    });

    it('should reject invalid status value', () => {
      expect(() =>
        allowlistQuerySchema.parse({
          status: 'invalid',
        }),
      ).toThrow();
    });
  });

  describe('pagination parameters', () => {
    it('should apply default page value of 1', () => {
      const result = allowlistQuerySchema.parse({});

      expect(result.page).toBe(1);
    });

    it('should apply default pageSize value of 20', () => {
      const result = allowlistQuerySchema.parse({});

      expect(result.pageSize).toBe(20);
    });

    it('should coerce string page to number', () => {
      const result = allowlistQuerySchema.parse({
        page: '5',
      });

      expect(result.page).toBe(5);
    });

    it('should coerce string pageSize to number', () => {
      const result = allowlistQuerySchema.parse({
        pageSize: '50',
      });

      expect(result.pageSize).toBe(50);
    });

    it('should accept valid page value', () => {
      const result = allowlistQuerySchema.parse({
        page: 10,
      });

      expect(result.page).toBe(10);
    });

    it('should accept valid pageSize value', () => {
      const result = allowlistQuerySchema.parse({
        pageSize: 25,
      });

      expect(result.pageSize).toBe(25);
    });

    it('should reject page less than 1', () => {
      expect(() =>
        allowlistQuerySchema.parse({
          page: 0,
        }),
      ).toThrow();
    });

    it('should reject negative page value', () => {
      expect(() =>
        allowlistQuerySchema.parse({
          page: -1,
        }),
      ).toThrow();
    });

    it('should reject pageSize greater than 100', () => {
      expect(() =>
        allowlistQuerySchema.parse({
          pageSize: 101,
        }),
      ).toThrow();
    });

    it('should reject pageSize less than 1', () => {
      expect(() =>
        allowlistQuerySchema.parse({
          pageSize: 0,
        }),
      ).toThrow();
    });

    it('should reject negative pageSize value', () => {
      expect(() =>
        allowlistQuerySchema.parse({
          pageSize: -10,
        }),
      ).toThrow();
    });

    it('should accept maximum pageSize of 100', () => {
      const result = allowlistQuerySchema.parse({
        pageSize: 100,
      });

      expect(result.pageSize).toBe(100);
    });
  });

  describe('search parameter', () => {
    it('should accept search string', () => {
      const result = allowlistQuerySchema.parse({
        search: 'test@example.com',
      });

      expect(result.search).toBe('test@example.com');
    });

    it('should accept empty search string', () => {
      const result = allowlistQuerySchema.parse({
        search: '',
      });

      expect(result.search).toBe('');
    });

    it('should return undefined when search is omitted', () => {
      const result = allowlistQuerySchema.parse({});

      expect(result.search).toBeUndefined();
    });

    it('should accept search with special characters', () => {
      const result = allowlistQuerySchema.parse({
        search: 'user+test@example.com',
      });

      expect(result.search).toBe('user+test@example.com');
    });
  });

  describe('sorting parameters', () => {
    it('should apply default sortBy value of addedAt', () => {
      const result = allowlistQuerySchema.parse({});

      expect(result.sortBy).toBe('addedAt');
    });

    it('should apply default sortOrder value of desc', () => {
      const result = allowlistQuerySchema.parse({});

      expect(result.sortOrder).toBe('desc');
    });

    it('should accept valid sortBy values', () => {
      expect(allowlistQuerySchema.parse({ sortBy: 'email' }).sortBy).toBe('email');
      expect(allowlistQuerySchema.parse({ sortBy: 'addedAt' }).sortBy).toBe('addedAt');
      expect(allowlistQuerySchema.parse({ sortBy: 'claimedAt' }).sortBy).toBe(
        'claimedAt',
      );
    });

    it('should accept valid sortOrder values', () => {
      expect(allowlistQuerySchema.parse({ sortOrder: 'asc' }).sortOrder).toBe('asc');
      expect(allowlistQuerySchema.parse({ sortOrder: 'desc' }).sortOrder).toBe('desc');
    });

    it('should reject invalid sortBy values', () => {
      expect(() =>
        allowlistQuerySchema.parse({
          sortBy: 'invalid',
        }),
      ).toThrow();
    });

    it('should reject invalid sortOrder values', () => {
      expect(() =>
        allowlistQuerySchema.parse({
          sortOrder: 'invalid',
        }),
      ).toThrow();
    });
  });

  describe('combined parameters', () => {
    it('should parse all parameters together', () => {
      const result = allowlistQuerySchema.parse({
        page: '2',
        pageSize: '10',
        search: 'test@example.com',
        status: 'pending',
        sortBy: 'email',
        sortOrder: 'asc',
      });

      expect(result).toEqual({
        page: 2,
        pageSize: 10,
        search: 'test@example.com',
        status: 'pending',
        sortBy: 'email',
        sortOrder: 'asc',
      });
    });

    it('should apply defaults with partial parameters', () => {
      const result = allowlistQuerySchema.parse({
        search: 'user',
        status: 'claimed',
      });

      expect(result).toEqual({
        page: 1,
        pageSize: 20,
        search: 'user',
        status: 'claimed',
        sortBy: 'addedAt',
        sortOrder: 'desc',
      });
    });
  });
});
