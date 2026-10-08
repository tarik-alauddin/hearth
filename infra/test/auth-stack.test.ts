import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { EnvName } from '@hearth/shared';
import { CLI_CALLBACK_URL, envConfig } from '../lib/config.js';
import { addChecks } from '../lib/hearth-app.js';
import { AuthStack } from '../lib/stacks/auth.js';
import { testApp } from './test-app.js';

function synth(env: EnvName) {
  const app = testApp();
  const stack = new AuthStack(app, { config: envConfig(env) });
  addChecks(app);
  app.synth();
  return { stack, template: Template.fromStack(stack) };
}

describe('AuthStack', () => {
  const dev = synth('dev');
  const prod = synth('prod');

  describe('user pool', () => {
    it('has no self sign-up: password users are created by the owner', () => {
      dev.template.hasResourceProperties('AWS::Cognito::UserPool', {
        UserPoolName: 'hearth-dev-users',
        UserPoolTier: 'ESSENTIALS',
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        UsernameAttributes: ['email'],
      });
    });

    it('offers TOTP MFA and requires a strong password for password users', () => {
      dev.template.hasResourceProperties('AWS::Cognito::UserPool', {
        MfaConfiguration: 'OPTIONAL',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        Policies: {
          PasswordPolicy: Match.objectLike({
            MinimumLength: 12,
            RequireLowercase: true,
            RequireUppercase: true,
            RequireNumbers: true,
            RequireSymbols: true,
          }),
        },
      });
    });

    it('requires no attribute, as Google and Discord may not share them', () => {
      const pool = Object.values(dev.template.findResources('AWS::Cognito::UserPool'))[0] as {
        Properties: { Schema: { Required: boolean }[] };
      };
      expect(pool.Properties.Schema.every((attribute) => !attribute.Required)).toBe(true);
    });

    it('is retained with deletion protection in prod only', () => {
      prod.template.hasResource('AWS::Cognito::UserPool', {
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({ DeletionProtection: 'ACTIVE' }),
      });
      dev.template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Delete' });
      expect(prod.stack.terminationProtection).toBe(true);
    });
  });

  it('has an admin group', () => {
    dev.template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admin' });
  });

  it('serves managed login (v2) on a prefix domain unique to the account', () => {
    dev.template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'hearth-dev-138300868928',
      ManagedLoginVersion: 2,
    });
  });

  describe('clients', () => {
    it('signs the CLI in through a loopback callback, with PKCE and no secret', () => {
      dev.template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ClientName: 'hearth-dev-cli',
        GenerateSecret: false,
        AllowedOAuthFlows: ['code'],
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthScopes: ['openid', 'email', 'profile'],
        CallbackURLs: [CLI_CALLBACK_URL],
        SupportedIdentityProviders: ['COGNITO'],
        ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
        PreventUserExistenceErrors: 'ENABLED',
      });
    });

    it('signs the web app in from Vite on dev; stage and prod have no web client yet', () => {
      dev.template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        ClientName: 'hearth-dev-web',
        CallbackURLs: ['http://localhost:5173/auth/callback'],
        LogoutURLs: ['http://localhost:5173'],
        ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      });
      prod.template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    });

    it('gives every client a managed login style', () => {
      dev.template.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 2);
      prod.template.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 1);
      dev.template.allResourcesProperties('AWS::Cognito::ManagedLoginBranding', { UseCognitoProvidedValues: true });
    });
  });

  it('publishes the pool, domain and clients in one SSM parameter', () => {
    dev.template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/hearth/dev/auth', Type: 'String' });
    const parameter = Object.values(dev.template.findResources('AWS::SSM::Parameter'))[0] as {
      Properties: { Value: unknown };
    };
    const value = JSON.stringify(parameter.Properties.Value);
    for (const key of ['region', 'userPoolId', 'issuer', 'domain', 'cliClientId', 'webClientId']) {
      expect(value).toContain(`\\"${key}\\"`);
    }
  });
});
