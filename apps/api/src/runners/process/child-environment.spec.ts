import {
  buildChildEnvironment,
  INHERITED_ENV_ALLOWLIST,
  PROXY_EXEMPTION_ENV_NAMES,
  PROXY_URL_ENV_NAMES,
  proxyUrlCarriesUserinfo,
  refusedProxyVariables,
} from './child-environment';

/**
 * The policy, as a pure function.
 *
 * `child-process-supervisor.spec.ts` proves the supervisor actually applies
 * this to a real spawn; here the question is only what the rule says, which is
 * cheap enough to ask exhaustively.
 */
describe('buildChildEnvironment', () => {
  /** A stand-in for the API process's environment, with real secret names. */
  const apiEnvironment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/root',
    LANG: 'C.UTF-8',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fake',
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-jwt-secret-',
    POSTGRES_PASSWORD: 'hunter2',
    GITHUB_TOKEN: 'ghp_fake',
    MODEL_ANTHROPIC_API_KEY: 'sk-ant-api-fake',
    MODEL_OPENAI_API_KEY: 'sk-proj-api-fake',
    // The superseded name (#422), still readable by the resolver and
    // therefore still a credential this process can be holding.
    SUPERVISOR_MODEL_API_KEY: 'sk-ant-api-fake-old',
  };

  describe('what it refuses to carry', () => {
    it('drops every credential the API process holds', () => {
      // The ones that matter, by name: JWT_SECRET mints an admin token against
      // the control plane supervising the run, POSTGRES_PASSWORD reaches the
      // database behind it, and the rest are spend. #422 turned one model
      // credential into one per provider; each is named here rather than
      // trusted to the allowlist, because a security assertion that stops
      // covering the real variable is worse than none.
      const env = buildChildEnvironment({}, apiEnvironment);

      expect(env.JWT_SECRET).toBeUndefined();
      expect(env.POSTGRES_PASSWORD).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.MODEL_ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.MODEL_OPENAI_API_KEY).toBeUndefined();
      expect(env.SUPERVISOR_MODEL_API_KEY).toBeUndefined();
    });

    it('drops a variable nobody has thought of yet', () => {
      // THE test that distinguishes an allowlist from a denylist. Everything
      // above could pass against four `delete` statements; nothing here could.
      // The names are stand-ins for #332's dotted-path settings keys, which is
      // the concrete reason a denylist was rejected: no denylist written today
      // contains a name that does not exist yet.
      const env = buildChildEnvironment(
        {},
        {
          ...apiEnvironment,
          SOME_FUTURE_SECRET: 'not-yet-invented',
          GITHUB__TOKEN: 'from-the-settings-resolver',
          OPIFEX_SETTING_github_token: 'also-from-the-resolver',
        },
      );

      expect(env.SOME_FUTURE_SECRET).toBeUndefined();
      expect(env.GITHUB__TOKEN).toBeUndefined();
      expect(env.OPIFEX_SETTING_github_token).toBeUndefined();
    });

    it('carries nothing beyond the allowlist and the overrides', () => {
      // Stated as a closed set rather than as a list of absences, so a future
      // widening has to be deliberate rather than incidental.
      const env = buildChildEnvironment(
        { OPIFEX_RUN_ID: 'r1' },
        apiEnvironment,
      );

      for (const name of Object.keys(env)) {
        expect(
          INHERITED_ENV_ALLOWLIST.includes(name) || name === 'OPIFEX_RUN_ID',
        ).toBe(true);
      }
    });

    it('does not let the environment smuggle in an allowlisted name it does not own', () => {
      // A variable that is absent upstream stays absent rather than becoming
      // the string "undefined", which is a value a shell test would treat as
      // set.
      const env = buildChildEnvironment({}, { PATH: '/usr/bin' });

      expect('HOME' in env).toBe(false);
      expect('ANTHROPIC_API_KEY' in env).toBe(false);
    });
  });

  describe('what a coding agent still gets', () => {
    it('carries the variables without which nothing runs', () => {
      const env = buildChildEnvironment({}, apiEnvironment);

      // PATH resolves the binary itself and every tool it reaches for; HOME is
      // where the CLI keeps the state base.compose.yml mounts a volume for.
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.HOME).toBe('/root');
      expect(env.LANG).toBe('C.UTF-8');
    });

    it('carries the credential that authenticates the CLI', () => {
      // Removing this breaks every run — and breaks it invisibly, because
      // `claude --version` succeeds unauthenticated, so the runner would keep
      // registering itself healthy while each dispatch failed at auth.
      expect(
        buildChildEnvironment({}, apiEnvironment).CLAUDE_CODE_OAUTH_TOKEN,
      ).toBe('sk-ant-oat-fake');

      expect(
        buildChildEnvironment({}, { ANTHROPIC_API_KEY: 'sk-ant-api-fake' })
          .ANTHROPIC_API_KEY,
      ).toBe('sk-ant-api-fake');
    });
  });

  describe('overrides', () => {
    it('carries a caller-supplied secret that the allowlist does not name', () => {
      // OPIFEX_GIT_TOKEN is exactly this shape: RunWorkspaceService hands it
      // over deliberately so its credential helper can read it, and it must
      // NOT need to be in the inheritance allowlist to arrive. The filter is
      // on what this process happens to hold, not on what a caller passes.
      const env = buildChildEnvironment(
        { OPIFEX_GIT_TOKEN: 'ghp_handed_over', GIT_TERMINAL_PROMPT: '0' },
        apiEnvironment,
      );

      expect(env.OPIFEX_GIT_TOKEN).toBe('ghp_handed_over');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    });

    it('wins over an inherited value of the same name', () => {
      const env = buildChildEnvironment({ HOME: '/workspace' }, apiEnvironment);

      expect(env.HOME).toBe('/workspace');
    });

    it('removes a key set to undefined, as SpawnRequest documents', () => {
      const env = buildChildEnvironment({ HOME: undefined }, apiEnvironment);

      expect('HOME' in env).toBe(false);
    });
  });

  describe('the proxy escape hatch (#358)', () => {
    // The bug this closes: an operator behind a corporate egress proxy got an
    // agent that could reach nothing, and NOTHING said so — `claude --version`
    // needs no network, so the runner registered healthy and every dispatch
    // died at its first fetch. These tests are the two halves of the answer:
    // a clean proxy arrives, a credentialed one is refused by name.

    it('carries a clean proxy through to the agent', () => {
      const env = buildChildEnvironment(
        {},
        {
          ...apiEnvironment,
          HTTP_PROXY: 'http://proxy.corp.example:3128',
          HTTPS_PROXY: 'http://proxy.corp.example:3128',
        },
      );

      expect(env.HTTP_PROXY).toBe('http://proxy.corp.example:3128');
      expect(env.HTTPS_PROXY).toBe('http://proxy.corp.example:3128');
    });

    it('carries the lowercase spellings, which are the ones curl reads', () => {
      // Not a stylistic duplicate of the case above. libcurl and several Node
      // agents read `https_proxy` and ignore `HTTPS_PROXY` — an operator who
      // set only the lowercase names would otherwise hit the exact silent
      // failure #358 reports, with the fix apparently already applied.
      const env = buildChildEnvironment(
        {},
        {
          ...apiEnvironment,
          http_proxy: 'http://proxy.corp.example:3128',
          https_proxy: 'http://proxy.corp.example:3128',
        },
      );

      expect(env.http_proxy).toBe('http://proxy.corp.example:3128');
      expect(env.https_proxy).toBe('http://proxy.corp.example:3128');
    });

    it('does not synthesise the case the operator did not set', () => {
      // Deliberate, and the header says why: writing `HTTP_PROXY` from
      // `http_proxy` would be this process inventing a variable nobody set,
      // and libcurl ignores the uppercase form ON PURPOSE because CGI puts
      // request headers in the `HTTP_*` namespace. What was set is what
      // travels.
      const env = buildChildEnvironment(
        {},
        { ...apiEnvironment, https_proxy: 'http://proxy.corp.example:3128' },
      );

      expect(env.https_proxy).toBe('http://proxy.corp.example:3128');
      expect('HTTPS_PROXY' in env).toBe(false);
    });

    it('refuses a proxy whose URL embeds credentials', () => {
      // The case that motivated leaving these off the allowlist in the first
      // place (#334): the proxy URL IS a credential, and handing it to an
      // autonomous agent is the thing this whole module exists to prevent.
      const env = buildChildEnvironment(
        {},
        {
          ...apiEnvironment,
          HTTPS_PROXY: 'http://svc-account:hunter2@proxy.corp.example:3128',
        },
      );

      expect('HTTPS_PROXY' in env).toBe(false);
    });

    it('refuses a credentialed proxy in either case, and by name', () => {
      const refused = refusedProxyVariables({
        http_proxy: 'http://svc:hunter2@proxy.corp.example:3128',
        HTTPS_PROXY: 'http://svc:hunter2@proxy.corp.example:3128',
        NO_PROXY: 'localhost',
      });

      expect(refused.map((variable) => variable.name).sort()).toEqual([
        'HTTPS_PROXY',
        'http_proxy',
      ]);
    });

    it('never puts the refused value in the reason it reports', () => {
      // The reason reaches a log line and an `unavailableReason` published on
      // /api/health/ready. A refusal that printed the password it was
      // protecting would leak it into the one file an operator pastes into a
      // bug report — which would be worse than the leak being refused.
      const refused = refusedProxyVariables({
        HTTPS_PROXY: 'http://svc-account:hunter2@proxy.corp.example:3128',
      });

      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toContain('HTTPS_PROXY');
      expect(refused[0].reason).not.toContain('hunter2');
      expect(refused[0].reason).not.toContain('svc-account');
    });

    it('refuses one credentialed variable without dropping a clean sibling', () => {
      // The refusal is per-value, not per-deployment. An operator who got one
      // of the pair wrong keeps the egress the other one gives them.
      const env = buildChildEnvironment(
        {},
        {
          ...apiEnvironment,
          HTTP_PROXY: 'http://proxy.corp.example:3128',
          HTTPS_PROXY: 'http://svc:hunter2@proxy.corp.example:3128',
        },
      );

      expect(env.HTTP_PROXY).toBe('http://proxy.corp.example:3128');
      expect('HTTPS_PROXY' in env).toBe(false);
    });

    it('passes NO_PROXY through untouched, and never parses it as a URL', () => {
      // It is a comma-separated suffix list, not a URL. Parsing it would
      // either throw on a legal value or read a hostname pattern as userinfo,
      // and it carries no credential to refuse.
      const exemptions = 'localhost,127.0.0.1,.svc.cluster.local,10.0.0.0/8';
      const env = buildChildEnvironment(
        {},
        { ...apiEnvironment, NO_PROXY: exemptions, no_proxy: exemptions },
      );

      expect(env.NO_PROXY).toBe(exemptions);
      expect(env.no_proxy).toBe(exemptions);
      expect(
        refusedProxyVariables({ NO_PROXY: 'user@host,localhost' }),
      ).toEqual([]);
    });

    describe('proxyUrlCarriesUserinfo', () => {
      it.each([
        ['http://user:pass@proxy.corp.example:3128', true],
        ['https://user:pass@proxy.corp.example:3128', true],
        // Bare username, no password. Still userinfo, still a credential.
        ['http://user@proxy.corp.example:3128', true],
        // Schemeless, which curl accepts and `new URL()` rejects — the reason
        // this is not a URL parse.
        ['user:pass@proxy.corp.example:3128', true],
        ['proxy.corp.example:3128', false],
        ['http://proxy.corp.example:3128', false],
        ['http://proxy.corp.example:3128/', false],
        // An `@` outside the authority is not userinfo. Cutting the authority
        // out rather than searching the whole string is what gets this right.
        ['http://proxy.corp.example:3128/pac@v1.js', false],
        ['http://proxy.corp.example:3128/?via=a@b', false],
        // A percent-encoded `@` inside the username leaves the real delimiter
        // in place.
        ['http://user%40corp:pass@proxy.corp.example:3128', true],
        ['  http://user:pass@proxy.corp.example:3128  ', true],
        ['', false],
      ])('%s -> %s', (value, expected) => {
        expect(proxyUrlCarriesUserinfo(value)).toBe(expected);
      });
    });
  });

  describe('the allowlist itself', () => {
    it('names no control-plane configuration', () => {
      // A `CLAUDE_CODE_*` prefix rule would be tidier and would carry the
      // runner's own concurrency and spend limits into the process they exist
      // to constrain — the "modifying budget configuration" half of VISION §8.
      // Whole names only.
      expect(INHERITED_ENV_ALLOWLIST).not.toContain(
        'CLAUDE_CODE_MAX_CONCURRENCY',
      );
      expect(INHERITED_ENV_ALLOWLIST).not.toContain(
        'CLAUDE_CODE_LOCAL_ENABLED',
      );
      expect(INHERITED_ENV_ALLOWLIST).not.toContain('DISPATCH_ENABLED');
      expect(INHERITED_ENV_ALLOWLIST).not.toContain('NODE_ENV');
    });

    it('names every proxy variable the refusal logic groups (#358)', () => {
      // The six names are stated twice — once as entries here, once split by
      // whether they are URLs — and the two statements have to agree. A proxy
      // name in one list and not the other is the silent half of #358 back
      // again: a value that is never inherited, or one that is inherited
      // without ever being checked for a credential.
      for (const name of [
        ...PROXY_URL_ENV_NAMES,
        ...PROXY_EXEMPTION_ENV_NAMES,
      ]) {
        expect(INHERITED_ENV_ALLOWLIST).toContain(name);
      }

      expect(
        INHERITED_ENV_ALLOWLIST.filter((name) =>
          name.toUpperCase().includes('PROXY'),
        ).sort(),
      ).toEqual([...PROXY_URL_ENV_NAMES, ...PROXY_EXEMPTION_ENV_NAMES].sort());
    });
  });
});
