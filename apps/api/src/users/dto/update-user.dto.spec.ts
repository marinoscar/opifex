import { updateUserSchema } from './update-user.dto';

describe('UpdateUserDto', () => {
  describe('displayName field', () => {
    it('should accept valid displayName', () => {
      const result = updateUserSchema.parse({
        displayName: 'John Doe',
      });

      expect(result.displayName).toBe('John Doe');
    });

    it('should accept displayName with single character', () => {
      const result = updateUserSchema.parse({
        displayName: 'A',
      });

      expect(result.displayName).toBe('A');
    });

    it('should accept displayName with special characters', () => {
      const result = updateUserSchema.parse({
        displayName: "O'Brien-Smith",
      });

      expect(result.displayName).toBe("O'Brien-Smith");
    });

    it('should accept displayName with unicode characters', () => {
      const result = updateUserSchema.parse({
        displayName: 'José María',
      });

      expect(result.displayName).toBe('José María');
    });

    it('should accept displayName at maximum length (100 chars)', () => {
      const longName = 'a'.repeat(100);
      const result = updateUserSchema.parse({
        displayName: longName,
      });

      expect(result.displayName).toBe(longName);
    });

    it('should reject displayName longer than 100 characters', () => {
      const tooLongName = 'a'.repeat(101);
      expect(() =>
        updateUserSchema.parse({
          displayName: tooLongName,
        }),
      ).toThrow();
    });

    it('should accept empty string for displayName', () => {
      const result = updateUserSchema.parse({
        displayName: '',
      });

      expect(result.displayName).toBe('');
    });

    it('should make displayName optional', () => {
      const result = updateUserSchema.parse({});

      expect(result.displayName).toBeUndefined();
    });
  });

  describe('isActive field', () => {
    it('should accept true boolean value', () => {
      const result = updateUserSchema.parse({
        isActive: true,
      });

      expect(result.isActive).toBe(true);
    });

    it('should accept false boolean value', () => {
      const result = updateUserSchema.parse({
        isActive: false,
      });

      expect(result.isActive).toBe(false);
    });

    it('should make isActive optional', () => {
      const result = updateUserSchema.parse({});

      expect(result.isActive).toBeUndefined();
    });

    it('should reject string "true" for isActive', () => {
      expect(() =>
        updateUserSchema.parse({
          isActive: 'true',
        }),
      ).toThrow();
    });

    it('should reject string "false" for isActive', () => {
      expect(() =>
        updateUserSchema.parse({
          isActive: 'false',
        }),
      ).toThrow();
    });

    it('should reject numeric 1 for isActive', () => {
      expect(() =>
        updateUserSchema.parse({
          isActive: 1,
        }),
      ).toThrow();
    });

    it('should reject numeric 0 for isActive', () => {
      expect(() =>
        updateUserSchema.parse({
          isActive: 0,
        }),
      ).toThrow();
    });
  });

  describe('combined fields', () => {
    it('should accept both displayName and isActive together', () => {
      const result = updateUserSchema.parse({
        displayName: 'Test User',
        isActive: true,
      });

      expect(result).toEqual({
        displayName: 'Test User',
        isActive: true,
      });
    });

    it('should accept partial update with only displayName', () => {
      const result = updateUserSchema.parse({
        displayName: 'Updated Name',
      });

      expect(result).toEqual({
        displayName: 'Updated Name',
      });
    });

    it('should accept partial update with only isActive', () => {
      const result = updateUserSchema.parse({
        isActive: false,
      });

      expect(result).toEqual({
        isActive: false,
      });
    });

    it('should accept empty object (all fields optional)', () => {
      const result = updateUserSchema.parse({});

      expect(result).toEqual({});
    });

    it('should strip unknown fields', () => {
      const result = updateUserSchema.parse({
        displayName: 'Test',
        unknownField: 'value',
      });

      expect(result).toEqual({
        displayName: 'Test',
      });
      expect(result).not.toHaveProperty('unknownField');
    });
  });
});
