import { Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import {
  AccountRecovery,
  CfnManagedLoginBranding,
  CfnUserPoolClient,
  CfnUserPoolGroup,
  FeaturePlan,
  ManagedLoginVersion,
  Mfa,
  OAuthScope,
  OidcAttributeRequestMethod,
  ProviderAttribute,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
  UserPoolIdentityProviderGoogle,
  UserPoolIdentityProviderOidc,
  type IUserPoolIdentityProvider,
} from 'aws-cdk-lib/aws-cognito';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { CLI_CALLBACK_URL } from '../config.js';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/** The Cognito group whose members are Hearth admins. */
export const ADMIN_GROUP = 'admin';

/** Discord's provider name in the pool: what `identity_provider=` takes and tokens' identities show. */
export const DISCORD_PROVIDER = 'Discord';

/**
 * Who you are: the Cognito user pool, its managed login pages and the clients that sign in through
 * them (the CLI everywhere; the web app where `webOrigins` lists one). Users sign in with Google
 * and Discord, per env's `signInProviders`; the only password users are the ones the owner
 * creates, so there is no self sign-up. Clients find the pool through one SSM parameter,
 * `/hearth/<env>/auth`.
 */
export class AuthStack extends HearthStack {
  readonly userPool: UserPool;
  readonly clients: readonly UserPoolClient[];

  constructor(scope: Construct, props: HearthStackProps) {
    const { isProd, env, account, webOrigins, signInProviders } = props.config;
    super(scope, 'Auth', { ...props, terminationProtection: isProd });

    this.userPool = new UserPool(this, 'Users', {
      userPoolName: `hearth-${env}-users`,
      featurePlan: FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      // Not required: Google and Discord may not share one, and required attributes can never change.
      standardAttributes: {
        email: { required: false, mutable: true },
        fullname: { required: false, mutable: true },
        profilePicture: { required: false, mutable: true },
      },
      // Optional for now (password users are the owner only). Applies to password users alone;
      // Google and Discord sign-ins use the provider's own MFA.
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const plusPlan =
      'Threat protection needs the Plus plan (billed per user). Password users are the owner only; everyone else signs in through Google or Discord.';
    Validations.of(this.userPool).acknowledge({ id: 'AwsSolutions-COG3', reason: plusPlan });
    Validations.of(this.userPool).acknowledge({ id: 'AwsSolutions-COG8', reason: plusPlan });
    Validations.of(this.userPool).acknowledge({
      id: 'AwsSolutions-COG2',
      reason: 'MFA is optional (TOTP) for now: the only password user is the owner; Google and Discord apply their own.',
    });

    new CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: 'Hearth admins: every server, users and agent channels',
    });

    // Prefix domains are global per region: the account ID keeps this one ours. A custom domain
    // replaces it once Hearth has one.
    const domain = new UserPoolDomain(this, 'Domain', {
      userPool: this.userPool,
      cognitoDomain: { domainPrefix: `hearth-${env}-${account}` },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Outside providers, each turned on per env once its secret exists. A first sign-in through one
    // creates that user in the pool (self sign-up governs password users only).
    const providers: IUserPoolIdentityProvider[] = [];
    if (signInProviders.includes('google')) {
      // { clientId, clientSecret } from the owner's Google OAuth client; CloudFormation resolves it
      // at deploy, so neither is in the code or the template.
      const secret = Secret.fromSecretNameV2(this, 'GoogleSecret', `hearth/${env}/google`);
      providers.push(
        new UserPoolIdentityProviderGoogle(this, 'Google', {
          userPool: this.userPool,
          clientId: secret.secretValueFromJson('clientId').unsafeUnwrap(), // not secret; shown on Google's sign-in page
          clientSecretValue: secret.secretValueFromJson('clientSecret'),
          scopes: ['openid', 'email', 'profile'],
          attributeMapping: {
            email: ProviderAttribute.GOOGLE_EMAIL,
            emailVerified: ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
            fullname: ProviderAttribute.GOOGLE_NAME,
            profilePicture: ProviderAttribute.GOOGLE_PICTURE,
          },
        }),
      );
    }
    if (signInProviders.includes('discord')) {
      // Discord speaks OpenID Connect (the `openid` scope adds an ID token); Cognito takes it as a
      // generic OIDC provider. Endpoints as Discord's discovery document lists them
      // (https://discord.com/.well-known/openid-configuration).
      const secret = Secret.fromSecretNameV2(this, 'DiscordSecret', `hearth/${env}/discord`);
      providers.push(
        new UserPoolIdentityProviderOidc(this, 'Discord', {
          userPool: this.userPool,
          name: DISCORD_PROVIDER,
          clientId: secret.secretValueFromJson('clientId').unsafeUnwrap(), // not secret; in Discord's authorize URL
          // Still a {{resolve:secretsmanager}} reference, resolved at deploy: never in the template.
          clientSecret: secret.secretValueFromJson('clientSecret').unsafeUnwrap(),
          issuerUrl: 'https://discord.com',
          endpoints: {
            authorization: 'https://discord.com/api/oauth2/authorize',
            token: 'https://discord.com/api/oauth2/token',
            userInfo: 'https://discord.com/api/oauth2/userinfo',
            jwksUri: 'https://discord.com/api/oauth2/keys',
          },
          // identify: username, display name and avatar; email: the address and whether it's verified.
          scopes: ['openid', 'identify', 'email'],
          attributeRequestMethod: OidcAttributeRequestMethod.GET,
          attributeMapping: {
            email: ProviderAttribute.other('email'),
            emailVerified: ProviderAttribute.other('email_verified'),
            preferredUsername: ProviderAttribute.other('preferred_username'),
            nickname: ProviderAttribute.other('nickname'),
            profilePicture: ProviderAttribute.other('picture'),
          },
        }),
      );
    }
    const supportedIdentityProviders = [
      UserPoolClientIdentityProvider.COGNITO,
      ...(signInProviders.includes('google') ? [UserPoolClientIdentityProvider.GOOGLE] : []),
      ...(signInProviders.includes('discord') ? [UserPoolClientIdentityProvider.custom(DISCORD_PROVIDER)] : []),
    ];

    const client = (id: string, callbackUrls: string[], logoutUrls: string[], refreshDays: number) => {
      const c = this.userPool.addClient(id, {
        userPoolClientName: `hearth-${env}-${id.toLowerCase()}`,
        generateSecret: false, // public clients (a browser, a CLI): they prove themselves with PKCE
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
          callbackUrls,
          logoutUrls,
        },
        supportedIdentityProviders,
        preventUserExistenceErrors: true,
        accessTokenValidity: Duration.hours(1),
        idTokenValidity: Duration.hours(1),
        refreshTokenValidity: Duration.days(refreshDays),
      });
      // Sign-in happens only on the managed login pages; the client itself may only refresh tokens.
      // (CDK reads an empty authFlows as "Cognito's defaults", which allow API sign-in flows.)
      (c.node.defaultChild as CfnUserPoolClient).explicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH'];
      // A client naming a provider that doesn't exist yet fails to deploy.
      for (const provider of providers) c.node.addDependency(provider);
      // Managed login (v2) shows a page only for clients with a style; Cognito's default here.
      new CfnManagedLoginBranding(this, `${id}Branding`, {
        userPoolId: this.userPool.userPoolId,
        clientId: c.userPoolClientId,
        useCognitoProvidedValues: true,
      }).node.addDependency(domain);
      return c;
    };

    const cli = client('Cli', [CLI_CALLBACK_URL], [CLI_CALLBACK_URL], 30);
    const web = webOrigins.length
      ? client(
          'Web',
          webOrigins.map((origin) => `${origin}/auth/callback`),
          [...webOrigins],
          7,
        )
      : undefined;
    this.clients = web ? [cli, web] : [cli];

    new StringParameter(this, 'AuthConfig', {
      parameterName: `/hearth/${env}/auth`,
      description: `Hearth ${env} sign-in: user pool, managed login domain and client IDs`,
      stringValue: Stack.of(this).toJsonString({
        region: this.region,
        userPoolId: this.userPool.userPoolId,
        issuer: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
        domain: domain.baseUrl(),
        cliClientId: cli.userPoolClientId,
        ...(web ? { webClientId: web.userPoolClientId } : {}),
      }),
    });
  }
}
