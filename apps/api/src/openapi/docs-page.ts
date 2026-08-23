// =============================================================================
// The /api/docs page (issue #53)
// =============================================================================
//
// Renders the Scalar API reference: a searchable sectioned sidebar, a built-in
// request client, generated code samples, and dark mode — replacing the stock
// Swagger UI that shipped with the scaffold.
//
// WHY THIS TEMPLATE INSTEAD OF `@scalar/nestjs-api-reference`
// -----------------------------------------------------------------------------
// That package renders a fixed template whose last statement is the
// `Scalar.createApiReference(...)` call. The one-click session auth below has to
// resolve a token BEFORE that call, so it can be handed to Scalar as
// pre-authorization rather than poked into Scalar's internal store afterwards.
// The token cannot be resolved server-side either: the refresh cookie is scoped
// to `path=/api/auth` and is therefore never sent to `/api/docs`. So the fetch
// must happen in the browser, before mount — which is exactly the seam the
// packaged template does not expose. Sixty lines of template we control beats
// string-surgery on generated HTML.
//
// The reference bundle is loaded from a CDN, matching Scalar's own default.
// `API_DOCS_CDN` overrides it, which is the escape hatch for an air-gapped
// deployment that wants to self-host the bundle behind its own nginx.
// =============================================================================

/** Where the standalone Scalar bundle is loaded from. */
export const DEFAULT_SCALAR_CDN =
  'https://cdn.jsdelivr.net/npm/@scalar/api-reference';

export interface DocsPageOptions {
  /** Browser tab title. */
  title: string;
  /** Application version, shown in the header bar. */
  version: string;
  /** Path the spec is fetched from, relative to the app root. */
  specUrl: string;
  /** Override for the reference bundle URL. */
  cdn?: string;
}

export interface DocsUnavailablePageOptions {
  /** Operator-facing explanation of why the reference is missing. */
  message: string;
  /** Path of the machine-readable spec, which is down for the same reason. */
  specUrl: string;
}

/**
 * A 🧱 favicon as a data URI.
 *
 * Inline rather than a served file so the docs page has no second request and
 * no dependency on static-asset routing, which differs between the dev server
 * and the nginx-fronted deployment.
 */
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<text y=".9em" font-size="90">🧱</text></svg>',
  );

/**
 * Renders the complete docs page.
 *
 * Every interpolated value is either JSON-serialized or HTML-escaped; the two
 * inline scripts additionally guard against a `</script` sequence closing the
 * block early, which is the one way a JSON literal can break out of one.
 */
export function renderDocsPage(options: DocsPageOptions): string {
  const cdn = options.cdn || process.env.API_DOCS_CDN || DEFAULT_SCALAR_CDN;

  const scalarConfig = {
    url: options.specUrl,
    theme: 'default',
    // Dark mode follows the OS by default, with Scalar's own toggle left
    // visible so a reader can override it — same posture as the app itself.
    hideDarkModeToggle: false,
    layout: 'modern',
    // Ordering is already deliberate in `tags.ts`; re-sorting here would throw
    // that away and render the sections alphabetically.
    defaultOpenAllTags: false,
    hideModels: false,
    searchHotKey: 'k',
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.title)}</title>
    <link rel="icon" href="${FAVICON}" />
    <style>
      body { margin: 0; }
      #eaf-authbar {
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        padding: 8px 16px; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
        background: #11131e; color: #e7e7e7; border-bottom: 1px solid rgba(255,255,255,.12);
      }
      #eaf-authbar strong { font-weight: 600; }
      #eaf-authbar .eaf-version { color: #8e93a8; }
      #eaf-authbar .eaf-spacer { flex: 1 1 auto; }
      #eaf-authbar button {
        font: inherit; cursor: pointer; padding: 5px 12px; border-radius: 6px;
        border: 1px solid rgba(255,255,255,.2); background: #2f354a; color: inherit;
      }
      #eaf-authbar button:hover { background: #3c435c; }
      #eaf-status::before { content: '●'; margin-right: 6px; }
      #eaf-status.eaf-ok { color: #30beb0; }
      #eaf-status.eaf-warn { color: #ffc90d; }
      #eaf-status.eaf-pending { color: #8e93a8; }
    </style>
  </head>
  <body>
    <div id="eaf-authbar">
      <strong>OPIFEX API</strong>
      <span class="eaf-version">${escapeHtml(options.version)}</span>
      <span class="eaf-spacer"></span>
      <span id="eaf-status" class="eaf-pending">Checking your session…</span>
      <button id="eaf-auth" type="button">Authorize with my session</button>
      <a href="${escapeHtml(options.specUrl)}" style="color:#2cb6f6">openapi.json</a>
    </div>
    <div id="app"></div>
    <script src="${escapeHtml(cdn)}"></script>
    <script>
${buildDocsAuthScript(scalarConfig, SESSION_SECURITY_SCHEME)}
    </script>
  </body>
