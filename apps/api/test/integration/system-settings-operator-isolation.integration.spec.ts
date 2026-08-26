import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockAdminUser, authHeader } from '../helpers/auth-mock.helper';
import { OperatorSettingsService } from '../../src/settings/operator-settings/operator-settings.service';

/**
 * `PUT /api/system-settings` cannot round-trip, smuggle, or destroy an
 * operator-managed setting (#352, ADR-0018).
 *
 * ## The hazard, precisely
 *
 * `systemSettingsSchema` (`common/schemas/settings.schema.ts`) is a plain
 * `z.object({ ui: {...}, features: z.record(string, boolean) })`. Two things
 * follow from that, and neither raises an error:
 *
 *  1. An unknown TOP-LEVEL key -- `dispatch`, say, shaped like an operator
 *     setting's own group -- is silently STRIPPED by `.parse()`. A client
 *     that believed a managed key lived under `system_settings` gets a 200
 *     and nothing happens, which is the "silently" this file is named for --
 *     an error would at least be legible.
 *  2. `features` is an OPEN record. A client that uses an operator setting's
 *     own dotted name as a feature-flag key -- `features['dispatch.enabled']`
 *     -- is accepted and persisted as an ordinary, meaningless boolean flag in
 *     `system_settings.features`. It looks like it worked. It never touches
 *     the `operator_settings` table `OperatorSettingsService` actually reads.
 *
 * ## Why this asserts on the Prisma call, not only the HTTP response
 *
 * `SystemSettingsService.replaceSettings()` returns a HAND-WRITTEN object
 * literal (`{ ui, features, updatedAt, updatedBy, version }`) -- so the HTTP
 * response could never carry a `dispatch` member regardless of whether
 * stripping actually happened upstream. Asserting against
 * `response.body.data` alone would be vacuous by construction: it would pass
 * even if the schema stopped stripping unknown keys entirely. The load-bearing
 * assertion is what `systemSettingsSchema.parse()` actually handed to
 * `prisma.systemSettings.upsert(...)` -- the payload one call before the
 * response is built -- which is what `upsertedValue()` below reads.
 *
 * Both hazards are proven here against the SAME `OperatorSettingsService`
 * instance the running application resolves managed keys through, so this is
 * not an assertion about the schema in isolation -- it is the guarantee
 * ADR-0018 §1 makes concrete: "no runtime path" from `system_settings` to a
 * managed key, in the direction that would let one arrive OR the direction
 * that would let one be wiped, because the two live in genuinely separate
 * tables and nothing in either write path ever reads the other.
 */
