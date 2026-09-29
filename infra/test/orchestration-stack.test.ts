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
      const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.startsWith('StateSync'))
        .map(([, p]) => p) as {
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

  describe('workflows', () => {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const definition = (name: string) => {
      const machine = Object.values(machines).find(
        (m) => (m as { Properties: { StateMachineName: string } }).Properties.StateMachineName === name,
      );
      return JSON.stringify((machine as { Properties: { DefinitionString: unknown } }).Properties.DefinitionString);
    };

    it.each(['create', 'start', 'stop'])('has a %s-server state machine with logging and tracing', (op) => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: `hearth-dev-${op}-server`,
        TracingConfiguration: { Enabled: true },
        LoggingConfiguration: Match.objectLike({ Level: 'ALL' }),
      });
    });

    it('runs create as launch, record volume, wait for the agent, mark running', () => {
      const def = definition('hearth-dev-create-server');
      const order = ['LaunchInstance', 'RecordVolume', 'WaitForAgent', 'MarkRunning'].map((s) => def.indexOf(`\\"${s}\\":`));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect(def).toContain('\\"StartAt\\":\\"LaunchInstance\\"');
    });

    it('routes every failure to mark FAILED, keeping the input', () => {
      for (const name of ['hearth-dev-create-server', 'hearth-dev-start-server', 'hearth-dev-stop-server']) {
        const def = definition(name);
        expect(def).toContain('\\"ErrorEquals\\":[\\"States.ALL\\"],\\"ResultPath\\":\\"$.error\\",\\"Next\\":\\"MarkFailed\\"');
      }
    });

    it('bounds the agent wait at 15 minutes', () => {
      expect(definition('hearth-dev-start-server')).toContain(
        '\\"ErrorEquals\\":[\\"NotReady\\"],\\"IntervalSeconds\\":15,\\"MaxAttempts\\":60',
      );
    });

    const statementsOf = (logicalIdPrefix: string) =>
      Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.startsWith(logicalIdPrefix))
        .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }).Properties.PolicyDocument.Statement);

    it('only launches instances and volumes from our launch templates', () => {
      const run = statementsOf('WorkflowsLaunchTasks').filter((s) => s.Action === 'ec2:RunInstances');
      const forInstances = run.find((s) => JSON.stringify(s.Resource).includes('instance/*'));
      expect(JSON.stringify(forInstances?.Condition)).toContain('ec2:LaunchTemplate');
      expect(JSON.stringify(run)).not.toContain('"*"');
    });

    it('only passes the instance role to EC2', () => {
      const pass = statementsOf('WorkflowsLaunchTasks').find((s) => s.Action === 'iam:PassRole');
      expect(pass?.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } });
    });

    it('only starts and stops Hearth instances of this environment', () => {
      const power = statementsOf('WorkflowsPowerTasks').find((s) => JSON.stringify(s.Action).includes('StartInstances'));
      expect(power?.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/app': 'hearth', 'aws:ResourceTag/env': 'dev' } });
    });

    it('keeps EC2 launch permissions out of the status and power functions', () => {
      for (const prefix of ['WorkflowsStatusTasks', 'WorkflowsPowerTasks']) {
        const actions = JSON.stringify(statementsOf(prefix).map((s) => s.Action));
        expect(actions).not.toContain('RunInstances');
        expect(actions).not.toContain('PassRole');
      }
    });
  });
});
