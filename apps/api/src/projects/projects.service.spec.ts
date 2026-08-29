import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { ProjectsService } from './projects.service';

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'billing-platform',
    name: 'Billing Platform',
    description: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-01T10:00:00Z'),
    _count: { repositories: 0 },
    ...overrides,
  };
}

/** What Prisma throws on a unique-index violation. */
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: ['slug'] },
  });
}

describe('ProjectsService (#404)', () => {
  let prisma: {
    project: Record<string, jest.Mock>;
    repository: Record<string, jest.Mock>;
  };
  let repositories: { update: jest.Mock };
  let service: ProjectsService;

  beforeEach(() => {
    prisma = {
      project: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      repository: { findUnique: jest.fn() },
    };
    repositories = { update: jest.fn() };

    service = new ProjectsService(
      prisma as unknown as PrismaService,
      repositories as unknown as RepositoriesService,
    );
  });

  describe('create, and the slug rule', () => {
    beforeEach(() => {
      prisma.project.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => projectRow(data),
      );
    });

    it('derives the slug from the name when none is supplied', async () => {
      const project = await service.create({ name: 'Billing Platform' });
      expect(project.slug).toBe('billing-platform');
    });

    it('uses the supplied slug verbatim, so a handle can be shorter than the name', async () => {
      const project = await service.create({
        name: 'Billing Platform (2026)',
        slug: 'billing',
      });
      expect(project.slug).toBe('billing');
    });

    it('REFUSES a taken slug instead of suffixing it', async () => {
      // The decision #404 asked to be made and argued: a silent `-2` hands
      // back a handle nobody chose, and every later reference to the original
      // slug then resolves to somebody else's project with no signal at all.
      prisma.project.create.mockRejectedValue(uniqueViolation());

      await expect(
        service.create({ name: 'Billing', slug: 'billing' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('names the DERIVED slug in the conflict, since the caller never typed it', async () => {
      prisma.project.create.mockRejectedValue(uniqueViolation());

      await expect(
        service.create({ name: 'Billing Platform' }),
      ).rejects.toThrow(/billing-platform/);
    });

    it('creates exactly once on a collision — no retry with another slug', async () => {
      prisma.project.create.mockRejectedValue(uniqueViolation());

      await expect(service.create({ name: 'Billing' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.project.create).toHaveBeenCalledTimes(1);
    });

    it('rethrows a database error that is NOT a unique violation', async () => {
      // Reporting an unrelated failure as a slug conflict would send the
      // operator to change a slug that was never the problem.
      const boom = Object.assign(new Error('connection reset'), {
        code: 'P1001',
      });
      prisma.project.create.mockRejectedValue(boom);

      await expect(service.create({ name: 'Billing' })).rejects.toBe(boom);
    });

    it('asks for an explicit slug when the name derives to nothing', async () => {
      await expect(service.create({ name: '日本語' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.project.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.project.findUnique.mockResolvedValue(projectRow());
      prisma.project.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => projectRow(data),
      );
    });

    it('does NOT re-derive the slug when the name changes', async () => {
      // The slug is the stable handle. Moving it under everything that
      // referenced the project is exactly what having a handle prevents.
      await service.update(projectRow().id, { name: 'Invoicing Platform' });

      const { data } = prisma.project.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data).not.toHaveProperty('slug');
      expect(data.name).toBe('Invoicing Platform');
    });

    it('changes the slug when one is asked for explicitly', async () => {
      const project = await service.update(projectRow().id, {
        slug: 'invoicing',
      });
      expect(project.slug).toBe('invoicing');
    });

    it('leaves omitted fields alone rather than writing undefined over them', async () => {
      await service.update(projectRow().id, { name: 'Renamed' });

      const { data } = prisma.project.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(Object.keys(data)).toEqual(['name']);
    });

    it('clears the description on an explicit null', async () => {
      const project = await service.update(projectRow().id, {
        description: null,
      });
      expect(project.description).toBeNull();
    });

    it('refuses a slug already taken by another project', async () => {
      prisma.project.update.mockRejectedValue(uniqueViolation());

      await expect(
        service.update(projectRow().id, { slug: 'taken' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s on an unknown project', async () => {
      prisma.project.findUnique.mockResolvedValue(null);

      await expect(
        service.update(projectRow().id, { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes the project and NEVER touches a repository row', async () => {
      // The non-cascade is the foreign key's (`ON DELETE SET NULL`), not this
      // method's. Nulling `projectId` here first would hide a schema
      // regression behind application code, and the guarantee has to hold for
      // a DELETE issued by hand too. The real database proves it in
      // test/integration/project-delete-non-cascade.integration.spec.ts.
      prisma.project.findUnique.mockResolvedValue(
        projectRow({ _count: { repositories: 3 } }),
      );

      await service.remove(projectRow().id);

      expect(prisma.project.delete).toHaveBeenCalledWith({
        where: { id: projectRow().id },
      });
      expect(repositories.update).not.toHaveBeenCalled();
    });

    it('reports how many repositories it left unassigned', async () => {
      prisma.project.findUnique.mockResolvedValue(
        projectRow({ _count: { repositories: 3 } }),
      );

      const result = await service.remove(projectRow().id);

      expect(result).toEqual({
        id: projectRow().id,
        slug: 'billing-platform',
        unassignedRepositories: 3,
      });
    });

    it('is not refused for having contents, unlike deleting a repository', async () => {
      // A repository with work orders refuses deletion because it would
      // cascade to runs and their provenance. A project owns no work orders,
      // no runs and no events, so there is nothing of VISION §5's graph to
      // protect and permanence would only make a mistyped label forever.
      prisma.project.findUnique.mockResolvedValue(
        projectRow({ _count: { repositories: 12 } }),
      );

      await expect(service.remove(projectRow().id)).resolves.toMatchObject({
        unassignedRepositories: 12,
      });
    });

    it('404s on an unknown project', async () => {
      prisma.project.findUnique.mockResolvedValue(null);

      await expect(service.remove(projectRow().id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.project.delete).not.toHaveBeenCalled();
    });
  });

  describe('assignment', () => {
    const repositoryId = '22222222-2222-4222-8222-222222222222';
    const projectId = projectRow().id;

    it('assigns through the repositories service, not by writing projectId here', async () => {
      // One code path for a move from a project screen and a move from
      // `PATCH /api/repositories/:id`, so the two cannot answer in different
      // shapes.
      prisma.project.findUnique.mockResolvedValue(projectRow());
      repositories.update.mockResolvedValue({ id: repositoryId, projectId });

      await service.assignRepository(projectId, repositoryId);

      expect(repositories.update).toHaveBeenCalledWith(repositoryId, {
        projectId,
      });
    });

    it('404s before assigning when the project does not exist', async () => {
      prisma.project.findUnique.mockResolvedValue(null);

      await expect(
        service.assignRepository(projectId, repositoryId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repositories.update).not.toHaveBeenCalled();
    });

    it('unassigns by setting projectId to null, leaving the repository registered', async () => {
      prisma.project.findUnique.mockResolvedValue(projectRow());
      prisma.repository.findUnique.mockResolvedValue({
        id: repositoryId,
        projectId,
        owner: 'acme',
        name: 'app',
      });
      repositories.update.mockResolvedValue({
        id: repositoryId,
        projectId: null,
      });

      const result = await service.unassignRepository(projectId, repositoryId);

      expect(repositories.update).toHaveBeenCalledWith(repositoryId, {
        projectId: null,
      });
      expect(result.projectId).toBeNull();
    });

    it('refuses to unassign a repository that is in a DIFFERENT project', async () => {
      // Otherwise a stale screen could unassign a repository from whichever
      // project it was actually moved to.
      prisma.project.findUnique.mockResolvedValue(projectRow());
      prisma.repository.findUnique.mockResolvedValue({
        id: repositoryId,
        projectId: '99999999-9999-4999-8999-999999999999',
        owner: 'acme',
        name: 'app',
      });

      await expect(
        service.unassignRepository(projectId, repositoryId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repositories.update).not.toHaveBeenCalled();
    });

    it('refuses to unassign a repository that is in no project at all', async () => {
      prisma.project.findUnique.mockResolvedValue(projectRow());
      prisma.repository.findUnique.mockResolvedValue({
        id: repositoryId,
        projectId: null,
        owner: 'acme',
        name: 'app',
      });

      await expect(
        service.unassignRepository(projectId, repositoryId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repositories.update).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    beforeEach(() => {
      prisma.project.findMany.mockResolvedValue([projectRow()]);
      prisma.project.count.mockResolvedValue(1);
    });

    it('carries repositoryCount so a list does not cost a request per row', async () => {
      prisma.project.findMany.mockResolvedValue([
        projectRow({ _count: { repositories: 4 } }),
      ]);

      const result = await service.list({ page: 1, pageSize: 25 } as never);

      expect(result.items[0].repositoryCount).toBe(4);
    });

    it('reports totalPages, which the documented flat list shape requires', async () => {
      prisma.project.count.mockResolvedValue(51);

      const result = await service.list({ page: 1, pageSize: 25 } as never);

      expect(result).toMatchObject({
        total: 51,
        page: 1,
        pageSize: 25,
        totalPages: 3,
      });
    });

    it('searches name and slug together, case-insensitively', async () => {
      await service.list({ page: 1, pageSize: 25, search: 'bill' } as never);

      const { where } = prisma.project.findMany.mock.calls[0][0] as {
        where: { OR: Array<Record<string, unknown>> };
      };
      expect(where.OR).toEqual([
        { name: { contains: 'bill', mode: 'insensitive' } },
        { slug: { contains: 'bill', mode: 'insensitive' } },
      ]);
    });

    it('applies no filter at all when nothing is searched for', async () => {
      await service.list({ page: 1, pageSize: 25 } as never);

      const { where } = prisma.project.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(where).toEqual({});
    });
  });

  describe('findById', () => {
    it('404s on an unknown project rather than returning null', async () => {
      prisma.project.findUnique.mockResolvedValue(null);

      await expect(service.findById(projectRow().id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('serialises dates as ISO strings, which the response schema declares', async () => {
      prisma.project.findUnique.mockResolvedValue(projectRow());

      const project = await service.findById(projectRow().id);

      expect(project.createdAt).toBe('2026-08-01T10:00:00.000Z');
      expect(project.updatedAt).toBe('2026-08-01T10:00:00.000Z');
    });
  });
});
