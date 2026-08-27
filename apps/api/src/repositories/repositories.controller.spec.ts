import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import type { AvailableRepositoriesService } from './available-repositories.service';
import { RepositoriesController } from './repositories.controller';
import type { RepositoriesService } from './repositories.service';
import type { ListAvailableRepositoriesQueryDto } from './dto/available-repository.dto';

/**
 * The routing hazard the picker introduced (#401).
 *
 * `GET /repositories/available` is a literal path on a controller that also
 * has `GET /repositories/:id`. Nest matches in DECLARATION ORDER, so below the
 * parameterised route the literal one is swallowed by it and answers 400 from
 * `ParseUUIDPipe` — a failure that looks like a client bug and is not. Nothing
 * else in the build notices, so it is asserted here.
 */
describe('RepositoriesController (#401)', () => {
  /** The route path each handler is decorated with, in declaration order. */
  function declaredRoutes(): { handler: string; path: string }[] {
    const prototype = RepositoriesController.prototype as unknown as Record<
      string,
      unknown
    >;

    return Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((handler) => ({
        handler,
        path: Reflect.getMetadata(
          PATH_METADATA,
          prototype[handler] as object,
        ) as string,
      }))
      .filter((route) => typeof route.path === 'string');
  }

  it('declares the literal `available` route before the `:id` route', () => {
    const routes = declaredRoutes();
    const available = routes.findIndex((route) => route.path === 'available');
    const byId = routes.findIndex((route) => route.path === ':id');

    expect(available).toBeGreaterThanOrEqual(0);
    expect(byId).toBeGreaterThanOrEqual(0);
    expect(available).toBeLessThan(byId);
  });

  /**
   * Retire is ONE request (#405). The controller's job is to make sure it
   * stays one — a handler that returned a plan for the client to execute, or
   * that dropped the actor, would put the atomicity back in the caller's
   * hands.
   */
  describe('retire (#405)', () => {
    function controllerWith(repositories: Partial<RepositoriesService>) {
      return new RepositoriesController(
        repositories as RepositoriesService,
        {} as unknown as AvailableRepositoriesService,
      );
    }

    it('hands the service the id, the reason and the caller', async () => {
      // The actor is the controller's to supply: it is the only layer that can
      // see who is asking, and `audit_events.actor_user_id` is the edge #405
      // exists to record.
      const retire = jest.fn().mockResolvedValue({ id: 'r1' });
      const controller = controllerWith({
        retire,
      } as unknown as Partial<RepositoriesService>);

      await controller.retire('r1', { reason: 'done with it' }, 'user-1');

      expect(retire).toHaveBeenCalledWith(
        'r1',
        { reason: 'done with it' },
        'user-1',
      );
    });

    it('hands un-retire the same three things', async () => {
      const unretire = jest.fn().mockResolvedValue({ id: 'r1' });
      const controller = controllerWith({
        unretire,
      } as unknown as Partial<RepositoriesService>);

      await controller.unretire('r1', { reason: 'back in service' }, 'user-1');

      expect(unretire).toHaveBeenCalledWith(
        'r1',
        { reason: 'back in service' },
        'user-1',
      );
    });

    it('answers 200 rather than 204, because the new state is the answer', async () => {
      // A client needs `retiredAt` and the flattened ladder back to redraw the
      // row without a second GET.
      const codes = (['retire', 'unretire'] as const).map((handler) =>
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          (
            RepositoriesController.prototype as unknown as Record<
              string,
              object
            >
          )[handler],
        ),
      );

      expect(codes).toEqual([200, 200]);
    });

    it('leaves DELETE alone', () => {
      // #405 changes nothing about de-registration: it still refuses a
      // repository with work orders, and still answers 204.
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          (
            RepositoriesController.prototype as unknown as Record<
              string,
              object
            >
          ).remove,
        ),
      ).toBe(204);
      expect(
        declaredRoutes().find((route) => route.handler === 'remove')?.path,
      ).toBe(':id');
    });
  });

  it('passes the query straight through to the picker', async () => {
    const available = {
      list: jest.fn().mockResolvedValue({ status: 'ok' }),
    };
    const controller = new RepositoriesController(
      {} as unknown as RepositoriesService,
      available as unknown as AvailableRepositoriesService,
    );
    const query = {
      page: 2,
      pageSize: 10,
      search: 'billing',
    } as ListAvailableRepositoriesQueryDto;

    await controller.listAvailable(query);

    expect(available.list).toHaveBeenCalledWith(query);
  });
});
