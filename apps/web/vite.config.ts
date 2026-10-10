import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** `vite` (dev) serves /config.json from config.local.json (gitignored), which
 *  `scripts/web-dev-config.ps1` writes from SSM; deployed sites get theirs from WebContentStack. */
function localConfig(): Plugin {
  return {
    name: 'hearth-local-config',
    configureServer(server) {
      server.middlewares.use('/config.json', (_req, res) => {
        try {
          const body = readFileSync(new URL('./config.local.json', import.meta.url));
          res.setHeader('content-type', 'application/json');
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end('No config.local.json: run scripts/web-dev-config.ps1');
        }
      });
    },
  };
}

// The web app: a static build in dist/, served from S3 through CloudFront (infra FrontendStack).
export default defineConfig({
  plugins: [react(), localConfig()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Hashed file names under assets/ are cached for a year; index.html is never cached.
    assetsDir: 'assets',
    // three.js, in the landing scene's own lazily loaded chunk, is about 540 kB (135 kB gzipped).
    chunkSizeWarningLimit: 600,
    // Never inline assets as data: URLs: the site's content policy loads fonts and images from the
    // site itself only (FrontendStack), and blocks data: fonts.
    assetsInlineLimit: 0,
  },
  server: { port: 5173, strictPort: true }, // the dev web client's callback origin (infra config)
  test: { environment: 'node' },
});
