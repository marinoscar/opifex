import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { AllowlistService } from './allowlist.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { AddEmailDto } from './dto/add-email.dto';
import { AllowlistQueryDto } from './dto/allowlist-query.dto';

describe('AllowlistService', () => {
  let service: AllowlistService;
  let mockPrisma: MockPrismaService;

  const mockAddedBy = {
    id: 'admin-id',
    email: 'admin@example.com',
  };

  const mockClaimedBy = {
    id: 'user-id',
    email: 'user@example.com',
  };

  const mockPendingEntry = {
    id: 'entry-1',
    email: 'pending@example.com',
    notes: 'Test note',
    addedById: mockAddedBy.id,
    addedAt: new Date('2024-01-15T10:00:00Z'),
    claimedById: null,
    claimedAt: null,
    addedBy: mockAddedBy,
    claimedBy: null,
  };

  const mockClaimedEntry = {
    id: 'entry-2',
    email: 'claimed@example.com',
    notes: null,
    addedById: mockAddedBy.id,
    addedAt: new Date('2024-01-15T10:00:00Z'),
    claimedById: mockClaimedBy.id,
    claimedAt: new Date('2024-01-16T10:00:00Z'),
    addedBy: mockAddedBy,
    claimedBy: mockClaimedBy,
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AllowlistService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AllowlistService>(AllowlistService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('listAllowedEmails', () => {
    it('should return paginated results', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'all',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockPendingEntry,
        mockClaimedEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(2);

      const result = await service.listAllowedEmails(query);

      expect(result).toEqual({
        items: [mockPendingEntry, mockClaimedEntry],
        total: 2,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      });

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 10,
        orderBy: { addedAt: 'desc' },
        include: {
          addedBy: {
            select: {
              id: true,
              email: true,
            },
          },
          claimedBy: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      });
    });

    it('should filter by status (pending)', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'pending',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockPendingEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(1);

      await service.listAllowedEmails(query);

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { claimedById: null },
        }),
      );
    });

    it('should filter by status (claimed)', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'claimed',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockClaimedEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(1);

      await service.listAllowedEmails(query);

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { claimedById: { not: null } },
        }),
      );
    });

    it('should search by email', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'all',
        search: 'pending',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockPendingEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(1);

      await service.listAllowedEmails(query);

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { contains: 'pending', mode: 'insensitive' } },
        }),
      );
    });

    it('should sort by email ascending', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'email',
        sortOrder: 'asc',
        status: 'all',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockClaimedEntry,
        mockPendingEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(2);

      await service.listAllowedEmails(query);

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { email: 'asc' },
        }),
      );
    });

    it('should calculate pagination correctly', async () => {
      const query: AllowlistQueryDto = {
        page: 3,
        pageSize: 5,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'all',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([]);
      mockPrisma.allowedEmail.count.mockResolvedValue(23);

      const result = await service.listAllowedEmails(query);

      expect(result.totalPages).toBe(5); // 23 / 5 = 5 pages
      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10, // (3 - 1) * 5
          take: 5,
        }),
      );
    });
  });

  describe('addEmail', () => {
    it('should create new entry with normalized lowercase email', async () => {
      const dto: AddEmailDto = {
        email: 'NewUser@Example.COM',
        notes: 'Test note',
      };

      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);
      mockPrisma.allowedEmail.create.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.addEmail(dto, mockAddedBy.id);

      expect(mockPrisma.allowedEmail.findUnique).toHaveBeenCalledWith({
        where: { email: 'newuser@example.com' },
      });

      expect(mockPrisma.allowedEmail.create).toHaveBeenCalledWith({
        data: {
          email: 'newuser@example.com',
          notes: 'Test note',
          addedById: mockAddedBy.id,
        },
        include: {
          addedBy: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      });

      expect(result).toEqual(mockPendingEntry);
    });

    it('should create audit event', async () => {
      const dto: AddEmailDto = {
        email: 'test@example.com',
      };

      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);
      mockPrisma.allowedEmail.create.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.addEmail(dto, mockAddedBy.id);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockAddedBy.id,
          action: 'allowlist:add',
          targetType: 'allowed_email',
          targetId: mockPendingEntry.id,
          meta: { email: 'test@example.com' },
        },
      });
    });

    it('should throw ConflictException if email already exists', async () => {
      const dto: AddEmailDto = {
        email: 'pending@example.com',
      };

      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );

      await expect(service.addEmail(dto, mockAddedBy.id)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.addEmail(dto, mockAddedBy.id)).rejects.toThrow(
        'Email pending@example.com is already in the allowlist',
      );

      expect(mockPrisma.allowedEmail.create).not.toHaveBeenCalled();
    });

    it('should handle notes as undefined if not provided', async () => {
      const dto: AddEmailDto = {
        email: 'test@example.com',
      };

      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);
      mockPrisma.allowedEmail.create.mockResolvedValue({
        ...mockPendingEntry,
        notes: null,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.addEmail(dto, mockAddedBy.id);

      expect(mockPrisma.allowedEmail.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'test@example.com',
            notes: undefined,
            addedById: mockAddedBy.id,
          }),
        }),
      );
    });

    it('should normalize email to lowercase', async () => {
      const dto: AddEmailDto = {
        email: 'MixedCase@Example.COM',
      };

      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);
      mockPrisma.allowedEmail.create.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.addEmail(dto, mockAddedBy.id);

      expect(mockPrisma.allowedEmail.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'mixedcase@example.com',
          }),
        }),
      );
    });

    it('should throw ConflictException for duplicate email (case-insensitive)', async () => {
      const dto: AddEmailDto = {
        email: 'PENDING@EXAMPLE.COM',
      };

      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );

      await expect(service.addEmail(dto, mockAddedBy.id)).rejects.toThrow(
        ConflictException,
      );

      expect(mockPrisma.allowedEmail.findUnique).toHaveBeenCalledWith({
        where: { email: 'pending@example.com' },
      });
    });

    it('should create entry with pending status', async () => {
      const dto: AddEmailDto = {
        email: 'newpending@example.com',
      };

      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);
      const createdEntry = {
        ...mockPendingEntry,
        email: 'newpending@example.com',
        claimedById: null,
        claimedAt: null,
      };
      mockPrisma.allowedEmail.create.mockResolvedValue(createdEntry as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.addEmail(dto, mockAddedBy.id);

      expect(result.claimedById).toBeNull();
      expect(result.claimedAt).toBeNull();
    });
  });

  describe('removeEmail', () => {
    it('should remove entry successfully', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.allowedEmail.delete.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.removeEmail(mockPendingEntry.id, mockAddedBy.id);

      expect(mockPrisma.allowedEmail.delete).toHaveBeenCalledWith({
        where: { id: mockPendingEntry.id },
      });
    });

    it('should create audit event on removal', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.allowedEmail.delete.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.removeEmail(mockPendingEntry.id, mockAddedBy.id);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockAddedBy.id,
          action: 'allowlist:remove',
          targetType: 'allowed_email',
          targetId: mockPendingEntry.id,
          meta: { email: mockPendingEntry.email },
        },
      });
    });

    it('should throw NotFoundException if entry not found', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);

      await expect(
        service.removeEmail('non-existent-id', mockAddedBy.id),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.removeEmail('non-existent-id', mockAddedBy.id),
      ).rejects.toThrow('Allowlist entry with ID non-existent-id not found');

      expect(mockPrisma.allowedEmail.delete).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if entry is claimed', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockClaimedEntry as any,
      );

      await expect(
        service.removeEmail(mockClaimedEntry.id, mockAddedBy.id),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.removeEmail(mockClaimedEntry.id, mockAddedBy.id),
      ).rejects.toThrow(
        'Cannot remove allowlist entry that has been claimed by a user',
      );

      expect(mockPrisma.allowedEmail.delete).not.toHaveBeenCalled();
    });
  });

  describe('isEmailAllowed', () => {
    it('should return true if email exists (case-insensitive)', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );

      const result = await service.isEmailAllowed('PENDING@EXAMPLE.COM');

      expect(result).toBe(true);
      expect(mockPrisma.allowedEmail.findUnique).toHaveBeenCalledWith({
        where: { email: 'pending@example.com' },
      });
    });

    it('should return false if email does not exist', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);

      const result = await service.isEmailAllowed('notfound@example.com');

      expect(result).toBe(false);
    });

    it('should normalize email to lowercase', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);

      await service.isEmailAllowed('Test@Example.COM');

      expect(mockPrisma.allowedEmail.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
      });
    });

    it('should return true for allowlisted email (pending status)', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );

      const result = await service.isEmailAllowed('pending@example.com');

      expect(result).toBe(true);
    });

    it('should return true for allowlisted email (claimed status)', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockClaimedEntry as any,
      );

      const result = await service.isEmailAllowed('claimed@example.com');

      expect(result).toBe(true);
    });

    it('should be case-insensitive (EMAIL@test.com matches email@test.com)', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );

      const result = await service.isEmailAllowed('PENDING@EXAMPLE.COM');

      expect(result).toBe(true);
      expect(mockPrisma.allowedEmail.findUnique).toHaveBeenCalledWith({
        where: { email: 'pending@example.com' },
      });
    });

    it('should handle mixed case email normalization', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );

      const result = await service.isEmailAllowed('PeNdInG@ExAmPlE.CoM');

      expect(result).toBe(true);
      expect(mockPrisma.allowedEmail.findUnique).toHaveBeenCalledWith({
        where: { email: 'pending@example.com' },
      });
    });
  });

  describe('markEmailClaimed', () => {
    it('should update entry with userId and timestamp', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.allowedEmail.update.mockResolvedValue({
        ...mockPendingEntry,
        claimedById: mockClaimedBy.id,
        claimedAt: new Date(),
      } as any);

      await service.markEmailClaimed(
        mockPendingEntry.email,
        mockClaimedBy.id,
      );

      expect(mockPrisma.allowedEmail.update).toHaveBeenCalledWith({
        where: { id: mockPendingEntry.id },
        data: {
          claimedById: mockClaimedBy.id,
          claimedAt: expect.any(Date),
        },
      });
    });

    it('should be idempotent (do nothing if already claimed)', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockClaimedEntry as any,
      );

      await service.markEmailClaimed(
        mockClaimedEntry.email,
        mockClaimedBy.id,
      );

      expect(mockPrisma.allowedEmail.update).not.toHaveBeenCalled();
    });

    it('should not error if email not in allowlist', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);

      await expect(
        service.markEmailClaimed('notfound@example.com', mockClaimedBy.id),
      ).resolves.not.toThrow();

      expect(mockPrisma.allowedEmail.update).not.toHaveBeenCalled();
    });

    it('should normalize email to lowercase', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.allowedEmail.update.mockResolvedValue({
        ...mockPendingEntry,
        claimedById: mockClaimedBy.id,
      } as any);

      await service.markEmailClaimed('PENDING@EXAMPLE.COM', mockClaimedBy.id);

      expect(mockPrisma.allowedEmail.findUnique).toHaveBeenCalledWith({
        where: { email: 'pending@example.com' },
      });
    });

    it('should update status from pending to claimed', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.allowedEmail.update.mockResolvedValue({
        ...mockPendingEntry,
        claimedById: mockClaimedBy.id,
        claimedAt: new Date(),
      } as any);

      await service.markEmailClaimed(
        mockPendingEntry.email,
        mockClaimedBy.id,
      );

      expect(mockPrisma.allowedEmail.update).toHaveBeenCalledWith({
        where: { id: mockPendingEntry.id },
        data: {
          claimedById: mockClaimedBy.id,
          claimedAt: expect.any(Date),
        },
      });
    });

    it('should link userId to the entry', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.allowedEmail.update.mockResolvedValue({
        ...mockPendingEntry,
        claimedById: mockClaimedBy.id,
        claimedAt: new Date(),
      } as any);

      await service.markEmailClaimed(
        mockPendingEntry.email,
        mockClaimedBy.id,
      );

      expect(mockPrisma.allowedEmail.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            claimedById: mockClaimedBy.id,
          }),
        }),
      );
    });
  });

  describe('removeEmail', () => {
    it('should remove entry successfully', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.allowedEmail.delete.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.removeEmail(mockPendingEntry.id, mockAddedBy.id);

      expect(mockPrisma.allowedEmail.delete).toHaveBeenCalledWith({
        where: { id: mockPendingEntry.id },
      });
    });

    it('should create audit event on removal', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.allowedEmail.delete.mockResolvedValue(
        mockPendingEntry as any,
      );
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.removeEmail(mockPendingEntry.id, mockAddedBy.id);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: mockAddedBy.id,
          action: 'allowlist:remove',
          targetType: 'allowed_email',
          targetId: mockPendingEntry.id,
          meta: { email: mockPendingEntry.email },
        },
      });
    });

    it('should throw NotFoundException if entry not found', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(null);

      await expect(
        service.removeEmail('non-existent-id', mockAddedBy.id),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.removeEmail('non-existent-id', mockAddedBy.id),
      ).rejects.toThrow('Allowlist entry with ID non-existent-id not found');

      expect(mockPrisma.allowedEmail.delete).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if entry is claimed', async () => {
      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        mockClaimedEntry as any,
      );

      await expect(
        service.removeEmail(mockClaimedEntry.id, mockAddedBy.id),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.removeEmail(mockClaimedEntry.id, mockAddedBy.id),
      ).rejects.toThrow(
        'Cannot remove allowlist entry that has been claimed by a user',
      );

      expect(mockPrisma.allowedEmail.delete).not.toHaveBeenCalled();
    });

    it('should succeed for pending entries', async () => {
      const pendingEntry = {
        ...mockPendingEntry,
        claimedById: null,
        claimedAt: null,
      };

      mockPrisma.allowedEmail.findUnique.mockResolvedValue(
        pendingEntry as any,
      );
      mockPrisma.allowedEmail.delete.mockResolvedValue(
        pendingEntry as any,
      );
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await expect(
        service.removeEmail(pendingEntry.id, mockAddedBy.id),
      ).resolves.not.toThrow();

      expect(mockPrisma.allowedEmail.delete).toHaveBeenCalled();
    });
  });

  describe('listAllowedEmails', () => {
    it('should return paginated results', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'all',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockPendingEntry,
        mockClaimedEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(2);

      const result = await service.listAllowedEmails(query);

      expect(result).toEqual({
        items: [mockPendingEntry, mockClaimedEntry],
        total: 2,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      });

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 10,
        orderBy: { addedAt: 'desc' },
        include: {
          addedBy: {
            select: {
              id: true,
              email: true,
            },
          },
          claimedBy: {
            select: {
              id: true,
              email: true,
            },
          },
        },
      });
    });

    it('should filter by status (pending)', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'pending',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockPendingEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(1);

      await service.listAllowedEmails(query);

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { claimedById: null },
        }),
      );
    });

    it('should filter by status (claimed)', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'claimed',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockClaimedEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(1);

      await service.listAllowedEmails(query);

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { claimedById: { not: null } },
        }),
      );
    });

    it('should search by email', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'all',
        search: 'pending',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockPendingEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(1);

      await service.listAllowedEmails(query);

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { contains: 'pending', mode: 'insensitive' } },
        }),
      );
    });

    it('should sort by email ascending', async () => {
      const query: AllowlistQueryDto = {
        page: 1,
        pageSize: 10,
        sortBy: 'email',
        sortOrder: 'asc',
        status: 'all',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([
        mockClaimedEntry,
        mockPendingEntry,
      ] as any);
      mockPrisma.allowedEmail.count.mockResolvedValue(2);

      await service.listAllowedEmails(query);

      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { email: 'asc' },
        }),
      );
    });

    it('should calculate pagination correctly', async () => {
      const query: AllowlistQueryDto = {
        page: 3,
        pageSize: 5,
        sortBy: 'addedAt',
        sortOrder: 'desc',
        status: 'all',
      };

      mockPrisma.allowedEmail.findMany.mockResolvedValue([]);
      mockPrisma.allowedEmail.count.mockResolvedValue(23);

      const result = await service.listAllowedEmails(query);

      expect(result.totalPages).toBe(5); // 23 / 5 = 5 pages
      expect(mockPrisma.allowedEmail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10, // (3 - 1) * 5
          take: 5,
        }),
      );
    });
  });
});
