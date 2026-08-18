import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';

export interface MockGoogleProfile {
  id: string;
  email: string;
  displayName: string;
  picture?: string;
}

/**
 * Mock Google OAuth strategy for testing
 * Bypasses actual Google OAuth and returns mock profile
 */
@Injectable()
export class MockGoogleStrategy extends PassportStrategy(Strategy, 'google') {
  static mockProfile: MockGoogleProfile = {
    id: 'google-123456',
    email: 'test@example.com',
    displayName: 'Test User',
    picture: 'https://example.com/photo.jpg',
  };

  constructor() {
    super();
  }

  validate(req: any, done: any): void {
    done(null, MockGoogleStrategy.mockProfile);
  }

  /**
   * Set the mock profile for the next authentication
   */
  static setMockProfile(profile: Partial<MockGoogleProfile>): void {
    MockGoogleStrategy.mockProfile = {
      ...MockGoogleStrategy.mockProfile,
      ...profile,
    };
  }

  /**
   * Reset mock profile to defaults
   */
  static resetMockProfile(): void {
    MockGoogleStrategy.mockProfile = {
      id: 'google-123456',
      email: 'test@example.com',
      displayName: 'Test User',
      picture: 'https://example.com/photo.jpg',
    };
  }
}

/**
 * Creates a mock profile for testing
 */
export function createMockGoogleProfile(
  overrides: Partial<MockGoogleProfile> = {},
): MockGoogleProfile {
  return {
    id: `google-${Date.now()}`,
    email: `user-${Date.now()}@example.com`,
    displayName: 'Mock User',
    picture: 'https://example.com/photo.jpg',
    ...overrides,
  };
}
