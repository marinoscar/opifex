import { userListQuerySchema } from './user-list-query.dto';

describe('UserListQueryDto', () => {
  describe('isActive parameter', () => {
    it('should transform isActive "true" string to boolean true', () => {
      const result = userListQuerySchema.parse({
        isActive: 'true',
      });

      expect(result.isActive).toBe(true);
    });

    it('should transform isActive "false" string to boolean false', () => {
      const result = userListQuerySchema.parse({
        isActive: 'false',
      });

      expect(result.isActive).toBe(false);
    });

    it('should return undefined when isActive is omitted', () => {
      const result = userListQuerySchema.parse({});

      expect(result.isActive).toBeUndefined();
    });

    it('should reject invalid isActive values', () => {
      expect(() =>
        userListQuerySchema.parse({
          isActive: 'invalid',
        }),
      ).toThrow();
    });

    it('should reject numeric isActive values', () => {
      expect(() =>
        userListQuerySchema.parse({
          isActive: 1,
        }),
      ).toThrow();
    });

    it('should reject boolean isActive values (requires string)', () => {
      expect(() =>
        userListQuerySchema.parse({
          isActive: true,
        }),
      ).toThrow();
    });
  });

  describe('pagination parameters', () => {
    it('should apply default page value of 1', () => {
      const result = userListQuerySchema.parse({});

      expect(result.page).toBe(1);
    });

    it('should apply default pageSize value of 20', () => {
      const result = userListQuerySchema.parse({});

      expect(result.pageSize).toBe(20);
    });

    it('should coerce string page to number', () => {
      const result = userListQuerySchema.parse({
        page: '5',
      });

      expect(result.page).toBe(5);
    });

    it('should coerce string pageSize to number', () => {
      const result = userListQuerySchema.parse({
        pageSize: '50',
      });

      expect(result.pageSize).toBe(50);
    });

    it('should reject page less than 1', () => {
      expect(() =>
        userListQuerySchema.parse({
          page: 0,
        }),
      ).toThrow();
    });

    it('should reject pageSize greater than 100', () => {
      expect(() =>
        userListQuerySchema.parse({
          pageSize: 101,
        }),
      ).toThrow();
    });

    it('should reject pageSize less than 1', () => {
      expect(() =>
        userListQuerySchema.parse({
          pageSize: 0,
        }),
      ).toThrow();
    });
  });

  describe('search parameter', () => {
    it('should accept search string', () => {
      const result = userListQuerySchema.parse({
        search: 'john',
      });

      expect(result.search).toBe('john');
    });

    it('should return undefined when search is omitted', () => {
      const result = userListQuerySchema.parse({});

      expect(result.search).toBeUndefined();
    });
  });

  describe('role parameter', () => {
    it('should accept role string', () => {
      const result = userListQuerySchema.parse({
        role: 'admin',
      });

      expect(result.role).toBe('admin');
    });

    it('should return undefined when role is omitted', () => {
      const result = userListQuerySchema.parse({});

      expect(result.role).toBeUndefined();
    });
  });

  describe('sorting parameters', () => {
    it('should apply default sortBy value of createdAt', () => {
      const result = userListQuerySchema.parse({});

      expect(result.sortBy).toBe('createdAt');
    });

    it('should apply default sortOrder value of desc', () => {
      const result = userListQuerySchema.parse({});

      expect(result.sortOrder).toBe('desc');
    });

    it('should accept valid sortBy values', () => {
      expect(userListQuerySchema.parse({ sortBy: 'email' }).sortBy).toBe('email');
      expect(userListQuerySchema.parse({ sortBy: 'createdAt' }).sortBy).toBe('createdAt');
      expect(userListQuerySchema.parse({ sortBy: 'updatedAt' }).sortBy).toBe('updatedAt');
    });

    it('should accept valid sortOrder values', () => {
      expect(userListQuerySchema.parse({ sortOrder: 'asc' }).sortOrder).toBe('asc');
      expect(userListQuerySchema.parse({ sortOrder: 'desc' }).sortOrder).toBe('desc');
    });

    it('should reject invalid sortBy values', () => {
      expect(() =>
        userListQuerySchema.parse({
          sortBy: 'invalid',
        }),
      ).toThrow();
    });

    it('should reject invalid sortOrder values', () => {
      expect(() =>
        userListQuerySchema.parse({
          sortOrder: 'invalid',
        }),
      ).toThrow();
    });
  });

  describe('combined parameters', () => {
    it('should parse all parameters together', () => {
      const result = userListQuerySchema.parse({
        page: '2',
        pageSize: '10',
        search: 'test',
        role: 'admin',
        isActive: 'true',
        sortBy: 'email',
        sortOrder: 'asc',
      });

      expect(result).toEqual({
        page: 2,
        pageSize: 10,
        search: 'test',
        role: 'admin',
        isActive: true,
        sortBy: 'email',
        sortOrder: 'asc',
      });
    });
  });
});
