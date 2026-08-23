import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma, Repository } from '@prisma/client';

import { EtagCacheService } from '../github/etag-cache.service';
import { GitHubAuthError, GitHubNotFoundError } from '../github/github.errors';
import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ListRepositoriesQueryDto,
  RegisterRepositoryDto,
  UpdateRepositoryDto,
} from './dto/repository.dto';

/**
 * Which repositories Opifex watches, and the policy for each.
 *
 * ## Why this is a table and not an environment variable
 *
 * A `WATCHED_REPOS` variable cannot express per-repository configuration —
 * budget ceiling, path constraints, whether dispatch is on — and cannot be
 * changed without a redeploy. The second matters more than it looks: VISION
 * §12's observation week ends per repository, and needing a deploy to enable
 * dispatch for one repository means it will be enabled for all of them at once
 * instead.
 */
@Injectable()
export class RepositoriesService {
  private readonly logger = new Logger(RepositoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubReadService,
    private readonly etags: EtagCacheService,
  ) {}

  async list(query: ListRepositoriesQueryDto) {
    const where: Prisma.RepositoryWhereInput = {
      ...(query.observeEnabled !== undefined && {
        observeEnabled: query.observeEnabled,
      }),
      ...(query.dispatchEnabled !== undefined && {
        dispatchEnabled: query.dispatchEnabled,
      }),
      ...(query.projectId !== undefined && { projectId: query.projectId }),
    };

    const [items, total] = await Promise.all([
      this.prisma.repository.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: [{ owner: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.repository.count({ where }),
    ]);

    return {
      items: items.map(toResponse),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findById(id: string) {
    const repository = await this.prisma.repository.findUnique({
      where: { id },
    });
    if (!repository) {
      throw new NotFoundException(`Repository ${id} not found`);
    }
    return toResponse(repository);
  }

  /**
   * Register a repository, after confirming Opifex can actually reach it.
   *
   * The reachability check is not politeness. A registry entry Opifex cannot
   * read turns every subsequent tick into a 404 against a repository nobody
   * will look at again, spending budget forever to rediscover a typo made
   * once — and the reconciler has no good way to tell that apart from a
   * repository that was deleted yesterday.
   */
  async register(dto: RegisterRepositoryDto) {
    const owner = dto.owner;
    const name = dto.name;

    const existing = await this.prisma.repository.findUnique({
      where: { owner_name: { owner, name } },
    });
    if (existing) {
      throw new ConflictException(`${owner}/${name} is already registered`);
    }

    if (dto.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: dto.projectId },
      });
      if (!project) {
        throw new NotFoundException(`Project ${dto.projectId} not found`);
      }
    }

    const verified = await this.verifyReachable(owner, name);

    const repository = await this.prisma.repository.create({
      data: {
        owner: verified.owner,
        name: verified.name,
        // Taken from GitHub rather than defaulted to `main`: a work order pins
        // a base commit on this branch, and guessing it wrong produces a run
        // that fails at checkout for a reason nothing in the diff explains.
        defaultBranch: verified.defaultBranch,
        projectId: dto.projectId ?? null,
        observeEnabled: dto.observeEnabled ?? true,
        // Never defaulted true, whatever the caller asks for on creation is
        // still their explicit choice — but the absence of a choice means off.
        dispatchEnabled: dto.dispatchEnabled ?? false,
        // Same reasoning as dispatch: absence of a choice means off.
        mirrorLabelsEnabled: dto.mirrorLabelsEnabled ?? false,
        // Off by default, like every other outward write.
        specFeedbackEnabled: dto.specFeedbackEnabled ?? false,
        budgetCeilingUsd: dto.budgetCeilingUsd ?? null,
        wallClockTimeoutMinutes: dto.wallClockTimeoutMinutes ?? null,
        pathConstraints: dto.pathConstraints ?? [],
      },
    });

    this.logger.log(
      `Registered ${owner}/${name} (observe=${repository.observeEnabled}, dispatch=${repository.dispatchEnabled})`,
    );
    return toResponse(repository);
  }

  async update(id: string, dto: UpdateRepositoryDto) {
    const existing = await this.prisma.repository.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Repository ${id} not found`);
    }

    if (dto.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: dto.projectId },
      });
      if (!project) {
        throw new NotFoundException(`Project ${dto.projectId} not found`);
      }
    }

    // Enabling dispatch is the moment a repository stops being observed and
    // starts being written to, so it is re-verified: a token whose access was
    // revoked since registration must not have dispatch turned on against it.
    if (dto.dispatchEnabled === true && !existing.dispatchEnabled) {
      await this.verifyReachable(existing.owner, existing.name);
    }

    const repository = await this.prisma.repository.update({
      where: { id },
      // Spread only the keys actually present, so a PATCH that omits a field
      // leaves it alone instead of writing `undefined` over it.
      data: {
        ...(dto.projectId !== undefined && { projectId: dto.projectId }),
        ...(dto.observeEnabled !== undefined && {
          observeEnabled: dto.observeEnabled,
        }),
        ...(dto.dispatchEnabled !== undefined && {
          dispatchEnabled: dto.dispatchEnabled,
        }),
        ...(dto.mirrorLabelsEnabled !== undefined && {
          mirrorLabelsEnabled: dto.mirrorLabelsEnabled,
        }),
        ...(dto.specFeedbackEnabled !== undefined && {
          specFeedbackEnabled: dto.specFeedbackEnabled,
        }),
        ...(dto.budgetCeilingUsd !== undefined && {
          budgetCeilingUsd: dto.budgetCeilingUsd,
        }),
        ...(dto.wallClockTimeoutMinutes !== undefined && {
          wallClockTimeoutMinutes: dto.wallClockTimeoutMinutes,
        }),
        ...(dto.pathConstraints !== undefined && {
          pathConstraints: dto.pathConstraints,
        }),
      },
    });

    return toResponse(repository);
  }

  /**
   * De-register a repository.
   *
   * Refused while it has work orders. Deleting would cascade them and their
   * runs away, and VISION §5's whole premise is that the provenance chain
   * survives — a run whose work order vanished is a hole in the graph, and
   * holes are not detectable after the fact. Turn observation off instead.
   */
  async remove(id: string): Promise<void> {
    const repository = await this.prisma.repository.findUnique({
      where: { id },
      include: { _count: { select: { workOrders: true } } },
    });
    if (!repository) {
      throw new NotFoundException(`Repository ${id} not found`);
    }

    if (repository._count.workOrders > 0) {
      throw new BadRequestException(
        `${repository.owner}/${repository.name} has ${repository._count.workOrders} work orders and cannot be removed. ` +
          'Set observeEnabled and dispatchEnabled to false instead.',
      );
    }

    await this.prisma.repository.delete({ where: { id } });

    // A cached 200 read under a token that could see this repository must not
    // be replayed after it is de-registered and possibly re-registered under a
    // different one.
    this.etags.invalidateRepository(repository.owner, repository.name);
    this.logger.log(`De-registered ${repository.owner}/${repository.name}`);
  }

  /**
   * The reconciler's target set.
   *
   * Read from here rather than from configuration — that is the point of the
   * table — and ordered oldest-observation-first so a tick that runs out of
   * rate-limit budget has still made progress on the repositories that have
   * waited longest, rather than re-reading the same few every time.
   */
  async listObserved(): Promise<Repository[]> {
    return this.prisma.repository.findMany({
      where: { observeEnabled: true },
      orderBy: [{ lastObservedAt: { sort: 'asc', nulls: 'first' } }],
    });
  }

  private async verifyReachable(owner: string, name: string) {
    try {
      const repository = await this.github.getRepository({ owner, name });

      if (repository.archived) {
        // An archived repository accepts no writes at all, so registering one
        // produces a work order that can never open a pull request.
        throw new BadRequestException(
          `${owner}/${name} is archived and cannot be worked on`,
        );
      }
      return repository;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;

      if (error instanceof GitHubNotFoundError) {
        // GitHub answers 404 for a repository that does not exist AND for a
        // private one the token cannot see, so the message has to name both.
        // Reporting only "not found" sends someone hunting for a typo in a
        // name that is perfectly correct.
        throw new BadRequestException(
          `${owner}/${name} is not reachable: it does not exist, or the configured GitHub token cannot see it`,
        );
      }
      if (error instanceof GitHubAuthError) {
        throw new ServiceUnavailableException(
          `Cannot verify ${owner}/${name}: the GitHub credential is missing, expired or lacks access. ${error.message}`,
        );
      }
      throw error;
    }
  }
}

/**
 * The Prisma row as the API returns it.
 *
 * `budgetCeilingUsd` is stringified rather than converted: it is a Postgres
 * DECIMAL, and a JS number would round a spend ceiling. Dates are ISO strings
 * because that is what the response schema declares and what the cockpit
 * parses.
 */
function toResponse(repository: Repository) {
  return {
    id: repository.id,
    projectId: repository.projectId,
    owner: repository.owner,
    name: repository.name,
    fullName: `${repository.owner}/${repository.name}`,
    defaultBranch: repository.defaultBranch,
    observeEnabled: repository.observeEnabled,
    dispatchEnabled: repository.dispatchEnabled,
    mirrorLabelsEnabled: repository.mirrorLabelsEnabled,
    specFeedbackEnabled: repository.specFeedbackEnabled,
    budgetCeilingUsd: repository.budgetCeilingUsd?.toString() ?? null,
    wallClockTimeoutMinutes: repository.wallClockTimeoutMinutes,
    pathConstraints: repository.pathConstraints,
    lastObservedAt: repository.lastObservedAt?.toISOString() ?? null,
    createdAt: repository.createdAt.toISOString(),
    updatedAt: repository.updatedAt.toISOString(),
  };
}
