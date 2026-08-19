/**
 * The single import site for the app's webfont.
 *
 * `@fontsource-variable/inter` is bundled, not linked: the production CSP
 * (`infra/nginx/csp.conf`) is `font-src 'self' data:`, so a Google Fonts link
 * is blocked outright — and it is not being relaxed for a font. Vite emits the
 * `.woff2` with a content hash, and `apps/web/nginx.conf` already serves
 * woff2 with `expires 1y; immutable`.
 *
 * The `wght` (weight-axis-only) stylesheet rather than the full `index.css`:
 * it drops the optical-size axis the app never varies, which is the larger of
 * the two axes in the variable file.
 *
 * Imported HERE and nowhere else. A second import in a component would ship
 * the @font-face rules twice and, worse, make the font's presence depend on
 * that component being mounted.
 */
import '@fontsource-variable/inter/wght.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { CssBaseline } from '@mui/material';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <CssBaseline />
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
