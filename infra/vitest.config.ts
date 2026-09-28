import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CDK synth with cdk-nag takes several seconds per app.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
