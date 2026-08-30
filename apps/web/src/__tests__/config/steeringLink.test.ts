/**
 * The link between the project screen and steering (#461, epic #457).
 *
 * A pure module, asserted directly: what these cases protect is a CONTRACT
 * between two screens that never render together, and a contract asserted only
 * through a render is one that both halves can drift out of while every test
 * stays green.
 *
 * The cases are the ones a plausible implementation gets wrong:
 *
 *  - an href whose scope id is not the id the catalogue builds, so the picker
 *    opens on "No scope chosen" and looks like it was told nothing;
 *  - a repository slug's slash left unencoded, which turns one query parameter
 *    into a path;
 *  - the steering permission hard-coded here as well as in
 *    `config/destinations.ts`, which is how an entry point ends up offered to
 *    somebody the API refuses.
 */

import { describe, expect, it } from 'vitest';

import { DESTINATIONS } from '../../config/destinations';
import {
  SCOPE_PARAM,
  STEERING_PATH,
  STEERING_PERMISSION,
  scopeIdFromParams,
  steerProjectHref,
  steerRepositoryHref,
  steeringHref,
} from '../../config/steeringLink';
import {
  UNSCOPED_ID,
  buildScopeCatalogue,
  findScope,
  projectScopeId,
  repositoryScopeId,
} from '../../config/steeringScope';
import {
  PROJECT_ID,
  projectFixture,
  repositoryFixture,
} from '../mocks/repositories';

/** The parameter a browser would hand `SteeringPage`, from a built href. */
function paramsOf(href: string): URLSearchParams {
  return new URL(href, 'https://opifex.test').searchParams;
}

describe('steeringLink', () => {
  describe('The destination registry is the only declaration', () => {
    it('takes the path and the permission from destinations.ts', () => {
      const steering = DESTINATIONS.find(
        (destination) => destination.key === 'steering',
      );

      expect(STEERING_PATH).toBe(steering?.path);
      expect(STEERING_PERMISSION).toBe(steering?.permission);
    });

    it('gates on the write permission steering really enforces', () => {
      // Not `workorders:read`, and not the `projects:read` that opens the
      // screen the links live on. Steering is the one Operate destination on a
      // write permission — deliberately, because it has no list to read — so
      // an account can reach the project screen and hold no right to steer.
      expect(STEERING_PERMISSION).toBe('workorders:write');
    });
  });

  describe('The href carries a scope the picker can resolve', () => {
    it('names a project by the id the catalogue itself builds', () => {
      const projects = [projectFixture()];
      const repositories = [
        repositoryFixture({ projectId: PROJECT_ID, observeEnabled: true }),
        repositoryFixture({
          id: 'second',
          owner: 'acme',
          name: 'legacy',
          fullName: 'acme/legacy',
          observeEnabled: true,
        }),
      ];
      const catalogue = buildScopeCatalogue(projects, repositories);

      const arrived = scopeIdFromParams(paramsOf(steerProjectHref(PROJECT_ID)));

      // The whole contract in one line: what the project screen wrote resolves
      // to the option the picker offers, rather than falling back to unscoped.
      expect(findScope(catalogue.options, arrived).request).toEqual({
        project: PROJECT_ID,
      });
      expect(arrived).toBe(projectScopeId(PROJECT_ID));
    });

    it('survives the slash in a repository slug', () => {
      const href = steerRepositoryHref('acme/legacy');

      // Encoded in the query, decoded on the way out — one parameter, not a
      // second path segment.
      expect(href).toBe('/steering?scope=repository%3Aacme%2Flegacy');
      expect(scopeIdFromParams(paramsOf(href))).toBe(
        repositoryScopeId('acme/legacy'),
      );
    });

    it('reads a visit with no scope as no scope', () => {
      // A direct visit to `/steering`, which has always opened on nothing
      // chosen and still does.
      expect(scopeIdFromParams(new URLSearchParams())).toBe(UNSCOPED_ID);
      expect(paramsOf(steeringHref('anything')).get(SCOPE_PARAM)).toBe(
        'anything',
      );
    });

    it('resolves a link to something gone as no scope, never as something else', () => {
      const catalogue = buildScopeCatalogue(
        [],
        [
          repositoryFixture({ observeEnabled: true }),
          repositoryFixture({
            id: 'second',
            owner: 'acme',
            name: 'legacy',
            fullName: 'acme/legacy',
            observeEnabled: true,
          }),
        ],
      );

      const arrived = scopeIdFromParams(paramsOf(steerProjectHref(PROJECT_ID)));

      // A bookmark to a project since deleted. Unscoped is the NARROW answer
      // since ADR-0020: an exclusive instruction with no scope is refused
      // rather than swept across every observed repository.
      expect(findScope(catalogue.options, arrived).id).toBe(UNSCOPED_ID);
    });
  });
});
