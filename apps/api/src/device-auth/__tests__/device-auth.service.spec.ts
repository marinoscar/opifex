import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DeviceAuthService } from '../device-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import { DeviceCodeStatus } from '@prisma/client';

describe('DeviceAuthService', () => {
  let service: DeviceAuthService;
  let mockPrisma: MockPrismaService;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockConfigService: jest.Mocked<ConfigService>;

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    isActive: true,
    userRoles: [
      {
        role: {
          name: 'viewer',
          rolePermissions: [
            { permission: { name: 'user_settings:read' } },
          ],
        },
      },
    ],
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockAuthService = {
      generateFullTokens: jest.fn().mockResolvedValue({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresIn: 900,
      }),
    } as any;
    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'deviceAuth.expiryMinutes': 15,
          'deviceAuth.pollInterval': 5,
          appUrl: 'http://localhost:3535',
        };
        return config[key] ?? defaultValue;
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceAuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<DeviceAuthService>(DeviceAuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generateDeviceCode', () => {
    it('should generate valid device code and user code', async () => {
      mockPrisma.deviceCode.create.mockResolvedValue({
        id: 'device-code-1',
        deviceCode: 'hashed-device-code',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        clientInfo: {},
        scopes: [],
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        userId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.generateDeviceCode();

      expect(result).toHaveProperty('deviceCode');
      expect(result).toHaveProperty('userCode');
      expect(result).toHaveProperty('verificationUri');
      expect(result).toHaveProperty('verificationUriComplete');
      expect(result).toHaveProperty('expiresIn');
      expect(result).toHaveProperty('interval');

      expect(result.deviceCode).toHaveLength(64); // 32 bytes hex = 64 chars
      expect(result.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(result.verificationUri).toBe('http://localhost:3535/activate');
      expect(result.verificationUriComplete).toContain(result.userCode);
      expect(result.expiresIn).toBe(900); // 15 minutes in seconds
      expect(result.interval).toBe(5);
    });

    it('should hash device code before storing', async () => {
      mockPrisma.deviceCode.create.mockResolvedValue({} as any);

      await service.generateDeviceCode();

      expect(mockPrisma.deviceCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deviceCode: expect.any(String),
          userCode: expect.any(String),
          status: DeviceCodeStatus.pending,
        }),
      });

      // Verify the stored device code is hashed (64 chars hex)
      const call = mockPrisma.deviceCode.create.mock.calls[0][0];
      expect(call.data.deviceCode).toHaveLength(64);
    });

    it('should store client info when provided', async () => {
      const clientInfo = {
        deviceName: 'Smart TV',
        userAgent: 'Mozilla/5.0',
        ipAddress: '192.168.1.1',
      };

      mockPrisma.deviceCode.create.mockResolvedValue({} as any);

      await service.generateDeviceCode(clientInfo);

      expect(mockPrisma.deviceCode.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientInfo,
        }),
      });
    });

    it('should create device code with correct expiration', async () => {
      mockPrisma.deviceCode.create.mockResolvedValue({} as any);

      const beforeTime = new Date();
      beforeTime.setMinutes(beforeTime.getMinutes() + 15);

      await service.generateDeviceCode();

      const afterTime = new Date();
      afterTime.setMinutes(afterTime.getMinutes() + 15);

      const call = mockPrisma.deviceCode.create.mock.calls[0][0];
      const expiresAt = call.data.expiresAt;

      expect(new Date(expiresAt).getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });
  });

  describe('pollForToken', () => {
    // Use unique device codes for each test to avoid rate limiting issues
    let testCounter = 0;
    const getUniqueDeviceCode = () => `device-code-${++testCounter}-${Date.now()}`;

    it('should throw authorization_pending when status is pending', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        deviceCode: 'hashed',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        userId: null,
        user: null,
      } as any);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected BadRequestException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.response.error).toBe('authorization_pending');
      }
    });

    it('should throw access_denied when status is denied', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.denied,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected BadRequestException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.response.error).toBe('access_denied');
      }
    });

    it('should throw expired_token when code is expired', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected BadRequestException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.response.error).toBe('expired_token');
      }

      // Should update status to expired
      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'device-code-1' },
        data: { status: DeviceCodeStatus.expired },
      });
    });

    it('should return tokens when status is approved', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.approved,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        userId: 'user-1',
        user: mockUser,
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.pollForToken(deviceCode);

      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        tokenType: 'Bearer',
        expiresIn: 900,
      });

      expect(mockAuthService.generateFullTokens).toHaveBeenCalledWith(
        mockUser,
        expect.objectContaining({
          accessTtlMinutes: expect.any(Number),
          refreshTtlDays: expect.any(Number),
        }),
      );

      // Should mark as expired to prevent reuse
      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'device-code-1' },
        data: { status: DeviceCodeStatus.expired },
      });
    });

    it('should throw invalid_grant when device code not found', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue(null);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected UnauthorizedException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.response.error).toBe('invalid_grant');
      }
    });

    it('should throw invalid_grant when user not found on approved code', async () => {
      const deviceCode = getUniqueDeviceCode();
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.approved,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        userId: 'user-1',
        user: null, // User was deleted
      } as any);

      try {
        await service.pollForToken(deviceCode);
        fail('Expected UnauthorizedException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.response.error).toBe('invalid_grant');
      }
    });

    it('should enforce rate limiting with slow_down error', async () => {
      // This test uses a fixed device code to test rate limiting
      const rateLimitDeviceCode = `rate-limit-test-${Date.now()}`;

      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      // First poll should throw authorization_pending
      try {
        await service.pollForToken(rateLimitDeviceCode);
      } catch (error: any) {
        expect(error.response.error).toBe('authorization_pending');
      }

      // Second immediate poll should throw slow_down
      try {
        await service.pollForToken(rateLimitDeviceCode);
        fail('Expected BadRequestException to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.response.error).toBe('slow_down');
      }
    });
  });

  describe('getActivationInfo', () => {
    it('should return verification URI when no code provided', async () => {
      const result = await service.getActivationInfo();

      expect(result).toEqual({
        verificationUri: 'http://localhost:3535/activate',
      });
    });

    it('should return device info for valid user code', async () => {
      const clientInfo = {
        deviceName: 'Smart TV',
        userAgent: 'Mozilla/5.0',
      };

      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        clientInfo,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      const result = await service.getActivationInfo('abcd-1234');

      expect(result).toEqual({
        verificationUri: 'http://localhost:3535/activate',
        userCode: 'ABCD-1234',
        clientInfo,
        expiresAt: expect.any(String),
      });
    });

    it('should normalize user code (uppercase, no spaces)', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        clientInfo: {},
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      await service.getActivationInfo('abcd-1234');

      expect(mockPrisma.deviceCode.findUnique).toHaveBeenCalledWith({
        where: { userCode: 'ABCD-1234' },
      });
    });

    it('should throw NotFoundException for invalid user code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue(null);

      await expect(
        service.getActivationInfo('INVALID-CODE'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getActivationInfo('INVALID-CODE'),
      ).rejects.toThrow('Invalid user code');
    });

    it('should throw BadRequestException for expired code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() - 1000),
      } as any);

      await expect(service.getActivationInfo('ABCD-1234')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getActivationInfo('ABCD-1234')).rejects.toThrow(
        'This code has expired',
      );
    });

    it('should throw BadRequestException for already processed code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.approved,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      await expect(service.getActivationInfo('ABCD-1234')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getActivationInfo('ABCD-1234')).rejects.toThrow(
        'This code has already been processed',
      );
    });
  });

  describe('authorizeDevice', () => {
    const userId = 'user-1';
    const userCode = 'ABCD-1234';

    it('should approve device successfully', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode,
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.authorizeDevice(userId, userCode, true);

      expect(result).toEqual({
        success: true,
        message: 'Device authorized successfully',
      });

      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'device-code-1' },
        data: {
          status: DeviceCodeStatus.approved,
          userId,
        },
      });
    });

    it('should deny device successfully', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode,
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.authorizeDevice(userId, userCode, false);

      expect(result).toEqual({
        success: true,
        message: 'Device authorization denied',
      });

      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'device-code-1' },
        data: {
          status: DeviceCodeStatus.denied,
          userId: null,
        },
      });
    });

    it('should normalize user code before lookup', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode: 'ABCD-1234',
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      await service.authorizeDevice(userId, 'abcd-1234', true);

      expect(mockPrisma.deviceCode.findUnique).toHaveBeenCalledWith({
        where: { userCode: 'ABCD-1234' },
      });
    });

    it('should throw NotFoundException for invalid user code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue(null);

      await expect(
        service.authorizeDevice(userId, 'INVALID', true),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.authorizeDevice(userId, 'INVALID', true),
      ).rejects.toThrow('Invalid user code');
    });

    it('should throw BadRequestException for expired code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode,
        status: DeviceCodeStatus.pending,
        expiresAt: new Date(Date.now() - 1000),
      } as any);

      await expect(
        service.authorizeDevice(userId, userCode, true),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.authorizeDevice(userId, userCode, true),
      ).rejects.toThrow('This code has expired');
    });

    it('should throw BadRequestException for already processed code', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'device-code-1',
        userCode,
        status: DeviceCodeStatus.approved,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      } as any);

      await expect(
        service.authorizeDevice(userId, userCode, true),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.authorizeDevice(userId, userCode, true),
      ).rejects.toThrow('This code has already been processed');
    });
  });

  describe('getUserDeviceSessions', () => {
    it('should return paginated device sessions', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          userCode: 'ABCD-1234',
          status: DeviceCodeStatus.approved,
          clientInfo: { deviceName: 'Smart TV' },
          createdAt: new Date('2024-01-01'),
          expiresAt: new Date('2024-01-02'),
        },
        {
          id: 'session-2',
          userCode: 'EFGH-5678',
          status: DeviceCodeStatus.approved,
          clientInfo: { deviceName: 'Mobile App' },
          createdAt: new Date('2024-01-03'),
          expiresAt: new Date('2024-01-04'),
        },
      ];

      mockPrisma.deviceCode.findMany.mockResolvedValue(mockSessions as any);
      mockPrisma.deviceCode.count.mockResolvedValue(2);

      const result = await service.getUserDeviceSessions('user-1', 1, 10);

      expect(result).toEqual({
        sessions: [
          {
            id: 'session-1',
            userCode: 'ABCD-1234',
            status: DeviceCodeStatus.approved,
            clientInfo: { deviceName: 'Smart TV' },
            createdAt: expect.any(String),
            expiresAt: expect.any(String),
          },
          {
            id: 'session-2',
            userCode: 'EFGH-5678',
            status: DeviceCodeStatus.approved,
            clientInfo: { deviceName: 'Mobile App' },
            createdAt: expect.any(String),
            expiresAt: expect.any(String),
          },
        ],
        total: 2,
        page: 1,
        limit: 10,
      });

      expect(mockPrisma.deviceCode.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          status: DeviceCodeStatus.approved,
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip: 0,
        take: 10,
      });
    });

    it('should handle pagination correctly', async () => {
      mockPrisma.deviceCode.findMany.mockResolvedValue([]);
      mockPrisma.deviceCode.count.mockResolvedValue(25);

      await service.getUserDeviceSessions('user-1', 3, 10);

      expect(mockPrisma.deviceCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20, // (page 3 - 1) * 10
          take: 10,
        }),
      );
    });

    it('should filter by approved status only', async () => {
      mockPrisma.deviceCode.findMany.mockResolvedValue([]);
      mockPrisma.deviceCode.count.mockResolvedValue(0);

      await service.getUserDeviceSessions('user-1');

      expect(mockPrisma.deviceCode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            status: DeviceCodeStatus.approved,
          },
        }),
      );
    });
  });

  describe('revokeDeviceSession', () => {
    it('should revoke device session successfully', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        status: DeviceCodeStatus.approved,
      } as any);
      mockPrisma.deviceCode.update.mockResolvedValue({} as any);

      const result = await service.revokeDeviceSession('user-1', 'session-1');

      expect(result).toEqual({
        success: true,
        message: 'Device session revoked successfully',
      });

      expect(mockPrisma.deviceCode.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { status: DeviceCodeStatus.denied },
      });
    });

    it('should throw NotFoundException when session not found', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeDeviceSession('user-1', 'non-existent'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.revokeDeviceSession('user-1', 'non-existent'),
      ).rejects.toThrow('Session not found');
    });

    it('should throw NotFoundException when user does not own session', async () => {
      mockPrisma.deviceCode.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'other-user',
        status: DeviceCodeStatus.approved,
      } as any);

      await expect(
        service.revokeDeviceSession('user-1', 'session-1'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.revokeDeviceSession('user-1', 'session-1'),
      ).rejects.toThrow('Session not found');

      // Should not attempt to update
      expect(mockPrisma.deviceCode.update).not.toHaveBeenCalled();
    });
  });

  describe('cleanupExpiredCodes', () => {
    it('should delete expired codes', async () => {
      mockPrisma.deviceCode.deleteMany.mockResolvedValue({ count: 5 } as any);

      const result = await service.cleanupExpiredCodes();

      expect(result).toBe(5);
      expect(mockPrisma.deviceCode.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { expiresAt: { lt: expect.any(Date) } },
            {
              status: DeviceCodeStatus.expired,
              updatedAt: {
                lt: expect.any(Date),
              },
            },
          ],
        },
      });
    });

    it('should return 0 when no codes to cleanup', async () => {
      mockPrisma.deviceCode.deleteMany.mockResolvedValue({ count: 0 } as any);

      const result = await service.cleanupExpiredCodes();

      expect(result).toBe(0);
    });
  });
});
