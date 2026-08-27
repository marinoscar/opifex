import type { SupervisorModelProvider } from './supervisor-model.config';

/**
 * Reading a version out of a model id, and deciding whether it is new enough
 * (#393, epic #391).
 *
 * ## Why this file lives in `invocation/`
 *
 * `supervisor-model.port.ts`: "nothing outside `invocation/` may name a model
 * provider", and `test/governing/supervisor-provider-seam.spec.ts` now asserts
 * that over the source. Version parsing cannot be provider-blind — the two
 * vendors spell a version differently enough that one regular expression over
 * both would have to be wrong about one of them — so this file names them,
 * which means it belongs here. The alternative considered was passing the
 * scheme in as data from the settings layer, which would have moved the
 * vendor-shaped knowledge outward while making it look like configuration. It
 * is not configuration: it is a fact about a vendor's catalogue, and the
 * `invocation/` directory is exactly where facts about vendors go.
 *
 * ## The load-bearing rule: an id that does not parse is NOT dropped
 *
 * Everything here returns three states, never two. `version_unrecognised` is
 * the one that matters, and it fails open deliberately: model ids follow no
 * stable scheme across vendors or across time, so the day a vendor changes its
 * naming the newest and most desirable model is precisely the one this file
 * would fail to parse. Hiding it would leave an operator staring at a dropdown
 * with no explanation and no way to select the model they came to select.
 * Marking it costs a line of UI; dropping it costs a support conversation and
 * a wrong conclusion about what the deployment can reach.
 *
 * So: parse where possible, mark where not, and never filter.
 */

/** A major/minor pair. Patch and date components are deliberately not kept. */
export interface ModelVersion {
  readonly major: number;
  readonly minor: number;
}

/** What the filter decided about one model id. Three states, never two. */
export type ModelAdmission =
  /** Parsed, and at or above the floor for its provider. */
  | 'admitted'
  /** Parsed, and older than the floor. Returned, not hidden. */
  | 'below_threshold'
  /** Did not parse. Returned and marked — see this file's header. */
  | 'version_unrecognised';

/**
 * The floor per provider, from epic #391's decision: "OpenAI above 5.4,
 * Anthropic above 4.6".
 *
 * **The comparison is inclusive**, and that is a reading of "above" worth
 * stating rather than leaving to a reader of the code. `gpt-5.4` and
 * `claude-opus-4-6` are the models the epic names as current; a floor that
 * excluded the two ids it was written from would filter out the flagship of
 * each vendor and read as a bug at the first glance anybody gave the dropdown.
 * "Above 5.4" here means "5.4 and newer".
 */
export const MODEL_VERSION_FLOOR: Readonly<
  Record<SupervisorModelProvider, ModelVersion>
> = Object.freeze({
  anthropic: { major: 4, minor: 6 },
  openai: { major: 5, minor: 4 },
});

/** `{ major: 4, minor: 6 }` → `"4.6"`. The form the UI shows an operator. */
export function formatModelVersion(version: ModelVersion): string {
  return `${version.major}.${version.minor}`;
}

/**
 * The version an id carries, or null when this file cannot tell.
 *
 * Null is never an error and never a reason to omit a model. It is the third
 * state, and every caller must carry it forward.
 */
export function parseModelVersion(
  provider: SupervisorModelProvider,
  id: string,
): ModelVersion | null {
  const normalised = id.trim().toLowerCase();
  if (normalised === '') return null;

  return PARSERS[provider](normalised);
}

/**
 * Parse, compare to the floor, and say which of the three states this is.
 *
 * One function so that a caller cannot accidentally implement "unparseable
 * means excluded" by writing the comparison itself — the shape of that mistake
 * is a `?? false` in a filter, and it is invisible in review.
 */
export function classifyModelId(
  provider: SupervisorModelProvider,
  id: string,
): { status: ModelAdmission; version: ModelVersion | null } {
  const version = parseModelVersion(provider, id);

  if (version === null) return { status: 'version_unrecognised', version };

  const floor = MODEL_VERSION_FLOOR[provider];
  const status = isAtLeast(version, floor) ? 'admitted' : 'below_threshold';

  return { status, version };
}

/** Inclusive at the floor. See `MODEL_VERSION_FLOOR` for why. */
function isAtLeast(version: ModelVersion, floor: ModelVersion): boolean {
  if (version.major !== floor.major) return version.major > floor.major;
  return version.minor >= floor.minor;
}

