import { RemovalPolicy } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, HttpStage, LogGroupLogDestination } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Policy, PolicyStatement, type IRole } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { IStateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { AGENT_CHANNELS, SERVERS_BY_INSTANCE_INDEX, agentChannelParameter, agentReleasesBucket } from '@hearth/shared';
import { hearthFunction } from '../hearth-function.js';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

export interface ApiStackProps extends HearthStackProps {
  readonly serversTable: ITableV2;
  /** Game instance roles, one per game region; they may call the agent routes. */
  readonly instanceRoles: readonly IRole[];
  /** The lifecycle workflows the server operations start. */
  readonly workflows: Record<'create' | 'start' | 'stop', IStateMachine>;
  readonly gameRegions: readonly string[];
}

/** The HTTP API: agent and admin routes (IAM) now; user (Cognito), bot and usage routes later. */
export class ApiStack extends HearthStack {
  readonly api: HttpApi;
  /** SSM parameter agents read at boot to find the API. */
  readonly apiUrlParameter: StringParameter;
  /** The API's Lambdas, for error alarms. */
  readonly functions: NodejsFunction[];

  constructor(scope: Construct, props: ApiStackProps) {
    super(scope, 'Api', props);
    const { env, isProd } = props.config;
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.api = new HttpApi(this, 'Api', { apiName: `hearth-${env}`, createDefaultStage: false });
    new HttpStage(this, 'DefaultStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
      accessLogSettings: {
        destination: new LogGroupLogDestination(
          new LogGroup(this, 'AccessLogs', { retention: RetentionDays.ONE_MONTH, removalPolicy }),
        ),
      },
    });

    // Agent routes: callers sign with their instance role; the handlers map the role session to an instance.
    const agentFunction = (id: string, handler: string) =>
      hearthFunction(this, id, {
        config: props.config,
        entry: 'api/src/agent/lambda.ts',
        handler,
        environment: {
          HEARTH_ENV: env,
          SERVERS_TABLE: props.serversTable.tableName,
          INSTANCE_ROLE_NAMES: props.instanceRoles.map((role) => role.roleName).join(','),
          AGENT_RELEASES_BUCKET: agentReleasesBucket(props.config.account),
        },
      });

    const byInstanceIndexArn = `${props.serversTable.tableArn}/index/${SERVERS_BY_INSTANCE_INDEX}`;
    const configFunction = agentFunction('AgentConfig', 'configHandler');
    configFunction.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [byInstanceIndexArn] }));
    // Which release each agent channel points at (written by the release and promote workflows).
    configFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: AGENT_CHANNELS.map((channel) =>
          this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: agentChannelParameter(env, channel).slice(1) }),
        ),
      }),
    );
    const statusFunction = agentFunction('AgentStatus', 'statusHandler');
    statusFunction.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [byInstanceIndexArn] }));
    statusFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [props.serversTable.tableArn] }),
    );

    const authorizer = new HttpIamAuthorizer();
    this.api.addRoutes({
      path: '/agent/config',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('AgentConfigIntegration', configFunction),
      authorizer,
    });
    this.api.addRoutes({
      path: '/agent/status',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('AgentStatusIntegration', statusFunction),
      authorizer,
    });

    // Admin routes: server operations for the hearth CLI, signed with your own AWS credentials.
    const admin = hearthFunction(this, 'Admin', {
      config: props.config,
      entry: 'api/src/admin/lambda.ts',
      handler: 'handler',
      environment: {
        SERVERS_TABLE: props.serversTable.tableName,
        INSTANCE_ROLE_NAMES: props.instanceRoles.map((role) => role.roleName).join(','),
        HOME_REGION: props.config.homeRegion,
        GAME_REGIONS: props.gameRegions.join(','),
        CREATE_WORKFLOW_ARN: props.workflows.create.stateMachineArn,
        START_WORKFLOW_ARN: props.workflows.start.stateMachineArn,
        STOP_WORKFLOW_ARN: props.workflows.stop.stateMachineArn,
      },
    });
    admin.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Scan'],
        resources: [props.serversTable.tableArn],
      }),
    );
    admin.addToRolePolicy(
      new PolicyStatement({
        actions: ['states:StartExecution'],
        resources: Object.values(props.workflows).map((machine) => machine.stateMachineArn),
      }),
    );
    this.functions = [configFunction, statusFunction, admin];
    const adminIntegration = new HttpLambdaIntegration('AdminIntegration', admin);
    for (const [path, method] of [
      ['/admin/servers', HttpMethod.GET],
      ['/admin/servers', HttpMethod.POST],
      ['/admin/servers/{id}', HttpMethod.GET],
      ['/admin/servers/{id}/start', HttpMethod.POST],
      ['/admin/servers/{id}/stop', HttpMethod.POST],
      ['/admin/servers/{id}/settings', HttpMethod.POST],
    ] as const) {
      this.api.addRoutes({ path, methods: [method], integration: adminIntegration, authorizer });
    }

    this.apiUrlParameter = new StringParameter(this, 'ApiUrl', {
      parameterName: `/hearth/${env}/api-url`,
      stringValue: this.api.apiEndpoint,
      description: `Hearth ${env} API endpoint, read by game agents at boot`,
    });

    // Granted here rather than in GameInfraStack: the role would otherwise depend on this stack
    // while this stack depends on the role (for INSTANCE_ROLE_NAMES), a circular dependency.
    new Policy(this, 'InstanceAccess', {
      roles: [...props.instanceRoles],
      statements: [
        new PolicyStatement({
          actions: ['execute-api:Invoke'],
          resources: [
            this.api.arnForExecuteApi('GET', '/agent/config', '$default'),
            this.api.arnForExecuteApi('POST', '/agent/status', '$default'),
          ],
        }),
        new PolicyStatement({ actions: ['ssm:GetParameter'], resources: [this.apiUrlParameter.parameterArn] }),
      ],
    });
  }
}
