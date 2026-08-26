/**
 * What a supervised child inherits from the API process, and nothing else.
 *
 * ## Why this is an allowlist, and why a denylist is not acceptable here
 *
 * This is the load-bearing decision in this file, so it is stated before the
 * list itself.
 *
 * The API process holds `JWT_SECRET`, `POSTGRES_PASSWORD`, `GITHUB_TOKEN` and
 * `SUPERVISOR_MODEL_API_KEY`. Until #334 every one of them was spread into the
 * agent's environment. With the first, the agent can mint itself an admin
 * token and call the control plane that is supervising it; with the second it
 * can reach the database directly and edit the record of its own run. VISION
 * §8 lists "reading or writing credentials" and "modifying budget
 * configuration" as never trustable REGARDLESS OF ANY GRANT — there is no
 * autonomy level at which handing these over is correct, so no configuration
 * flag guards this and none should.
 *
 * A denylist cannot do this job, for two reasons:
 *
 *  1. It has to predict every future secret name. Every variable added to
 *     `.env.example` from now on is exposed by DEFAULT and stays exposed until
 *     someone remembers this file — and the failure is silent, because a
 *     leaked variable changes no behaviour anyone would notice.
 *  2. Epic #332 moves settings into the database behind a resolver with
 *     dotted-path keys (`github.token`). Whatever name-mangling reaches the
 *     environment then, no denylist written today contains it. ADR-0018 is
 *     concrete about the mechanism: `ConfigService.set()` writes its value
 *     into `process.env` under the dotted path, "readable by anything in the
 *     process that reads `process.env` directly, including a child process
 *     spawned with an inherited environment" — and it names this file as one
 *     of the two things that make its own "provably cannot reach it" claim
 *     true rather than false.
 *
 * An allowlist fails the other way: a variable the agent genuinely needs and
 * that nobody added shows up as a run that does not work, immediately, on the
 * first dispatch. That is a bug report; the denylist's failure is a breach
 * nobody files.
 *
 * ## Why names, and never prefixes
 *
 * `CLAUDE_CODE_*` would be a tempting single entry. It would also carry
 * `CLAUDE_CODE_MAX_CONCURRENCY` and `CLAUDE_CODE_LOCAL_ENABLED` — the runner's
 * own limits — into the process those limits exist to constrain, which is
 * precisely the "modifying budget configuration" half of VISION §8. A prefix
 * rule is a small denylist wearing an allowlist's clothes: it admits everything
 * matching a shape, including things that do not exist yet. Every entry below
 * is a whole name.
 *
 * ## What is deliberately NOT here
 *
 * - `NODE_ENV`. Not a secret, but `production` leaking into the workspace makes
 *   the agent's own `npm install` skip devDependencies, so its tests cannot
 *   run. The child is not this process.
 * - `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`. Opifex ships with direct egress
 *   (`infra/compose`), and a proxy URL can itself carry credentials. A
 *   deployment that needs them adds them here as a deliberate act, which is the
 *   point of the mechanism.
 * - `ANTHROPIC_BASE_URL`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`. Same answer:
 *   real, plausible, one line each, and not carried on a guess.
 */
export const INHERITED_ENV_ALLOWLIST: readonly string[] = [
  // Process resolution. `spawn` resolves a bare command name against the
  // child's PATH, so without this the agent cannot start and nor can any tool
  // it reaches for — `git`, `node`, a test runner.
  'PATH',
  // The CLI keeps its state under `$HOME/.claude`, which `base.compose.yml`
  // mounts as a named volume so it survives a rebuild. git also reads
  // `$HOME/.gitconfig`.
  'HOME',
  // The agent's Bash tool spawns a shell. Unset, it falls back to `/bin/sh`,
  // which quietly changes what its commands mean.
  'SHELL',
  // Locale. Wrong or missing, git and node mangle non-ASCII in paths, diffs
  // and commit messages, and the corruption lands in a commit.
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  // So timestamps the run writes match the ones an operator reads.
  'TZ',
  // The credential that authenticates the CLI (#326). Exactly one of these is
  // set; both are listed because which one is an operator's choice about which
  // quota an autonomous run spends. Removing them would break every run —
  // `claude --version` still succeeds unauthenticated, so the runner would go
  // on registering itself healthy while every dispatch failed at auth.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
];

/**
 * The environment for one supervised child: the allowlist, then the overrides.
 *
 * `overrides` are trusted and unfiltered, because they are constructed by this
 * codebase rather than inherited — `buildInvocationEnv()`'s correlation ids,
 * and `RunWorkspaceService`'s `OPIFEX_GIT_TOKEN`, which its credential helper
 * reads out of the environment precisely so the token never becomes an argv
 * element or a literal in `.git/config`. The filter is on what the API process
 * happens to be holding, not on what a caller deliberately hands over.
 *
 * A key set to `undefined` is dropped rather than passed through, which is the
 * contract `SpawnRequest.env` already documented.
 *
 * `inherited` is a parameter so the policy is testable as a pure function
 * without mutating the test runner's own environment.
 */
export function buildChildEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const name of INHERITED_ENV_ALLOWLIST) {
    const value = inherited[name];
    if (value !== undefined) env[name] = value;
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  return env;
}
