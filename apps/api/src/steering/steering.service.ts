import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { GitHubNotFoundError } from '../github/github.errors';
import { INPUT_LABELS } from '../github/labels/factory-labels';
import { EpicChildrenService } from '../github/read/epic-children.service';
import {
  GitHubReadService,
  type RepositoryRef,
} from '../github/read/github-read.service';
import { issueRef } from '../github/read/epic-children.types';
import { GitHubWriteService } from '../github/write/github-write.service';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorSettingsService } from '../settings/operator-settings/operator-settings.service';
import {
  modelReadiness,
  resolveModelConfig,
} from '../supervisor/invocation/supervisor-model.config';
import { assessChatSpend } from './chat-spend-gate';
import {
  PROPOSAL_TTL_MINUTES,
  type ApplySteeringDto,
  type ProposeSteeringDto,
  type SteerableLabel,
  type SteeringApplyResult,
  type SteeringOperation,
  type SteeringProposal,
  type UnresolvedReference,
} from './dto/steering.dto';
import {
  parseSteeringInstruction,
  type ParsedInstruction,
  type ParsedTarget,
} from './steering-instruction.parser';

/** An issue the instruction resolved to, with its state at propose time. */
interface ScopedIssue {
  ref: string;
  owner: string;
  name: string;
  number: number;
  title: string | null;
  inputLabels: string[];
}

/**
 * An operator instruction, turned into a PROPOSED diff of label operations
 * (#425, epic #419).
 *
 * ## The architectural commitment, stated once
 *
 * The chat is a TRANSLATOR, not a controller. An instruction becomes GitHub
 * labels and nothing else: there is no scope table, no priority column, and no
 * stored proposal. That is not tidiness — a `scope` table the dispatcher
 * consulted would make labels and that table two expressions of the same
 * intent, and the reconciler would be left to arbitrate between them the first
 * time they disagreed. Epic #332 spent twenty-one issues removing exactly that
 * shape, and VISION §3.3's rule against depending on values the system wrote
 * itself is the general form of it.
 *
 * The one thing this service persists is an `audit_events` row on APPLY, which
 * records what a human instructed and what was done about it. That is a
 * record of an action, not a state anything consults: nothing reads it back,
 * and the factory behaves identically if every row is deleted.
 * `steering.service.spec.ts` asserts the whole of that over a Prisma proxy
 * that fails on any other write.
 *
 * ## Propose, then apply, and nothing in between
 *
 * `propose` performs no writes at all. `apply` takes the proposal BACK from
 * the client — because there is nowhere to have kept it — re-checks the labels
 * it was built against, and writes. VISION §3.6: no model output takes effect
 * without passing through deterministic policy, and here the policy is a human
 * confirming a concrete list of label operations.
 *
 * ## The model is not in this class
 *
 * There is no `SupervisorModel` in the constructor, and that absence is the
 * acceptance criterion "an instruction naming explicit issue numbers is
 * resolved without invoking a model at all" made structural rather than
 * promised. `parseSteeringInstruction` answers first; when it cannot, the
 * response says so and says why no model was asked
 * (`chat-spend-gate.ts`) and whether one could have answered
 * (`modelReadiness`, #423).
 */
@Injectable()
export class SteeringService {
  private readonly logger = new Logger(SteeringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly read: GitHubReadService,
    private readonly epics: EpicChildrenService,
    private readonly writes: GitHubWriteService,
    private readonly settings: OperatorSettingsService,
  ) {}

  // -------------------------------------------------------------------------
  // Propose
  // -------------------------------------------------------------------------

