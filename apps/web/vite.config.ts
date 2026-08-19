import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // Vite rejects requests whose Host header it does not recognise, so any
    // hostname the dev server is reached through must be listed here. The dev
    // VPS proxies opifex.dev.marin.cr to this server; without it every page
    // load returns "Blocked request. This host is not allowed."
    allowedHosts: ['opifex.dev.marin.cr', 'localhost', '.localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
