import { Injectable, Logger } from '@nestjs/common';

import { GitHubWriteService } from '../../github/write/github-write.service';
import type { ReconcileAction } from '../diff/actions.types';

export interface ExecutionOutcome {
  /** Label writes actually performed against GitHub. */
  executed: number;
  /** Writes that were already true — the label was present or absent already. */
  noops: number;
  /** Writes suppressed because a flag was off. */
  suppressed: number;
  failures: { action: ReconcileAction; reason: string }[];
}

/**
 * Applies the mirror-label actions the diff engine computed, and nothing else.
 *
 * ## Where this sits, and why it is not in the reconciler core
 *
 * `ReconcilerService` — observation, projection, diff — has no write
 * capability at all and still does not: it does not depend on this class.
 * `ReconcilerTask` orchestrates, calling the reconciler to COMPUTE and then
 * handing the resulting action list here to EXECUTE. So the component that
 * decides what should happen remains structurally incapable of making it
 * happen, which is the property VISION §12's observation week rests on.
 *
 * What changed with #48 is narrower than "the reconciler can now write": a
 * separate, small, auditable component can write two kinds of label, behind
 * two flags. Since ADR-0019 (#439) only one of them still defaults off —
 * `Repository.mirrorLabelsEnabled`, per repository — while
 * `GITHUB_WRITES_ENABLED` ships on. A repository that has not opted in is
 * still not written to.
 *
 * ## What it will not do
 *
 * It handles `add-mirror-label` and `remove-mirror-label` and ignores every
 * other action type — dispatch, escalate, quarantine all pass through
 * untouched. That is not a policy check that could be misconfigured; there is
 * no branch here that could dispatch anything, and `GitHubWriteService` has no
 * dispatch adapter to call even if one were written.
 *
 * ## The invariant it must not break
 *
 * VISION §3.3: mirror labels are written and never read as truth. This class
 * writes them and returns counts. It never feeds anything back into the
 * projection — the projection's inputs are gathered fresh next tick from
 * GitHub, where the read adapter strips these labels out again.
 */
@Injectable()
export class MirrorLabelExecutor {
  private readonly logger = new Logger(MirrorLabelExecutor.name);

  constructor(private readonly writes: GitHubWriteService) {}

  /**
   * Apply the label actions for repositories that have opted in.
   *
   * @param actions   the full action list from the tick
   * @param enabledFor repositories (`owner/name`) with mirror labels enabled
   */
  async execute(
    actions: ReconcileAction[],
    enabledFor: ReadonlySet<string>,
  ): Promise<ExecutionOutcome> {
    const outcome: ExecutionOutcome = {
      executed: 0,
      noops: 0,
      suppressed: 0,
      failures: [],
    };

    for (const action of actions) {
      if (
        action.type !== 'add-mirror-label' &&
        action.type !== 'remove-mirror-label'
      ) {
        continue;
      }

      if (!enabledFor.has(action.repository)) {
        outcome.suppressed += 1;
        continue;
      }

      const [owner, name] = action.repository.split('/');
      const label = action.label;
      if (!label) {
        // A label action with no label is a diff-engine bug, not a GitHub
        // problem. Recorded rather than thrown so one malformed action cannot
        // abandon the rest of the list.
        outcome.failures.push({
          action,
          reason: 'label action carried no label',
        });
        continue;
      }

      try {
        const result =
          action.type === 'add-mirror-label'
            ? await this.writes.addLabel(
                { owner, name },
                action.issueNumber,
                label,
              )
            : await this.writes.removeLabel(
                { owner, name },
                action.issueNumber,
                label,
              );

        if (!result.performed) {
          // The global kill switch. Counted separately from a per-repository
          // opt-out so the log distinguishes "this repository is not enabled"
          // from "writes are off everywhere".
          outcome.suppressed += 1;
        } else if (result.noop) {
          outcome.noops += 1;
        } else {
          outcome.executed += 1;
        }
      } catch (error) {
        outcome.failures.push({
          action,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (outcome.executed > 0 || outcome.failures.length > 0) {
      this.logger.log(
        `Mirror labels: ${outcome.executed} written, ${outcome.noops} already correct, ` +
          `${outcome.suppressed} suppressed, ${outcome.failures.length} failed`,
      );
    }

    return outcome;
  }
}
