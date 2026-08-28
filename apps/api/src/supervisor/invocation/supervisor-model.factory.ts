import type { OperatorSettingsService } from '../../settings/operator-settings/operator-settings.service';
import { AnthropicSupervisorModel } from './anthropic-supervisor-model';
import { OpenAiSupervisorModel } from './openai-supervisor-model';
import {
  resolveModelConfig,
  type ModelConsumer,
  type SupervisorModelProvider,
} from './supervisor-model.config';
import type {
  SupervisorModel,
  SupervisorModelRequest,
  SupervisorModelResponse,
} from './supervisor-model.port';

/**
 * Where the supervisor's vendor is chosen (#392).
 *
 * `supervisor-model.port.ts`: "nothing outside `invocation/` may name a model
 * provider." `supervisor.module.ts` imports `createSupervisorModel` from HERE
 * rather than from an adapter file, so the module's own import list names no
 * vendor either — before #392 it imported the factory out of
 * `anthropic-supervisor-model.ts`, and the seam's claim was true of the code
 * but not of the import path.
 *
 * ## Why the choice is per CALL and not per process
 *
 * A factory runs once. If it read `supervisor.model.provider` and returned the
 * matching adapter, that verdict would become a second, stale copy of the
 * setting — and #344 removed exactly that shape for the API key, for exactly
 * this reason: an operator switches provider in the Control Center, the UI
 * shows the new one, and every invocation until the next restart calls the old
 * one. ADR-0018 §5 makes the same argument for the reconciler's interval.
 *
 * So the factory returns a router. Both adapters are constructed — each holds
 * nothing but the settings resolver, so building the one that is not selected
 * costs a field — and every `ask()` and every read of `name` picks between
 * them from the live setting.
 *
 * ## What the router deliberately is not
 *
 * It is not a fallback. A call that fails on the selected provider fails, and
 * `SupervisorService` records it; trying the other vendor would spend a second
 * credential on the same tick and record a `model` the operator did not ask
 * for, which is precisely the claim #89 wants the log to be able to settle.
 */
export class ProviderRoutingSupervisorModel implements SupervisorModel {
  private readonly adapters: Readonly<
    Record<SupervisorModelProvider, SupervisorModel>
  >;

  /**
   * @param consumer Which thing in this process this router answers for (#423).
   *
   * #423 built `resolveModelConfig(settings, consumer)` and left this class
   * hard-wired to the supervisor's four keys, which meant a second consumer
   * could not be routed at all without either a second router or a second copy
   * of the resolution. Threading the consumer here is what makes
   * `chat.model.provider` select an adapter the same way
   * `supervisor.model.provider` does — one router, two consumers, still one
   * place where a vendor is chosen.
   *
   * Required, not defaulted. See the adapters' constructors for why a default
   * of `'supervisor'` would be a misconfiguration with no symptom.
   */
  constructor(
    private readonly settings: OperatorSettingsService,
    private readonly consumer: ModelConsumer,
  ) {
    this.adapters = Object.freeze({
      anthropic: new AnthropicSupervisorModel(settings, consumer),
      openai: new OpenAiSupervisorModel(settings, consumer),
    });
  }

  /** The adapter for whatever THIS consumer's setting says RIGHT NOW. */
  private selected(): SupervisorModel {
    return this.adapters[
      resolveModelConfig(this.settings, this.consumer).provider
    ];
  }

  /**
   * The model string the selected provider would send, verbatim.
   *
   * Delegated rather than resolved here, so that the name in the decision log
   * comes from the same object that made the call. Both adapters answer from
   * the shared `reportedModelName`, so an unconfigured deployment records the
   * same `'none'` on either provider and a key naming no model records
   * `'unconfigured'` on either — a provider switch must not make the log
   * incomparable with itself.
   */
  get name(): string {
    return this.selected().name;
  }

  ask(request: SupervisorModelRequest): Promise<SupervisorModelResponse> {
    return this.selected().ask(request);
  }
}

/**
 * Build the adapter. Always.
 *
 * ## Why this returns an adapter unconditionally (#344)
 *
 * It used to return `undefined` when `SUPERVISOR_MODEL_API_KEY` was absent,
 * which left `SUPERVISOR_MODEL` unbound for the life of the process and
 * `SupervisorService` permanently on `UnavailableSupervisorModel`. That was
 * correct while the key could only arrive from a `.env` file read at boot: in
 * that world "no key" is a fact fixed for the process's whole life, and not
 * binding is strictly tidier than binding something that refuses.
 *
 * Epic #332 makes the key an operator-settable value, and inverts the
 * argument exactly as ADR-0018 §5 inverts it for the reconciler's interval.
 * A factory runs once. Its verdict becomes a SECOND, STALE COPY of the key's
 * presence, and the two can disagree for as long as the process stays up — an
 * operator sets the key in the Control Center, `supervisor.enabled` is already
 * live (`supervisor.service.ts`), and they enable a supervisor that provably
 * cannot call anything while the UI says it is on. That is the failure class
 * this epic exists to eliminate, and it is invisible: every invocation records
 * a refusal that reads exactly like a deployment that never configured one.
 *
 * So the binding no longer depends on configuration at all, and the
 * configuration — now including WHICH VENDOR — is resolved per call.
 *
 * ## The unconfigured path is unchanged, and must stay that way
 *
 * ADR-0015 requires it, #344 keeps it, and #392 keeps it on both providers.
 * With no key: `ask()` refuses, the proposer's failure is caught by
 * `SupervisorService` as any other proposer failure is, the invocation still
 * writes its decision-log row, and `SupervisorModel.name` still reads
 * `'none'`. Nothing is swallowed and nothing crashes at boot — what changed is
 * that the refusal names the setting to change, and that supplying it takes
 * effect on the next invocation instead of on the next restart.
 *
 * ADR-0015 also asked for a warning at STARTUP when a key names no model.
 * That warning is gone rather than moved: it read the key once, at boot, to
 * describe a state that is now allowed to change underneath it, so it could
 * only be right by accident. Its content survives where it is actually
 * checkable — `ask()` refuses per invocation with the missing variable named,
 * which is what ADR-0015 wanted the warning for.
 *
 * `SupervisorService` keeps its `@Optional()` parameter and its
 * `?? new UnavailableSupervisorModel()` fallback. Through this module the
 * fallback is now unreachable, and it is not deleted: the service is
 * constructed directly, without the module, by
 * `test/governing/supervisor-offline.spec.ts` among others, and a required
 * binding would make "the factory runs with the supervisor offline" harder to
 * state rather than easier.
 */
export function createSupervisorModel(
  settings: OperatorSettingsService,
  consumer: ModelConsumer,
): SupervisorModel {
  return new ProviderRoutingSupervisorModel(settings, consumer);
}
