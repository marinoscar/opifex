import { updateUserRolesSchema } from './update-user-roles.dto';

describe('UpdateUserRolesDto', () => {
  describe('roleNames field', () => {
    it('should accept array with single role', () => {
      const result = updateUserRolesSchema.parse({
        roleNames: ['Admin'],
      });

      expect(result.roleNames).toEqual(['Admin']);
    });

    it('should accept array with multiple roles', () => {
      const result = updateUserRolesSchema.parse({
        roleNames: ['Admin', 'Contributor'],
      });

      expect(result.roleNames).toEqual(['Admin', 'Contributor']);
    });

    it('should accept array with all valid role names', () => {
      const result = updateUserRolesSchema.parse({
        roleNames: ['Admin', 'Contributor', 'Viewer'],
      });

      expect(result.roleNames).toEqual(['Admin', 'Contributor', 'Viewer']);
    });

    it('should reject empty array', () => {
      expect(() =>
        updateUserRolesSchema.parse({
          roleNames: [],
        }),
      ).toThrow('At least one role is required');
    });

    it('should reject non-array value - string', () => {
      expect(() =>
        updateUserRolesSchema.parse({
          roleNames: 'Admin',
        }),
      ).toThrow();
    });

    it('should reject non-array value - object', () => {
      expect(() =>
        updateUserRolesSchema.parse({
          roleNames: { role: 'Admin' },
        }),
      ).toThrow();
    });

    it('should reject non-array value - number', () => {
      expect(() =>
        updateUserRolesSchema.parse({
          roleNames: 123,
        }),
      ).toThrow();
    });

    it('should reject missing roleNames field', () => {
      expect(() => updateUserRolesSchema.parse({})).toThrow();
    });

    it('should reject array with non-string elements', () => {
      expect(() =>
        updateUserRolesSchema.parse({
          roleNames: [123, 456],
        }),
      ).toThrow();
    });

    it('should reject array with mixed types', () => {
      expect(() =>
        updateUserRolesSchema.parse({
          roleNames: ['Admin', 123],
        }),
      ).toThrow();
    });

    it('should accept array with empty string elements', () => {
      const result = updateUserRolesSchema.parse({
        roleNames: [''],
      });

      expect(result.roleNames).toEqual(['']);
    });

    it('should preserve role name casing', () => {
      const result = updateUserRolesSchema.parse({
        roleNames: ['admin', 'CONTRIBUTOR', 'Viewer'],
      });

      expect(result.roleNames).toEqual(['admin', 'CONTRIBUTOR', 'Viewer']);
    });

    it('should accept duplicate role names', () => {
      const result = updateUserRolesSchema.parse({
        roleNames: ['Admin', 'Admin'],
      });

      expect(result.roleNames).toEqual(['Admin', 'Admin']);
    });

    it('should accept role names with whitespace', () => {
      const result = updateUserRolesSchema.parse({
        roleNames: [' Admin ', 'Contributor '],
      });

      expect(result.roleNames).toEqual([' Admin ', 'Contributor ']);
    });
  });

  describe('validation errors', () => {
    it('should provide clear error message for empty array', () => {
      try {
        updateUserRolesSchema.parse({ roleNames: [] });
        fail('Should have thrown an error');
      } catch (error: any) {
        // zod v4: error.issues replaces error.errors
        expect(error.issues[0].message).toBe('At least one role is required');
      }
    });
  });
});
