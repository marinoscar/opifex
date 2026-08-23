/**
 * Guards the conditional registration of TestAuthModule in AppModule.
 *
 * TestAuthModule exposes POST /api/auth/test/login, which bypasses both OAuth
 * and the email allowlist and can mint an admin session for any email. The
 * registration decision is made at module-evaluation time from process.env, so
 * each case re-imports AppModule with a fresh module registry.
 */
describe('AppModule — TestAuthModule registration', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestAuth = process.env.TEST_AUTH_ENABLED;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;

    if (originalTestAuth === undefined) {
      delete process.env.TEST_AUTH_ENABLED;
    } else {
      process.env.TEST_AUTH_ENABLED = originalTestAuth;
    }
  });

  /**
   * Re-evaluates AppModule under the current env and reports whether
   * TestAuthModule ended up in its imports.
   */
  function importsTestAuthModule(): boolean {
    let registered = false;

    jest.isolateModules(() => {
       
      const { AppModule } = require('./app.module');
       
      const { TestAuthModule } = require('./test-auth/test-auth.module');

      const imports: unknown[] = Reflect.getMetadata('imports', AppModule) ?? [];
      registered = imports.includes(TestAuthModule);
    });

    return registered;
  }

  it('registers TestAuthModule in development by default', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.TEST_AUTH_ENABLED;

    expect(importsTestAuthModule()).toBe(true);
  });

  it('does not register TestAuthModule when TEST_AUTH_ENABLED is false', () => {
    process.env.NODE_ENV = 'development';
    process.env.TEST_AUTH_ENABLED = 'false';

    expect(importsTestAuthModule()).toBe(false);
  });

  it('does not register TestAuthModule in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TEST_AUTH_ENABLED;

    expect(importsTestAuthModule()).toBe(false);
  });

  it('still registers TestAuthModule when TEST_AUTH_ENABLED is explicitly true', () => {
    process.env.NODE_ENV = 'development';
    process.env.TEST_AUTH_ENABLED = 'true';

    expect(importsTestAuthModule()).toBe(true);
  });
});
