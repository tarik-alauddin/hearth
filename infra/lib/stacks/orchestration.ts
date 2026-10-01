import { Duration, Validations } from 'aws-cdk-lib';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { SERVERS_BY_INSTANCE_INDEX, SYNCED_INSTANCE_STATES } from '@hearth/shared';
import { hearthFunction } from '../hearth-function.js';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';
import { LifecycleWorkflows } from '../lifecycle-workflows.js';
import type { GameInfraStack } from './game-infra.js';

export interface OrchestrationStackProps extends HearthStackProps {
  readonly serversTable: ITableV2;
  readonly gameInfra: readonly GameInfraStack[];
}

/** Server lifecycle: state sync and the create/start/stop workflows; later archiving and sweeps. */
export class OrchestrationStack extends HearthStack {
  readonly stateSync: NodejsFunction;
  readonly workflows: LifecycleWorkflows;
  /** Delivers EC2 state changes to state sync. */
  readonly stateChanges: Rule;

  constructor(scope: Construct, props: OrchestrationStackProps) {
    super(scope, 'Orchestration', props);
    const { env } = props.config;
    const table = props.serversTable;

    // EC2 state changes for every instance in the account and region (the rule keeps only the
    // states worth recording); the handler ignores instances that aren't this environment's servers.
    this.stateSync = hearthFunction(this, 'StateSync', {
      config: props.config,
      entry: 'events/src/state-sync-lambda.ts',
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: { HEARTH_ENV: env, SERVERS_TABLE: table.tableName },
    });
    this.stateSync.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${table.tableArn}/index/${SERVERS_BY_INSTANCE_INDEX}`],
      }),
    );
    this.stateSync.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [table.tableArn] }));
    this.stateSync.addToRolePolicy(new PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));
    Validations.of(this.stateSync).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'ec2:DescribeInstances does not support resource-level permissions.',
    });

    this.stateChanges = new Rule(this, 'Ec2StateChanges', {
      description: `Hearth ${env}: EC2 instance state changes to state sync`,
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: { state: [...SYNCED_INSTANCE_STATES] },
      },
      // Handler errors (e.g. a record not written yet) are retried by Lambda: twice, a minute or two apart.
      targets: [new LambdaFunction(this.stateSync)],
    });

    this.workflows = new LifecycleWorkflows(this, 'Workflows', {
      config: props.config,
      serversTable: table,
      gameInfra: props.gameInfra,
    });
  }
}
