export const userFixtures = {
  validUser: {
    email: 'valid@example.com',
    providerDisplayName: 'Valid User',
    providerProfileImageUrl: 'https://example.com/photo.jpg',
    isActive: true,
  },

  inactiveUser: {
    email: 'inactive@example.com',
    providerDisplayName: 'Inactive User',
    isActive: false,
  },

  adminUser: {
    email: 'admin@example.com',
    providerDisplayName: 'Admin User',
    isActive: true,
  },

  googleIdentity: {
    provider: 'google',
    providerSubject: 'google-test-123',
    providerEmail: 'test@example.com',
  },
};

export const googleProfileFixtures = {
  newUser: {
    id: 'google-new-user',
    email: 'newuser@example.com',
    displayName: 'New User',
    picture: 'https://example.com/new.jpg',
  },

  existingUser: {
    id: 'google-existing',
    email: 'existing@example.com',
    displayName: 'Existing User',
    picture: 'https://example.com/existing.jpg',
  },

  adminBootstrap: {
    id: 'google-admin',
    email: process.env.INITIAL_ADMIN_EMAIL || 'admin@example.com',
    displayName: 'Admin Bootstrap User',
    picture: 'https://example.com/admin.jpg',
  },
};