</html>
`;
}

/**
 * The page served at `/api/docs` when document generation failed at startup.
 *
 * Deliberately self-contained: no CDN bundle, no spec fetch, no script. The one
 * thing that failed is the document, so a page that needs the document to
 * render would fail the same way — and this page's whole job is to be the thing
 * that still works.
 *
 * It names the failure and points at the logs rather than reproducing the
 * error. The stack is in the process log, at `error` level, where an operator
 * can already read it; putting it on an unauthenticated page would leak
 * internals to anyone who can reach `/api/docs`.
 */
export function renderDocsUnavailablePage(
  options: DocsUnavailablePageOptions,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>API Reference Unavailable</title>
    <link rel="icon" href="${FAVICON}" />
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #f7f7f8;
        color: #1a1a1a;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        line-height: 1.6;
      }
      main { max-width: 34rem; padding: 2rem; }
      h1 { font-size: 1.5rem; margin: 0 0 1rem; }
      p { margin: 0 0 1rem; }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: #ececf0;
        border-radius: 3px;
        padding: 0.1em 0.35em;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #131316; color: #e8e8ea; }
        code { background: #26262b; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>API reference unavailable</h1>
      <p>${escapeHtml(options.message)}</p>
      <p>
        The API itself is unaffected — only this reference and
        <code>${escapeHtml(options.specUrl)}</code> are down. They return again
        once the document builds on a restart.
      </p>
    </main>
  </body>
</html>
`;
}

/**
 * The page's only runtime logic: exchange the session cookie for an access
 * token, then mount Scalar pre-authorized with it.
 *
 * Exported, and returned as a standalone string, so `docs-page.spec.ts` can
 * **execute** it against stubbed globals rather than pattern-match the markup.
 * That distinction is not academic — this shipped broken precisely because the
 * tests asserted the page *contained* `fetch('/api/auth/refresh')` and never ran
 * it, so nothing noticed the response was being read one level too shallow.
 *
 * A plain string rather than a serialized TypeScript function on purpose: a
 * function put through `Function.prototype.toString()` carries whatever the
 * compiler emitted, including coverage instrumentation under `test:cov`, which
 * would be broken JavaScript in a browser. A string is inert data, and the spec
 * evaluates exactly the bytes the browser receives.
 */
export function buildDocsAuthScript(config: unknown, scheme: string): string {
  return `      (function () {
        var CONFIG = ${jsonForScript(config)};
        var SCHEME = ${jsonForScript(scheme)};
        var statusEl = document.getElementById('eaf-status');
        var buttonEl = document.getElementById('eaf-auth');

        function setStatus(text, kind) {
          statusEl.textContent = text;
          statusEl.className = 'eaf-' + kind;
        }

        // Exchanges the browser's refresh cookie for a short-lived access
        // token. \`credentials: 'include'\` is required even same-origin here:
        // the cookie is path-scoped to /api/auth, so it rides along only
        // because this request targets that path.
        function fetchSessionToken() {
          return fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'include',
            headers: { Accept: 'application/json' },
          })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (body) {
              // The global response interceptor wraps every JSON body in
              // { data, meta }, so the token is at body.data.accessToken — NOT
              // body.accessToken. Tolerating both mirrors the web client, and
              // means this keeps working whichever shape the endpoint returns.
              var payload = (body && body.data) || body;
              return (payload && payload.accessToken) || null;
            })
            .catch(function () { return null; });
        }

        function mount(token) {
          var config = Object.assign({}, CONFIG);
          if (token) {
            var schemes = {};
            schemes[SCHEME] = { token: token };
            config.authentication = { preferredSecurityScheme: SCHEME, securitySchemes: schemes };
            setStatus('Authorized with your session', 'ok');
          } else {
            setStatus('Not signed in \u2014 sign in, then reload', 'warn');
          }
          window.Scalar.createApiReference('#app', config);
          return token;
        }

        // Re-authorizing means re-mounting, and re-mounting cleanly is what a
        // reload already does — the fetch above runs again on load. The button
        // is for a token that has expired (15 minutes); landing here signed in
        // needs no click at all.
        buttonEl.addEventListener('click', function () { window.location.reload(); });

        // Exposed so the spec can await the bootstrap, and so a reader
        // debugging an authorization problem in the console has something to
        // inspect.
        window.__eafDocsAuth = fetchSessionToken().then(mount);
      })();`;
}

/**
 * Kept in sync with `SECURITY_SCHEMES.JWT_AUTH` by the assertion in
 * `docs-page.spec.ts` — importing it here would drag the whole document
 * builder (and Nest) into a module that only renders a string.
 */
export const SESSION_SECURITY_SCHEME = 'JWT-auth';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * JSON for embedding inside a `<script>` block.
 *
 * `JSON.stringify` alone is not safe there: a `</script` inside any string
 * value ends the block, and `<!--` starts an HTML comment. Both are escaped
 * into equivalent JSON that the parser reads identically.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
