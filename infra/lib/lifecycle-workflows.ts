import { Duration, RemovalPolicy, Stack, Validations, type CfnElement } from 'aws-cdk-lib';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  DefinitionBody,
  Fail,
  JsonPath,
  LogLevel,
  StateMachine,
  Succeed,
  TaskInput,
  type Chain,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct, type IConstruct } from 'constructs';
import type { EnvConfig } from './config.js';
import { hearthFunction } from './hearth-function.js';
import type { GameInfraStack } from './stacks/game-infra.js';

export interface LifecycleWorkflowsProps {
  readonly config: EnvConfig;
  readonly serversTable: ITableV2;
  readonly gameInfra: readonly GameInfraStack[];
}

/** Acknowledges cdk-nag's IAM5 for exactly these wildcard resources (v3 needs one per finding). */
function acknowledgeWildcards(construct: IConstruct, resources: readonly string[], reason: string) {
  for (const resource of resources) {
    Validations.of(construct).acknowledge({ id: `AwsSolutions-IAM5[Resource::${resource}]`, reason });
  }
}

/** How cdk-nag names a function's "any version" ARN in its findings. */
function anyVersionArn(fn: NodejsFunction): string {
  return `<${Stack.of(fn).getLogicalId(fn.node.defaultChild as CfnElement)}.Arn>:*`;
}

function requireId(id: string | undefined): string {
  if (!id) throw new Error('Launch template has no ID');
  return id;
}

type StepFactory = (id: string, fn: NodejsFunction, task: string, retry?: Retry) => LambdaInvoke;

/** Invokes a task Lambda with `{ task, input }`; its result becomes the next step's input. */
function invoke(scope: Construct, id: string, fn: NodejsFunction, task: string): LambdaInvoke {
  return new LambdaInvoke(scope, id, {
    lambdaFunction: fn,
    payload: TaskInput.fromObject({ task, input: JsonPath.entirePayload }),
    payloadResponseOnly: true,
  });
}

interface Retry {
  error: string;
  interval: Duration;
  maxAttempts: number;
  backoffRate?: number;
}

// Waits are task retries on NotReady; these bound how long each wait may take.
const RETRY_VOLUME: Retry = { error: 'NotReady', interval: Duration.seconds(5), maxAttempts: 60 }; // 5 min
const RETRY_AGENT: Retry = { error: 'NotReady', interval: Duration.seconds(10), maxAttempts: 90 }; // 15 min
const RETRY_STOPPED: Retry = { error: 'NotReady', interval: Duration.seconds(5), maxAttempts: 120 }; // 10 min
const RETRY_CAPACITY: Retry = { error: 'CapacityError', interval: Duration.seconds(30), maxAttempts: 4, backoffRate: 2 };

/**
 * The create, start and stop workflows (see "Server lifecycle" in the architecture doc) and their
 * task Lambdas from services/workflows, grouped into three functions by the permissions they need.
 */
export class LifecycleWorkflows extends Construct {
  readonly createServer: StateMachine;
  readonly startServer: StateMachine;
  readonly stopServer: StateMachine;

