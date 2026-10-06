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

    it.each(['create', 'start', 'stop', 'destroy'])('has a %s-server state machine with logging and tracing', (op) => {
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
      const q = '\\"';
      const caught = (path: string, next: string) =>
        `${q}ErrorEquals${q}:[${q}States.ALL${q}],${q}ResultPath${q}:${q}${path}${q},${q}Next${q}:${q}${next}${q}`;
      expect(definition('hearth-dev-stop-server')).toContain(caught('$.error', 'MarkFailed'));
      expect(definition('hearth-dev-stop-server')).not.toContain('StopAfterFailure');
      // Create and start first stop the instance, and mark FAILED even if that fails.
      for (const name of ['hearth-dev-create-server', 'hearth-dev-start-server']) {
        const def = definition(name);
        expect(def).toContain(caught('$.error', 'StopAfterFailure'));
        expect(def).not.toContain(caught('$.error', 'MarkFailed'));
        expect(def).toContain(caught('$.cleanupError', 'MarkFailed'));
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

    it('stops the agent before the instance, and stops the instance even if the agent stop fails', () => {
      const def = definition('hearth-dev-stop-server');
      const order = ['StopAgent', 'WaitForAgentStop', 'StopInstance', 'WaitForStopped', 'MarkStopped'].map((s) =>
        def.indexOf(`\\"${s}\\":`),
      );
      expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
      expect(def).toContain('\\"StartAt\\":\\"StopAgent\\"');
      const q = '\\"';
      const stopAnyway = `${q}ErrorEquals${q}:[${q}States.ALL${q}],${q}ResultPath${q}:${q}$.agentStopError${q},${q}Next${q}:${q}StopInstance${q}`;
      expect(def.split(stopAnyway)).toHaveLength(3); // StopAgent and WaitForAgentStop
    });

    it('only runs the stop-agent document, and only on Hearth instances of this environment', () => {
      const send = statementsOf('WorkflowsPowerTasks').filter((s) => s.Action === 'ssm:SendCommand');
      expect(send).toHaveLength(2);
      const onDocument = send.find((s) => JSON.stringify(s.Resource).includes(':document/'));
      expect(onDocument?.Condition).toBeUndefined();
      const onInstances = send.find((s) => JSON.stringify(s.Resource).includes('instance/*'));
      expect(onInstances?.Condition).toEqual({ StringEquals: { 'ssm:resourceTag/app': 'hearth', 'ssm:resourceTag/env': 'dev' } });
    });

    it('only starts and stops Hearth instances of this environment', () => {
      const power = statementsOf('WorkflowsPowerTasks').find((s) => JSON.stringify(s.Action).includes('StartInstances'));
      expect(power?.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/app': 'hearth', 'aws:ResourceTag/env': 'dev' } });
    });

    it('destroys as terminate, wait, delete volumes, delete record; failures mark FAILED', () => {
      const def = definition('hearth-dev-destroy-server');
      const order = ['TerminateInstances', 'WaitForTerminated', 'DeleteVolumes', 'DeleteRecord'].map((s) =>
        def.indexOf(`\\"${s}\\":`),
      );
      expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
      expect(def).toContain('\\"StartAt\\":\\"TerminateInstances\\"');
      expect(def).toContain('MarkFailed');
      expect(def).not.toContain('StopAfterFailure');
    });

    it('only terminates and deletes Hearth instances and volumes of this environment', () => {
      const statements = statementsOf('WorkflowsDestroyTasks');
      const ours = { StringEquals: { 'aws:ResourceTag/app': 'hearth', 'aws:ResourceTag/env': 'dev' } };
      expect(statements.find((s) => s.Action === 'ec2:TerminateInstances')?.Condition).toEqual(ours);
      expect(statements.find((s) => s.Action === 'ec2:DeleteVolume')?.Condition).toEqual(ours);
      expect(JSON.stringify(statements.map((s) => s.Action))).not.toMatch(/RunInstances|StartInstances|StopInstances|PassRole|UpdateItem/);
    });

    it('keeps terminate, delete-volume and delete-item permissions in the destroy function alone', () => {
      for (const prefix of ['WorkflowsLaunchTasks', 'WorkflowsPowerTasks', 'WorkflowsStatusTasks']) {
        const actions = JSON.stringify(statementsOf(prefix).map((s) => s.Action));
        expect(actions).not.toMatch(/TerminateInstances|DeleteVolume|DeleteItem/);
      }
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
