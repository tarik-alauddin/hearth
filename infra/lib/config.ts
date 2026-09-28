import type { EnvName } from '@hearth/shared';

export const AWS_ACCOUNT = '138300868928';
export const HOME_REGION = 'us-west-2';

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
}

// Qualifiers are at most 10 alphanumeric characters.
const QUALIFIERS: Record<EnvName, string> = {
  dev: 'hearthdev',
  stage: 'hearthstg',
  prod: 'hearthprd',
};

export function envConfig(env: EnvName): EnvConfig {
  return {
    env,
    account: AWS_ACCOUNT,
    homeRegion: HOME_REGION,
    gameRegions: [HOME_REGION],
    qualifier: QUALIFIERS[env],
    isProd: env === 'prod',
  };
}

export function stackName(env: EnvName, stack: string, region?: string): string {
  return ['hearth', env, stack, region].filter(Boolean).join('-');
}
