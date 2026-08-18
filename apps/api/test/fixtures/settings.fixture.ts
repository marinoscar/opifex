export const userSettingsFixtures = {
  default: {
    theme: 'system',
    profile: {
      useProviderImage: true,
    },
    updatedAt: new Date().toISOString(),
    version: 1,
  },

  darkTheme: {
    theme: 'dark',
    profile: {
      useProviderImage: true,
    },
    updatedAt: new Date().toISOString(),
    version: 1,
  },

  customProfile: {
    theme: 'light',
    profile: {
      displayName: 'Custom Name',
      useProviderImage: false,
      customImageUrl: 'https://example.com/custom.jpg',
    },
    updatedAt: new Date().toISOString(),
    version: 1,
  },
};

export const systemSettingsFixtures = {
  default: {
    ui: {
      allowUserThemeOverride: true,
    },
    features: {},
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    version: 1,
  },

  restrictive: {
    ui: {
      allowUserThemeOverride: false,
    },
    features: {
      newFeature: false,
    },
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    version: 1,
  },
};
