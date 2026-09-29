import { RemovalPolicy } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, HttpStage, LogGroupLogDestination } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Policy, PolicyStatement, type IRole } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { SERVERS_BY_INSTANCE_INDEX } from '@hearth/shared';
import { hearthFunction } from '../hearth-function.js';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

export interface ApiStackProps extends HearthStackProps {
  readonly serversTable: ITableV2;
  /** Game instance roles, one per game region; they may call the agent routes. */
  readonly instanceRoles: readonly IRole[];
}

/** The HTTP API: agent routes (IAM) now; user routes (Cognito JWT), bot routes and usage routes later. */
export class ApiStack extends HearthStack {
  readonly api: HttpApi;
  /** SSM parameter agents read at boot to find the API. */
  readonly apiUrlParameter: StringParameter;

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
          SERVERS_TABLE: props.serversTable.tableName,
          INSTANCE_ROLE_NAMES: props.instanceRoles.map((role) => role.roleName).join(','),
        },
      });

    const byInstanceIndexArn = `${props.serversTable.tableArn}/index/${SERVERS_BY_INSTANCE_INDEX}`;
    const configFunction = agentFunction('AgentConfig', 'configHandler');
    configFunction.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [byInstanceIndexArn] }));
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
