import type {
  HardCeiling,
  HardSpendCeilingService,
} from '../budget/hard-spend-ceiling';
import { PrismaService } from '../prisma/prisma.service';
import type { AutonomyEffect } from './never-trustable';
import {
  NeverTrustableService,
  type AutonomyEnforcementRequest,
} from './never-trustable.service';

const CEILING: HardCeiling = { limitUsd: 50, windowDays: 30, malformed: null };

function prismaDouble() {
  return {
    auditEvent: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
}

function ceilingDouble(overrides: Partial<HardCeiling> = {}) {
  return { value: { ...CEILING, ...overrides } };
}

function request(
  effects: AutonomyEffect[],
  overrides: Partial<AutonomyEnforcementRequest> = {},
): AutonomyEnforcementRequest {
  return {
    actionClass: 're-dispatch',
    effects,
    proposalId: 'prop-1',
    grantId: 'grant-1',
    targetRef: 'acme/web#7',
    ...overrides,
  };
}

const FORCE_PUSH: AutonomyEffect = {
  kind: 'git-push',
  repository: 'acme/web',
  branch: 'main',
  force: true,
  protectedBranch: true,
};

describe('NeverTrustableService (#95, ADR-0013)', () => {
  let prisma: ReturnType<typeof prismaDouble>;
  let service: NeverTrustableService;

  /**
   * A service over the given ceiling, with the refusal warning silenced.
   *
   * Every refusal warns with its reasons, which is the behaviour an operator
   * needs and the last thing a suite that is supposed to refuse a dozen times
   * should print.
   */
  function build(overrides: Partial<HardCeiling> = {}): NeverTrustableService {
    const built = new NeverTrustableService(
      prisma as unknown as PrismaService,
      ceilingDouble(overrides) as unknown as HardSpendCeilingService,
    );
    jest.spyOn(built['logger'], 'warn').mockImplementation(() => undefined);
    return built;
  }

  beforeEach(() => {
    prisma = prismaDouble();
    service = build();
  });

  describe('permitted actions', () => {
    it('permits an action whose effects are all ordinary', async () => {
      const verdict = await service.enforce(
        request([
          { kind: 'dispatch', repository: 'acme/web', workOrder: 'wo-1' },
          { kind: 'spend', usd: 1.5 },
        ]),
      );

      expect(verdict).toEqual({ permitted: true });
    });

    it('writes nothing for a permitted action', async () => {
      // #97/#100 own the digest of what ran under trust (VISION §8). Recording
      // half of it here would give the digest a second partial record of the
      // same events to disagree with.
      await service.enforce(request([{ kind: 'spend', usd: 1.5 }]));

      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('refusals', () => {
    it('refuses and returns every rule that matched', async () => {
      const verdict = await service.enforce(request([FORCE_PUSH]));

      expect(verdict.permitted).toBe(false);
      if (verdict.permitted) throw new Error('unreachable');
      expect(verdict.refusals.map((refusal) => refusal.rule)).toEqual([
        'force-push',
        'protected-branch-write',
      ]);
    });

    it('writes ONE audit row however many rules matched', async () => {
      // The event being recorded is the ATTEMPT. Three rows would make one
      // action that tried three forbidden things look like three incidents,
      // and the count of refusals is what #95 wants to watch for escalation.
      await service.enforce(
        request([
          FORCE_PUSH,
          { kind: 'credential-access', mode: 'read', what: 'GITHUB_TOKEN' },
        ]),
      );

      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
      const { data } = prisma.auditEvent.create.mock.calls[0][0];
      expect(data.meta.rules).toEqual([
        'force-push',
        'protected-branch-write',
        'credential-access',
      ]);
    });

    it('records the action, the rules, the reasons and the effects', async () => {
      await service.enforce(request([FORCE_PUSH]));

      const { data } = prisma.auditEvent.create.mock.calls[0][0];

      expect(data.action).toBe('autonomy.refused');
      expect(data.targetType).toBe('action-class');
      expect(data.targetId).toBe('re-dispatch');
      expect(data.actorUserId).toBeNull();
      expect(data.meta.proposalId).toBe('prop-1');
      expect(data.meta.grantId).toBe('grant-1');
      expect(data.meta.targetRef).toBe('acme/web#7');
      expect(data.meta.effects).toEqual([FORCE_PUSH, FORCE_PUSH]);
      expect(data.meta.reasons[0]).toContain('acme/web@main');
    });

    it('records the acting human when there is one', async () => {
      await service.enforce(request([FORCE_PUSH], { actorUserId: 'user-1' }));

      const { data } = prisma.auditEvent.create.mock.calls[0][0];
      expect(data.actorUserId).toBe('user-1');
    });

    it('nulls the optional context rather than omitting it', async () => {
      await service.enforce({
        actionClass: 'decomposition',
        effects: [FORCE_PUSH],
      });

      const { data } = prisma.auditEvent.create.mock.calls[0][0];
      expect(data.meta.proposalId).toBeNull();
      expect(data.meta.grantId).toBeNull();
      expect(data.meta.targetRef).toBeNull();
    });

    it('refuses a class that is not in the registry at all', async () => {
      // ADR-0013: the guard does not ask what class an action belongs to
      // before deciding whether to refuse it. That is the point of putting the
      // check on the effect.
      const verdict = await service.enforce(
        request([FORCE_PUSH], { actionClass: 'not-a-registered-class' }),
      );

      expect(verdict.permitted).toBe(false);
      expect(prisma.auditEvent.create.mock.calls[0][0].data.targetId).toBe(
        'not-a-registered-class',
      );
    });
  });

  describe('when the audit write fails', () => {
    beforeEach(() => {
      prisma.auditEvent.create.mockRejectedValue(
        new Error('remaining connection slots are reserved'),
      );
      jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => undefined);
    });

    it('still refuses', async () => {
      // A guard whose enforcement depends on a successful database write fails
      // open under exactly the load that makes writes fail — the one condition
      // under which nobody would notice it had.
      const verdict = await service.enforce(request([FORCE_PUSH]));

      expect(verdict.permitted).toBe(false);
      if (verdict.permitted) throw new Error('unreachable');
      expect(verdict.refusals).toHaveLength(2);
    });

    it('does not propagate the write failure to the caller', async () => {
      await expect(service.enforce(request([FORCE_PUSH]))).resolves.toEqual(
        expect.objectContaining({ permitted: false }),
      );
    });

    it('logs the dropped record, so the gap is not silent', async () => {
      await service.enforce(request([FORCE_PUSH]));

      expect(service['logger'].error).toHaveBeenCalledWith(
        expect.stringContaining('audit write failed'),
      );
    });
  });

  describe('the ceiling comes from #65, not from here', () => {
    it('uses the injected ceiling to judge a spend', async () => {
      service = build({ limitUsd: 5 });

      const verdict = await service.enforce(
        request([{ kind: 'spend', usd: 10 }]),
      );

      expect(verdict.permitted).toBe(false);
    });

    it('refuses every spend when no ceiling is configured', async () => {
      // Unset is not unlimited (#65). The guard has nothing to check against.
      service = build({ limitUsd: null });

      const verdict = await service.enforce(
        request([{ kind: 'spend', usd: 0.01 }]),
      );

      expect(verdict.permitted).toBe(false);
    });
  });
});
