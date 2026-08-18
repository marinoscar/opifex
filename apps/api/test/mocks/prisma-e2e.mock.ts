import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';

/**
 * Mock PrismaService that can be used in E2E tests
 * This prevents the need for a real database connection during testing
 */
@Injectable()
export class MockPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MockPrismaService');
  private mock: DeepMockProxy<PrismaClient>;

  constructor() {
    super();
    this.mock = mockDeep<PrismaClient>();

    // Copy all mock methods to this instance
    Object.assign(this, this.mock);
  }

  async onModuleInit() {
    // Skip actual connection in mock mode
    this.logger.log('Mock database initialized (no real connection)');
  }

  async onModuleDestroy() {
    // Skip actual disconnection in mock mode
    this.logger.log('Mock database cleaned up');
  }

  async $connect() {
    // No-op for mock
    return Promise.resolve();
  }

  async $disconnect() {
    // No-op for mock
    return Promise.resolve();
  }

  /**
   * Get the underlying mock for test setup
   */
  getMock(): DeepMockProxy<PrismaClient> {
    return this.mock;
  }

  /**
   * Reset all mocks between tests
   */
  resetMock() {
    this.mock = mockDeep<PrismaClient>();
    Object.assign(this, this.mock);
  }
}

/**
 * Creates a mocked PrismaService for E2E testing
 */
export function createMockPrismaServiceForE2E(): MockPrismaService {
  return new MockPrismaService();
}
