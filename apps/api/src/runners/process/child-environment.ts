/**
 * What a supervised child inherits from the API process, and nothing else.
 *
 * ## Why this is an allowlist, and why a denylist is not acceptable here
 *
 * This is the load-bearing decision in this file, so it is stated before the
 * list itself.
 *
 * The API process holds `JWT_SECRET`, `POSTGRES_PASSWORD`, `GITHUB_TOKEN` and
 * the model credentials (`MODEL_ANTHROPIC_API_KEY`, `MODEL_OPENAI_API_KEY`,
 * and the superseded `SUPERVISOR_MODEL_API_KEY` — #422 split one key into one
 * per provider, and an allowlist covered all three the day the split landed
 * without an edit here, which is the argument below in miniature). Until #334
 * every one of them was spread into the
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
 * ## The proxy variables, and why they are conditional (#358)
 *
 * Until #358 this section recorded `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
 * as deliberately absent, on the grounds that Opifex ships with direct egress
 * and that a proxy URL can itself carry credentials. The first half was an
 * assumption about one deployment. An operator running behind a corporate
 * egress proxy got an agent that could reach nothing at all, with no error
 * naming the cause: `claude --version` needs no network, so the runner went on
 * registering itself healthy while every dispatch failed at whatever it tried
 * to fetch first. That is the #326 failure shape — configured looks fine,
 * observed looks fine, and it only breaks where real work happens.
 *
 * The second half was, and remains, true. So the variables are carried, and a
 * value whose URL embeds userinfo (`http://user:pass@proxy:8080`) is REFUSED
 * by name rather than passed — see {@link refusedProxyVariables}. That keeps
 * the common case working and fails loudly on the case that motivated the
 * original exclusion, instead of choosing one of them for every operator.
 *
 * Three details that are easy to get wrong:
 *
 *  - **Both cases are listed, and neither is synthesised from the other.**
 *    libcurl and many Node agents read the lowercase names; an operator who
 *    set only `https_proxy` would otherwise hit exactly the silent failure
 *    this exists to end. Synthesising the missing case would be this process
 *    inventing a variable nobody set, and it is not even a safe no-op:
 *    libcurl deliberately ignores uppercase `HTTP_PROXY` because CGI puts
 *    request headers in the `HTTP_*` namespace, so writing one from
 *    `http_proxy` would change what some clients do. What the operator set is
 *    what the child gets, spelled the way they spelled it.
 *  - **`NO_PROXY` is not a URL.** It is a comma-separated suffix list
 *    (`localhost,.internal,10.0.0.0/8`) and is never parsed as one — a check
 *    that URL-parsed it would either throw on a legal value or find userinfo
 *    in a hostname pattern. It carries no credential and passes through
 *    untouched.
 *  - **`ALL_PROXY` is still not here**, nor `NODE_EXTRA_CA_CERTS` or
 *    `SSL_CERT_FILE`. Real, plausible, one line each — and still not carried
 *    on a guess. #358 named three variables and observed three failing; the
 *    fourth gets added when something observes it, not before.
 *
 * ## What is deliberately NOT here
 *
 * - `NODE_ENV`. Not a secret, but `production` leaking into the workspace makes
 *   the agent's own `npm install` skip devDependencies, so its tests cannot
 *   run. The child is not this process.
 * - `ANTHROPIC_BASE_URL`. Real, plausible, one line, and not carried on a
 *   guess.
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
  //
  // `ANTHROPIC_API_KEY` here is the RUNNER's credential and is deliberately
  // NOT the supervisor's metered one — which is why #422 named the supervisor
  // slots `MODEL_<PROVIDER>_API_KEY` rather than reusing the vendor's
  // conventional variable. Had it reused this name, the split would have
  // carried the separately metered key ADR-0015 exists to keep apart into
  // every agent subprocess, through this line, silently.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  // Egress (#358). Whole names, both cases, because different clients read
  // different ones and neither is synthesised from the other — see the header.
  // Naming one here says the NAME may travel; `refusedProxyVariables()` below
  // decides whether this deployment's VALUE may, and drops the ones that embed
  // a credential. `PROXY_URL_ENV_NAMES` and `PROXY_EXEMPTION_ENV_NAMES` are
  // the same six names grouped by whether they are URLs, and
  // `child-environment.spec.ts` asserts the two statements agree.
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
];

/**
 * The proxy variables whose value is a URL, and can therefore carry a
 * credential in its userinfo component.
 *
 * Uppercase first in each pair only because that is the spelling the issue and
 * most documentation use; nothing depends on the order.
 */
export const PROXY_URL_ENV_NAMES: readonly string[] = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
];

/**
 * The proxy variables whose value is a host suffix list, not a URL.
 *
 * `localhost,127.0.0.1,.svc.cluster.local,10.0.0.0/8`. There is no userinfo
 * component to find here and nothing to parse, so these are never inspected —
 * a check that treated this as a URL would be wrong about a legal value.
 */
export const PROXY_EXEMPTION_ENV_NAMES: readonly string[] = [
  'NO_PROXY',
  'no_proxy',
];

