/**
 * The link from something an operator is looking at to steering it (#461,
 * epic #457).
 *
 * ## The URL is the carrier, and it is the only carrier
 *
 * `/steering?scope=project:<uuid>` hands a scope from one screen to another
 * with no shared state between them. The alternative — a context, a store, or
 * a "last selected project" the two screens keep in sync — was rejected for
 * the reason the epic gives about scope generally: two places that can answer
 * "which project" independently eventually answer it differently, and the one
 * that is wrong here writes labels across somebody else's backlog. A query
 * parameter has no second copy to drift, survives a reload, and can be pasted
 * into a message.
 *
 * ## The value is an option id from `steeringScope`, not a project id
 *
 * `scope=project:<uuid>` rather than `project=<uuid>`, because the picker
 * offers four kinds of scope (ADR-0020) and a link should be able to name any
 * of them — a repository from a ladder card, the unassigned bucket, the
 * deployment-wide sweep — without this module growing one parameter per kind.
 * `findScope` resolves the id against what the deployment actually has, so a
 * link to a project since deleted or a repository since retired opens the
 * picker on "No scope chosen" rather than on something that no longer exists.
 *
 * ## The permission and the path come from the destination registry
 *
 * `config/destinations.ts` is the single nav/permission registry, and steering
 * is the one Operate destination gated on a WRITE permission
 * (`workorders:write`) — deliberately, since the screen has no list a viewer
 * could read. A caller that hard-coded either string would be a second
 * declaration of a fact that file exists to hold once, and the failure mode is
 * a button offered to somebody the API will refuse.
 */

import { DESTINATIONS } from './destinations';
import {
  UNSCOPED_ID,
  projectScopeId,
  repositoryScopeId,
} from './steeringScope';

const STEERING = DESTINATIONS.find(
  (destination) => destination.key === 'steering',
);

/** Where a steering link points. Read from the registry, never spelled twice. */
export const STEERING_PATH = STEERING?.path ?? '/steering';

/**
 * What it takes to be OFFERED a steering link.
 *
 * Fail-closed on the impossible case: `steering` is a member of
 * `DestinationKey`, so the lookup above always finds it, and an empty string
 * matches no permission — a registry that somehow lost the entry hides the
 * entry point rather than showing it to everybody.
 */
export const STEERING_PERMISSION = STEERING?.permission ?? '';

/** The query parameter carrying the scope. */
export const SCOPE_PARAM = 'scope';

/** `/steering?scope=<id>`, encoded — a repository id contains a slash. */
export function steeringHref(scopeId: string): string {
  const params = new URLSearchParams({ [SCOPE_PARAM]: scopeId });
  return `${STEERING_PATH}?${params.toString()}`;
}

/** Steer one project: every observed repository filed under it. */
export function steerProjectHref(projectId: string): string {
  return steeringHref(projectScopeId(projectId));
}

/** Steer one repository, by `owner/name`. */
export function steerRepositoryHref(fullName: string): string {
  return steeringHref(repositoryScopeId(fullName));
}

/**
 * The scope a visit to `/steering` arrived with.
 *
 * `UNSCOPED_ID` when there is no parameter, which is what a direct visit to
 * `/steering` is — the screen has always opened with nothing chosen and still
 * does.
 */
export function scopeIdFromParams(params: URLSearchParams): string {
  return params.get(SCOPE_PARAM) ?? UNSCOPED_ID;
}
