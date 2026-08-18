import {
  updateSystemSettingsSchema,
  patchSystemSettingsSchema,
} from './update-system-settings.dto';

describe('UpdateSystemSettingsDto (PUT)', () => {
  describe('ui field', () => {
    it('should accept valid ui settings object', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {},
      });

      expect(result.ui.allowUserThemeOverride).toBe(true);
    });

    it('should accept allowUserThemeOverride as false', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: false,
        },
        features: {},
      });

      expect(result.ui.allowUserThemeOverride).toBe(false);
    });

    it('should reject ui without allowUserThemeOverride', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          ui: {},
          features: {},
        }),
      ).toThrow();
    });

    it('should reject non-boolean allowUserThemeOverride', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          ui: {
            allowUserThemeOverride: 'true',
          },
          features: {},
        }),
      ).toThrow();
    });

    it('should require ui field', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          features: {},
        }),
      ).toThrow();
    });
  });

  describe('features field', () => {
    it('should accept empty features object', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {},
      });

      expect(result.features).toEqual({});
    });

    it('should accept features with boolean flags', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {
          enableNotifications: true,
          enableAnalytics: false,
        },
      });

      expect(result.features).toEqual({
        enableNotifications: true,
        enableAnalytics: false,
      });
    });

    it('should reject features with non-boolean values', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          ui: {
            allowUserThemeOverride: true,
          },
          features: {
            enableNotifications: 'true',
          },
        }),
      ).toThrow();
    });

    it('should require features field', () => {
      expect(() =>
        updateSystemSettingsSchema.parse({
          ui: {
            allowUserThemeOverride: true,
          },
        }),
      ).toThrow();
    });
  });

  describe('complete settings object', () => {
    it('should accept valid complete settings', () => {
      const result = updateSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {
          enableNotifications: true,
          enableAdvancedFeatures: false,
        },
      });

      expect(result).toEqual({
        ui: {
          allowUserThemeOverride: true,
        },
        features: {
          enableNotifications: true,
          enableAdvancedFeatures: false,
        },
      });
    });
  });
});

describe('PatchSystemSettingsDto (PATCH)', () => {
  describe('ui field', () => {
    it('should make ui field optional', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result.ui).toBeUndefined();
    });

    it('should accept ui with allowUserThemeOverride', () => {
      const result = patchSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: false,
        },
      });

      expect(result.ui?.allowUserThemeOverride).toBe(false);
    });

    it('should make allowUserThemeOverride optional in ui', () => {
      const result = patchSystemSettingsSchema.parse({
        ui: {},
      });

      expect(result.ui).toEqual({});
    });
  });

  describe('features field', () => {
    it('should make features field optional', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result.features).toBeUndefined();
    });

    it('should accept features with boolean flags', () => {
      const result = patchSystemSettingsSchema.parse({
        features: {
          newFeature: true,
        },
      });

      expect(result.features).toEqual({
        newFeature: true,
      });
    });

    it('should reject features with non-boolean values', () => {
      expect(() =>
        patchSystemSettingsSchema.parse({
          features: {
            newFeature: 'yes',
          },
        }),
      ).toThrow();
    });
  });

  describe('partial updates', () => {
    it('should accept empty object (all fields optional)', () => {
      const result = patchSystemSettingsSchema.parse({});

      expect(result).toEqual({});
    });

    it('should accept update with only ui field', () => {
      const result = patchSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: true,
        },
      });

      expect(result).toEqual({
        ui: {
          allowUserThemeOverride: true,
        },
      });
    });

    it('should accept update with only features field', () => {
      const result = patchSystemSettingsSchema.parse({
        features: {
          beta: true,
        },
      });

      expect(result).toEqual({
        features: {
          beta: true,
        },
      });
    });

    it('should accept combination of partial fields', () => {
      const result = patchSystemSettingsSchema.parse({
        ui: {
          allowUserThemeOverride: false,
        },
        features: {
          experimental: true,
        },
      });

      expect(result).toEqual({
        ui: {
          allowUserThemeOverride: false,
        },
        features: {
          experimental: true,
        },
      });
    });
  });
});
