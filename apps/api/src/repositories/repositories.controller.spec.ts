import { PATH_METADATA } from '@nestjs/common/constants';

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