  constructor(scope: Construct, id: string, props: LifecycleWorkflowsProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const { env } = props.config;
    const table = props.serversTable;

    // Where to launch, per game region: subnets and the launch template version each deploy produced
    // (CloudFormation never moves a template's default version, so launches name it).
    const gameInfra = Object.fromEntries(
      props.gameInfra.map((infra) => [
        infra.region,
        {
          subnetIds: infra.vpc.publicSubnets.map((subnet) => subnet.subnetId),
          launchTemplates: Object.fromEntries(
            Object.entries(infra.launchTemplates).map(([game, template]) => [
              game,
              { id: requireId(template.launchTemplateId), version: template.latestVersionNumber },
            ]),
          ),
        },
      ]),
    );
    const environment = { HEARTH_ENV: env, SERVERS_TABLE: table.tableName, GAME_INFRA: stack.toJsonString(gameInfra) };
    const fn = (fnId: string, handler: string) =>
      hearthFunction(this, fnId, {
        config: props.config,
        entry: 'workflows/src/lambda.ts',
        handler,
        timeout: Duration.seconds(30),
        environment,
      });

    const launch = fn('LaunchTasks', 'launchHandler');
    const power = fn('PowerTasks', 'powerHandler');
    const status = fn('StatusTasks', 'statusHandler');
    this.grantLaunch(launch, props);
    this.grantPower(power, env);
    for (const f of [launch, power, status]) {
      f.addToRolePolicy(
        new PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [table.tableArn] }),
      );
    }

    this.createServer = this.stateMachine('Create', `hearth-${env}-create-server`, status, (step) =>
      step('LaunchInstance', launch, 'launchInstance', RETRY_CAPACITY)
        .next(step('RecordVolume', launch, 'recordVolume', RETRY_VOLUME))
        .next(step('WaitForAgent', status, 'waitForAgent', RETRY_AGENT))
        .next(step('MarkRunning', status, 'markRunning')),
    );
    this.startServer = this.stateMachine('Start', `hearth-${env}-start-server`, status, (step) =>
      step('StartInstance', power, 'startInstance', RETRY_CAPACITY)
        .next(step('WaitForAgent', status, 'waitForAgent', RETRY_AGENT))
        .next(step('MarkRunning', status, 'markRunning')),
    );
    this.stopServer = this.stateMachine('Stop', `hearth-${env}-stop-server`, status, (step) =>
      step('StopInstance', power, 'stopInstance')
        .next(step('WaitForStopped', power, 'waitForStopped', RETRY_STOPPED))
        .next(step('MarkStopped', status, 'markStopped')),
    );
  }

  /**
   * A state machine built from task steps. Every step falls through to "mark FAILED" on any error,
   * keeping its input (serverId, since) and adding the error, so the failure knows which server and why.
   */
  private stateMachine(
    id: string,
    name: string,
    status: NodejsFunction,
    build: (step: StepFactory) => Chain,
  ): StateMachine {
    const scope = new Construct(this, id);
    const invoked = new Set<NodejsFunction>([status]);
    const failed = invoke(scope, 'MarkFailed', status, 'markFailed').next(new Fail(scope, 'Failed'));
    const step: StepFactory = (stepId, fn, task, retry) => {
      invoked.add(fn);
      const s = invoke(scope, stepId, fn, task);
      if (retry) {
        s.addRetry({
          errors: [retry.error],
          interval: retry.interval,
          maxAttempts: retry.maxAttempts,
          backoffRate: retry.backoffRate ?? 1,
        });
      }
      s.addCatch(failed, { resultPath: '$.error' });
      return s;
    };
    const machine = new StateMachine(scope, 'StateMachine', {
      stateMachineName: name,
      definitionBody: DefinitionBody.fromChainable(build(step).next(new Succeed(scope, 'Done'))),
      timeout: Duration.minutes(30),
      tracingEnabled: true,
      logs: {
        destination: new LogGroup(scope, 'Logs', { retention: RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
        level: LogLevel.ALL,
        includeExecutionData: true,
      },
    });
    acknowledgeWildcards(
      machine,
      ['*', ...[...invoked].map(anyVersionArn)],
      'CDK-generated: invoking the task Lambdas (any version); log delivery and X-Ray have no resource ARNs.',
    );
    return machine;
  }

  /** Launch: run instances only from our launch templates, into our subnets, and pass the instance role. */
  private grantLaunch(fn: NodejsFunction, props: LifecycleWorkflowsProps) {
    const wildcards: string[] = [];
    for (const infra of props.gameInfra) {
      const arn = (resource: string, region = infra.region) =>
        `arn:${Stack.of(infra).partition}:ec2:${region}:${infra.account}:${resource}`;
      const image = `arn:${Stack.of(infra).partition}:ec2:${infra.region}::image/*`;
      wildcards.push(arn('security-group/*'), arn('network-interface/*'), image, arn('instance/*'), arn('volume/*'));
      const templates = Object.values(infra.launchTemplates).map((t) =>
        arn(`launch-template/${requireId(t.launchTemplateId)}`),
      );
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: ['ec2:RunInstances'],
          resources: [
            ...templates,
            ...infra.vpc.publicSubnets.map((s) => arn(`subnet/${s.subnetId}`)),
            arn('security-group/*'),
            arn('network-interface/*'),
            image,
          ],
        }),
      );
      // The instance and its volumes may only come from our templates.
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: ['ec2:RunInstances'],
          resources: [arn('instance/*'), arn('volume/*')],
          conditions: { ArnLike: { 'ec2:LaunchTemplate': templates } },
        }),
      );
      // Tags from the launch template are applied by RunInstances; later tags only on our own resources.
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: ['ec2:CreateTags'],
          resources: [arn('instance/*'), arn('volume/*')],
          conditions: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } },
        }),
      );
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: ['ec2:CreateTags'],
          resources: [arn('instance/*'), arn('volume/*')],
          conditions: { StringEquals: { 'aws:ResourceTag/app': 'hearth', 'aws:ResourceTag/env': props.config.env } },
        }),
      );
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [infra.instanceRole.roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
        }),
      );
    }
    fn.addToRolePolicy(new PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));
    acknowledgeWildcards(
      fn,
      ['*', ...wildcards],
      'New instances, volumes and interfaces have no ARN before launch; scoped by launch template and tag conditions. DescribeInstances has no resource-level permissions.',
    );
  }

  /** Power: start and stop only this environment's Hearth instances (enforced by tag). */
  private grantPower(fn: NodejsFunction, env: string) {
    const instances = `arn:${Stack.of(this).partition}:ec2:*:${Stack.of(this).account}:instance/*`;
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['ec2:StartInstances', 'ec2:StopInstances'],
        resources: [instances],
        conditions: { StringEquals: { 'aws:ResourceTag/app': 'hearth', 'aws:ResourceTag/env': env } },
      }),
    );
    fn.addToRolePolicy(new PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));
    acknowledgeWildcards(
      fn,
      ['*', instances],
      'Instances are chosen at runtime; limited to this environment by the app and env tag condition. DescribeInstances has no resource-level permissions.',
    );
  }
}
