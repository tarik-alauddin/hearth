import { Stack } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { testApp } from './test-app.js';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS } from '@hearth/shared';
import { envConfig } from '../lib/config.js';
import { addChecks, addEnvironment } from '../lib/hearth-app.js';

function synthAll() {
  const app = testApp();
  for (const env of ENVIRONMENTS) addEnvironment(app, envConfig(env));
  addChecks(app);
  return app.synth();
}

describe('environment stacks', () => {
  const assembly = synthAll();

  it('prefixes every stack name with its environment', () => {
    const names = assembly.stacks.map((s) => s.stackName);
    for (const env of ENVIRONMENTS) {
      expect(names).toContain(`hearth-${env}-Data`);
      expect(names).toContain(`hearth-${env}-GameInfra-us-west-2`);
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

  it('tags every taggable resource with its app and environment', () => {
    for (const stack of assembly.stacks) {
      const env = stack.stackName.split('-')[1];
      const resources = Object.values((stack.template as { Resources: Record<string, unknown> }).Resources) as {
        Properties?: { Tags?: unknown };
      }[];
      for (const resource of resources.filter((r) => Array.isArray(r.Properties?.Tags))) {
        expect(resource.Properties?.Tags).toEqual(
          expect.arrayContaining([
            { Key: 'app', Value: 'hearth' },
            { Key: 'env', Value: env },
          ]),
        );
      }
    }
  });
});

describe('cdk-nag', () => {
  it('fails synth on an unacknowledged violation', () => {
    const app = testApp();
    new Bucket(new Stack(app, 'Probe'), 'NoLogsNoSsl');
    addChecks(app);
    expect(() => app.synth()).toThrow();
  });
});
