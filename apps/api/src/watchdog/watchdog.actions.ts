import type { ReconcileAction } from '../reconciler/diff/actions.types';
import type { LoopVerdict } from './loop-detection';
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
      escalationKind: 'run_stalled',
      progressStoppedAt: verdict.progressStoppedAt.toISOString(),
      ...(verdict.detectionSource
        ? { detectionSource: verdict.detectionSource }
        : {}),
      // Written to be decidable from a phone (#57): what stopped, where, how
      // long ago, and what Opifex intends to do about it.
      reason:
        `${verdict.workOrderIdentity} (${verdict.repository}#${verdict.issueNumber}) has stalled — ` +
        `${verdict.reason}. Opifex would kill it and re-run from the pinned base commit; ` +
        `no executor exists yet, so it is waiting for you.`,
    },
  ];
}

/**
 * Turn a loop verdict into the action it implies.
 *
 * ## Why the response differs from silence
 *
 * `kill-and-re-plan`, not `kill-and-re-run`. #55 is explicit: re-running the
 * identical work order from base would simply loop again. The work order
 * itself is the problem — it asked for something the runner cannot get to
 * from here — so it needs decomposing rather than retrying.
 *
 * Re-planning implies decomposition, which VISION §7 puts in the advisory
 * agent's hands. The supervisor does not exist (#21), so this escalates to a
 * human, and the escalation says what a human would need to decide.
 *
 * Collapsing this into silence's response is the mistake VISION §9 warns about
 * directly: three failure modes, three responses, and conflating them is the
 * most common supervision bug.
 */
export function actionsForLoop(
  verdict: LoopVerdict,
  run: {
    runId: string;
    workOrderIdentity: string;
    repository: string;
    issueNumber: number;
  },
): ReconcileAction[] {
  const base = {
    repository: run.repository,
    issueNumber: run.issueNumber,
    runId: run.runId,
    evidence: {
      intent: 'running' as const,
      inputLabels: [],
      workOrderIdentity: run.workOrderIdentity,
      runStatus: 'running',
      currentMirrorLabels: [],
      desiredMirrorLabels: [],
    },
  };

  return [
    {
      ...base,
      type: 'kill-and-re-plan',
      reason: `kill and re-plan ${run.workOrderIdentity}: ${verdict.reason}`,
    },
    {
      ...base,
      type: 'escalate',
      escalationKind: 'run_looping',
      // When the signature STARTED repeating, not the last event. A looping
      // run is not silent, so measuring from its newest event would report a
      // few seconds of latency for a run that has been going nowhere for an
      // hour (#59).
      ...(verdict.startedRepeatingAt
        ? { progressStoppedAt: verdict.startedRepeatingAt.toISOString() }
        : {}),
      // Loop detection needs tool detail, which only the runner's own stream
      // carries. There is no git-derived path to this verdict.
      detectionSource: 'runner',
      reason:
        `${run.workOrderIdentity} (${run.repository}#${run.issueNumber}) is looping — ` +
        `${verdict.reason}. Re-running it unchanged would loop again, so the work order needs ` +
        `decomposing; no supervisor exists yet, so it is waiting for you.`,
    },
  ];
}
