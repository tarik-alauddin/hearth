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
    for (const handler of ['index.configHandler', 'index.statusHandler']) {
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

  it('publishes the API URL for agents', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/hearth/dev/api-url', Type: 'String' });
  });

  it('lets game instances call only the agent routes and read only the API URL', () => {
    const statements = policyStatements('InstanceAccess') as { Action: string; Resource: unknown }[];
    expect(statements.map((s) => s.Action)).toEqual(['execute-api:Invoke', 'ssm:GetParameter']);
    const invoke = JSON.stringify(statements[0]?.Resource);
    expect(invoke).toContain('/$default/GET/agent/config');
    expect(invoke).toContain('/$default/POST/agent/status');
    expect(invoke).not.toMatch(/\/\*\//);
  });
});
