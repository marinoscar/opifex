/**
 * The Control Center's section registry (#347, epic #332).
 *
 * `/admin/settings` replaced a three-tab System Settings page — one switch, a
 * feature-flag record nothing read, and a raw JSON textarea — with the screen
 * epic #332 exists for: an operator configures Opifex here, and the screen
 * says honestly what is configured, what is observed, and which of the two it
 * is looking at.
 *
 * ## This file is the seam the rest of the epic lands in
 *
 * #348 (registry-driven settings), #349 (secrets and test buttons), #350 (the
 * repository ladder) and #351 (change history) each own one section. They are
 * declared here NOW, as `planned`, for the same reason
 * `config/cockpitApi.ts` declared its unwired endpoints before they existed:
 * the shape of the thing is part of what the app communicates, and a section
 * that appears out of nowhere three PRs from now teaches an operator less than
 * one that has been saying "arrives in #350" all along. Landing a section is a
 * status flip here plus its own component — never a change to the shell.
 *
 * ## Why `interface` is separate from `settings`
 *
 * They read different APIs and that difference is not cosmetic.
 * `interface` holds `ui.allowUserThemeOverride`, which lives in the
 * `system_settings` JSONB document behind `GET/PATCH /api/system-settings` and
 * reaches users through `/auth/me`. `settings` (#348) will hold OPERATOR
 * settings — the registry keys behind `operator_settings`, with their own
 * resolution order, reload semantics and secret handling. Collapsing them
 * would put two storage models, two permission stories and two reload stories
 * behind one heading.
 *
 * ## Sections are query parameters, not routes
 *
 * `?section=readiness`. `config/destinations.ts` owns `/admin/settings` as a
 * single destination, and giving each section a path would mean five new
 * routes in `App.tsx` for one destination — which the route-ownership test
 * would accept and a reader would not. A query parameter is deep-linkable,
 * survives a reload, and leaves the navigation model with exactly one entry
 * for this screen.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import ChecklistIcon from '@mui/icons-material/Checklist';
import PaletteIcon from '@mui/icons-material/Palette';
import TuneIcon from '@mui/icons-material/Tune';
import KeyIcon from '@mui/icons-material/Key';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import HistoryIcon from '@mui/icons-material/History';

export type ControlCenterSectionKey =
  | 'readiness'
  | 'interface'
  | 'settings'
  | 'credentials'
  | 'repositories'
  | 'history';

export interface ControlCenterSection {
  key: ControlCenterSectionKey;
  /** The tab label. */
  label: string;
  /** What this section answers, in one sentence. Shown under its heading. */
  description: string;
  Icon: SvgIconComponent;
  /**
   * `live` — the section is wired to an API that exists.
   * `planned` — it renders `NotWiredState` naming the issue that delivers it.
   *
   * A planned section is still REACHABLE, exactly as a planned destination is:
   * an operator who opens the Control Center looking for the credential field
   * should find out where it will be, not that it does not exist.
   */
  status: 'live' | 'planned';
  /**
   * The issue that delivers this section. Present on `live` sections too, so
   * the registry records provenance rather than only intent.
   */
  issue: number;
  /**
   * The VISION §12 phase, verbatim, for `NotWiredState`. Every section of this
   * screen belongs to Phase 5, since the Control Center is a web application.
   */
  phase: string;
}

/** Phase 5 verbatim from VISION §12. Do not paraphrase — see `NotWiredState`. */
const PHASE = 'Phase 5 — Cockpit';

/**
 * The sections, in the order an operator meets them.
 *
 * Readiness is FIRST and is the landing section because it is the only one
 * that answers "is this deployment able to do anything", and every other
 * section is a way of changing an answer it gives.
 */
export const CONTROL_CENTER_SECTIONS: readonly ControlCenterSection[] = [
  {
    key: 'readiness',
    label: 'Readiness',
    description:
      'The chain from an installed binary to a repository the factory may ' +
      'work in, each step showing what was actually observed.',
    Icon: ChecklistIcon,
    status: 'live',
    issue: 347,
    phase: PHASE,
  },
  {
    key: 'interface',
    label: 'Interface',
    description:
      'Application-wide interface policy, stored in system settings and ' +
      'delivered to every user on /auth/me.',
    Icon: PaletteIcon,
    status: 'live',
    issue: 347,
    phase: PHASE,
  },
  {
    key: 'settings',
    label: 'Configuration',
    description:
      'Every operator-managed key — dispatch, the runner, the reconciler, ' +
      'GitHub, timeouts — with its configured value beside the value in ' +
      'force, and what a change actually does.',
    Icon: TuneIcon,
    status: 'planned',
    issue: 348,
    phase: PHASE,
  },
  {
    key: 'credentials',
    label: 'Credentials',
    description:
      'The Claude credential, the GitHub token and the spend ceilings — ' +
      'each stored encrypted, shown masked, and TESTED rather than assumed.',
    Icon: KeyIcon,
    status: 'planned',
    issue: 349,
    phase: PHASE,
  },
  {
    key: 'repositories',
    label: 'Repositories',
    description:
      'The enablement ladder: register, observe, then dispatch — one ' +
      'repository at a time, which is how the observation week ends.',
    Icon: AccountTreeIcon,
    status: 'live',
    issue: 350,
    phase: PHASE,
  },
  {
    key: 'history',
    label: 'History',
    description:
      'Who changed which setting, when, and what it was before — with ' +
      'secrets recorded as a mask rather than a value.',
    Icon: HistoryIcon,
    status: 'planned',
    issue: 351,
    phase: PHASE,
  },
];

/** The landing section. Readiness, for the reason given above. */
export const DEFAULT_SECTION: ControlCenterSectionKey = 'readiness';

/** The query parameter that selects a section. */
export const SECTION_PARAM = 'section';

/**
 * Is this a section key? Used to sanitise `?section=` before it selects a tab.
 *
 * An unrecognised value falls back to the default rather than rendering
 * nothing: a stale bookmark from before a section was renamed should land the
 * operator on Readiness, not on a blank panel.
 */
export function isControlCenterSectionKey(
  value: string | null | undefined,
): value is ControlCenterSectionKey {
  return CONTROL_CENTER_SECTIONS.some((section) => section.key === value);
}

/** The section `?section=` selects, defaulting when it names nothing. */
export function resolveSection(
  value: string | null | undefined,
): ControlCenterSectionKey {
  return isControlCenterSectionKey(value) ? value : DEFAULT_SECTION;
}
