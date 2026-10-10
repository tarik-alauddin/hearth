import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';

// The same feature flags as `cdk synth`, so tests synthesize exactly what gets deployed.
const { context } = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};

/** A stand-in for the built web app, so tests don't need `pnpm --filter @hearth/web build`. */
export const WEB_FIXTURE = fileURLToPath(new URL('./fixtures/web', import.meta.url));

/** An App for tests: cdk.json's context, and no asset bundling (Go and esbuild builds), which `pnpm synth` covers. */
export function testApp(): App {
  // Version reporting matches the CLI's default; it also keeps placeholder stacks non-empty.
  return new App({ analyticsReporting: true, context: { ...context, 'aws:cdk:bundling-stacks': [], webDist: WEB_FIXTURE } });
}