/** One proxy variable this process will not hand to a child, and why. */
export interface RefusedProxyVariable {
  /** The variable's name, spelled as the operator spelled it. */
  readonly name: string;
  /**
   * One sentence, fit for a log line, an `unavailableReason` or an API
   * response.
   *
   * It NEVER contains the value. The whole reason this variable is being
   * refused is that its value is believed to hold a password, and a refusal
   * that printed it into the log would leak the credential it was protecting
   * — into the one file an operator is most likely to paste into a bug report.
   */
  readonly reason: string;
}

/**
 * Whether a proxy URL embeds userinfo — a `user:pass@` (or bare `user@`)
 * component before the host.
 *
 * Deliberately NOT `new URL()`. A proxy value is routinely written without a
 * scheme (`proxy.corp.example:3128`), which `URL` rejects outright, so parsing
 * would have to decide between throwing on a value curl accepts and inventing
 * a scheme that changes what the value means. This reads the authority
 * directly instead: everything after `://` if there is one, up to the first
 * `/`, `?` or `#`. A literal `@` in there is userinfo by definition, and an
 * `@` anywhere later (a path, a query) is not — which is why the authority is
 * cut out rather than the whole string searched.
 *
 * A percent-encoded `@` inside the username (`user%40corp:pass@proxy`) still
 * leaves the real delimiter in place, so it is caught.
 */
export function proxyUrlCarriesUserinfo(value: string): boolean {
  const trimmed = value.trim();
  const schemeSeparator = trimmed.indexOf('://');
  const afterScheme =
    schemeSeparator === -1 ? trimmed : trimmed.slice(schemeSeparator + 3);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority =
    authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);

  return authority.includes('@');
}

/**
 * Which proxy variables this process is holding that a child must not get.
 *
 * Exported, and returning data rather than logging or throwing, because two
 * callers need the same answer for different purposes:
 * {@link buildChildEnvironment} to drop the value, and
 * `ClaudeCodeLocalRunner.capabilities()` to declare itself unavailable with
 * this as the stated reason.
 *
 * ## Why this is not a startup refusal, and not a per-spawn throw
 *
 * #358 asks for a loud, named failure, because the bug it reports is a failure
 * that names nothing. Three places could carry it:
 *
 *  - **Exiting at boot**, as `env.validation.ts` does for `JWT_SECRET`. Wrong
 *    here, and the difference is what is left working. Without a signing
 *    secret every authorization decision the process makes is void, so there
 *    is nothing safe to serve; with a credentialed proxy, the API's OWN egress
 *    through that proxy is fine — it is only the child that is denied it. A
 *    hard exit would turn "agents cannot reach the network" into "the product
 *    does not start", for an operator whose proxy may genuinely require basic
 *    auth and who would then have no running Control Center to fix it from.
 *    That is strictly worse than the bug.
 *  - **Throwing from the spawn path.** Also too late, and in the wrong place:
 *    it would answer at every single spawn a question whose answer was fixed
 *    at boot, and it would do so at the moment the issue already complains
 *    about — the middle of a run. It would also make
 *    `ChildProcessSupervisor.start` and `probeBinaryVersion` throw, and
 *    `probe-version.ts` is explicit that its whole contract is to report
 *    rather than reject.
 *  - **Declaring the runner unavailable**, which is what happens. The refusal
 *    means the agent has no egress, and a runner with no egress cannot do
 *    work — so it says so, by name, in the capability manifest, 60 seconds
 *    after boot and before anything is dispatched to it. That is precisely the
 *    shape #358 says to avoid inverted: not a healthy-looking runner failing
 *    every dispatch, but an unavailable runner stating the variable that made
 *    it so. `/api/health/ready` carries it and the Control Center's readiness
 *    chain renders `unavailableReason` verbatim, so the operator reads the
 *    cause on the screen built to answer "why is nothing running".
 *
 * The API log gets one ERROR at construction as well, so the fact is also in
 * the place an operator looks immediately after changing `.env`.
 */
export function refusedProxyVariables(
  inherited: NodeJS.ProcessEnv = process.env,
): RefusedProxyVariable[] {
  const refused: RefusedProxyVariable[] = [];

  for (const name of PROXY_URL_ENV_NAMES) {
    const value = inherited[name];
    if (value === undefined) continue;
    if (!proxyUrlCarriesUserinfo(value)) continue;

    refused.push({
      name,
      reason:
        `${name} embeds credentials in its URL (a \`user:pass@\` component), so it ` +
        'is not passed to agent subprocesses — an autonomous agent must not be ' +
        'handed a credential this process holds. The agent therefore has no ' +
        'egress through that proxy. Point it at a proxy that does not require ' +
        'inline credentials, or authenticate to the existing one some other ' +
        'way, and recreate the api container.',
    });
  }

  return refused;
}

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
 *
 * The allowlist is filtered once more, by VALUE, for the proxy variables
 * (#358): a name may be allowed to travel while this deployment's particular
 * value is not, because that value has a password in it. The refusal applies
 * only to inheritance, for the same reason the whole filter does — an override
 * is something this codebase constructed and handed over deliberately.
 */
export function buildChildEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const refused = new Set(
    refusedProxyVariables(inherited).map((variable) => variable.name),
  );

  for (const name of INHERITED_ENV_ALLOWLIST) {
    const value = inherited[name];
    if (value === undefined) continue;
    if (refused.has(name)) continue;
    env[name] = value;
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  return env;
}
