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
  },
  server: { port: 5173, strictPort: true }, // the dev web client's callback origin (infra config)
  test: { environment: 'node' },
});
