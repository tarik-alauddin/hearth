import { App } from 'aws-cdk-lib';

/** An App for tests: skips asset bundling (Go and esbuild builds), which `pnpm synth` covers. */
export function testApp(): App {
  return new App({ context: { 'aws:cdk:bundling-stacks': [] } });
}
