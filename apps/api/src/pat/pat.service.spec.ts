import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PatService } from './pat.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { CreatePatDto } from './dto/create-pat.dto';
import { createHash } from 'node:crypto';

describe('PatService', () => {
  let service: PatService;
  let mockPrisma: MockPrismaService;

  const mockUserId = 'user-123';

  const mockPatRecord = {
    id: 'pat-id-123',
    userId: mockUserId,
    name: 'My Token',
    tokenHash: 'stored-hash',
    tokenPrefix: 'pat_abcd',
    durationValue: 30,
    durationUnit: 'days',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days in future
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockUserWithRelations = {
    id: mockUserId,
    email: 'test@example.com',
    isActive: true,
    displayName: null,
    userRoles: [
      {
        userId: mockUserId,
        roleId: 'role-1',
        role: {
          id: 'role-1',
          name: 'viewer',
          rolePermissions: [
            {
              roleId: 'role-1',
              permissionId: 'perm-1',
              permission: { id: 'perm-1', name: 'user_settings:read', description: null },
            },
          ],
        },
      },
    ],
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PatService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<PatService>(PatService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // createToken
  // ============================================================================

  describe('createToken', () => {
    it('should return raw token starting with pat_', async () => {
      const dto: CreatePatDto = { name: 'My Token', durationValue: 30, durationUnit: 'days' };

      mockPrisma.personalAccessToken.create.mockResolvedValue(mockPatRecord as any);

      const result = await service.createToken(mockUserId, dto);

      expect(result.token).toMatch(/^pat_/);
      expect(result.token).toHaveLength(4 + 64); // "pat_" + 64 hex chars
    });

    it('should store the SHA256 hash of the token (not the raw token)', async () => {
      const dto: CreatePatDto = { name: 'Secure Token', durationValue: 7, durationUnit: 'days' };

      mockPrisma.personalAccessToken.create.mockResolvedValue(mockPatRecord as any);

      await service.createToken(mockUserId, dto);

      expect(mockPrisma.personalAccessToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), // SHA256 hex
        }),
      });

      const callArg = (mockPrisma.personalAccessToken.create as jest.Mock).mock.calls[0][0];
      const storedHash = callArg.data.tokenHash;

      // Verify it's a valid SHA256 hex string (64 chars, lowercase hex)
      expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should compute the correct SHA256 hash for the raw token', async () => {
      const dto: CreatePatDto = { name: 'Test', durationValue: 1, durationUnit: 'days' };

      mockPrisma.personalAccessToken.create.mockResolvedValue(mockPatRecord as any);

      const result = await service.createToken(mockUserId, dto);

      const callArg = (mockPrisma.personalAccessToken.create as jest.Mock).mock.calls[0][0];
      const storedHash = callArg.data.tokenHash;

      // Verify the stored hash matches the SHA256 of the returned raw token
      const expectedHash = createHash('sha256').update(result.token).digest('hex');
      expect(storedHash).toBe(expectedHash);
    });

    it('should set tokenPrefix to pat_ + first 4 hex chars', async () => {
      const dto: CreatePatDto = { name: 'Token', durationValue: 1, durationUnit: 'days' };

      mockPrisma.personalAccessToken.create.mockResolvedValue(mockPatRecord as any);

      const result = await service.createToken(mockUserId, dto);

      // tokenPrefix should be pat_ + first 4 chars of the hex part
      const hexPart = result.token.slice(4); // Remove "pat_"
      const expectedPrefix = `pat_${hexPart.slice(0, 4)}`;

      const callArg = (mockPrisma.personalAccessToken.create as jest.Mock).mock.calls[0][0];
      expect(callArg.data.tokenPrefix).toBe(expectedPrefix);
    });

    describe('expiresAt calculation', () => {
      it('should calculate expiresAt correctly for "days" unit', async () => {
        const dto: CreatePatDto = { name: 'Token', durationValue: 30, durationUnit: 'days' };

        mockPrisma.personalAccessToken.create.mockResolvedValue(mockPatRecord as any);

        const before = new Date();
        await service.createToken(mockUserId, dto);
        const after = new Date();

        const callArg = (mockPrisma.personalAccessToken.create as jest.Mock).mock.calls[0][0];
        const expiresAt: Date = callArg.data.expiresAt;

        // Should be approximately 30 days from now
        const expectedMin = new Date(before);
        expectedMin.setDate(expectedMin.getDate() + 30);
        const expectedMax = new Date(after);
        expectedMax.setDate(expectedMax.getDate() + 30);

        expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
        expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
      });

      it('should calculate expiresAt correctly for "minutes" unit', async () => {
        const dto: CreatePatDto = { name: 'Token', durationValue: 15, durationUnit: 'minutes' };

        mockPrisma.personalAccessToken.create.mockResolvedValue(mockPatRecord as any);

        const before = new Date();
        await service.createToken(mockUserId, dto);
        const after = new Date();

        const callArg = (mockPrisma.personalAccessToken.create as jest.Mock).mock.calls[0][0];
        const expiresAt: Date = callArg.data.expiresAt;

        const expectedMin = new Date(before.getTime() + 15 * 60 * 1000);
        const expectedMax = new Date(after.getTime() + 15 * 60 * 1000);

        expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
        expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
      });

      it('should calculate expiresAt correctly for "months" unit', async () => {
        const dto: CreatePatDto = { name: 'Token', durationValue: 3, durationUnit: 'months' };

        mockPrisma.personalAccessToken.create.mockResolvedValue(mockPatRecord as any);

        const before = new Date();
        await service.createToken(mockUserId, dto);
        const after = new Date();

        const callArg = (mockPrisma.personalAccessToken.create as jest.Mock).mock.calls[0][0];
        const expiresAt: Date = callArg.data.expiresAt;

        // Should be approximately 3 months from now
        const expectedMin = new Date(before);
        expectedMin.setMonth(expectedMin.getMonth() + 3);
        const expectedMax = new Date(after);
        expectedMax.setMonth(expectedMax.getMonth() + 3);

        // Allow a 1-second window for test execution time
        expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime() - 1000);
        expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax.getTime() + 1000);
      });
    });

    it('should return the correct shape from createToken', async () => {
      const dto: CreatePatDto = { name: 'Shape Test', durationValue: 30, durationUnit: 'days' };

      mockPrisma.personalAccessToken.create.mockResolvedValue(mockPatRecord as any);

      const result = await service.createToken(mockUserId, dto);

      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('id', mockPatRecord.id);
      expect(result).toHaveProperty('name', mockPatRecord.name);
      expect(result).toHaveProperty('tokenPrefix', mockPatRecord.tokenPrefix);
      expect(result).toHaveProperty('expiresAt');
      expect(result).toHaveProperty('createdAt');
      expect(typeof result.expiresAt).toBe('string'); // ISO string
      expect(typeof result.createdAt).toBe('string'); // ISO string
    });

    it('should pass correct userId and name to Prisma create', async () => {
      const dto: CreatePatDto = { name: 'Named Token', durationValue: 30, durationUnit: 'days' };

      mockPrisma.personalAccessToken.create.mockResolvedValue(mockPatRecord as any);

      await service.createToken(mockUserId, dto);

      expect(mockPrisma.personalAccessToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: mockUserId,
          name: 'Named Token',
          durationValue: 30,
          durationUnit: 'days',
        }),
      });
    });
  });

  // ============================================================================
  // listTokens
  // ============================================================================

  describe('listTokens', () => {
    it('should call findMany with correct userId filter', async () => {
      const mockTokens = [mockPatRecord, { ...mockPatRecord, id: 'pat-id-456', name: 'Other Token' }];

      mockPrisma.personalAccessToken.findMany.mockResolvedValue(mockTokens as any);

      const result = await service.listTokens(mockUserId);

      expect(mockPrisma.personalAccessToken.findMany).toHaveBeenCalledWith({
        where: { userId: mockUserId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          tokenPrefix: true,
          durationValue: true,
          durationUnit: true,
          expiresAt: true,
          lastUsedAt: true,
          createdAt: true,
          revokedAt: true,
        },
      });

      expect(result).toHaveLength(2);
    });

    it('should return empty array when user has no tokens', async () => {
      mockPrisma.personalAccessToken.findMany.mockResolvedValue([]);

      const result = await service.listTokens(mockUserId);

      expect(result).toHaveLength(0);
      expect(result).toEqual([]);
    });

    it('should return tokens ordered by createdAt desc', async () => {
      mockPrisma.personalAccessToken.findMany.mockResolvedValue([mockPatRecord] as any);

      await service.listTokens(mockUserId);

      expect(mockPrisma.personalAccessToken.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        }),
      );
    });
  });

  // ============================================================================
  // revokeToken
  // ============================================================================

  describe('revokeToken', () => {
    it('should set revokedAt on the token', async () => {
      const patId = 'pat-id-123';

      mockPrisma.personalAccessToken.findFirst.mockResolvedValue(mockPatRecord as any);
      mockPrisma.personalAccessToken.update.mockResolvedValue({
        ...mockPatRecord,
        revokedAt: new Date(),
      } as any);

      await service.revokeToken(mockUserId, patId);

      expect(mockPrisma.personalAccessToken.update).toHaveBeenCalledWith({
        where: { id: mockPatRecord.id },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('should find token by id and userId (ownership check)', async () => {
      const patId = 'pat-id-123';

      mockPrisma.personalAccessToken.findFirst.mockResolvedValue(mockPatRecord as any);
      mockPrisma.personalAccessToken.update.mockResolvedValue({
        ...mockPatRecord,
        revokedAt: new Date(),
      } as any);

      await service.revokeToken(mockUserId, patId);

      expect(mockPrisma.personalAccessToken.findFirst).toHaveBeenCalledWith({
        where: { id: patId, userId: mockUserId },
      });
    });

    it('should throw NotFoundException when token not found', async () => {
      mockPrisma.personalAccessToken.findFirst.mockResolvedValue(null);

      await expect(service.revokeToken(mockUserId, 'nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );

      await expect(service.revokeToken(mockUserId, 'nonexistent-id')).rejects.toThrow(
        'Token not found',
      );
    });

    it('should throw NotFoundException when token is already revoked', async () => {
      const revokedPat = {
        ...mockPatRecord,
        revokedAt: new Date(Date.now() - 3600000), // revoked 1 hour ago
      };

      mockPrisma.personalAccessToken.findFirst.mockResolvedValue(revokedPat as any);

      await expect(service.revokeToken(mockUserId, revokedPat.id)).rejects.toThrow(
        NotFoundException,
      );

      await expect(service.revokeToken(mockUserId, revokedPat.id)).rejects.toThrow(
        'Token already revoked',
      );

      // Should not call update
      expect(mockPrisma.personalAccessToken.update).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // validateToken
  // ============================================================================

  describe('validateToken', () => {
    it('should return user for a valid active token', async () => {
      const rawToken = 'pat_' + 'a'.repeat(64);

      const patWithUser = {
        ...mockPatRecord,
        expiresAt: new Date(Date.now() + 86400000), // 1 day in future
        revokedAt: null,
        user: mockUserWithRelations,
      };

      mockPrisma.personalAccessToken.findUnique.mockResolvedValue(patWithUser as any);
      mockPrisma.personalAccessToken.update.mockResolvedValue(patWithUser as any);

      const result = await service.validateToken(rawToken);

      expect(result).not.toBeNull();
      expect(result).toMatchObject({ id: mockUserId, email: 'test@example.com' });
    });

    it('should compute SHA256 hash of token before lookup', async () => {
      const rawToken = 'pat_' + 'b'.repeat(64);
      const expectedHash = createHash('sha256').update(rawToken).digest('hex');

      mockPrisma.personalAccessToken.findUnique.mockResolvedValue(null);

      await service.validateToken(rawToken);

      expect(mockPrisma.personalAccessToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: expectedHash },
        }),
      );
    });

    it('should return null when token does not exist', async () => {
      mockPrisma.personalAccessToken.findUnique.mockResolvedValue(null);

      const result = await service.validateToken('pat_nonexistent_token_hash_here');

      expect(result).toBeNull();
    });

    it('should return null when token is expired', async () => {
      const rawToken = 'pat_' + 'c'.repeat(64);

      const expiredPat = {
        ...mockPatRecord,
        expiresAt: new Date(Date.now() - 86400000), // 1 day in past
        revokedAt: null,
        user: mockUserWithRelations,
      };

      mockPrisma.personalAccessToken.findUnique.mockResolvedValue(expiredPat as any);

      const result = await service.validateToken(rawToken);

      expect(result).toBeNull();
    });

    it('should return null when token is revoked', async () => {
      const rawToken = 'pat_' + 'd'.repeat(64);

      const revokedPat = {
        ...mockPatRecord,
        expiresAt: new Date(Date.now() + 86400000), // 1 day in future
        revokedAt: new Date(Date.now() - 3600000), // revoked 1 hour ago
        user: mockUserWithRelations,
      };

      mockPrisma.personalAccessToken.findUnique.mockResolvedValue(revokedPat as any);

      const result = await service.validateToken(rawToken);

      expect(result).toBeNull();
    });

    it('should return null when user is inactive', async () => {
      const rawToken = 'pat_' + 'e'.repeat(64);

      const patWithInactiveUser = {
        ...mockPatRecord,
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: null,
        user: { ...mockUserWithRelations, isActive: false },
      };

      mockPrisma.personalAccessToken.findUnique.mockResolvedValue(patWithInactiveUser as any);

      const result = await service.validateToken(rawToken);

      expect(result).toBeNull();
    });

    it('should include user relations for RBAC in the findUnique query', async () => {
      const rawToken = 'pat_' + 'f'.repeat(64);

      mockPrisma.personalAccessToken.findUnique.mockResolvedValue(null);

      await service.validateToken(rawToken);

      expect(mockPrisma.personalAccessToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            user: {
              include: {
                userRoles: {
                  include: {
                    role: {
                      include: {
                        rolePermissions: {
                          include: { permission: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      );
    });
  });

  // ============================================================================
  // cleanupExpiredTokens
  // ============================================================================

  describe('cleanupExpiredTokens', () => {
    it('should call deleteMany with correct OR conditions', async () => {
      mockPrisma.personalAccessToken.deleteMany.mockResolvedValue({ count: 3 });

      const result = await service.cleanupExpiredTokens();

      expect(mockPrisma.personalAccessToken.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { expiresAt: { lt: expect.any(Date) } },
            {
              revokedAt: { not: null, lt: expect.any(Date) },
            },
          ],
        },
      });

      expect(result).toBe(3);
    });

    it('should return count of deleted records', async () => {
      mockPrisma.personalAccessToken.deleteMany.mockResolvedValue({ count: 42 });

      const result = await service.cleanupExpiredTokens();

      expect(result).toBe(42);
    });

    it('should return 0 when nothing to clean up', async () => {
      mockPrisma.personalAccessToken.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.cleanupExpiredTokens();

      expect(result).toBe(0);
    });

    it('should use 30 days ago as the threshold for revoked tokens', async () => {
      mockPrisma.personalAccessToken.deleteMany.mockResolvedValue({ count: 0 });

      const before = new Date();
      await service.cleanupExpiredTokens();
      const after = new Date();

      const callArg = (mockPrisma.personalAccessToken.deleteMany as jest.Mock).mock.calls[0][0];
      const revokedThreshold: Date = callArg.where.OR[1].revokedAt.lt;

      // Threshold should be approximately 30 days ago
      const expectedMin = new Date(before);
      expectedMin.setDate(expectedMin.getDate() - 30);
      const expectedMax = new Date(after);
      expectedMax.setDate(expectedMax.getDate() - 30);

      expect(revokedThreshold.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
      expect(revokedThreshold.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
    });
  });
});
