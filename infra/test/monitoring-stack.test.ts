import type { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { EnvName } from '@hearth/shared';
import { envConfig } from '../lib/config.js';
import { addChecks, addEnvironment } from '../lib/hearth-app.js';
import { AccountStack } from '../lib/stacks/account.js';
import { testApp } from './test-app.js';

function monitoring(env: EnvName) {
  const app = testApp();
  addEnvironment(app, envConfig(env));
  addChecks(app);
  app.synth();
  return Template.fromStack(app.node.findChild(`hearth-${env}-Monitoring`) as Stack);
}

describe('MonitoringStack', () => {
  const dev = monitoring('dev');
  const prod = monitoring('prod');

  it('emails alerts to the configured address over TLS only', () => {
    dev.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'tarikza.dev@gmail.com' });
    dev.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
  });

  it('has the agreed alarms, each notifying the alerts topic', () => {
    const alarms = Object.values(dev.findResources('AWS::CloudWatch::Alarm')) as {
      Properties: { AlarmName: string; AlarmActions: unknown[] };
    }[];
    expect(alarms.map((a) => a.Properties.AlarmName).sort()).toEqual(
      [
        'api-5xx',
        'create-workflow-failed',
        'failed-servers',
        'lambda-errors',
        'start-workflow-failed',
        'state-sync-lost-events',
        'status-mismatches',
        'stop-workflow-failed',
        'stuck-servers',
        'unclean-stop',
      ].map((n) => `hearth-dev-${n}`),
    );
    expect(alarms.every((a) => a.Properties.AlarmActions.length === 1)).toBe(true);
  });

  it('runs the fleet check every 15 minutes in prod only', () => {
    prod.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(15 minutes)' });
    expect(Object.keys(dev.findResources('AWS::Events::Rule'))).toHaveLength(0);
  });

  it('lets the fleet check only query the byStatus index', () => {
    const policies = Object.entries(dev.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith('FleetCheck'))
      .flatMap(([, p]) => (p as { Properties: { PolicyDocument: { Statement: { Action: string; Resource: unknown }[] } } }).Properties.PolicyDocument.Statement);
    expect(policies.map((s) => s.Action)).toEqual(['dynamodb:Query']);
    expect(JSON.stringify(policies[0]?.Resource)).toContain('/index/byStatus');
  });

  it('leaves the task Lambdas (which throw NotReady by design) out of the error alarm', () => {
    const alarm = Object.values(dev.findResources('AWS::CloudWatch::Alarm')).find(
      (a) => (a as { Properties: { AlarmName: string } }).Properties.AlarmName === 'hearth-dev-lambda-errors',
    );
    expect(JSON.stringify(alarm)).not.toMatch(/LaunchTasks|PowerTasks|StatusTasks/);
  });

  it('has a dashboard', () => {
    dev.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: 'hearth-dev' });
  });
});

describe('AccountStack', () => {
  const app = testApp();
  const template = Template.fromStack(new AccountStack(app));

  it('keeps agent releases in one private, versioned bucket that is never deleted', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        BucketName: 'hearth-agent-releases-138300868928',
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
      }),
    });
  });

  it('budgets $50 a month for everything tagged app=hearth, emailing at 80%, 100% and forecast 100%', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetLimit: { Amount: 50, Unit: 'USD' },
        TimeUnit: 'MONTHLY',
        CostFilters: { TagKeyValue: ['user:app$hearth'] },
      }),
      NotificationsWithSubscribers: [
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 80 }) }),
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 100 }) }),
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }) }),
      ],
    });
  });
});
