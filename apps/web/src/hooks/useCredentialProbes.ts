/**
 * The Test buttons' state (#349, epic #332).
 *
 * ## An observation is stored with the thing it observed
 *
 * `run()` takes the settings document as it stands and fingerprints the keys
 * the probe reads BEFORE calling it, so the answer is filed alongside the
 * configuration it was an answer about. That is what lets
 * `probeFreshness` say "this describes the previous value" after a rotation,
 * instead of the screen showing a green tick for a token that no longer
 * exists. Sampling afterwards would attribute the answer to whatever the
 * document had become by the time the call returned, which on a slow probe is
 * exactly the case that matters.
 *
 * ## Never throws, and never clears a previous answer
 *
 * `runOperatorProbe` resolves for every outcome, including a 403 and a missing
 * route, so there is no rejection path here. A new answer replaces the old one
 * for that probe and nothing else is touched: two probes on one card are two
 * independent questions, and testing the Claude binary must not erase what the
 * credential test found.
 */

import { useCallback, useState } from 'react';

import { runOperatorProbe } from '../services/api';
import {
  probeWitness,
  type ProbeDescriptor,
  type ProbeObservation,
} from '../config/credentialProbes';
import type { OperatorProbeName } from '../types/operatorProbes';
import type { OperatorSetting } from '../types/operatorSettings';
import { useIsMounted } from './useIsMounted';

export interface UseCredentialProbesResult {
  /** What each probe last answered. Absent means it has never been run. */
  observations: Partial<Record<OperatorProbeName, ProbeObservation>>;
  /** The probe in flight, if any. One at a time — see `run`. */
  runningProbe: OperatorProbeName | null;
  run: (
    descriptor: ProbeDescriptor,
    settings: readonly OperatorSetting[],
  ) => Promise<void>;
}

export function useCredentialProbes(): UseCredentialProbesResult {
  const [observations, setObservations] = useState<
    Partial<Record<OperatorProbeName, ProbeObservation>>
  >({});
  const [runningProbe, setRunningProbe] = useState<OperatorProbeName | null>(
    null,
  );
  // Every `setState` past an `await` is guarded — a probe settling after the
  // section is closed must not schedule an update on it.
  const isMounted = useIsMounted();

  const run = useCallback(
    async (
      descriptor: ProbeDescriptor,
      settings: readonly OperatorSetting[],
    ) => {
      // One at a time, and the guard is here rather than only on the button:
      // two of these spend real money, and a double-submit that the disabled
      // attribute did not catch would spend it twice.
      if (runningProbe !== null) return;

      const witness = probeWitness(descriptor, settings);
      setRunningProbe(descriptor.name);

      try {
        const outcome = await runOperatorProbe(descriptor.name);
        if (isMounted()) {
          setObservations((current) => ({
            ...current,
            [descriptor.name]: { probe: descriptor.name, outcome, witness },
          }));
        }
      } finally {
        if (isMounted()) setRunningProbe(null);
      }
    },
    [runningProbe, isMounted],
  );

  return { observations, runningProbe, run };
}

export default useCredentialProbes;
