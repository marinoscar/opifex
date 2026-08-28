import {
  buildChildEnvironment,
  INHERITED_ENV_ALLOWLIST,
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
  });
});
