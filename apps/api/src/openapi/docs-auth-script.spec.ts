import { buildDocsAuthScript, renderDocsPage } from './docs-page';

/**
 * Runs the docs page's bootstrap script for real.
 *
 * This suite exists because of a defect it would have caught: the page read the
 * refresh response as `body.accessToken`, but the global `TransformInterceptor`
 * wraps every JSON body in `{ data, meta }`, so the token was always
 * `undefined`. Scalar mounted unauthenticated and every request from the docs
 * page returned 401. The defect was inherited with the code; these tests are
 * what stop it recurring here.
 *
 * Nothing failed, because the only tests over this code asserted that the HTML
 * *contained* `fetch('/api/auth/refresh')` and `credentials: 'include'`. String
 * matching on a script proves it was written, not that it works. So these tests
 * evaluate the exact string the browser is served, against stubbed globals.
 */

interface Harness {
  run: (fetchImpl: jest.Mock) => Promise<unknown>;
  status: () => { text: string; kind: string };
  mountedConfig: () => Record<string, unknown> | undefined;
  clickAuthorize: () => void;
  reloads: () => number;
}

const CONFIG = { url: '/api/openapi.json', layout: 'modern' };
const SCHEME = 'JWT-auth';

/**
 * Evaluates the script with `document`, `fetch` and `window` supplied as
 * parameters, which shadow the globals the browser would provide.
 */
function harness(): Harness {
  const script = buildDocsAuthScript(CONFIG, SCHEME);

  const statusEl = { textContent: '', className: '' };
  let clickHandler: (() => void) | undefined;
  const buttonEl = {
    addEventListener: (_event: string, handler: () => void) => {
      clickHandler = handler;
    },
  };

  let mountedConfig: Record<string, unknown> | undefined;
  let reloads = 0;

  const documentStub = {
    getElementById: (id: string) => (id === 'eaf-status' ? statusEl : buttonEl),
  };
  const windowStub: Record<string, unknown> = {
    Scalar: {
      createApiReference: (_selector: string, config: Record<string, unknown>) => {
        mountedConfig = config;
      },
    },
    location: {
      reload: () => {
        reloads += 1;
      },
    },
  };

  return {
    run: async (fetchImpl) => {
       
      const evaluate = new Function('window', 'document', 'fetch', script);
      evaluate(windowStub, documentStub, fetchImpl);
      return windowStub.__eafDocsAuth;
    },
    status: () => ({ text: statusEl.textContent, kind: statusEl.className }),
    mountedConfig: () => mountedConfig,
    clickAuthorize: () => clickHandler?.(),
    reloads: () => reloads,
  };
}

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body });

describe('docs page bootstrap script', () => {
  it('reads the token out of the { data } envelope the API actually returns', async () => {
    const h = harness();
    const fetchImpl = jest.fn().mockResolvedValue(
      // The exact wire shape: TransformInterceptor wraps the handler's
      // `{ accessToken, expiresIn }` return value.
      jsonResponse({ data: { accessToken: 'tok-123', expiresIn: 900 }, meta: { timestamp: 'x' } }),
    );

    await h.run(fetchImpl);

    expect(h.mountedConfig()?.authentication).toEqual({
      preferredSecurityScheme: SCHEME,
      securitySchemes: { [SCHEME]: { token: 'tok-123' } },
    });
    expect(h.status()).toEqual({ text: 'Authorized with your session', kind: 'eaf-ok' });
  });

  it('also accepts an unwrapped body, so it survives the envelope changing', async () => {
    const h = harness();
    await h.run(jest.fn().mockResolvedValue(jsonResponse({ accessToken: 'tok-bare' })));

    expect(h.mountedConfig()?.authentication).toEqual({
      preferredSecurityScheme: SCHEME,
      securitySchemes: { [SCHEME]: { token: 'tok-bare' } },
    });
  });

  it('calls the refresh endpoint with the cookie attached', async () => {
    const h = harness();
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ data: { accessToken: 't' } }));

    await h.run(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('still mounts, unauthorized, when the caller is not signed in', async () => {
    const h = harness();
    await h.run(jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    expect(h.mountedConfig()).toBeDefined();
    expect(h.mountedConfig()?.authentication).toBeUndefined();
    expect(h.status().text).toContain('Not signed in');
    expect(h.status().kind).toBe('eaf-warn');
  });

  it('still mounts when the refresh request itself fails', async () => {
    const h = harness();
    await h.run(jest.fn().mockRejectedValue(new Error('offline')));

    expect(h.mountedConfig()).toBeDefined();
    expect(h.status().kind).toBe('eaf-warn');
  });

  it('preserves the rest of the configuration when authorizing', async () => {
    const h = harness();
    await h.run(jest.fn().mockResolvedValue(jsonResponse({ data: { accessToken: 't' } })));

    expect(h.mountedConfig()).toMatchObject(CONFIG);
  });

  it('reloads on Authorize, which is what re-runs the exchange', async () => {
    const h = harness();
    await h.run(jest.fn().mockResolvedValue(jsonResponse({ data: { accessToken: 't' } })));

    expect(h.reloads()).toBe(0);
    h.clickAuthorize();
    expect(h.reloads()).toBe(1);
  });

  it('is the same script the rendered page serves', () => {
    // Otherwise these tests could pass against a script the page does not use.
    const html = renderDocsPage({
      title: 'T',
      version: '1.0.0',
      specUrl: '/api/openapi.json',
      cdn: 'https://example.test/bundle.js',
    });
    expect(html).toContain('window.__eafDocsAuth');
    expect(html).toContain('(body && body.data) || body');
  });
});
