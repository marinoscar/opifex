import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, Project } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RepositoriesService } from '../repositories/repositories.service';
import type {
  CreateProjectDto,
  ListProjectsQueryDto,
  UpdateProjectDto,
} from './dto/project.dto';
import { deriveProjectSlug } from './slug';

/** A project row plus the count the response carries. */
type ProjectWithCount = Project & {
  _count: { repositories: number };
};

const WITH_COUNT = {
  _count: { select: { repositories: true } },
} as const;

/**
 * Projects: the grouping `schema.prisma` has modelled since the core migration
 * and that nothing could create until #404.
 *
 * ## A project is a grouping, and grouping is ALL it is
 *
 * VISION §11 states Opifex is single-operator by design and that multi-user
 * "is not a deferred feature — it is a different product", which the schema's
 * own comment on `Project` repeats. So a project is not a tenancy boundary, not
 * a permission scope and not a budget owner: it carries no authority, and
 * nothing reads it to decide whether something may run. `projects:read` and
 * `projects:write` gate the endpoints because they are the permissions the
 * repository registry already uses — a project is administered by whoever
 * administers the repositories in it, and inventing a second pair would grant
 * nothing new.
 *
 * ## Unassigned is a first-class state
 *
 * Every repository registered before this module existed has `projectId: null`,
 * and nothing here changes that. There is no "Default" project and no data
 * migration that sweeps anything into one: a grouping the operator never chose
 * is an assertion about their intent that Opifex has no basis for. An
 * unassigned repository is listed, observed, dispatched and walked up the
 * enablement ladder exactly as an assigned one is — the ladder does not read
 * `projectId` at all.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Assignment goes THROUGH the repositories service rather than around it,
    // so a repository moved from a project screen and one moved from
    // `PATCH /api/repositories/:id` take the same code path and come back in
    // the same shape. A second mapper would be a second answer to "what does a
    // repository look like", and the two would drift.
    private readonly repositories: RepositoriesService,
  ) {}

  async list(query: ListProjectsQueryDto) {
    const where: Prisma.ProjectWhereInput = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { slug: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: [{ name: 'asc' }],
        include: WITH_COUNT,
      }),
      this.prisma.project.count({ where }),
    ]);

    return {
      items: items.map(toResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async findById(id: string) {
    return toResponse(await this.requireProject(id));
  }

  /**
   * Create a project.
   *
   * The slug is the caller's when they gave one and derived from the name when
   * they did not — see `slug.ts` for why derivation happens only here and
   * never again. A taken slug is a 409 that NAMES it, including when it was
   * derived, because the operator who never typed `billing-platform` still has
   * to be told that is what collided.
   */
  async create(dto: CreateProjectDto) {
    const supplied = dto.slug !== undefined;
    const slug = dto.slug ?? deriveProjectSlug(dto.name);

    if (slug === '') {
      // Only reachable by derivation: a supplied slug cleared the DTO's
      // pattern before it got here. The remedy is the operator's to choose,
      // so this asks for one rather than manufacturing `project-a3f1`, which
      // would be a handle nobody can remember or guess.
      throw new BadRequestException(
        `No slug could be derived from the name ${JSON.stringify(dto.name)}. Supply a slug explicitly.`,
      );
    }

    let project: ProjectWithCount;
    try {
      project = await this.prisma.project.create({
        data: {
          slug,
          name: dto.name,
          description: dto.description ?? null,
        },
        include: WITH_COUNT,
      });
    } catch (error) {
      // Caught rather than pre-checked with a `findUnique`: a pre-check is a
      // race, and the unique index is the thing that actually decides. The
      // pre-check would still have to be backed by this branch, so it would
      // only buy a nicer message for the non-racing case, which this gives
      // anyway.
      throw this.slugConflict(error, slug, supplied);
    }

    this.logger.log(`Created project ${project.slug} (${project.id})`);
    return toResponse(project);
  }

  async update(id: string, dto: UpdateProjectDto) {
    await this.requireProject(id);

    try {
      const project = await this.prisma.project.update({
        where: { id },
        // Spread only the keys present, so a PATCH that omits a field leaves
        // it alone. Note what is NOT here: changing `name` does not touch
        // `slug`. Re-deriving would move the handle under everything that
        // referenced it, which is the one thing a stable handle is for.
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.slug !== undefined && { slug: dto.slug }),
          ...(dto.description !== undefined && {
            description: dto.description,
          }),
        },
        include: WITH_COUNT,
      });
      return toResponse(project);
    } catch (error) {
      throw this.slugConflict(error, dto.slug ?? '', true);
    }
  }

  /**
   * Delete a project. Its repositories survive, unassigned.
   *
   * ## Why deletion is offered here and refused for repositories
   *
   * `DELETE /api/repositories/:id` is refused once a repository has work
   * orders, because deleting one would cascade to runs and their provenance,
   * and VISION §5's premise is that a hole in the provenance graph is not
   * detectable after the fact. None of that applies to a project: it owns no
   * work orders, no runs and no events. The only thing lost is the grouping
   * itself, and the repositories return to the unassigned state they were all
   * in before this module existed — which #404 establishes as first-class
   * rather than broken. Making a pure label permanent would be a worse answer
   * than making it removable.
   *
   * The non-cascade is the database's, not this method's: the foreign key is
   * `ON DELETE SET NULL` (`schema.prisma`'s `onDelete: SetNull`, emitted as
   * `confdeltype = 'n'`). This method does NOT null the column itself first —
   * doing so would hide a schema regression behind application code, and the
   * point is that the guarantee holds even for a `DELETE` issued by hand.
   * `test/integration/project-delete-non-cascade.integration.spec.ts` proves
   * it against a real Postgres, because a mocked Prisma would report whatever
   * the mock was told to.
   */
  async remove(id: string) {
    const project = await this.requireProject(id);

    await this.prisma.project.delete({ where: { id } });

    this.logger.log(
      `Deleted project ${project.slug} (${project.id}); ` +
        `${project._count.repositories} repositories are now unassigned and remain registered`,
    );

    return {
      id: project.id,
      slug: project.slug,
      unassignedRepositories: project._count.repositories,
    };
  }

  /** Put a repository in this project, moving it out of another if need be. */
  async assignRepository(projectId: string, repositoryId: string) {
    await this.requireProject(projectId);
    return this.repositories.update(repositoryId, { projectId });
  }

  /**
   * Take a repository out of this project.
   *
   * Refuses when the repository is in a DIFFERENT project. As a subresource,
   * `DELETE /projects/{a}/repositories/{r}` asserts that `r` is in `a`; acting
   * on it anyway would let a stale screen quietly unassign a repository from
   * the project somebody else just moved it to.
   */
  async unassignRepository(projectId: string, repositoryId: string) {
    await this.requireProject(projectId);

    const repository = await this.prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { id: true, projectId: true, owner: true, name: true },
    });
    if (!repository) {
      throw new NotFoundException(`Repository ${repositoryId} not found`);
    }
    if (repository.projectId !== projectId) {
      throw new NotFoundException(
        `${repository.owner}/${repository.name} is not in project ${projectId}`,
      );
    }

    return this.repositories.update(repositoryId, { projectId: null });
  }

  private async requireProject(id: string): Promise<ProjectWithCount> {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: WITH_COUNT,
    });
    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }
    return project;
  }

  /**
   * Turn a unique-index violation into a 409 that names the slug, and rethrow
   * anything else untouched — swallowing an unrelated database error as a
   * conflict would tell the operator to change a slug that was never the
   * problem.
   */
  private slugConflict(
    error: unknown,
    slug: string,
    supplied: boolean,
  ): unknown {
    if (!isUniqueViolation(error)) return error;

    return new ConflictException(
      supplied
        ? `A project with the slug "${slug}" already exists`
        : `A project with the slug "${slug}", derived from that name, already exists. ` +
            'Supply a different slug, or a different name.',
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

/** The Prisma row as the API returns it. Dates are ISO strings. */
function toResponse(project: ProjectWithCount) {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    repositoryCount: project._count.repositories,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
