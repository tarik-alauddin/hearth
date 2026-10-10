import { defineConfig } from 'vitest/config';

// Runs every package's tests in one Vitest run (each package's own config still applies).
// In GitHub Actions: failures are annotated on their lines, and scripts/test-summary.mjs turns
// test-results.json into one job summary that names each failing test.
const ci = !!process.env.GITHUB_ACTIONS;

export default defineConfig({
  test: {
    projects: ['apps/*', 'cli', 'infra', 'packages/*', 'services/*', '!**/*.md'],
    includeTaskLocation: true,
    reporters: ci
      ? ['default', ['github-actions', { jobSummary: { enabled: false } }], ['json', { outputFile: 'test-results.json' }]]
      : ['default'],
  },
});
