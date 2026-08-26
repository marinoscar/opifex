import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';

import {
  FakeOperatorSettingsPrisma,
  TEST_ENCRYPTION_KEY,
  makeOperatorSettings,
} from '../../../test/fixtures/operator-settings.fixture';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS } from '../../common/constants/roles.constants';
import { PERMISSION_MODES } from '../../runners/claude-code-local/claude-code-invocation';
import { ENCRYPTION_KEY_ENV_VAR } from '../../common/crypto/secret-box';
import { ZodValidationPipe } from 'nestjs-zod';

import {
  PatchOperatorSettingsDto,
  patchOperatorSettingsSchema,
} from './dto/patch-operator-settings.dto';
import { OperatorSettingsController } from './operator-settings.controller';
import { OPERATOR_SETTING_KEYS } from './operator-settings.registry';
import type { OperatorSettingsService } from './operator-settings.service';
import type { OperatorProbesService } from './probes/operator-probes.service';

/**
 * The endpoint behaviours #338 names, against the real service and the real
 * registry — only the two tables and the environment are stood in for.
 *
 * The `PATCH` cases are the ones worth reading. Two of them ("does not clear
 * the keys it was not sent" and "reverts to the environment, not to the
 * code's default") are the whole reason this shape was specified: both would
 * pass a naive implementation's happy path and both describe a way for a
 * deployment to quietly stop honouring its own configuration.
 */

const ADMIN: RequestUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'operator@example.com',
  roles: ['admin'],
  permissions: [
    PERMISSIONS.SYSTEM_SETTINGS_READ,
    PERMISSIONS.SYSTEM_SETTINGS_WRITE,
    PERMISSIONS.OPERATOR_SETTINGS_WRITE_SECRET,
  ],
  isActive: true,
};

/** An operator who may tune knobs but not rotate credentials. */
const TUNER: RequestUser = {
  ...ADMIN,
  id: '00000000-0000-4000-8000-000000000002',
  permissions: [
    PERMISSIONS.SYSTEM_SETTINGS_READ,
    PERMISSIONS.SYSTEM_SETTINGS_WRITE,
  ],
};

