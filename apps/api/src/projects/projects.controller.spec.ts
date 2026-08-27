import { Reflector } from '@nestjs/core';

import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { ProjectsController } from './projects.controller';
import type { ProjectsService } from './projects.service';
import { createProjectSchema, updateProjectSchema } from './dto/project.dto';

/**
 * The gate and the body. Read off handler metadata rather than by booting a
 * guard: `PermissionsGuard` has its own tests, and what regresses here is the
 * DECORATION — a route added later without an `@Auth()`, or with the wrong
 * permission on it.
 */
describe('ProjectsController (#404)', () => {
  const required = (handler: unknown): string[] =>
    new Reflector().get<string[]>(PERMISSIONS_KEY, handler as never) ?? [];

  describe('the gate', () => {
    it.each([
      ['list', ProjectsController.prototype.list],
      ['findOne', ProjectsController.prototype.findOne],
    ])('gates %s on projects:read', (_name, handler) => {
      expect(required(handler)).toEqual([PERMISSIONS.PROJECTS_READ]);
    });

    it.each([
      ['create', ProjectsController.prototype.create],
      ['update', ProjectsController.prototype.update],
      ['remove', ProjectsController.prototype.remove],
      ['assignRepository', ProjectsController.prototype.assignRepository],
      ['unassignRepository', ProjectsController.prototype.unassignRepository],
    ])('gates %s on projects:write', (_name, handler) => {
      expect(required(handler)).toEqual([PERMISSIONS.PROJECTS_WRITE]);
    });

    it('leaves no handler ungated', () => {
      // The one that catches a route added later with no @Auth() at all: an
      // undecorated handler on this controller would be world-readable, and
      // enumerating the prototype is the only check that notices a method
      // nobody remembered to add to the lists above.
      const handlers = Object.getOwnPropertyNames(
        ProjectsController.prototype,
      ).filter((name) => name !== 'constructor');

      expect(handlers.length).toBeGreaterThan(0);
      for (const name of handlers) {
        const handler = (
          ProjectsController.prototype as unknown as Record<string, unknown>
        )[name];
        expect(required(handler)).not.toEqual([]);
      }
    });

    it('reuses the repository registry’s permissions rather than minting new ones', () => {
      // A project is administered by whoever administers the repositories in
      // it. A `project:*` pair would grant nothing new and would have to be
      // seeded and granted separately before anybody could see the screen.
      const all = Object.getOwnPropertyNames(ProjectsController.prototype)
        .filter((name) => name !== 'constructor')
        .flatMap((name) =>
          required(
            (
              ProjectsController.prototype as unknown as Record<string, unknown>
            )[name],
          ),
        );

      expect(new Set(all)).toEqual(
        new Set([PERMISSIONS.PROJECTS_READ, PERMISSIONS.PROJECTS_WRITE]),
      );
    });
  });

  describe('delegation', () => {
    function controller(service: Partial<Record<string, jest.Mock>>) {
      return new ProjectsController(service as unknown as ProjectsService);
    }

    it('passes the two path ids to assignment in project-then-repository order', async () => {
      // Both are uuids, so a transposition typechecks and would silently
      // assign the wrong way round.
      const assignRepository = jest.fn().mockResolvedValue({});
      await controller({ assignRepository }).assignRepository(
        'project-id',
        'repository-id',
      );

      expect(assignRepository).toHaveBeenCalledWith(
        'project-id',
        'repository-id',
      );
    });

    it('passes the two path ids to unassignment in the same order', async () => {
      const unassignRepository = jest.fn().mockResolvedValue({});
      await controller({ unassignRepository }).unassignRepository(
        'project-id',
        'repository-id',
      );

      expect(unassignRepository).toHaveBeenCalledWith(
        'project-id',
        'repository-id',
      );
    });

    it('returns the payload unwrapped, since TransformInterceptor adds the envelope', async () => {
      const payload = { id: 'p', slug: 's' };
      const findById = jest.fn().mockResolvedValue(payload);

      await expect(controller({ findById }).findOne('p')).resolves.toBe(
        payload,
      );
    });
  });

  describe('the body', () => {
    it('accepts a name alone, so the slug is optional', () => {
      expect(createProjectSchema.parse({ name: 'Billing Platform' })).toEqual({
        name: 'Billing Platform',
      });
    });

    it('rejects a slug that is not in the slug alphabet', () => {
      expect(
        createProjectSchema.safeParse({ name: 'Billing', slug: 'Billing_1' })
          .success,
      ).toBe(false);
    });

    it('rejects a PATCH with no recognised field', () => {
      // A misspelled key would otherwise be stripped by zod and answer 200
      // with the row unchanged — success reported for a write that did
      // nothing.
      expect(updateProjectSchema.safeParse({}).success).toBe(false);
      expect(updateProjectSchema.safeParse({ nmae: 'typo' }).success).toBe(
        false,
      );
    });

    it('keeps null and absent apart on the description', () => {
      // Absent leaves it alone; null clears it. Collapsing them would make it
      // impossible to remove a description at all.
      expect(updateProjectSchema.parse({ description: null })).toEqual({
        description: null,
      });
      expect(updateProjectSchema.parse({ name: 'x' })).not.toHaveProperty(
        'description',
      );
    });

    it('has no repositoryCount field a caller could write', () => {
      // It is derived from a count, and accepting one would let a caller
      // state a number the database disagrees with.
      const parsed = createProjectSchema.parse({
        name: 'Billing',
        repositoryCount: 99,
      } as never);
      expect(parsed).not.toHaveProperty('repositoryCount');
    });
  });
});