  async propose(dto: ProposeSteeringDto): Promise<SteeringProposal> {
    const parsed = parseSteeringInstruction(dto.instruction);
    const registered = await this.registeredRepositories();
    const requested = dto.repository
      ? this.requireRegistered(dto.repository, registered)
      : null;

    const unresolved: UnresolvedReference[] = [];
    const scoped = new Map<string, ScopedIssue>();
    const epicsResolved: SteeringProposal['scope']['epics'] = [];

    if (!parsed.confident) {
      unresolved.push({
        reference: dto.instruction,
        reason: 'needs-interpretation',
        detail:
          parsed.ambiguity ??
          'The instruction could not be read without interpretation.',
      });
    }

    for (const target of parsed.targets) {
      const repo = this.repositoryFor(target, requested, registered);
      if ('unresolved' in repo) {
        unresolved.push(repo.unresolved);
        continue;
      }

      if (target.kind === 'epic') {
        await this.resolveEpic(
          repo.repo,
          target,
          dto.maxDepth,
          scoped,
          unresolved,
          epicsResolved,
        );
      } else {
        await this.resolveIssue(repo.repo, target, scoped, unresolved);
      }
    }

    const operations: SteeringOperation[] = [];

    for (const issue of scoped.values()) {
      operations.push(this.namedOperation(issue, parsed));
    }

    // The "everything else" sweep, and the only place a proposal touches an
    // issue nobody named.
    const sweepRepos = requested !== null ? [requested] : registered.map(toRef);
    let candidatesConsidered = 0;

    if (parsed.exclusive && parsed.intent === 'ready') {
      for (const repo of sweepRepos) {
        // Asked for BY LABEL rather than swept and filtered: the blast radius
        // of "everything else" is exactly the set of issues the factory would
        // otherwise act on, and an open issue with no `factory:ready` is not
        // one of them. It also keeps the request count to one page per
        // repository instead of one per issue.
        const { issues } = await this.read.listIssues(repo, {
          state: 'open',
          labels: [INPUT_LABELS.READY],
        });
        candidatesConsidered += issues.length;

        for (const issue of issues) {
          const ref = issueRef(repo.owner, repo.name, issue.number);
          if (scoped.has(ref)) continue;

          const holds = issue.inputLabels.includes(INPUT_LABELS.HOLD);
          const add: SteerableLabel[] =
            parsed.elseIntent === 'hold' && !holds ? [INPUT_LABELS.HOLD] : [];

          operations.push({
            ref,
            owner: repo.owner,
            name: repo.name,
            number: issue.number,
            title: issue.title,
            add,
            remove: [INPUT_LABELS.READY],
            observedInputLabels: [...issue.inputLabels],
            reason:
              parsed.elseIntent === 'hold'
                ? 'Not named by the instruction, which asked to hold everything else.'
                : 'Not named by the instruction, which restricted work to the issues it named.',
            named: false,
          });
        }
      }
    }

    const proposedAt = new Date();
    const proposal: SteeringProposal = {
      proposalId: randomUUID(),
      proposedAt: proposedAt.toISOString(),
      expiresAt: new Date(
        proposedAt.getTime() + PROPOSAL_TTL_MINUTES * 60_000,
      ).toISOString(),
      instruction: dto.instruction,
      interpretation: this.describeInterpretation(parsed),
      scope: {
        intent: parsed.intent,
        exclusive: parsed.exclusive,
        elseIntent: parsed.elseIntent,
        repositories: sweepRepos.map((repo) => `${repo.owner}/${repo.name}`),
        candidatesConsidered,
        epics: epicsResolved,
      },
      operations,
      blastRadius: blastRadius(operations),
      unresolved,
    };

    this.logger.log(
      `Proposal ${proposal.proposalId}: ${proposal.blastRadius.summary}`,
    );

    return proposal;
  }

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------