describe('OperatorSettingsController (#338)', () => {
  let prisma: FakeOperatorSettingsPrisma;
  let settings: OperatorSettingsService;
  let controller: OperatorSettingsController;

  async function build(env: NodeJS.ProcessEnv = {}): Promise<void> {
    prisma = new FakeOperatorSettingsPrisma();
    ({ settings } = await makeOperatorSettings({ prisma, env }));
    controller = new OperatorSettingsController(
      settings,
      {} as unknown as OperatorProbesService,
    );
  }

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    process.env[ENCRYPTION_KEY_ENV_VAR] = TEST_ENCRYPTION_KEY;
    await build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[ENCRYPTION_KEY_ENV_VAR];
  });

  function entry(document: { settings: Array<{ key: string }> }, key: string) {
    const found = document.settings.find((item) => item.key === key);
    if (!found) throw new Error(`no entry for ${key}`);
    return found as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------
  // GET
  // -------------------------------------------------------------------------

  describe('GET', () => {
    it('returns every managed key with its provenance, reload and danger', () => {
      const document = controller.list();

      // The registry's own count, so a key added there and not served here
      // fails rather than going unnoticed.
      expect(document.settings.map((item) => item.key)).toEqual(
        OPERATOR_SETTING_KEYS,
      );

      expect(entry(document, 'github.writesEnabled')).toMatchObject({
        group: 'github',
        label: 'GitHub writes enabled',
        type: 'boolean',
        reload: 'live',
        dangerous: true,
        source: 'default',
        value: false,
        secret: false,
      });
    });

    it('publishes the constraints a control has to render from', async () => {
      // #348 renders the sections "entirely from the registry response", so a
      // key's bounds, enum members and format have to travel with it — an
      // integer field with no min/max would be a free-text box that 400s.
      const document = controller.list();

      expect(entry(document, 'github.maxRetries').constraints).toEqual({
        min: 0,
        max: 10,
      });
      expect(
        entry(document, 'runners.claudeCodeLocal.permissionMode').constraints,
      ).toMatchObject({
        // Straight from `PERMISSION_MODES`, which the registry imports rather
        // than restating — so this list moving is a decision somebody made in
        // one place, not a drift between two.
        values: [...PERMISSION_MODES],
      });
      expect(entry(document, 'github.apiBaseUrl').constraints).toEqual({
        format: 'url',
      });
    });

    it('says which keys accept null as a real value', () => {
      // `dispatch.maxConcurrent` resolving to null means "no ceiling", which a
      // UI has to be able to offer — and which is a different thing from the
      // `null` a PATCH sends to revert a key to the environment.
      const document = controller.list();

      expect(entry(document, 'dispatch.maxConcurrent')).toMatchObject({
        nullable: true,
        value: null,
      });
      expect(entry(document, 'dispatch.enabled').nullable).toBe(false);
    });

    it('names the environment variable each key falls back to', () => {
      // So the Control Center can say "set in .env as GITHUB_TOKEN" rather
      // than making an operator guess which variable to unset.
      expect(entry(controller.list(), 'github.token').envVar).toBe(
        'GITHUB_TOKEN',
      );
    });

    it('reports the layer a value actually came from', async () => {
      await build({ GITHUB_MAX_RETRIES: '7' });
      prisma.put('github.rateLimitReserve', 250);
      await settings.refresh();

      const document = controller.list();

      expect(entry(document, 'github.maxRetries')).toMatchObject({
        source: 'env',
        value: 7,
      });
      expect(entry(document, 'github.rateLimitReserve')).toMatchObject({
        source: 'database',
        value: 250,
      });
      expect(entry(document, 'github.requestTimeoutMs')).toMatchObject({
        source: 'default',
      });
    });

    it('carries the document revision and the overlay status', async () => {
      prisma.put('dispatch.enabled', true);
      await settings.refresh();

      const document = controller.list();

      expect(document.status).toBe('loaded');
      expect(document.revision).toBe(1);
      expect(document.overlay.overriddenKeys).toBe(1);
    });

    it('says the overlay is unavailable rather than pretending there are no overrides', async () => {
      prisma.down = 'connection refused';
      await settings.refresh();

      const document = controller.list();

      expect(document.status).toBe('unavailable');
      expect(document.overlay.warning).toBe(
        'operator_settings_overlay_unavailable',
      );
      expect(document.overlay.problem).toContain('connection refused');
    });

    it('reports a value the registry rejected instead of presenting it as in force', async () => {
      await build({ GITHUB_MAX_RETRIES: 'lots' });

      const item = entry(controller.list(), 'github.maxRetries');

      expect(item.value).toBe(3);
      expect(item.source).toBe('default');
      expect(item.invalid).toMatchObject({ source: 'env' });
    });
  });

  // -------------------------------------------------------------------------
  // PATCH
  // -------------------------------------------------------------------------

  describe('PATCH', () => {
    it('applies only the keys it was sent', async () => {
      const document = await controller.patch(
        { 'dispatch.enabled': true } as never,
        ADMIN,
      );

      expect(entry(document, 'dispatch.enabled').value).toBe(true);
      expect(prisma.rows.size).toBe(1);
      expect([...prisma.rows.keys()]).toEqual(['dispatch.enabled']);
    });

    it('does not clear the keys it was NOT sent', async () => {
      // The correctness requirement, not an optimisation. A `PATCH` that wrote
      // every rendered key would materialise today's defaults into rows and
      // freeze this deployment against every future change to them.
      prisma.put('reconciler.intervalMs', 30_000);
      prisma.put('github.maxRetries', 5);
      await settings.refresh();

      await controller.patch({ 'dispatch.enabled': true } as never, ADMIN);

      expect(new Set(prisma.rows.keys())).toEqual(
        new Set([
          'reconciler.intervalMs',
          'github.maxRetries',
          'dispatch.enabled',
        ]),
      );
      expect(settings.get('reconciler.intervalMs')).toBe(30_000);
      expect(settings.get('github.maxRetries')).toBe(5);
    });

    it('treats null as "revert to the environment", not "store null"', async () => {
      await build({ RECONCILER_INTERVAL_MS: '45000' });
      prisma.put('reconciler.intervalMs', 30_000);
      await settings.refresh();
      expect(settings.get('reconciler.intervalMs')).toBe(30_000);

      const document = await controller.patch(
        { 'reconciler.intervalMs': null } as never,
        ADMIN,
      );

      // 45000, the operator's env value — NOT the code's 60000 default.
      // ADR-0018 §2: a revert must not erase a choice made outside the running
      // system.
      expect(entry(document, 'reconciler.intervalMs')).toMatchObject({
        value: 45_000,
        source: 'env',
      });
      expect(prisma.rows.has('reconciler.intervalMs')).toBe(false);
    });

    it('falls all the way to the code default when the environment says nothing', async () => {
      prisma.put('reconciler.intervalMs', 30_000);
      await settings.refresh();

      const document = await controller.patch(
        { 'reconciler.intervalMs': null } as never,
        ADMIN,
      );

      expect(entry(document, 'reconciler.intervalMs')).toMatchObject({
        value: 60_000,
        source: 'default',
      });
    });

    it('accepts several keys in one body', async () => {
      const document = await controller.patch(
        {
          'dispatch.enabled': true,
          'github.maxRetries': 6,
          'runners.claudeCodeLocal.permissionMode': 'plan',
        } as never,
        ADMIN,
      );

      expect(entry(document, 'dispatch.enabled').value).toBe(true);
      expect(entry(document, 'github.maxRetries').value).toBe(6);
      expect(
        entry(document, 'runners.claudeCodeLocal.permissionMode').value,
      ).toBe('plan');
    });

    it('bumps the revision, so a client holding the old one is now stale', async () => {
      const before = controller.list().revision;

      const after = await controller.patch(
        { 'dispatch.enabled': true } as never,
        ADMIN,
      );

      expect(after.revision).toBe((before ?? 0) + 1);
    });

    it('records who wrote it', async () => {
      await controller.patch({ 'dispatch.enabled': true } as never, ADMIN);

      expect(prisma.rows.get('dispatch.enabled')).toBeDefined();
      expect(prisma.audits).toHaveLength(1);
      expect(prisma.audits[0]).toMatchObject({
        actorUserId: ADMIN.id,
        action: 'operator_settings:set',
        targetType: 'operator_settings',
        targetId: 'dispatch.enabled',
      });
    });

    describe('If-Match', () => {
      it('applies the change when the revision matches', async () => {
        prisma.put('github.maxRetries', 5);
        await settings.refresh();
        const current = controller.list().revision;

        const document = await controller.patch(
          { 'dispatch.enabled': true } as never,
          ADMIN,
          String(current),
        );

        expect(entry(document, 'dispatch.enabled').value).toBe(true);
      });

      it('answers 409 for a stale revision and writes nothing', async () => {
        prisma.put('github.maxRetries', 5);
        await settings.refresh();

        await expect(
          controller.patch({ 'dispatch.enabled': true } as never, ADMIN, '0'),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(prisma.rows.has('dispatch.enabled')).toBe(false);
      });

      it('checks against the database, not against a cached revision', async () => {
        // Somebody else writes between this client's GET and its PATCH. The
        // in-memory overlay refreshes on a 15-second loop, so without the
        // re-read in the handler this would be accepted against a revision
        // that has already moved — which is the entire failure `If-Match`
        // exists to prevent.
        const stale = controller.list().revision;
        prisma.revision += 1n;

        await expect(
          controller.patch(
            { 'dispatch.enabled': true } as never,
            ADMIN,
            String(stale),
          ),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('accepts a quoted ETag, which is the form a browser round-trips', async () => {
        const current = controller.list().revision;

        await expect(
          controller.patch(
            { 'dispatch.enabled': true } as never,
            ADMIN,
            `"${current}"`,
          ),
        ).resolves.toBeDefined();
      });

      it('accepts the RFC wildcard as "do not check"', async () => {
        await expect(
          controller.patch({ 'dispatch.enabled': true } as never, ADMIN, '*'),
        ).resolves.toBeDefined();
      });

      it('rejects a header that is not a revision at all', async () => {
        await expect(
          controller.patch(
            { 'dispatch.enabled': true } as never,
            ADMIN,
            'yesterday',
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('refuses rather than guessing when the revision cannot be read', async () => {
        prisma.down = 'connection refused';

        await expect(
          controller.patch({ 'dispatch.enabled': true } as never, ADMIN, '3'),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });

    describe('secrets', () => {
      it('lets an operator holding the secret permission rotate a credential', async () => {
        const document = await controller.patch(
          { 'github.token': 'ghp_Rk8Wp3Zt6Nx2Vd9Mq5Jb7Ly4Hc1Fs' } as never,
          ADMIN,
        );

        expect(entry(document, 'github.token')).toMatchObject({
          secret: true,
          configured: true,
          source: 'database',
        });
        // Sealed, not stored in the clear.
        const row = prisma.rows.get('github.token');
        expect(row?.secretCiphertext).toBeTruthy();
        expect(row?.value).toBeNull();
      });

      it('refuses a secret write from an operator without the second permission', async () => {
        await expect(
          controller.patch(
            { 'github.token': 'ghp_Rk8Wp3Zt6Nx2Vd9Mq5Jb7Ly4Hc1Fs' } as never,
            TUNER,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.rows.size).toBe(0);
      });

      it('refuses the whole body when a secret is mixed in with allowed keys', async () => {
        // A partial application would be worse than a refusal: the operator
        // would see some of their form land and have to work out which.
        await expect(
          controller.patch(
            {
              'dispatch.enabled': true,
              'github.token': 'ghp_Rk8Wp3Zt6Nx2Vd9Mq5Jb7Ly4Hc1Fs',
            } as never,
            TUNER,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.rows.size).toBe(0);
      });

      it('still lets that operator change non-secret keys', async () => {
        await expect(
          controller.patch({ 'dispatch.enabled': true } as never, TUNER),
        ).resolves.toBeDefined();
      });

      it('names the secret permission in the refusal, so the message is actionable', async () => {
        await expect(
          controller.patch(
            { 'supervisor.model.apiKey': 'sk-ant-api03-Zx4Nq8' } as never,
            TUNER,
          ),
        ).rejects.toThrow(/operator_settings:write_secret/);
      });
    });

    it('rejects a value the registry refuses, and does not write it', async () => {
      await expect(
        controller.patch({ 'github.maxRetries': 99 } as never, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.rows.size).toBe(0);
    });

    it('rejects an unknown key at the controller too, not only in the DTO', async () => {
      await expect(
        controller.patch({ 'github.notAKey': 1 } as never, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // The body schema
  // -------------------------------------------------------------------------

  describe('the PATCH body schema', () => {
    it('is what the global pipe actually enforces on the wire', () => {
      // The specs below assert the schema; this asserts it is WIRED. A DTO
      // that is correct and not reached would leave every one of them true and
      // the endpoint unvalidated, which is the failure mode a schema-only test
      // cannot see.
      const pipe = new ZodValidationPipe();
      const metadata = {
        type: 'body' as const,
        metatype: PatchOperatorSettingsDto,
      };

      expect(() => pipe.transform({ nope: 1 }, metadata)).toThrow();
      expect(pipe.transform({ 'dispatch.enabled': true }, metadata)).toEqual({
        'dispatch.enabled': true,
      });
    });

    it('accepts a sparse body', () => {
      expect(
        patchOperatorSettingsSchema.safeParse({ 'dispatch.enabled': true })
          .success,
      ).toBe(true);
    });

    it('accepts null for a key', () => {
      expect(
        patchOperatorSettingsSchema.safeParse({ 'dispatch.enabled': null })
          .success,
      ).toBe(true);
    });

    it('refuses an unknown key before anything is written', () => {
      const result = patchOperatorSettingsSchema.safeParse({
        'dispatch.enabled': true,
        'dispatch.enbaled': true,
      });

      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(
        'is not a managed setting key',
      );
    });

    it('refuses an empty body', () => {
      expect(patchOperatorSettingsSchema.safeParse({}).success).toBe(false);
    });

    it('refuses a value shape no setting can have', () => {
      expect(
        patchOperatorSettingsSchema.safeParse({
          'dispatch.enabled': { nested: true },
        }).success,
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Probes routing
  // -------------------------------------------------------------------------

  describe('POST probes/:probe', () => {
    it('refuses an unknown probe with the list of real ones', async () => {
      await expect(controller.probe('rm-rf')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(controller.probe('rm-rf')).rejects.toThrow(/github-token/);
    });

    it('hands a known probe to the probes service', async () => {
      const run = jest.fn().mockResolvedValue({ ok: true });
      const withProbes = new OperatorSettingsController(settings, {
        run,
      } as unknown as OperatorProbesService);

      await withProbes.probe('github-token');

      expect(run).toHaveBeenCalledWith('github-token', {});
    });

    it('passes a repository id through when one is given', async () => {
      const run = jest.fn().mockResolvedValue({ ok: true });
      const withProbes = new OperatorSettingsController(settings, {
        run,
      } as unknown as OperatorProbesService);

      await withProbes.probe('github-repo', {
        repositoryId: '00000000-0000-4000-8000-0000000000ff',
      } as never);

      expect(run).toHaveBeenCalledWith('github-repo', {
        repositoryId: '00000000-0000-4000-8000-0000000000ff',
      });
    });
  });
});
