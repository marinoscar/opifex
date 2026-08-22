import type { ReconcileAction } from '../reconciler/diff/actions.types';
import type { SilenceVerdict } from './watchdog.types';

/**
 * Turn a silence verdict into the action it implies.
 *
 * ## Why an action rather than a kill
 *
 * #54 is explicit about the phase boundary: the response is "computed and
 * recorded as a typed action through the diff engine's vocabulary (#47), and
 * escalates while no executor exists — actually killing a run and
 * re-dispatching from base is Phase 4 machinery (#61, #66)."
 *
 * So this produces data, exactly as the diff engine does. Nothing in Phase 3
 * can execute it, and building the detection against the same vocabulary the
 * executor will eventually consume means Phase 4 wires up an existing contract
 * rather than inventing one.
 *
 * ## Two actions per verdict, not one
 *
 * A silent run yields `kill-and-re-run` AND `escalate`. They are not
 * alternatives: the kill is what should happen to the run, and the escalation
 * is what should happen to the human. VISION §9 puts notification "on the same
 * footing as dispatch", so a kill that nobody is told about would reproduce
 * the original problem — a run stopped at 10am and discovered at 2pm — by a
 * different route.
 *
 * While no executor exists, only the escalation has any effect, and that is
 * the correct degradation: the operator is told, and can act.
 */
export function actionsForSilence(verdict: SilenceVerdict): ReconcileAction[] {
  const base = {
    repository: verdict.repository,
    issueNumber: verdict.issueNumber,
    runId: verdict.runId,
    evidence: {
      intent: 'running' as const,
      inputLabels: [],
      workOrderIdentity: verdict.workOrderIdentity,
      runStatus: 'stalled',
      currentMirrorLabels: [],
      desiredMirrorLabels: [],
    },
  };

  return [
    {
      ...base,
      type: 'kill-and-re-run',
      reason: `kill and re-run ${verdict.workOrderIdentity} from its base commit: ${verdict.reason}`,
    },
    {
      ...base,
      type: 'escalate',
      // Written to be decidable from a phone (#57): what stopped, where, how
      // long ago, and what Opifex intends to do about it.
      reason:
        `${verdict.workOrderIdentity} (${verdict.repository}#${verdict.issueNumber}) has stalled — ` +
        `${verdict.reason}. Opifex would kill it and re-run from the pinned base commit; ` +
        `no executor exists yet, so it is waiting for you.`,
    },
  ];
}
