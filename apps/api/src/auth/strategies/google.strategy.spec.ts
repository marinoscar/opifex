import { ConfigService } from '@nestjs/config';
import {
  GoogleStrategy,
  GoogleProfile,
  createGoogleStrategy,
} from './google.strategy';
import { Profile } from 'passport-google-oauth20';

/**
 * A ConfigService stand-in returning whatever `google.*` values a case needs.
 */
function configWith(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const FULL_CONFIG = {
  'google.clientId': 'test-client-id',
  'google.clientSecret': 'test-client-secret',
  'google.callbackUrl': 'http://localhost:3000/api/auth/google/callback',
};

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

  beforeEach(() => {
    // Constructed directly rather than through a Nest container: since #138
    // the strategy takes already-validated options and is not `@Injectable()`,
    // precisely so that it cannot be registered as a plain class provider and
    // constructed with credentials that are not there.
    strategy = new GoogleStrategy({
      clientID: 'test-client-id',
      clientSecret: 'test-client-secret',
      callbackURL: 'http://localhost:3000/api/auth/google/callback',
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createGoogleStrategy', () => {
    it('builds a strategy when both credentials are set', () => {
      expect(createGoogleStrategy(configWith(FULL_CONFIG))).toBeInstanceOf(
        GoogleStrategy,
      );
    });

    it('builds a strategy without a callback URL', () => {
      // Google falls back to the redirect URI registered on the OAuth client;
      // the old `|| ''` would have sent an empty redirect_uri instead.
      const { 'google.callbackUrl': _omitted, ...rest } = FULL_CONFIG;

      expect(createGoogleStrategy(configWith(rest))).toBeInstanceOf(
        GoogleStrategy,
      );
    });

    it('returns undefined instead of throwing when nothing is configured', () => {
      // The regression #138 is about: this used to be
      // `OAuth2Strategy requires a clientID option` at boot.
      expect(createGoogleStrategy(configWith({}))).toBeUndefined();
    });

    it('returns undefined when only the client id is set', () => {
      expect(
        createGoogleStrategy(
          configWith({ 'google.clientId': 'test-client-id' }),
        ),
      ).toBeUndefined();
    });

    it('returns undefined when only the client secret is set', () => {
      expect(
        createGoogleStrategy(
          configWith({ 'google.clientSecret': 'test-client-secret' }),
        ),
      ).toBeUndefined();
    });

    it('treats empty-string credentials as unset', () => {
      // `''` was the value the old fallback supplied, and it is exactly the
      // value passport rejects.
      expect(
        createGoogleStrategy(
          configWith({
            'google.clientId': '',
            'google.clientSecret': '',
            'google.callbackUrl': '',
          }),
        ),
      ).toBeUndefined();
    });
  });

  describe('validate', () => {
    it('should extract email from Google profile correctly', (done) => {
      const mockProfile = createMockProfile({
        emails: [{ value: 'test@example.com', verified: true }],
      });

      strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
        (err, user) => {
          expect(err).toBeNull();
          expect(user).toBeDefined();
          expect((user as GoogleProfile).email).toBe('test@example.com');
          done();
        },
      );
    });

    it('should extract displayName from Google profile', (done) => {
      const mockProfile = createMockProfile({
        displayName: 'John Doe',
        emails: [{ value: 'john@example.com', verified: true }],
      });

      strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
        (err, user) => {
          expect(err).toBeNull();
          expect(user).toBeDefined();
          expect((user as GoogleProfile).displayName).toBe('John Doe');
          done();
        },
      );
    });

    it('should extract picture URL from Google profile', (done) => {
      const mockProfile = createMockProfile({
        photos: [{ value: 'https://lh3.googleusercontent.com/a/photo123' }],
      });

      strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
        (err, user) => {
          expect(err).toBeNull();
          expect(user).toBeDefined();
          expect((user as GoogleProfile).picture).toBe(
            'https://lh3.googleusercontent.com/a/photo123',
          );
          done();
        },
      );
    });

    it('should handle profile with missing optional fields', (done) => {
      const mockProfile = createMockProfile({
        photos: [], // No photos
      });

      strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
        (err, user) => {
          expect(err).toBeNull();
          expect(user).toBeDefined();
          const googleProfile = user as GoogleProfile;
          expect(googleProfile.email).toBe('test@example.com');
          expect(googleProfile.picture).toBeUndefined();
          done();
        },
      );
    });

    it('should pass provider and providerId correctly', (done) => {
      const mockProfile = createMockProfile({
        id: 'google-unique-id-12345',
      });

      strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
        (err, user) => {
          expect(err).toBeNull();
          expect(user).toBeDefined();
          expect((user as GoogleProfile).id).toBe('google-unique-id-12345');
          done();
        },
      );
    });

    it('should return error when no email found in profile', (done) => {
      const mockProfile = createMockProfile({
        emails: [], // No emails
      });

      strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
        (err, user) => {
          expect(err).toBeDefined();
          expect((err as Error).message).toContain(
            'No email found in Google profile',
          );
          expect(user).toBe(false);
          done();
        },
      );
    });

    it('should return error when emails array is undefined', (done) => {
      const mockProfile = createMockProfile({
        emails: undefined as any,
      });

      strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
        (err, user) => {
          expect(err).toBeDefined();
          expect((err as Error).message).toContain(
            'No email found in Google profile',
          );
          expect(user).toBe(false);
          done();
        },
      );
    });

    it('should handle multiple emails and use the first one', (done) => {
      const mockProfile = createMockProfile({
        emails: [
          { value: 'primary@example.com', verified: true },
          { value: 'secondary@example.com', verified: false },
        ],
      });

      strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
        (err, user) => {
          expect(err).toBeNull();
          expect(user).toBeDefined();
          expect((user as GoogleProfile).email).toBe('primary@example.com');
          done();
        },
      );
    });

    it('should handle multiple photos and use the first one', (done) => {
      const mockProfile = createMockProfile({
        photos: [
          { value: 'https://example.com/photo1.jpg' },
          { value: 'https://example.com/photo2.jpg' },
        ],
      });

      strategy.validate(
        'access-token',
        'refresh-token',
        mockProfile,
        (err, user) => {
          expect(err).toBeNull();
          expect(user).toBeDefined();
          expect((user as GoogleProfile).picture).toBe(
            'https://example.com/photo1.jpg',
          );
          done();
        },
      );
    });
  });
});
