import { createMockPrismaService } from '../mocks/prisma.mock';
import { createMockGoogleProfile } from '../mocks/google-oauth.mock';

describe('Test Framework Setup', () => {
  describe('Prisma Mock', () => {
    it('should create a mock Prisma service', () => {
      const mockPrisma = createMockPrismaService();
      expect(mockPrisma).toBeDefined();
      expect(mockPrisma.user).toBeDefined();
      expect(mockPrisma.role).toBeDefined();
    });
  });

  describe('Google OAuth Mock', () => {
    it('should create a mock Google profile', () => {
      const profile = createMockGoogleProfile({
        email: 'test@example.com',
      });

      expect(profile).toBeDefined();
      expect(profile.email).toBe('test@example.com');
      expect(profile.id).toContain('google-');
      expect(profile.displayName).toBeDefined();
    });

    it('should create unique profiles with different emails', () => {
      const profile1 = createMockGoogleProfile({ email: 'user1@example.com' });
      const profile2 = createMockGoogleProfile({ email: 'user2@example.com' });

      expect(profile1.email).toBe('user1@example.com');
      expect(profile2.email).toBe('user2@example.com');
      expect(profile1.email).not.toBe(profile2.email);
    });
  });

  describe('Test Fixtures', () => {
    it('should have user fixtures available', () => {
      const { userFixtures } = require('../fixtures/users.fixture');
      expect(userFixtures).toBeDefined();
      expect(userFixtures.validUser).toBeDefined();
      expect(userFixtures.adminUser).toBeDefined();
    });

    it('should have role fixtures available', () => {
      const { roleFixtures, permissionFixtures } = require('../fixtures/roles.fixture');
      expect(roleFixtures).toBeDefined();
      expect(roleFixtures.admin).toBeDefined();
      expect(permissionFixtures).toBeDefined();
    });

    it('should have settings fixtures available', () => {
      const { userSettingsFixtures, systemSettingsFixtures } = require('../fixtures/settings.fixture');
      expect(userSettingsFixtures).toBeDefined();
      expect(systemSettingsFixtures).toBeDefined();
    });
  });
});
