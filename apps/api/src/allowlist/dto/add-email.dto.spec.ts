import { addEmailSchema } from './add-email.dto';

describe('AddEmailDto', () => {
  describe('email field', () => {
    it('should accept valid email format', () => {
      const result = addEmailSchema.parse({
        email: 'test@example.com',
      });

      expect(result.email).toBe('test@example.com');
    });

    it('should transform email to lowercase', () => {
      const result = addEmailSchema.parse({
        email: 'TEST@EXAMPLE.COM',
      });

      expect(result.email).toBe('test@example.com');
    });

    it('should accept email with plus sign', () => {
      const result = addEmailSchema.parse({
        email: 'user+test@example.com',
      });

      expect(result.email).toBe('user+test@example.com');
    });

    it('should accept email with subdomain', () => {
      const result = addEmailSchema.parse({
        email: 'user@mail.example.com',
      });

      expect(result.email).toBe('user@mail.example.com');
    });

    it('should reject invalid email format - missing @', () => {
      expect(() =>
        addEmailSchema.parse({
          email: 'invalidemail.com',
        }),
      ).toThrow();
    });

    it('should reject invalid email format - missing domain', () => {
      expect(() =>
        addEmailSchema.parse({
          email: 'user@',
        }),
      ).toThrow();
    });

    it('should reject invalid email format - missing local part', () => {
      expect(() =>
        addEmailSchema.parse({
          email: '@example.com',
        }),
      ).toThrow();
    });

    it('should reject empty email', () => {
      expect(() =>
        addEmailSchema.parse({
          email: '',
        }),
      ).toThrow();
    });

    it('should reject missing email field', () => {
      expect(() => addEmailSchema.parse({})).toThrow();
    });
  });

  describe('notes field', () => {
    it('should accept valid notes string', () => {
      const result = addEmailSchema.parse({
        email: 'test@example.com',
        notes: 'This is a test note',
      });

      expect(result.notes).toBe('This is a test note');
    });

    it('should make notes field optional', () => {
      const result = addEmailSchema.parse({
        email: 'test@example.com',
      });

      expect(result.notes).toBeUndefined();
    });

    it('should accept empty notes string', () => {
      const result = addEmailSchema.parse({
        email: 'test@example.com',
        notes: '',
      });

      expect(result.notes).toBe('');
    });

    it('should accept notes at maximum length (500 chars)', () => {
      const longNotes = 'a'.repeat(500);
      const result = addEmailSchema.parse({
        email: 'test@example.com',
        notes: longNotes,
      });

      expect(result.notes).toBe(longNotes);
    });

    it('should reject notes longer than 500 characters', () => {
      const tooLongNotes = 'a'.repeat(501);
      expect(() =>
        addEmailSchema.parse({
          email: 'test@example.com',
          notes: tooLongNotes,
        }),
      ).toThrow();
    });
  });

  describe('combined fields', () => {
    it('should parse both email and notes together', () => {
      const result = addEmailSchema.parse({
        email: 'User@Example.Com',
        notes: 'Added for testing purposes',
      });

      expect(result).toEqual({
        email: 'user@example.com',
        notes: 'Added for testing purposes',
      });
    });
  });
});
