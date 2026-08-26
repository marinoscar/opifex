/**
 * The supervisor's model seam (#89).
 *
 * VISION §6 makes the RUNNER seam vendor-neutral by construction, and the same
 * argument applies here for the same reason: the control plane must not know
 * which vendor answers. This interface is what a supervisor adapter
 * implements, and nothing outside `invocation/` may name a model provider.
 *
 * ## Why there was no adapter when this file was written
 *
 * There was no model client in the repository, and inventing one to have
 * something to call would have been worse than the absence: an adapter nobody
 * has pointed at a real endpoint is untested plumbing that reads as a working
 * feature. VISION §3.7 is explicit about not building the second thing before
 * it is needed.
 *
 * So the seam shipped with `UnavailableSupervisorModel` in place, and it said
 * so out loud — every invocation recorded the refusal, in the log, where it is
 * visible. ADR-0015 then supplied the Anthropic adapter, and #344 binds it
 * unconditionally; a deployment with no API key gets the same refusal from the
 * adapter itself, recorded the same way. A supervisor that appears to be
 * running and is not is exactly the failure the decision log exists to make
 * impossible.
 */

/** DI token. A string token because the port is an interface, not a class. */
export const SUPERVISOR_MODEL = Symbol('SUPERVISOR_MODEL');

/** What the supervisor is asked. */
export interface SupervisorModelRequest {
  /**
   * The rendered snapshot (#88) — the ONLY state the model receives.
   *
   * VISION §7: "The supervisor holds no state in its context." There is no
   * conversation id here, no history, no thread. That absence is the design.
   */
  snapshot: string;
  /** What this particular proposer wants, appended to the snapshot. */
  instruction: string;
  /** A ceiling on the answer, so one proposer cannot spend the invocation. */
  maxOutputTokens?: number;
}

/** What comes back. */
export interface SupervisorModelResponse {
  /** The model's answer, verbatim. Parsing belongs to the proposer. */
  text: string;
  /**
   * What the call cost, or null when the adapter cannot say.
   *
   * Null rather than 0, exactly as `Run.costUsd` is nullable: VISION §6 makes
   * cost reporting a declared capability, and an adapter that does not report
   * must not look free.
   */
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
}

/**
 * A supervisor model adapter.
 *
 * Note what it CANNOT do: it takes text and returns text. It has no tools, no
 * function calling, no handle onto the control plane. #90 requires execution
 * be structurally impossible, and a model that could call a tool would be an
 * executor with extra steps.
 */
export interface SupervisorModel {
  /**
   * The model's own name, recorded per invocation.
   *
   * #89 requires the model be recorded "for cost accounting", and it also
   * makes "runs on a small model" a claim checkable against the log rather
   * than against the config file as it reads today.
   */
  readonly name: string;

  /** Ask. Throws on failure; the caller records the failure and moves on. */
  ask(request: SupervisorModelRequest): Promise<SupervisorModelResponse>;
}

/**
 * The default when no adapter is bound at all.
 *
 * Throws rather than returning empty text. An empty answer would be recorded
 * as a supervisor that ran and had nothing to say, which is a lie the approval
 * rate would then average over — and #90 is explicit that "declined" must mean
 * the supervisor LOOKED and declined.
 *
 * Since #344 `SupervisorModule` always binds `AnthropicSupervisorModel`, so
 * this is no longer what an unconfigured DEPLOYMENT gets — the adapter refuses
 * per call instead, and deliberately reports the same `'none'` name so the
 * decision-log row is unchanged. What still reaches this class is a
 * `SupervisorService` constructed outside the module, which is how the
 * governing tests state "the factory runs with the supervisor offline".
 */
export class UnavailableSupervisorModel implements SupervisorModel {
  readonly name = 'none';

  ask(): Promise<SupervisorModelResponse> {
    return Promise.reject(
      new Error(
        'No supervisor model adapter is configured. Bind SUPERVISOR_MODEL to an ' +
          'implementation, or leave SUPERVISOR_ENABLED off.',
      ),
    );
  }
}
