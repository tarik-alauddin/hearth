import type { EnvName } from '@hearth/shared';

export const AWS_ACCOUNT = '138300868928';
export const HOME_REGION = 'us-west-2';

/** Where alarms and budget alerts are emailed. */
export const ALERT_EMAIL = 'tarikza.dev@gmail.com';
/** Monthly AWS budget for everything tagged app=hearth, in USD. */
export const MONTHLY_BUDGET_USD = 50;

export interface EnvConfig {
  readonly env: EnvName;
  readonly account: string;
  /** Region for the control plane: API, DynamoDB, Cognito, UI, workflows, event bus. */
  readonly homeRegion: string;
  /** Regions that get a GameInfraStack. */
  readonly gameRegions: readonly string[];
  /** CDK bootstrap qualifier, so each environment has its own CDK roles and asset bucket. */
  readonly qualifier: string;
  readonly isProd: boolean;
  /** Run the fleet check every 15 minutes. Elsewhere it only runs when invoked by hand. */
  readonly fleetCheckScheduled: boolean;
  /**
   * Origins the web app signs in from (callback `<origin>/auth/callback`, sign-out back to the
   * origin). Empty = no web sign-in client yet. The deployed site's origin joins these in M10.
   */
  readonly webOrigins: readonly string[];
  /**
   * Outside sign-in providers on. Each needs its secret (`hearth/<env>/<provider>`, created by the
   * owner) before it's turned on here, or the deploy fails reading it.
   */
  readonly signInProviders: readonly SignInProvider[];
}

export type SignInProvider = 'google' | 'discord';

/** The CLI's sign-in callback: a fixed loopback port, as Cognito matches callback URLs exactly. */
export const CLI_CALLBACK_URL = 'http://localhost:8976/callback';

// Qualifiers are at most 10 alphanumeric characters.
const QUALIFIERS: Record<EnvName, string> = {
  dev: 'hearthdev',
  stage: 'hearthstg',
  prod: 'hearthprd',
};

// Turned on per env once its secrets exist.
const SIGN_IN_PROVIDERS: Record<EnvName, readonly SignInProvider[]> = {
  dev: ['google', 'discord'],
  stage: [],
  prod: [],
};

export function envConfig(env: EnvName): EnvConfig {
  return {
    env,
    account: AWS_ACCOUNT,
    homeRegion: HOME_REGION,
    gameRegions: [HOME_REGION],
    qualifier: QUALIFIERS[env],
    isProd: env === 'prod',
    fleetCheckScheduled: env === 'prod',
    // Vite's dev server, for building the UI against dev.
    webOrigins: env === 'dev' ? ['http://localhost:5173'] : [],
    signInProviders: SIGN_IN_PROVIDERS[env],
  };
}

// Listed rather than looked up, so synth needs no AWS credentials.
const AVAILABILITY_ZONES: Record<string, readonly string[]> = {
  'us-west-2': ['us-west-2a', 'us-west-2b', 'us-west-2c'],
};

export function availabilityZones(region: string): string[] {
  const zones = AVAILABILITY_ZONES[region];
  if (!zones) throw new Error(`No availability zones configured for ${region}`);
  return [...zones];
}

export function stackName(env: EnvName, stack: string, region?: string): string {
  return ['hearth', env, stack, region].filter(Boolean).join('-');
}