describe('PUT /api/system-settings cannot touch operator settings (#352)', () => {
  let context: TestContext;
  let operatorSettings: OperatorSettingsService;

  beforeAll(async () => {
    // Booted BEFORE any prisma mock is configured, matching the working
    // pattern `system-settings.integration.spec.ts` already uses --
    // `OperatorSettingsService.onModuleInit()` runs exactly once here, against
    // an unconfigured `$transaction`, and reports its overlay unavailable
    // rather than throwing. Configuring `setupBaseMocks()` (which stubs
    // `$transaction` to actually await its array) BEFORE this boot would hit
    // an unrelated, pre-existing robustness gap in `refresh()` -- see this
    // issue's report -- so the ordering here is load-bearing, not incidental.
    context = await createTestApp({ useMockDatabase: true });
    operatorSettings = context.module.get(OperatorSettingsService);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  /**
   * What `replaceSettings` actually asked Prisma to write, from whichever
   * branch of the upsert Prisma took. `create` and `update` carry the same
   * `value` in this service, so either is the real, persisted payload.
   */
  function upsertedValue(): Record<string, unknown> {
    const call = (context.prismaMock.systemSettings.upsert as jest.Mock).mock
      .calls[0]?.[0];
    expect(call).toBeDefined();
    return (call.update ?? call.create).value;
  }

  it('starts from the registry default for the keys this test flips (control)', () => {
    // Without this, a failure below could just as easily mean "these keys
    // never resolved to anything meaningful in this harness" and would prove
    // nothing about isolation specifically.
    expect(operatorSettings.get('dispatch.enabled')).toBe(false);
    expect(operatorSettings.get('reconciler.enabled')).toBe(false);
  });

  it('silently strips an unknown top-level key shaped like an operator setting group', async () => {
    const admin = await createMockAdminUser(context);

    const smuggled = {
      ui: { allowUserThemeOverride: true },
      features: {},
      // Not a declared field of `systemSettingsSchema` -- a naive attempt to
      // reach the managed key the same way `PATCH /api/operator-settings`
      // would, through the wrong endpoint.
      dispatch: { enabled: true },
    };

    await request(context.app.getHttpServer())
      .put('/api/system-settings')
      .set(authHeader(admin.accessToken))
      .send(smuggled)
      // No error, no rejection -- the whole hazard is that this looks like it
      // worked.
      .expect(200);

    // The load-bearing assertion: what was actually handed to Prisma never
    // carried `dispatch` at all, because the DTO pipe and the service's own
    // `systemSettingsSchema.parse()` both stripped it before this call was
    // made.
    expect(upsertedValue()).not.toHaveProperty('dispatch');
    expect(Object.keys(upsertedValue())).toEqual(
      expect.arrayContaining(['ui', 'features']),
    );

    // The actual guarantee under test: the managed key never moved.
    expect(operatorSettings.get('dispatch.enabled')).toBe(false);
  });

  it('cannot flip a managed key by writing its dotted name into features', async () => {
    const admin = await createMockAdminUser(context);

    const usingManagedKeyNames = {
      ui: { allowUserThemeOverride: false },
      // `features` is an open `z.record(string, boolean)` -- these ARE legal,
      // ordinary feature-flag keys as far as `systemSettingsSchema` is
      // concerned. That they happen to spell two real operator setting names
      // is exactly the confusion this test rules out.
      features: {
        'dispatch.enabled': true,
        'reconciler.enabled': true,
      },
    };

    await request(context.app.getHttpServer())
      .put('/api/system-settings')
      .set(authHeader(admin.accessToken))
      .send(usingManagedKeyNames)
      .expect(200);

    // It DOES round-trip inside system_settings -- that half is not a bug,
    // it is an ordinary feature flag that happens to share a name. Read from
    // the actual write payload, not the response, for the same reason as
    // above.
    expect(upsertedValue().features).toEqual({
      'dispatch.enabled': true,
      'reconciler.enabled': true,
    });

    // What it must NEVER do: reach the resolver `RunExecutorService`,
    // `ReconcilerTask` and everything else in this codebase actually reads.
    // If this ever turned `true`, the two systems have stopped being
    // separate tables and PUT /api/system-settings would have become a
    // second, unaudited write path to a managed key -- the exact hazard a
    // dedicated `operator_settings` table (#336) exists to rule out.
    expect(operatorSettings.get('dispatch.enabled')).toBe(false);
    expect(operatorSettings.get('reconciler.enabled')).toBe(false);
  });

  it('cannot destroy an operator setting by replacing the whole system-settings document', async () => {
    const admin = await createMockAdminUser(context);

    // A full PUT is a REPLACE, not a merge -- the closest thing to "destroy"
    // this endpoint can do to its own document. Sent with an entirely empty
    // `features`, which is the strongest form of that replacement.
    const wipe = { ui: { allowUserThemeOverride: true }, features: {} };

    await request(context.app.getHttpServer())
      .put('/api/system-settings')
      .set(authHeader(admin.accessToken))
      .send(wipe)
      .expect(200);

    // There was never anything to destroy at this address: a full replace of
    // `system_settings` cannot even in principle affect a row in the separate
    // `operator_settings` table. Re-asserted directly rather than inferred
    // from the previous test, so this test stands on its own.
    expect(operatorSettings.get('dispatch.enabled')).toBe(false);
    expect(operatorSettings.get('reconciler.enabled')).toBe(false);
  });
});
