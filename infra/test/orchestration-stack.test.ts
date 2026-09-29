import type { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { envConfig } from '../lib/config.js';
import { addChecks, addEnvironment } from '../lib/hearth-app.js';
import { testApp } from './test-app.js';

const app = testApp();
addEnvironment(app, envConfig('dev'));
addChecks(app);
app.synth();
const template = Template.fromStack(app.node.findChild('hearth-dev-Orchestration') as Stack);

describe('OrchestrationStack', () => {
  describe('state sync', () => {
    it('receives only the EC2 state changes worth recording', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['aws.ec2'],
          'detail-type': ['EC2 Instance State-change Notification'],
          detail: { state: ['running', 'stopped', 'terminated'] },
        },
        State: 'ENABLED',
        Targets: [Match.objectLike({ Arn: Match.anyValue() })],
      });
    });

    it('runs the state sync handler for this environment', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        Environment: { Variables: Match.objectLike({ HEARTH_ENV: 'dev', SERVERS_TABLE: Match.anyValue() }) },
      });
    });

    it('can only query the index, update items and describe instances', () => {
      const policies = Object.values(template.findResources('AWS::IAM::Policy')) as {
        Properties: { PolicyDocument: { Statement: { Action: string; Resource: unknown }[] } };
      }[];
      const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
      expect(statements.map((s) => s.Action).sort()).toEqual([
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'ec2:DescribeInstances',
      ]);
      const query = statements.find((s) => s.Action === 'dynamodb:Query');
      expect(JSON.stringify(query?.Resource)).toContain('/index/byInstance');
    });
  });
});
