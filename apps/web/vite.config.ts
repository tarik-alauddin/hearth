import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The web app: a static build in dist/, served from S3 through CloudFront (infra FrontendStack).
export default defineConfig({
  plugins: [react()],
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
