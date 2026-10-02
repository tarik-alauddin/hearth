import { Duration, Validations } from 'aws-cdk-lib';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import {
  Alarm,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  LogQueryWidget,
  MathExpression,
  Metric,
  TextWidget,
  TreatMissingData,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';
import { METRICS, SERVERS_BY_INSTANCE_INDEX, SERVERS_BY_STATUS_INDEX, fleetCheckFunctionName, metricsNamespace } from '@hearth/shared';
import { ALERT_EMAIL } from '../config.js';
import { hearthFunction } from '../hearth-function.js';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

export interface MonitoringStackProps extends HearthStackProps {
  readonly serversTable: ITableV2;
  readonly workflows: Record<'create' | 'start' | 'stop', StateMachine>;
  readonly api: HttpApi;
  /** Lambdas whose errors are real failures (not the task Lambdas, which throw NotReady by design). */
  readonly apiFunctions: readonly NodejsFunction[];
  readonly stateSync: NodejsFunction;
  readonly stateChanges: Rule;
}

const FIVE_MINUTES = Duration.minutes(5);

/**
 * What a healthy Hearth looks like, watched: the fleet check, alarms emailed through SNS, and a
 * dashboard. See "Monitoring" in the architecture doc for the targets.
 */
export class MonitoringStack extends HearthStack {
  readonly alerts: Topic;
  readonly fleetCheck: NodejsFunction;
  readonly dashboard: Dashboard;

  constructor(scope: Construct, props: MonitoringStackProps) {
    super(scope, 'Monitoring', props);
    const { env } = props.config;
    const namespace = metricsNamespace(env);
    const custom = (name: string, statistic: string, dimensionsMap?: Record<string, string>) =>
      new Metric({ namespace, metricName: name, statistic, dimensionsMap, period: FIVE_MINUTES });

    // Fleet check: an independent look for failed, stuck and mismatched servers, and for instances
    // no server knows about. `hearth fleet-check` invokes it by name.
    this.fleetCheck = hearthFunction(this, 'FleetCheck', {
      config: props.config,
      entry: 'events/src/fleet-check-lambda.ts',
      handler: 'handler',
      functionName: fleetCheckFunctionName(env),
      timeout: Duration.seconds(30),
      environment: {
        HEARTH_ENV: env,
        SERVERS_TABLE: props.serversTable.tableName,
        GAME_REGIONS: props.config.gameRegions.join(','),
      },
    });
    this.fleetCheck.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [SERVERS_BY_STATUS_INDEX, SERVERS_BY_INSTANCE_INDEX].map(
          (index) => `${props.serversTable.tableArn}/index/${index}`,
        ),
      }),
    );
    this.fleetCheck.addToRolePolicy(new PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));
    Validations.of(this.fleetCheck).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'DescribeInstances has no resource-level permissions; the fleet check only reads.',
    });
    if (props.config.fleetCheckScheduled) {
      new Rule(this, 'FleetCheckSchedule', {
        description: `Hearth ${env}: fleet check every 15 minutes`,
        schedule: Schedule.rate(Duration.minutes(15)),
        targets: [new LambdaFunction(this.fleetCheck)],
      });
    }

    // Alarms → email. (Subscribing sends a confirmation email that must be accepted once.)
    this.alerts = new Topic(this, 'Alerts', { topicName: `hearth-${env}-alerts`, enforceSSL: true });
    this.alerts.addSubscription(new EmailSubscription(ALERT_EMAIL));
    Validations.of(this.alerts).acknowledge({
      id: 'AwsSolutions-SNS2',
      reason: 'CloudWatch alarms cannot publish to a topic encrypted with the AWS-managed SNS key; alerts carry no secrets.',
    });
    const alarm = (id: string, description: string, metric: IMetric, threshold = 1, evaluationPeriods = 1) => {
      const a = new Alarm(this, id, {
        alarmName: `hearth-${env}-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(new SnsAction(this.alerts));
      return a;
    };

    for (const [name, machine] of Object.entries(props.workflows)) {
      alarm(
        `${name}-workflow-failed`,
        `A ${name} workflow failed or timed out: a player's ${name} broke. See the execution in Step Functions.`,
        new MathExpression({
          expression: 'failed + timedOut + aborted',
          usingMetrics: {
            failed: machine.metricFailed({ period: FIVE_MINUTES, statistic: 'Sum' }),
            timedOut: machine.metricTimedOut({ period: FIVE_MINUTES, statistic: 'Sum' }),
            aborted: machine.metricAborted({ period: FIVE_MINUTES, statistic: 'Sum' }),
          },
          period: FIVE_MINUTES,
        }),
      );
    }
    alarm(
      'unclean-stop',
      'A server stopped without the agent reporting a clean stop: its world may not be saved.',
      // StopClean is 1 or 0 per stop; any 0 in the period means an unclean stop.
      new MathExpression({
        expression: 'samples - clean',
        usingMetrics: { samples: custom(METRICS.stopClean, 'SampleCount'), clean: custom(METRICS.stopClean, 'Sum') },
        period: FIVE_MINUTES,
      }),
    );
    alarm(
      'lambda-errors',
      'API or fleet-check Lambdas are failing repeatedly (a platform bug). Check their logs.',
      new MathExpression({
        expression: [...props.apiFunctions, this.fleetCheck].map((_, i) => `e${i}`).join(' + '),
        usingMetrics: Object.fromEntries(
          [...props.apiFunctions, this.fleetCheck].map((fn, i) => [`e${i}`, fn.metricErrors({ period: FIVE_MINUTES, statistic: 'Sum' })]),
        ),
        period: FIVE_MINUTES,
      }),
      3,
      3,
    );
    alarm('api-5xx', 'The API is returning server errors.', props.api.metricServerError({ period: FIVE_MINUTES, statistic: 'Sum' }), 5);
    alarm(
      'state-sync-lost-events',
      'EC2 state changes were lost before reaching the table: statuses and IPs may be stale.',
      new MathExpression({
        expression: 'dropped + failedDeliveries',
        usingMetrics: {
          dropped: new Metric({
            namespace: 'AWS/Lambda',
            metricName: 'AsyncEventsDropped',
            dimensionsMap: { FunctionName: props.stateSync.functionName },
            statistic: 'Sum',
            period: FIVE_MINUTES,
          }),
          failedDeliveries: new Metric({
            namespace: 'AWS/Events',
            metricName: 'FailedInvocations',
            dimensionsMap: { RuleName: props.stateChanges.ruleName },
            statistic: 'Sum',
            period: FIVE_MINUTES,
          }),
        },
        period: FIVE_MINUTES,
      }),
    );
    alarm('stuck-servers', 'A server has been mid-transition for over 35 minutes. See the fleet check log.', custom(METRICS.stuckServers, 'Maximum'));
    alarm('failed-servers', 'A server is FAILED. `hearth status <id>` shows why.', custom(METRICS.failedServers, 'Maximum'));
    alarm(
      'untracked-instances',
      'A Hearth instance has no server record. `hearth fleet-check` lists it; stop or terminate it if unneeded.',
      custom(METRICS.untrackedInstances, 'Maximum'),
    );
    alarm(
      'status-mismatches',
      'A server is RUNNING but EC2 says its instance is not. See the fleet check log.',
      custom(METRICS.statusMismatches, 'Maximum'),
    );

    // Dashboard: health first, then workflows, platform and fleet.
    const graph = (title: string, metrics: IMetric[], width = 8) => new GraphWidget({ title, left: metrics, width, height: 6 });
    const workflows = Object.entries(props.workflows);
    this.dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: `hearth-${env}`,
      widgets: [
        [
          new TextWidget({
            markdown: `## Hearth ${env}\nTargets: starts ≥ 99% succeed · time to ready p90 < 3 min (start), < 6 min (create) · 100% clean stops · 0 failed or stuck servers.`,
            width: 24,
            height: 2,
          }),
        ],
        [
          graph('Time to ready, p90 (s)', [
            custom(METRICS.timeToReady, 'p90', { Workflow: 'create' }).with({ label: 'create' }),
            custom(METRICS.timeToReady, 'p90', { Workflow: 'start' }).with({ label: 'start' }),
          ]),
          graph('Clean stops (1 = all clean)', [custom(METRICS.stopClean, 'Average').with({ label: 'clean stop rate' })]),
          graph('Fleet', [
            custom(METRICS.runningServers, 'Maximum').with({ label: 'running' }),
            custom(METRICS.failedServers, 'Maximum').with({ label: 'failed' }),
            custom(METRICS.stuckServers, 'Maximum').with({ label: 'stuck' }),
            custom(METRICS.statusMismatches, 'Maximum').with({ label: 'mismatched' }),
            custom(METRICS.untrackedInstances, 'Maximum').with({ label: 'untracked instances' }),
          ]),
        ],
        [
          new LogQueryWidget({
            title: 'Fleet check findings (latest per server or instance)',
            logGroupNames: [this.fleetCheck.logGroup.logGroupName],
            queryLines: [
              'filter msg in ["stuck server", "failed server", "status mismatch", "untracked instance"]',
              'stats latest(@timestamp) as lastSeen, latest(status) as status, latest(state) as instanceState by msg, serverId, instanceId, region',
              'sort lastSeen desc',
            ],
            width: 24,
            height: 6,
          }),
        ],
        [
          graph(
            'Workflows succeeded',
            workflows.map(([name, m]) => m.metricSucceeded({ period: FIVE_MINUTES, statistic: 'Sum', label: name })),
          ),
          graph(
            'Workflows failed or timed out',
            workflows.flatMap(([name, m]) => [
              m.metricFailed({ period: FIVE_MINUTES, statistic: 'Sum', label: `${name} failed` }),
              m.metricTimedOut({ period: FIVE_MINUTES, statistic: 'Sum', label: `${name} timed out` }),
            ]),
          ),
          graph(
            'Workflow duration, p90 (ms)',
            workflows.map(([name, m]) => m.metricTime({ period: FIVE_MINUTES, statistic: 'p90', label: name })),
          ),
        ],
        [
          graph('API requests and 5xx', [
            props.api.metricCount({ period: FIVE_MINUTES, statistic: 'Sum', label: 'requests' }),
            props.api.metricServerError({ period: FIVE_MINUTES, statistic: 'Sum', label: '5xx' }),
          ]),
          graph('API latency, p90 (ms)', [props.api.metricLatency({ period: FIVE_MINUTES, statistic: 'p90', label: 'p90' })]),
          graph(
            'Lambda errors (API, fleet check)',
            [...props.apiFunctions, this.fleetCheck].map((fn) => fn.metricErrors({ period: FIVE_MINUTES, statistic: 'Sum' })),
          ),
        ],
      ],
    });
  }
}