// ---------------------------------------------------------------------------
// The two schemes
// ---------------------------------------------------------------------------

const PARSERS: Readonly<
  Record<SupervisorModelProvider, (id: string) => ModelVersion | null>
> = Object.freeze({
  anthropic: parseTrailingDashedVersion,
  openai: parseLeadingDottedVersion,
});

/** A whole segment that is nothing but digits. */
const DIGITS = /^\d+$/;

/** A whole segment that is nothing but letters. */
const LETTERS = /^[a-z]+$/;

/** `20251001` — a release date, which is not a version component. */
const RELEASE_DATE = /^\d{8}$/;

/** A bare number with at most one decimal place: `5`, `5.4`, `4.1`. */
const DOTTED_NUMBER = /^(\d+)(?:\.(\d+))?$/;

/**
 * Anthropic: the version is the DASH-SEPARATED NUMERIC RUN AT THE END, after
 * an optional trailing release date.
 *
 * `claude-opus-4-6` → 4.6. `claude-haiku-4-5-20251001` → 4.5, and getting that
 * to be 4.5 rather than "4.5.20251001" is the whole reason the date is stripped
 * first: the date is when a snapshot was published, not which version it is,
 * and treating it as a version component would make every dated id sort above
 * every undated one.
 *
 * **Trailing, not anywhere.** `claude-3-5-sonnet-20241022` therefore does NOT
 * parse, and that is the intended answer rather than a gap. Anthropic moved the
 * version from the middle of the id to the end when the 4 series arrived, so a
 * rule that accepted both would be claiming a scheme that no longer exists —
 * and the middle-version ids are all far below the floor anyway, so the cost of
 * marking them `version_unrecognised` is that a handful of superseded models
 * appear in the list marked rather than appearing in it filtered. That is the
 * cheap direction to be wrong in, and it is the direction this whole file
 * leans by design.
 */
function parseTrailingDashedVersion(id: string): ModelVersion | null {
  const segments = id.split('-');

  if (segments.length > 1 && RELEASE_DATE.test(segments[segments.length - 1])) {
    segments.pop();
  }

  // The maximal run of all-digit segments at the end, left to right.
  let start = segments.length;
  while (start > 0 && DIGITS.test(segments[start - 1])) start -= 1;

  const run = segments.slice(start);

  // No trailing number at all, or an id that is nothing BUT numbers and so
  // names no model family. Neither is something to guess at.
  if (run.length === 0 || start === 0) return null;

  // Only the first two are read. A third component would be a patch level,
  // and the floor is expressed in major/minor, so keeping it would add a digit
  // nothing compares against.
  return { major: Number(run[0]), minor: run.length > 1 ? Number(run[1]) : 0 };
}

/**
 * OpenAI: the version is the FIRST SEGMENT AFTER THE FAMILY NAME, and it
 * carries its minor after a DOT rather than after a dash.
 *
 * `gpt-5.4` → 5.4. `gpt-5.4-mini` → 5.4, because the size qualifier trails the
 * version rather than preceding it the way Anthropic's tier name does — which
 * is exactly why this cannot be the same function as the Anthropic one.
 * `gpt-5-pro` → 5.0, and so falls below a 5.4 floor: `gpt-5` really is an
 * older model than `gpt-5.4`, and pricing it as current would be the filter
 * getting its own job backwards.
 *
 * **Anchored immediately after the leading run of purely alphabetic
 * segments**, rather than "the first number anywhere". Without that anchor
 * `gpt-4o-mini-2024-07-18` parses as version 2024 — a dated snapshot of a
 * superseded model, admitted as the newest thing in the catalogue. Anchoring
 * makes it stop at `4o`, which is not a bare number, so the id is marked
 * unrecognised instead. That is the right answer twice over: `4o` is genuinely
 * not a version this scheme can order, and the failure is visible rather than
 * confidently wrong.
 */
function parseLeadingDottedVersion(id: string): ModelVersion | null {
  const segments = id.split('-');

  let index = 0;
  while (index < segments.length && LETTERS.test(segments[index])) index += 1;

  // Nothing after the family name (`chat-latest`), or a first segment that is
  // not alphabetic at all (`o3-mini`), which means there is no family name to
  // anchor to.
  if (index === 0 || index >= segments.length) return null;

  const match = DOTTED_NUMBER.exec(segments[index]);
  if (match === null) return null;

  return { major: Number(match[1]), minor: match[2] ? Number(match[2]) : 0 };
}
