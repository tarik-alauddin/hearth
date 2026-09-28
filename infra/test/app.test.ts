import { App, Stack } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS } from '@hearth/shared';
import { envConfig } from '../lib/config.js';
import { addChecks, addEnvironment } from '../lib/hearth-app.js';

function synthAll() {
  const app = new App();
  for (const name of ENVIRONMENTS) addEnvironment(app, envConfig(name));
  addChecks(app);
  return app.synth();
}

describe('environment stacks', () => {
  const assembly = synthAll();

  it('prefixes every stack name with its environment', () => {
    const names = assembly.stacks.map((s) => s.stackName);
    for (const name of ENVIRONMENTS) {
      expect(names).toContain(`hearth-${name}-Data`);
      expect(names).toContain(`hearth-${name}-GameInfra-us-west-2`);
    }
    expect(names.every((n) => /^hearth-(dev|stage|prod)-/.test(n))).toBe(true);
  });

  it('uses each environment’s own bootstrap qualifier', () => {
    for (const stack of assembly.stacks) {
      const env = stack.stackName.split('-')[1] as (typeof ENVIRONMENTS)[number];
      const template = stack.template as { Parameters: { BootstrapVersion: { Default: string } } };
      expect(template.Parameters.BootstrapVersion.Default).toBe(
        `/cdk-bootstrap/${envConfig(env).qualifier}/version`,
      );
    }
  });

  it('tags every stack with its environment', () => {
    for (const stack of assembly.stacks) {
      expect(stack.tags).toMatchObject({ app: 'hearth', env: stack.stackName.split('-')[1] });
    }
  });
});

describe('cdk-nag', () => {
  it('fails synth on an unacknowledged violation', () => {
    const app = new App();
    new Bucket(new Stack(app, 'Probe'), 'NoLogsNoSsl');
    addChecks(app);
    expect(() => app.synth()).toThrow();
  });
});
