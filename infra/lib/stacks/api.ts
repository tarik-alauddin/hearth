import { Duration, RemovalPolicy, Size, Validations } from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { HttpApi, HttpMethod, HttpStage, LogGroupLogDestination } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Policy, PolicyStatement, Role, type IRole } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { IStateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import {
  AGENT_CHANNELS,
  SERVERS_BY_INSTANCE_INDEX,
  agentChannelParameter,
  agentReleasesBucket,
  backupBucket,
  backupPrefix,
  uploadsBucket,
} from '@hearth/shared';
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
    // DataStack's bucket, named rather than referenced: it's always in the home region, like this stack.
    const backups = backupBucket(env, props.config.account, props.config.homeRegion);
    const uploads = uploadsBucket(env, props.config.account, props.config.homeRegion);
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
          BACKUP_BUCKET: backups,
          BACKUP_BUCKET_REGION: props.config.homeRegion,
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

    // Backups: instances have no S3 access of their own. This role can write any server's backups;
    // the credentials handler narrows each session to one key (see services/api/src/backups.ts).
    const serverBackups = `arn:${this.partition}:s3:::${backups}/${backupPrefix('*')}*`;
    const backupCredentialsFunction = agentFunction('AgentBackupCredentials', 'backupCredentialsHandler');
    backupCredentialsFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:Query'], resources: [byInstanceIndexArn] }),
    );
    // Only the credentials function may assume the writer role.
    const backupWriter = new Role(this, 'BackupWriter', {
      assumedBy: backupCredentialsFunction.grantPrincipal,
      description: `Hearth ${env}: writes world backups, one key per session`,
    });
    backupWriter.addToPolicy(
      new PolicyStatement({ actions: ['s3:PutObject', 's3:AbortMultipartUpload'], resources: [serverBackups] }),
    );
    backupWriter.grantAssumeRole(backupCredentialsFunction.grantPrincipal);
    backupCredentialsFunction.addEnvironment('BACKUP_WRITER_ROLE_ARN', backupWriter.roleArn);
    const backupDoneFunction = agentFunction('AgentBackupDone', 'backupDoneHandler');
    backupDoneFunction.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [byInstanceIndexArn] }));
    backupDoneFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [props.serversTable.tableArn] }),
    );
    // HeadObject, to check the backup exists and read its size; list and delete, to keep only the newest.
    backupDoneFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['s3:GetObject', 's3:DeleteObject'], resources: [serverBackups] }),
    );
    const listServerBackups = new PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [`arn:${this.partition}:s3:::${backups}`],
      conditions: { StringLike: { 's3:prefix': `${backupPrefix('*')}*` } },
    });
    backupDoneFunction.addToRolePolicy(listServerBackups);

    // Restores: the config handler presigns the download, so the link reads with this role.
    configFunction.addToRolePolicy(new PolicyStatement({ actions: ['s3:GetObject'], resources: [serverBackups] }));
    const restoredFunction = agentFunction('AgentRestored', 'restoredHandler');
    restoredFunction.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [byInstanceIndexArn] }));
    restoredFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [props.serversTable.tableArn] }),
    );

    // Idle stops: an agent stops its own server through the same stop workflow as the admin route.
    const idleFunction = agentFunction('AgentIdle', 'idleHandler');
    idleFunction.addEnvironment('STOP_WORKFLOW_ARN', props.workflows.stop.stateMachineArn);
    idleFunction.addToRolePolicy(new PolicyStatement({ actions: ['dynamodb:Query'], resources: [byInstanceIndexArn] }));
    idleFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [props.serversTable.tableArn] }),
    );
    idleFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['states:StartExecution'], resources: [props.workflows.stop.stateMachineArn] }),
    );

    for (const construct of [backupWriter, backupDoneFunction, configFunction]) {
      Validations.of(construct).acknowledge({
        id: `AwsSolutions-IAM5[Resource::${serverBackups}]`,
        reason: 'Every server has its own backup prefix; each upload session and download link covers one key.',
      });
    }

    const authorizer = new HttpIamAuthorizer();
    const agentRoutes = [
      ['/agent/config', HttpMethod.GET, configFunction],
      ['/agent/status', HttpMethod.POST, statusFunction],
      ['/agent/backup-credentials', HttpMethod.POST, backupCredentialsFunction],
      ['/agent/backups', HttpMethod.POST, backupDoneFunction],
      ['/agent/restored', HttpMethod.POST, restoredFunction],
      ['/agent/idle', HttpMethod.POST, idleFunction],
    ] as const;
    for (const [path, method, fn] of agentRoutes) {
      this.api.addRoutes({
        path,
        methods: [method],
        integration: new HttpLambdaIntegration(`${fn.node.id}Integration`, fn),
        authorizer,
      });
    }

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
        BACKUP_BUCKET: backups,
        BACKUP_BUCKET_REGION: props.config.homeRegion,
        UPLOADS_BUCKET: uploads,
        UPLOADS_BUCKET_REGION: props.config.homeRegion,
      },
    });
    admin.addToRolePolicy(listServerBackups);
    // Upload forms are signed with this role, so it may write landing files and nothing else there.
    const uploadsArn = `arn:${this.partition}:s3:::${uploads}`;
    const landing = `${uploadsArn}/landing/*`;
    const accepted = `${uploadsArn}/accepted/*`;
    const rejected = `${uploadsArn}/rejected/*`;
    admin.addToRolePolicy(new PolicyStatement({ actions: ['s3:PutObject'], resources: [landing] }));
    // Upload status: read where an upload has got to. Listing makes a missing key a 404 rather than a 403.
    admin.addToRolePolicy(new PolicyStatement({ actions: ['s3:GetObject'], resources: [landing, accepted, rejected] }));
    admin.addToRolePolicy(new PolicyStatement({ actions: ['s3:ListBucket'], resources: [uploadsArn] }));

    // Repack: each new landing file, through EventBridge. It reads landing files and writes
    // results; it can't delete anything (landing files expire).
    const repack = hearthFunction(this, 'Repack', {
      config: props.config,
      entry: 'repack/src/lambda.ts',
      handler: 'handler',
      environment: { UPLOADS_BUCKET: uploads },
      timeout: Duration.minutes(15),
      memorySize: 2048,
      ephemeralStorageSize: Size.gibibytes(10),
      commonJsDependencies: true, // yauzl, tar-stream
    });
    repack.addToRolePolicy(new PolicyStatement({ actions: ['s3:GetObject'], resources: [landing] }));
    repack.addToRolePolicy(new PolicyStatement({ actions: ['s3:PutObject'], resources: [accepted, rejected] }));
    new Rule(this, 'UploadLanded', {
      description: `Hearth ${env}: repack each new upload`,
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: { bucket: { name: [uploads] }, object: { key: [{ prefix: 'landing/' }] } },
      },
      targets: [new LambdaFunction(repack, { retryAttempts: 2 })],
    });

    for (const [construct, resources] of [
      [admin, [landing, accepted, rejected]],
      [repack, [landing, accepted, rejected]],
    ] as const) {
      for (const resource of resources) {
        Validations.of(construct).acknowledge({
          id: `AwsSolutions-IAM5[Resource::${resource}]`,
          reason: 'Uploads are keyed by a random ID under fixed prefixes; each role gets only the prefixes it needs.',
        });
      }
    }
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
    this.functions = [...agentRoutes.map(([, , fn]) => fn), admin, repack];
    const adminIntegration = new HttpLambdaIntegration('AdminIntegration', admin);
    for (const [path, method] of [
      ['/admin/servers', HttpMethod.GET],
      ['/admin/servers', HttpMethod.POST],
      ['/admin/uploads', HttpMethod.POST],
      ['/admin/uploads/{id}', HttpMethod.GET],
      ['/admin/servers/{id}', HttpMethod.GET],
      ['/admin/servers/{id}/backups', HttpMethod.GET],
      ['/admin/servers/{id}/version', HttpMethod.POST],
      ['/admin/servers/{id}/restore', HttpMethod.POST],
      ['/admin/servers/{id}/restore/cancel', HttpMethod.POST],
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
          resources: agentRoutes.map(([path, method]) => this.api.arnForExecuteApi(method, path, '$default')),
        }),
        new PolicyStatement({ actions: ['ssm:GetParameter'], resources: [this.apiUrlParameter.parameterArn] }),
      ],
    });
  }
}
