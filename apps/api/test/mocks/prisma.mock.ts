import { DeepMockProxy, mockDeep, mockReset } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

/**
 * Type-safe Prisma mock for testing
 */
export type MockPrismaClient = DeepMockProxy<PrismaClient>;
export type MockPrismaService = DeepMockProxy<PrismaClient>;

/**
 * Global Prisma mock instance
 * Use this in tests with jest-mock-extended
 */
const _prismaMock: MockPrismaClient = mockDeep<PrismaClient>();

// Export as `any` to allow flexible mocking without strict Prisma type checking
// This is intentional - tests need to mock partial responses
export const prismaMock = _prismaMock as any;

/**
 * Alias for backward compatibility
 */
export const mockPrisma = prismaMock;

/**
 * `verifyConnection()` lives on `PrismaService`, not `PrismaClient`, so it is
 * not part of the type `mockDeep<PrismaClient>()` is built from. Left alone,
 * jest-mock-extended's proxy auto-vivifies it on first access as a bare
 * `jest.fn()` that resolves `undefined` — the database looks permanently
 * healthy, and the ~20 existing `$queryRaw.mockResolvedValue` /
 * `.mockRejectedValue` setups in the health specs are never consulted, because
 * nothing routes through `$queryRaw` anymore.
 *
 * Give it a default implementation that makes the same round trip the real
 * `PrismaService.verifyConnection()` makes (see prisma.service.ts), so the
 * double behaves like the thing it doubles: every existing `$queryRaw` mock
 * setup keeps controlling this call unchanged, and the fix lives in one place
 * instead of at each of those ~20 call sites.
 */
function installVerifyConnectionDefault(): void {
  prismaMock.verifyConnection = jest.fn(async () => {
    await prismaMock.$queryRaw`SELECT 1`;
  });
}

installVerifyConnectionDefault();

/**
 * Reset all Prisma mocks
 * Call this in beforeEach() to ensure clean state
 *
 * `mockReset` clears any custom implementation set on `verifyConnection`
 * (including the default above) along with everything else, so it must be
 * re-installed after every reset or the first test after a reset would
 * silently revert to the always-healthy behaviour described above.
 */
export function resetPrismaMock(): void {
  mockReset(prismaMock);
  installVerifyConnectionDefault();
}

/**
 * Helper to mock $transaction - executes callbacks immediately
 */
export function mockPrismaTransaction(): void {
  prismaMock.$transaction.mockImplementation(async (arg: any) => {
    if (typeof arg === 'function') {
      // Interactive transaction
      return arg(prismaMock);
    } else if (Array.isArray(arg)) {
      // Sequential operations
      return Promise.all(arg);
    }
    return arg;
  });
}

/**
 * Creates a fresh mock PrismaService for unit tests
 */
export function createMockPrismaService(): MockPrismaService {
  return mockDeep<PrismaClient>();
}
