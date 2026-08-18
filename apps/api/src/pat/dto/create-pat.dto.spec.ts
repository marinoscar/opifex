import { createPatSchema } from './create-pat.dto';

describe('createPatSchema (Zod validation)', () => {
  // ============================================================================
  // Valid inputs
  // ============================================================================

  describe('valid inputs', () => {
    it('should pass with all required fields provided (days)', () => {
      const result = createPatSchema.safeParse({
        name: 'My CI Token',
        durationValue: 30,
        durationUnit: 'days',
      });

      expect(result.success).toBe(true);
    });

    it('should pass with durationUnit "minutes"', () => {
      const result = createPatSchema.safeParse({
        name: 'Short Lived',
        durationValue: 15,
        durationUnit: 'minutes',
      });

      expect(result.success).toBe(true);
    });

    it('should pass with durationUnit "months"', () => {
      const result = createPatSchema.safeParse({
        name: 'Long Lived',
        durationValue: 12,
        durationUnit: 'months',
      });

      expect(result.success).toBe(true);
    });

    it('should pass with minimum durationValue of 1', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 1,
        durationUnit: 'days',
      });

      expect(result.success).toBe(true);
    });

    it('should pass with maximum durationValue of 999', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 999,
        durationUnit: 'days',
      });

      expect(result.success).toBe(true);
    });

    it('should pass with name of exactly 100 characters', () => {
      const result = createPatSchema.safeParse({
        name: 'a'.repeat(100),
        durationValue: 30,
        durationUnit: 'days',
      });

      expect(result.success).toBe(true);
    });

    it('should trim whitespace from name', () => {
      const result = createPatSchema.safeParse({
        name: '  My Token  ',
        durationValue: 30,
        durationUnit: 'days',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('My Token');
      }
    });
  });

  // ============================================================================
  // Invalid: name
  // ============================================================================

  describe('invalid name', () => {
    it('should fail when name is missing', () => {
      const result = createPatSchema.safeParse({
        durationValue: 30,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when name is empty string', () => {
      const result = createPatSchema.safeParse({
        name: '',
        durationValue: 30,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when name is only whitespace', () => {
      const result = createPatSchema.safeParse({
        name: '   ',
        durationValue: 30,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when name exceeds 100 characters', () => {
      const result = createPatSchema.safeParse({
        name: 'a'.repeat(101),
        durationValue: 30,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when name is a number', () => {
      const result = createPatSchema.safeParse({
        name: 123,
        durationValue: 30,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when name is null', () => {
      const result = createPatSchema.safeParse({
        name: null,
        durationValue: 30,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Invalid: durationValue
  // ============================================================================

  describe('invalid durationValue', () => {
    it('should fail when durationValue is 0', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 0,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationValue is 1000 (above max)', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 1000,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationValue is negative', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: -1,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationValue is a non-integer (1.5)', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 1.5,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationValue is a string', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: '30',
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationValue is missing', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationValue is null', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: null,
        durationUnit: 'days',
      });

      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Invalid: durationUnit
  // ============================================================================

  describe('invalid durationUnit', () => {
    it('should fail when durationUnit is "weeks"', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 30,
        durationUnit: 'weeks',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationUnit is "hours"', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 30,
        durationUnit: 'hours',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationUnit is "years"', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 30,
        durationUnit: 'years',
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationUnit is missing', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 30,
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationUnit is null', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 30,
        durationUnit: null,
      });

      expect(result.success).toBe(false);
    });

    it('should fail when durationUnit is empty string', () => {
      const result = createPatSchema.safeParse({
        name: 'Token',
        durationValue: 30,
        durationUnit: '',
      });

      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Missing all fields
  // ============================================================================

  describe('missing all fields', () => {
    it('should fail when body is empty object', () => {
      const result = createPatSchema.safeParse({});

      expect(result.success).toBe(false);
    });

    it('should fail when body is null', () => {
      const result = createPatSchema.safeParse(null);

      expect(result.success).toBe(false);
    });

    it('should fail when body is undefined', () => {
      const result = createPatSchema.safeParse(undefined);

      expect(result.success).toBe(false);
    });
  });
});