  /**
   * Carry out a proposal the operator has confirmed.
   *
   * ## Why it re-reads every issue
   *
   * #425 asks whether apply should re-check or apply blind, and re-checking is
   * both right and cheap: one conditional GET per operation, against an
   * ETag cache, versus writing a label diff the operator confirmed against a
   * picture of the world that has since changed. The alternative is worse than
   * it sounds — the destructive half of a steering proposal removes
   * `factory:ready` from issues the operator did NOT name, so a stale apply
   * silently reverses a decision somebody made in the meantime.
   *
   * ## Drift skips one operation, never the batch
   *
   * A drifted issue is one the operator has not seen, so it is left alone and
   * reported. Aborting the whole apply would let one unrelated edit discard
   * nineteen correct operations, and the operator's only recourse would be to
   * re-propose and race again.
   */
  async apply(
    dto: ApplySteeringDto,
    actorUserId: string,
  ): Promise<SteeringApplyResult> {
    const proposedAt = new Date(dto.proposedAt);
    const ageMinutes = (Date.now() - proposedAt.getTime()) / 60_000;

    if (!Number.isFinite(ageMinutes)) {
      throw new BadRequestException('proposedAt is not a valid instant');
    }

    if (ageMinutes > PROPOSAL_TTL_MINUTES) {
      // A time bound on top of the per-issue drift check, not instead of it:
      // drift catches the labels that moved, and this catches a proposal
      // replayed long after the backlog it described stopped resembling the
      // one in front of the operator. Re-proposing costs nothing.
      throw new ConflictException(
        `This proposal was made ${Math.round(ageMinutes)} minutes ago and ` +
          `proposals expire after ${PROPOSAL_TTL_MINUTES}. Ask for a new one — ` +
          `nothing has been written.`,
      );
    }

    const registered = await this.registeredRepositories();
    const applied: SteeringApplyResult['applied'] = [];
    const skipped: SteeringApplyResult['skipped'] = [];

    for (const operation of dto.operations) {
      const repo = { owner: operation.owner, name: operation.name };
      const ref = issueRef(repo.owner, repo.name, operation.number);

      if (!isRegistered(repo, registered)) {
        skipped.push({
          ref,
          reason: 'repository-not-registered',
          detail: `${repo.owner}/${repo.name} is not a repository Opifex observes.`,
          drift: [],
        });
        continue;
      }

      let issue;
      try {
        issue = await this.read.getIssue(repo, operation.number);
      } catch (error) {
        if (!(error instanceof GitHubNotFoundError)) throw error;
        skipped.push({
          ref,
          reason: 'issue-not-found',
          detail: `${ref} could not be read: ${error.message}`,
          drift: [],
        });
        continue;
      }

      if (issue.isPullRequest) {
        skipped.push({
          ref,
          reason: 'is-pull-request',
          detail: `${ref} is a pull request, not an issue.`,
          drift: [],
        });
        continue;
      }

      if (issue.state !== 'open') {
        skipped.push({
          ref,
          reason: 'issue-closed',
          detail: `${ref} has been closed since the proposal was made.`,
          drift: [],
        });
        continue;
      }

      const drift = driftBetween(
        operation.observedInputLabels,
        issue.inputLabels,
      );
      if (drift.length > 0) {
        skipped.push({
          ref,
          reason: 'drift',
          detail:
            `The factory labels on ${ref} changed after the proposal was made, so ` +
            `this operation was not applied. Ask for a new proposal to see the ` +
            `current picture.`,
          drift,
        });
        continue;
      }

      const writes: SteeringApplyResult['applied'][number]['writes'] = [];

      for (const label of operation.add) {
        const result = await this.writes.addLabel(
          repo,
          operation.number,
          label,
        );
        writes.push({
          label,
          operation: 'add',
          performed: result.performed,
          noop: result.noop,
        });
      }

      for (const label of operation.remove) {
        const result = await this.writes.removeLabel(
          repo,
          operation.number,
          label,
        );
        writes.push({
          label,
          operation: 'remove',
          performed: result.performed,
          noop: result.noop,
        });
      }

      applied.push({
        ref,
        add: [...operation.add],
        remove: [...operation.remove],
        writes,
      });
    }

    const labelWrites = applied.reduce(
      (total, entry) => total + entry.writes.length,
      0,
    );
    const labelWritesPerformed = applied.reduce(
      (total, entry) =>
        total + entry.writes.filter((write) => write.performed).length,
      0,
    );

    const result: SteeringApplyResult = {
      proposalId: dto.proposalId,
      applied,
      skipped,
      // The same two facts `QueueSteeringService` keeps apart, in the same
      // words: what reached GitHub, and whether the control plane has acted on
      // it. A UI that showed the queue as re-scoped before a tick had run
      // would be showing a state nothing has reached.
      labelWritten: labelWritesPerformed > 0,
      writesEnabled: this.writes.enabled,
      reconciled: false,
      effect:
        'The labels are the request. They take effect on the next reconciler tick.',
      summary: {
        operationsRequested: dto.operations.length,
        operationsApplied: applied.length,
        operationsSkipped: skipped.length,
        labelWrites,
        labelWritesPerformed,
      },
    };

    // Audited AFTER the writes and BEFORE the caller is told anything, and
    // audited whether or not anything reached GitHub — "who instructed this,
    // in these words, and what was done about it" is the fact worth keeping,
    // and an apply that wrote nothing because the kill switch is off is
    // exactly the one somebody will later need to find.
    await this.prisma.auditEvent.create({
      data: {
        actorUserId,
        action: 'steering.apply',
        targetType: 'steering_proposal',
        targetId: dto.proposalId,
        meta: {
          instruction: dto.instruction,
          proposedAt: dto.proposedAt,
          writesEnabled: result.writesEnabled,
          labelWritten: result.labelWritten,
          summary: result.summary,
          applied: applied.map((entry) => ({
            ref: entry.ref,
            add: entry.add,
            remove: entry.remove,
          })),
          skipped: skipped.map((entry) => ({
            ref: entry.ref,
            reason: entry.reason,
          })),
        } as never,
      },
    });

    this.logger.log(
      `Steering ${dto.proposalId}: ${applied.length} applied, ${skipped.length} skipped, ` +
        `${labelWritesPerformed}/${labelWrites} label writes ${
          result.writesEnabled ? 'performed' : 'RECORDED ONLY (writes disabled)'
        }`,
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * What the endpoint will say about how it read the instruction.
   *
   * On the deterministic path `model` and `spend` are NULL, and that is a
   * claim: the chat's settings are not read, so there is nothing to report
   * about them. Filling them in anyway would make "no model was involved"
   * unfalsifiable from the response — the one thing #425 wants a caller to be
   * able to check.
   */
  private describeInterpretation(
    parsed: ParsedInstruction,
  ): SteeringProposal['interpretation'] {
    if (parsed.confident) {
      return {
        method: 'deterministic',
        modelInvoked: false,
        notes: parsed.notes,
        ambiguity: null,
        model: null,
        spend: null,
      };
    }

    const readiness = modelReadiness(resolveModelConfig(this.settings, 'chat'));
    const spend = assessChatSpend();

    return {
      method: 'none',
      modelInvoked: false,
      notes: parsed.notes,
      ambiguity: parsed.ambiguity,
      model: {
        consumer: 'chat',
        provider: readiness.provider,
        model: readiness.model,
        available: readiness.available,
        unavailableReason: readiness.unavailableReason,
      },
      spend: { admitted: spend.admit, reason: spend.reason },
    };
  }

  /** The repositories Opifex observes. Retired ones are not steerable. */
  private async registeredRepositories(): Promise<
    { owner: string; name: string }[]
  > {
    return this.prisma.repository.findMany({
      where: { retiredAt: null, observeEnabled: true },
      select: { owner: true, name: true },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  }

  private requireRegistered(
    slug: string,
    registered: { owner: string; name: string }[],
  ): RepositoryRef {
    const [owner, name] = slug.split('/');
    const repo = { owner, name };

    if (!isRegistered(repo, registered)) {
      throw new NotFoundException(
        `${slug} is not a repository Opifex observes, so it cannot be steered.`,
      );
    }

    return repo;
  }

  /**
   * Which repository a target names.
   *
   * A bare `#12` has to mean something, and guessing is the one thing that
   * must not happen: writing a label to issue 12 of a repository the operator
   * was not thinking about is exactly the harm the `unresolved` collection
   * exists to report instead of causing.
   */
  private repositoryFor(
    target: ParsedTarget,
    requested: RepositoryRef | null,
    registered: { owner: string; name: string }[],
  ): { repo: RepositoryRef } | { unresolved: UnresolvedReference } {
    if (target.owner !== null && target.name !== null) {
      const repo = { owner: target.owner, name: target.name };
      if (!isRegistered(repo, registered)) {
        return {
          unresolved: {
            reference: target.reference,
            reason: 'repository-not-registered',
            detail: `${target.owner}/${target.name} is not a repository Opifex observes. Register it first.`,
          },
        };
      }
      return { repo };
    }

    if (requested !== null) return { repo: requested };

    if (registered.length === 1) {
      return { repo: toRef(registered[0]) };
    }

    if (registered.length === 0) {
      return {
        unresolved: {
          reference: target.reference,
          reason: 'repository-not-registered',
          detail:
            'No repository is registered with Opifex, so there is nothing for a bare issue number to refer to.',
        },
      };
    }

    return {
      unresolved: {
        reference: target.reference,
        reason: 'ambiguous-repository',
        detail:
          `${registered.length} repositories are registered, so \`${target.reference}\` could ` +
          `mean any of them. Write it as \`owner/name#${target.number}\`, or send a ` +
          `\`repository\` with the instruction.`,
      },
    };
  }

  private async resolveIssue(
    repo: RepositoryRef,
    target: ParsedTarget,
    scoped: Map<string, ScopedIssue>,
    unresolved: UnresolvedReference[],
  ): Promise<void> {
    const ref = issueRef(repo.owner, repo.name, target.number);

    let issue;
    try {
      issue = await this.read.getIssue(repo, target.number);
    } catch (error) {
      if (!(error instanceof GitHubNotFoundError)) throw error;
      unresolved.push({
        reference: target.reference,
        reason: 'issue-not-found',
        detail: `${ref} could not be read. It may not exist, may have been transferred, or may be private to this token.`,
      });
      return;
    }

    if (issue.isPullRequest) {
      unresolved.push({
        reference: target.reference,
        reason: 'is-pull-request',
        detail: `${ref} is a pull request. Steering acts on issues, which is what a work order is built from.`,
      });
      return;
    }

    if (issue.state !== 'open') {
      unresolved.push({
        reference: target.reference,
        reason: 'issue-closed',
        detail: `${ref} is closed. Marking a closed issue changes nothing the reconciler will act on.`,
      });
      return;
    }

    scoped.set(ref, {
      ref,
      owner: repo.owner,
      name: repo.name,
      number: issue.number,
      title: issue.title,
      inputLabels: [...issue.inputLabels],
    });
  }

  /**
   * An epic reference, expanded through #424.
   *
   * The epic ISSUE itself is deliberately not steered. "Work on the auth epic"
   * names the work the epic lists, and an epic is a tracking issue: applying
   * `factory:ready` to it would offer the epic body to a runner as a task
   * spec.
   */
  private async resolveEpic(
    repo: RepositoryRef,
    target: ParsedTarget,
    maxDepth: number | undefined,
    scoped: Map<string, ScopedIssue>,
    unresolved: UnresolvedReference[],
    epicsResolved: SteeringProposal['scope']['epics'],
  ): Promise<void> {
    let resolution;
    try {
      resolution = await this.epics.resolve(repo, target.number, {
        ...(maxDepth === undefined ? {} : { maxDepth }),
      });
    } catch (error) {
      if (!(error instanceof GitHubNotFoundError)) throw error;
      unresolved.push({
        reference: target.reference,
        reason: 'issue-not-found',
        detail: `The epic ${issueRef(repo.owner, repo.name, target.number)} could not be read: ${error.message}`,
      });
      return;
    }

    epicsResolved.push({
      ref: resolution.epic.ref,
      title: resolution.epic.title,
      source: resolution.source,
      maxDepth: resolution.maxDepth,
      childrenFound: resolution.children.length,
      nativeUnavailable: resolution.nativeUnavailable,
    });

    for (const child of resolution.children) {
      if (child.unreadable) {
        unresolved.push({
          reference: child.ref,
          reason: 'unreadable',
          detail: `${child.ref} is named by ${child.namedBy} but could not be read, so it is not in the diff.`,
        });
        continue;
      }

      if (child.isPullRequest) {
        unresolved.push({
          reference: child.ref,
          reason: 'is-pull-request',
          detail: `${child.ref} is a pull request, not an issue.`,
        });
        continue;
      }

      if (child.state !== 'open') {
        unresolved.push({
          reference: child.ref,
          reason: 'issue-closed',
          detail: `${child.ref} is closed, so it is not in the diff.`,
        });
        continue;
      }

      // A second read, because #424 carries state and title but not labels —
      // it resolves MEMBERSHIP, and the diff needs the current input labels to
      // avoid proposing a label that is already there.
      await this.resolveIssue(
        { owner: child.owner, name: child.name },
        {
          kind: 'issue',
          owner: child.owner,
          name: child.name,
          number: child.number,
          reference: child.ref,
        },
        scoped,
        unresolved,
      );
    }
  }

  /**
   * The diff for an issue the operator NAMED.
   *
   * Note the removal on the ready path: `factory:hold` is taken off, because
   * an issue carrying both labels is HELD (`issue-projection.ts`), so an
   * instruction to work on it that left the hold in place would report success
   * and change nothing. It shows in the diff as a removal, which is the whole
   * reason removals are carried separately — this is precisely the deliberate
   * intent #425 says must not be discarded silently.
   */
  private namedOperation(
    issue: ScopedIssue,
    parsed: ParsedInstruction,
  ): SteeringOperation {
    const has = (label: string) => issue.inputLabels.includes(label);

    const add: SteerableLabel[] = [];
    const remove: SteerableLabel[] = [];

    if (parsed.intent === 'ready') {
      if (!has(INPUT_LABELS.READY)) add.push(INPUT_LABELS.READY);
      if (has(INPUT_LABELS.HOLD)) remove.push(INPUT_LABELS.HOLD);
    } else if (!has(INPUT_LABELS.HOLD)) {
      // A hold does NOT remove `factory:ready`, exactly as
      // `QueueSteeringService.hold` does not: the hold is what the projection
      // reads, and leaving the ready label alone means releasing later
      // restores the state the operator had rather than a guess at it.
      add.push(INPUT_LABELS.HOLD);
    }

    const unchanged = add.length === 0 && remove.length === 0;

    return {
      ref: issue.ref,
      owner: issue.owner,
      name: issue.name,
      number: issue.number,
      title: issue.title,
      add,
      remove,
      observedInputLabels: [...issue.inputLabels],
      reason: unchanged
        ? 'Named by the instruction, and already in the state it asks for. Nothing to change.'
        : parsed.intent === 'ready'
          ? 'Named by the instruction as work to do.'
          : 'Named by the instruction as work to hold.',
      named: true,
    };
  }
}

function toRef(repo: { owner: string; name: string }): RepositoryRef {
  return { owner: repo.owner, name: repo.name };
}

/** GitHub repository names are case-insensitive; a slug typed by hand may not be. */
function isRegistered(
  repo: RepositoryRef,
  registered: { owner: string; name: string }[],
): boolean {
  const wanted = `${repo.owner}/${repo.name}`.toLowerCase();
  return registered.some(
    (candidate) =>
      `${candidate.owner}/${candidate.name}`.toLowerCase() === wanted,
  );
}

/**
 * What changed in an issue's INPUT labels since the proposal was made.
 *
 * The comparison is over the recognised `factory:` input labels and nothing
 * else, which is the precise scope of what the operator confirmed. Comparing
 * every label would report `bug` being added as drift and make the check
 * useless through noise; comparing only the labels this operation touches
 * would miss the case that matters most — a `factory:hold` applied by hand
 * five minutes ago on an issue this proposal is about to mark ready.
 */
export function driftBetween(
  observed: string[],
  current: string[],
): { label: string; wasPresent: boolean; isPresent: boolean }[] {
  const was = new Set(observed);
  const is = new Set(current);
  const labels = [...new Set([...observed, ...current])].sort();

  return labels
    .filter((label) => was.has(label) !== is.has(label))
    .map((label) => ({
      label,
      wasPresent: was.has(label),
      isPresent: is.has(label),
    }));
}

/**
 * The numbers an operator reads BEFORE confirming.
 *
 * #425: *"the blast radius must be stated ('this will un-ready 17 issues') as
 * data the UI can render before confirmation"*. Data, not prose the UI has to
 * parse — every count is its own field, and `summary` is a rendered sentence
 * for the case where a UI wants one rather than the only way to get the
 * figure.
 *
 * Operations with an empty diff are carried in `operations` (so an operator who
 * named an issue can see what happened to it) but are NOT counted here: an
 * issue already in the state asked for is not part of the blast radius, and
 * inflating the number would make the warning less believable exactly where it
 * needs to be believed.
 */
export function blastRadius(
  operations: SteeringOperation[],
): SteeringProposal['blastRadius'] {
  const changing = operations.filter(
    (operation) => operation.add.length > 0 || operation.remove.length > 0,
  );

  const labelsAdded = changing.reduce((n, o) => n + o.add.length, 0);
  const labelsRemoved = changing.reduce((n, o) => n + o.remove.length, 0);
  const unreadied = changing.filter((o) =>
    o.remove.includes(INPUT_LABELS.READY),
  ).length;
  const readied = changing.filter((o) =>
    o.add.includes(INPUT_LABELS.READY),
  ).length;
  const held = changing.filter((o) => o.add.includes(INPUT_LABELS.HOLD)).length;
  const collateral = changing.filter((o) => !o.named).length;

  const sentences: string[] = [];

  if (changing.length === 0) {
    sentences.push(
      'Nothing changes: every issue this instruction names is already in the state it asks for.',
    );
  } else {
    if (readied > 0) {
      sentences.push(`This will mark ${plural(readied, 'issue')} ready.`);
    }
    if (unreadied > 0) {
      sentences.push(
        `This will un-ready ${plural(unreadied, 'issue')}` +
          (collateral > 0
            ? `, ${collateral} of which the instruction did not name.`
            : '.'),
      );
    }
    if (held > 0) {
      sentences.push(`This will hold ${plural(held, 'issue')}.`);
    }
  }

  return {
    issuesAffected: changing.length,
    named: changing.filter((o) => o.named).length,
    collateral,
    labelsAdded,
    labelsRemoved,
    unreadied,
    readied,
    held,
    destructive: labelsRemoved > 0,
    summary: sentences.join(' '),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
