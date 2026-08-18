import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GoogleStrategy, GoogleProfile } from './google.strategy';
import { Profile } from 'passport-google-oauth20';

/**
 * Helper function to create mock Google Profile objects
 */
function createMockProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'google-123456',
    displayName: 'Test User',
    emails: [{ value: 'test@example.com', verified: true }],
    photos: [{ value: 'https://example.com/photo.jpg' }],
    provider: 'google',
    profileUrl: 'https://google.com/profile',
    _raw: '',
    _json: {} as any,
    ...overrides,
  };
}

describe('GoogleStrategy', () => {
  let strategy: GoogleStrategy;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, string> = {
          'google.clientId': 'test-client-id',
          'google.clientSecret': 'test-client-secret',
          'google.callbackUrl': 'http://localhost:3000/api/auth/google/callback',
        };
        return config[key] || '';
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleStrategy,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    strategy = module.get<GoogleStrategy>(GoogleStrategy);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validate', () => {
    it('should extract email from Google profile correctly', (done) => {
      const mockProfile = createMockProfile({
        emails: [{ value: 'test@example.com', verified: true }],
      });

      strategy.validate('access-token', 'refresh-token', mockProfile, (err, user) => {
        expect(err).toBeNull();
        expect(user).toBeDefined();
        expect((user as GoogleProfile).email).toBe('test@example.com');
        done();
      });
    });

    it('should extract displayName from Google profile', (done) => {
      const mockProfile = createMockProfile({
        displayName: 'John Doe',
        emails: [{ value: 'john@example.com', verified: true }],
      });

      strategy.validate('access-token', 'refresh-token', mockProfile, (err, user) => {
        expect(err).toBeNull();
        expect(user).toBeDefined();
        expect((user as GoogleProfile).displayName).toBe('John Doe');
        done();
      });
    });

    it('should extract picture URL from Google profile', (done) => {
      const mockProfile = createMockProfile({
        photos: [{ value: 'https://lh3.googleusercontent.com/a/photo123' }],
      });

      strategy.validate('access-token', 'refresh-token', mockProfile, (err, user) => {
        expect(err).toBeNull();
        expect(user).toBeDefined();
        expect((user as GoogleProfile).picture).toBe('https://lh3.googleusercontent.com/a/photo123');
        done();
      });
    });

    it('should handle profile with missing optional fields', (done) => {
      const mockProfile = createMockProfile({
        photos: [], // No photos
      });

      strategy.validate('access-token', 'refresh-token', mockProfile, (err, user) => {
        expect(err).toBeNull();
        expect(user).toBeDefined();
        const googleProfile = user as GoogleProfile;
        expect(googleProfile.email).toBe('test@example.com');
        expect(googleProfile.picture).toBeUndefined();
        done();
      });
    });

    it('should pass provider and providerId correctly', (done) => {
      const mockProfile = createMockProfile({
        id: 'google-unique-id-12345',
      });

      strategy.validate('access-token', 'refresh-token', mockProfile, (err, user) => {
        expect(err).toBeNull();
        expect(user).toBeDefined();
        expect((user as GoogleProfile).id).toBe('google-unique-id-12345');
        done();
      });
    });

    it('should return error when no email found in profile', (done) => {
      const mockProfile = createMockProfile({
        emails: [], // No emails
      });

      strategy.validate('access-token', 'refresh-token', mockProfile, (err, user) => {
        expect(err).toBeDefined();
        expect((err as Error).message).toContain('No email found in Google profile');
        expect(user).toBe(false);
        done();
      });
    });

    it('should return error when emails array is undefined', (done) => {
      const mockProfile = createMockProfile({
        emails: undefined as any,
      });

      strategy.validate('access-token', 'refresh-token', mockProfile, (err, user) => {
        expect(err).toBeDefined();
        expect((err as Error).message).toContain('No email found in Google profile');
        expect(user).toBe(false);
        done();
      });
    });

    it('should handle multiple emails and use the first one', (done) => {
      const mockProfile = createMockProfile({
        emails: [
          { value: 'primary@example.com', verified: true },
          { value: 'secondary@example.com', verified: false },
        ],
      });

      strategy.validate('access-token', 'refresh-token', mockProfile, (err, user) => {
        expect(err).toBeNull();
        expect(user).toBeDefined();
        expect((user as GoogleProfile).email).toBe('primary@example.com');
        done();
      });
    });

    it('should handle multiple photos and use the first one', (done) => {
      const mockProfile = createMockProfile({
        photos: [
          { value: 'https://example.com/photo1.jpg' },
          { value: 'https://example.com/photo2.jpg' },
        ],
      });

      strategy.validate('access-token', 'refresh-token', mockProfile, (err, user) => {
        expect(err).toBeNull();
        expect(user).toBeDefined();
        expect((user as GoogleProfile).picture).toBe('https://example.com/photo1.jpg');
        done();
      });
    });
  });
});
