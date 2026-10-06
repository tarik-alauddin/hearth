import type { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { testApp } from './test-app.js';
import { describe, expect, it } from 'vitest';
import { envConfig } from '../lib/config.js';
import { addChecks, addEnvironment } from '../lib/hearth-app.js';

// Synthesized through the whole environment, since ApiStack takes the table and instance roles from other stacks.
const app = testApp();
addEnvironment(app, envConfig('dev'));
addChecks(app);
app.synth();
const stack = app.node.findChild('hearth-dev-Api') as Stack;
const template = Template.fromStack(stack);

function policyStatements(logicalIdPrefix: string): unknown[] {
  const policies = template.findResources('AWS::IAM::Policy');
  const match = Object.entries(policies).find(([id]) => id.startsWith(logicalIdPrefix));
  if (!match) throw new Error(`no policy ${logicalIdPrefix}`);
  return (match[1] as { Properties: { PolicyDocument: { Statement: unknown[] } } }).Properties.PolicyDocument.Statement;
}

describe('ApiStack', () => {
  it('is an HTTP API with throttling and access logs on the default stage', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { Name: 'hearth-dev', ProtocolType: 'HTTP' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
    });
  });

  it.each([
    ['GET /agent/config'],
    ['POST /agent/status'],
    ['POST /agent/backup-credentials'],
    ['POST /agent/backups'],
    ['POST /agent/restored'],
    ['POST /agent/idle'],
  ])('protects %s with IAM auth', (routeKey) => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: routeKey, AuthorizationType: 'AWS_IAM' });
  });

  it('has no routes without auth', () => {
    const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')) as {
      Properties: { AuthorizationType?: string };
    }[];
    expect(routes.every((route) => route.Properties.AuthorizationType === 'AWS_IAM')).toBe(true);
  });

  it('runs the agent handlers on ARM Node 24 with the table and instance role names', () => {
    for (const handler of [
      'index.configHandler',
      'index.statusHandler',
      'index.backupCredentialsHandler',
      'index.backupDoneHandler',
      'index.restoredHandler',
      'index.idleHandler',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: handler,
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        Environment: {
          Variables: Match.objectLike({
            SERVERS_TABLE: Match.anyValue(),
            INSTANCE_ROLE_NAMES: Match.anyValue(),
          }),
        },
      });
    }
  });

  it('lets the config handler only query the byInstance index', () => {
    const statements = JSON.stringify(policyStatements('AgentConfigServiceRoleDefaultPolicy'));
    expect(statements).toContain('dynamodb:Query');
    expect(statements).toContain('/index/byInstance');
    expect(statements).not.toContain('dynamodb:UpdateItem');
    expect(statements).not.toContain('dynamodb:PutItem');
  });

  it('lets the status handler query the index and update items, nothing else', () => {
    const actions = policyStatements('AgentStatusServiceRoleDefaultPolicy').map((s) => (s as { Action: string }).Action);
    expect(actions.sort()).toEqual(['dynamodb:Query', 'dynamodb:UpdateItem']);
  });

  it("lets the agent config handler read exactly its environment's two agent channel parameters", () => {
    const ssm = (policyStatements('AgentConfigServiceRoleDefaultPolicy') as { Action: string; Resource: unknown }[]).find(
      (s) => s.Action === 'ssm:GetParameter',
    );
    const resources = JSON.stringify(ssm?.Resource);
    expect(resources).toContain('parameter/hearth/dev/agent/canary');
    expect(resources).toContain('parameter/hearth/dev/agent/stable');
    expect(resources).not.toContain('*');
  });

  it('publishes the API URL for agents', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/hearth/dev/api-url', Type: 'String' });
  });

  it('lets game instances call only the agent routes and read only the API URL', () => {
    const statements = policyStatements('InstanceAccess') as { Action: string; Resource: unknown }[];
    expect(statements.map((s) => s.Action)).toEqual(['execute-api:Invoke', 'ssm:GetParameter']);
    const invoke = JSON.stringify(statements[0]?.Resource);
    expect(invoke).toContain('/$default/GET/agent/config');
    expect(invoke).toContain('/$default/POST/agent/status');
    expect(invoke).toContain('/$default/POST/agent/backup-credentials');
    expect(invoke).toContain('/$default/POST/agent/backups');
    expect(invoke).toContain('/$default/POST/agent/restored');
    expect(invoke).toContain('/$default/POST/agent/idle');
    expect(invoke).not.toMatch(/\/\*\//);
    expect(invoke).not.toContain('/admin');
  });

  it('has a backup writer role only the credentials function can assume, writing only server backups', () => {
    const [id, role] = Object.entries(template.findResources('AWS::IAM::Role')).find(([key]) => key.startsWith('BackupWriter'))!;
    const trust = (role as { Properties: { AssumeRolePolicyDocument: { Statement: { Principal: unknown }[] } } }).Properties
      .AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(JSON.stringify(trust[0]?.Principal)).toContain('AgentBackupCredentialsServiceRole');

    const statements = policyStatements(`${id.replace(/[0-9A-F]{8}$/, '')}DefaultPolicy`) as { Action: unknown; Resource: unknown }[];
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual(['s3:AbortMultipartUpload', 's3:PutObject']);
    expect(JSON.stringify(statements[0]?.Resource)).toContain('/servers/*/*');
  });

  it('lets the config handler read server backups and accepted uploads, for the restore links it presigns', () => {
    const statements = policyStatements('AgentConfigServiceRoleDefaultPolicy') as { Action: string; Resource: unknown }[];
    const s3 = statements.filter((s) => JSON.stringify(s.Action).includes('s3:'));
    expect(s3).toEqual([
      expect.objectContaining({
        Action: 's3:GetObject', // CDK merges the two statements
        Resource: [
          'arn:aws:s3:::hearth-dev-backups-138300868928-us-west-2/servers/*/*',
          'arn:aws:s3:::hearth-dev-uploads-138300868928-us-west-2/accepted/*',
        ],
      }),
      expect.objectContaining({ Action: 's3:ListBucket', Resource: 'arn:aws:s3:::hearth-dev-uploads-138300868928-us-west-2' }),
    ]);
  });

  it('lets the idle handler start only the stop workflow, and no other workflow', () => {
    const statements = policyStatements('AgentIdleServiceRoleDefaultPolicy') as { Action: unknown; Resource: unknown }[];
    expect(statements.flatMap((s) => s.Action).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
      'states:StartExecution',
    ]);
    // Exactly the workflow the admin function starts for a stop.
    const admin = Object.values(template.findResources('AWS::Lambda::Function')).find(
      (fn) => (fn as { Properties: { Handler: string } }).Properties.Handler === 'index.handler',
    ) as { Properties: { Environment: { Variables: Record<string, unknown> } } };
    const start = statements.find((s) => s.Action === 'states:StartExecution');
    expect(start?.Resource).toEqual(admin.Properties.Environment.Variables.STOP_WORKFLOW_ARN);
  });

  it('lets the restored handler query the index and update items, nothing else', () => {
    const actions = policyStatements('AgentRestoredServiceRoleDefaultPolicy').map((s) => (s as { Action: string }).Action);
    expect(actions.sort()).toEqual(['dynamodb:Query', 'dynamodb:UpdateItem']);
  });

  it('lets the backup-done function read, list and delete only server backups, and update items', () => {
    const statements = policyStatements('AgentBackupDoneServiceRoleDefaultPolicy') as {
      Action: string | string[];
      Resource: unknown;
      Condition?: unknown;
    }[];
    expect(statements.flatMap((s) => s.Action).sort()).toEqual([
      'dynamodb:Query',
      'dynamodb:UpdateItem',
      's3:DeleteObject',
      's3:GetObject',
      's3:ListBucket',
    ]);
    const objects = statements.find((s) => Array.isArray(s.Action) && s.Action.includes('s3:DeleteObject'));
    expect(JSON.stringify(objects?.Resource)).toContain('/servers/*/*');
    const list = statements.find((s) => s.Action === 's3:ListBucket');
    expect(list?.Condition).toEqual({ StringLike: { 's3:prefix': 'servers/*/*' } });
  });

  it.each([
    ['GET /admin/servers'],
    ['POST /admin/servers'],
    ['GET /admin/servers/{id}'],
    ['POST /admin/uploads'],
    ['GET /admin/uploads/{id}'],
    ['GET /admin/servers/{id}/backups'],
    ['POST /admin/servers/{id}/version'],
    ['POST /admin/servers/{id}/restore'],
    ['POST /admin/servers/{id}/restore/cancel'],
    ['POST /admin/servers/{id}/start'],
    ['POST /admin/servers/{id}/stop'],
    ['POST /admin/servers/{id}/destroy'],
    ['POST /admin/servers/{id}/settings'],
  ])('protects %s with IAM auth', (routeKey) => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: routeKey, AuthorizationType: 'AWS_IAM' });
  });

  it('lets the admin function start only the four lifecycle workflows', () => {
    const statements = policyStatements('AdminServiceRoleDefaultPolicy') as { Action: unknown; Resource: unknown }[];
    const start = statements.find((s) => s.Action === 'states:StartExecution');
    expect(JSON.stringify(start?.Resource)).toMatch(/create-server|Create/);
    expect((start?.Resource as unknown[]).length).toBe(4); // create, start, stop, destroy
    const dynamo = statements.find((s) => JSON.stringify(s.Action).includes('dynamodb'));
    expect((dynamo?.Action as string[]).sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Scan',
      'dynamodb:UpdateItem',
    ]);
    expect(JSON.stringify(statements)).not.toMatch(/ec2:|DeleteItem/);
  });

  it('lets the admin function list server backups, write upload landing files and read upload results', () => {
    const statements = policyStatements('AdminServiceRoleDefaultPolicy') as {
      Action: unknown;
      Resource: unknown;
      Condition?: unknown;
    }[];
    const uploads = 'arn:aws:s3:::hearth-dev-uploads-138300868928-us-west-2';
    const s3 = statements.filter((s) => JSON.stringify(s.Action).includes('s3:'));
    expect(s3).toEqual([
      expect.objectContaining({ Action: 's3:ListBucket', Condition: { StringLike: { 's3:prefix': 'servers/*/*' } } }),
      // Landing files only: it can't write backups (a server created from an upload restores it in place).
      expect.objectContaining({ Action: 's3:PutObject', Resource: `${uploads}/landing/*` }),
      expect.objectContaining({
        Action: 's3:GetObject',
        Resource: [`${uploads}/accepted/*`, `${uploads}/landing/*`, `${uploads}/rejected/*`], // CDK sorts them
      }),
      expect.objectContaining({ Action: 's3:ListBucket', Resource: uploads }),
    ]);
    expect(JSON.stringify(statements)).not.toContain('s3:Delete');
  });

  describe('repack', () => {
    const uploads = 'arn:aws:s3:::hearth-dev-uploads-138300868928-us-west-2';

    it('has the disk, memory and time for uploads of a few GB', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Timeout: 900,
        MemorySize: 2048,
        EphemeralStorage: { Size: 10240 },
        Environment: { Variables: Match.objectLike({ UPLOADS_BUCKET: 'hearth-dev-uploads-138300868928-us-west-2' }) },
      });
    });

    it('reads landing files and writes results, and can delete nothing', () => {
      const statements = policyStatements('RepackServiceRoleDefaultPolicy') as { Action: unknown; Resource: unknown }[];
      expect(statements).toEqual([
        expect.objectContaining({ Action: 's3:GetObject', Resource: `${uploads}/landing/*` }),
        expect.objectContaining({ Action: 's3:PutObject', Resource: [`${uploads}/accepted/*`, `${uploads}/rejected/*`] }),
      ]);
    });

    it('runs for each new landing file in the uploads bucket', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['aws.s3'],
          'detail-type': ['Object Created'],
          detail: {
            bucket: { name: ['hearth-dev-uploads-138300868928-us-west-2'] },
            object: { key: [{ prefix: 'landing/' }] },
          },
        },
        Targets: [Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 2 } })],
      });
    });
  });
});
