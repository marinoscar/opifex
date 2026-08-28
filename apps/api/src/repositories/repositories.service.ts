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
import {
  LabelProvisioningService,
  type LabelProvisioningReport,
} from '../github/labels/label-provisioning.service';
import { GitHubReadService } from '../github/read/github-read.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ListRepositoriesQueryDto,
  RegisterRepositoryDto,
  RetireRepositoryDto,
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
    private readonly labels: LabelProvisioningService,
  ) {}

  async list(query: ListRepositoriesQueryDto) {
    const where: Prisma.RepositoryWhereInput = {
      ...(query.observeEnabled !== undefined && {
        observeEnabled: query.observeEnabled,
      }),
      ...(query.dispatchEnabled !== undefined && {
        dispatchEnabled: query.dispatchEnabled,
      }),
      // `none` is the literal the query schema admits alongside a uuid, and
      // it maps to SQL NULL: "in no project" is a real filter, not the absence
      // of one, so it must not fall through to "any project" here.
      ...(query.projectId !== undefined && {
        projectId: query.projectId === 'none' ? null : query.projectId,
      }),
      // Omitting `retired` means BOTH, deliberately: a retired repository is
      // still listed. Hiding it would leave an operator unable to find the
      // thing they just retired in order to un-retire it.
      ...(query.retired !== undefined && {
        retiredAt: query.retired ? { not: null } : null,
      }),
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

    // AFTER the row exists, and never able to undo it. See `provisionLabels`.
    const labelProvisioning = await this.provisionLabels(owner, name);

    return { ...toResponse(repository), labelProvisioning };
  }

  /**
   * Create the factory labels on a freshly registered repository.
   *
   * ## Why this cannot fail the registration
   *
   * `factory:ready` is the whole eligibility signal, and GitHub's label picker
   * only offers labels that EXIST — so a repository registered without the
   * taxonomy cannot be steered at all except by typing the label name by hand,
   * spelled exactly right, with no autocomplete. That is #415: `Knecta` was
   * registered, walked to the top of the ladder, observed every 60 seconds,
   * and had zero factory labels.
   *
   * But provisioning writes, and writing is a different permission from
   * reading. ADR-0001 authenticates with a FINE-GRAINED personal access token,
   * granted one repository at a time and one permission at a time, and a
   * fine-grained token emits no `x-oauth-scopes` header — so whether it can
   * create a label is genuinely unknowable until it is tried. Refusing the
   * registration on that basis would leave the operator with nothing
   * registered, no explanation, and a reachability check that passed.
   *
   * So the registration stands and the failure is REPORTED, in the response,
   * distinctly: `labelProvisioning.status` says `refused` rather than `ok`,
   * and the repair endpoint exists for the moment the permission is granted.
   * A repository that looks registered and cannot be labelled is exactly the
   * "configured is not effective" trap epic #332 exists to stop repeating —
   * and the way out of that trap is to SAY SO, not to refuse.
   *
   * The catch is belt-and-braces on top of a service that already reports
   * rather than throws: a bug in provisioning must not cost a registration
   * either. Null then, which the response schema admits.
   */
  private async provisionLabels(
    owner: string,
    name: string,
  ): Promise<LabelProvisioningReport | null> {
    try {
      const report = await this.labels.provision({ owner, name });
      if (!report.ok) {
        this.logger.warn(
          `${owner}/${name} is registered, but its factory labels are not complete: ${report.detail}`,
        );
      }
      return report;
    } catch (error) {
      this.logger.error(
        `${owner}/${name} is registered, but provisioning its factory labels threw: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }

  /**
   * The label taxonomy on this repository, as an observation with a time.
   *
   * A read: it asks GitHub what is there and writes nothing. `repair` is the
   * write.
   */
  async inspectLabels(id: string): Promise<LabelProvisioningReport> {
    const repository = await this.requireRepository(id);
    return this.labels.inspect({
      owner: repository.owner,
      name: repository.name,
    });
  }

  /**
   * Create the missing labels and update the drifted ones.
   *
   * The recovery path for a repository registered while the token lacked
   * permission — without a de-register and re-register, which would be a
   * destructive way to retry a write. Idempotent: on a repository that is
   * already correct this performs no writes and answers `ok`.
   */
  async repairLabels(id: string): Promise<LabelProvisioningReport> {
    const repository = await this.requireRepository(id);
    return this.labels.provision({
      owner: repository.owner,
      name: repository.name,
    });
  }

  private async requireRepository(id: string): Promise<Repository> {
    const repository = await this.prisma.repository.findUnique({
      where: { id },
    });
    if (!repository) {
      throw new NotFoundException(`Repository ${id} not found`);
    }
    return repository;
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

    // A retired repository is OFF the ladder, and a PATCH must not be able to
    // put one rung back on. Allowing it would leave `retiredAt` set on a
    // repository that is being observed or dispatched to — a row that says two
    // contradictory things, and the invariant every reader of `retiredAt`
    // depends on. Turning a rung ON while retired IS un-retiring, so the
    // remedy is the endpoint that says so and writes the audit row.
    //
    // Everything else about a retired repository stays editable: budget
    // ceiling, timeout, path constraints, project. Those change what a future
    // run would be allowed to do, not whether one can happen.
    if (existing.retiredAt) {
      const rungs = (
        [
          'observeEnabled',
          'mirrorLabelsEnabled',
          'specFeedbackEnabled',
          'dispatchEnabled',
        ] as const
      ).filter((rung) => dto[rung] === true);

      if (rungs.length > 0) {
        throw new BadRequestException(
          `${existing.owner}/${existing.name} is retired, so ${rungs.join(', ')} cannot be enabled. ` +
            'Un-retire it first: POST /api/repositories/:id/unretire.',
        );
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
   * Stand a repository down: the whole ladder off, in one act, recorded.
   *
   * ## Why this exists rather than four PATCHes
   *
   * `DELETE` is refused on any repository with work orders (see `remove`
   * below), so the only removal action available fails on exactly the
   * repositories an operator most wants to tidy — the used ones. Retiring is
   * what the system actually wants: the repository stops being observed and
   * stops being written to, and its runs, work orders and provenance are not
   * touched at all.
   *
   * Composing it client-side out of four PATCHes would make a dropped
   * connection halfway through leave a HALF-retired repository — observation
   * off, dispatch still on — which is the one intermediate state nobody would
   * choose. One request, one transaction.
   *
   * ## Why `retiredAt` is stored and not read off the flags
   *
   * The full argument is on the `Repository` model in schema.prisma. The short
   * form: all four flags off is reachable without anyone deciding anything, so
   * the derived reading cannot tell a stand-down from a pause, and un-retire
   * would have nothing to undo.
   *
   * ## Atomic, including the audit row
   *
   * The update and the `audit_events` row are one transaction, so a retired
   * repository without a record of who retired it is not a reachable state.
   * This is the opposite of the operator-settings write path, which swallows a
   * failed audit write because the change is already in force — here the
   * change is not yet in force, and the safe direction to fail is closed: a
   * repository that stayed on the ladder is the status quo, and the operator
   * gets an error rather than silence.
   *
   * No GitHub call happens in here, deliberately. Retiring enables nothing, so
   * there is nothing to re-verify, and a network round trip inside a
   * transaction would hold a connection open for the length of GitHub's
   * latency.
   */
  async retire(id: string, dto: RetireRepositoryDto, actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.repository.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException(`Repository ${id} not found`);
      }

      // Idempotent, and that is the point of the requirement it serves: an
      // operator whose connection dropped mid-request retries, and the retry
      // must not be a second decision. No second audit row either — one act
      // recorded twice would read as two.
      if (existing.retiredAt) {
        return toResponse(existing);
      }

      const repository = await tx.repository.update({
        where: { id },
        data: {
          // All four, unconditionally. Not "the ones currently on": the caller
          // asked for the repository to be off the ladder, and a conditional
          // write would make the result depend on a read that raced.
          observeEnabled: false,
          mirrorLabelsEnabled: false,
          specFeedbackEnabled: false,
          dispatchEnabled: false,
          retiredAt: new Date(),
          retiredById: actorUserId,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorUserId,
          action: 'repository.retired',
          targetType: 'repository',
          targetId: repository.id,
          meta: {
            repository: `${repository.owner}/${repository.name}`,
            reason: dto.reason ?? null,
            // The rungs it was standing on when it was stood down. Recorded
            // HERE because un-retire deliberately does not restore them, so
            // this row is the only place the previous ladder position
            // survives — and "what was this allowed to do before?" is the
            // question an audit of a retirement is asked.
            //
            // Not redacted: four booleans and an `owner/name`, none of which
            // is a credential. `common/crypto/redact.ts` guards secret VALUES,
            // and there are none in this payload.
            ladderBefore: {
              observeEnabled: existing.observeEnabled,
              mirrorLabelsEnabled: existing.mirrorLabelsEnabled,
              specFeedbackEnabled: existing.specFeedbackEnabled,
              dispatchEnabled: existing.dispatchEnabled,
            },
          } as never,
        },
      });

      this.logger.log(
        `Retired ${repository.owner}/${repository.name} by ${actorUserId}` +
          (dto.reason ? `: ${dto.reason}` : ''),
      );

      return toResponse(repository);
    });
  }

  /**
   * Put a retired repository back on the ladder, at the BOTTOM.
   *
   * Observation on, every outward write off — which is exactly where
   * `register` puts a newly registered repository, and exactly what VISION
   * §12's staged rollout means by the first rung. The bottom of the ladder is
   * observation, not nothing: a repository nobody observes is invisible, and
   * "off the ladder entirely" is the state this is undoing.
   *
   * Emphatically NOT a restore of the rungs it previously held. Retiring is
   * often the response to a repository that was doing something unwanted, and
   * an un-retire that silently switched dispatch back on would re-enable the
   * factory's most consequential permission as a side effect of a button
   * labelled "un-retire". Whoever wants dispatch back can ask for it, and that
   * PATCH re-verifies reachability the way it always has.
   *
   * `retiredById` is cleared with `retiredAt`: who retired it is history, and
   * history lives in `audit_events`. An actor beside a null timestamp would be
   * a state with no meaning.
   */
  async unretire(id: string, dto: RetireRepositoryDto, actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.repository.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException(`Repository ${id} not found`);
      }

      // Idempotent for the same reason as `retire`, and with one extra
      // consequence worth naming: un-retiring a repository that is not retired
      // must NOT reset its ladder. Otherwise a stray call would turn off
      // dispatch on a repository nobody retired.
      if (!existing.retiredAt) {
        return toResponse(existing);
      }

      const repository = await tx.repository.update({
        where: { id },
        data: {
          observeEnabled: true,
          mirrorLabelsEnabled: false,
          specFeedbackEnabled: false,
          dispatchEnabled: false,
          retiredAt: null,
          retiredById: null,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorUserId,
          action: 'repository.unretired',
          targetType: 'repository',
          targetId: repository.id,
          meta: {
            repository: `${repository.owner}/${repository.name}`,
            reason: dto.reason ?? null,
            retiredAt: existing.retiredAt.toISOString(),
            retiredById: existing.retiredById,
            // Stated in the row rather than left to be inferred from the
            // flags, so an auditor reading this event alone knows the
            // repository came back observed and nothing more.
            restoredTo: 'observe',
          } as never,
        },
      });

      this.logger.log(
        `Un-retired ${repository.owner}/${repository.name} by ${actorUserId}; ` +
          'back at the bottom of the ladder (observe only)',
      );

      return toResponse(repository);
    });
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
    retiredAt: repository.retiredAt?.toISOString() ?? null,
    retiredById: repository.retiredById,
    createdAt: repository.createdAt.toISOString(),
    updatedAt: repository.updatedAt.toISOString(),
  };
}
