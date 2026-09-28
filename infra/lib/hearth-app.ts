import { Validations, type App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { EnvConfig } from './config.js';
import { ApiStack } from './stacks/api.js';
import { AuthStack } from './stacks/auth.js';
import { DataStack } from './stacks/data.js';
import { FrontendStack } from './stacks/frontend.js';
import { GameInfraStack } from './stacks/game-infra.js';
import { IntegrationsStack } from './stacks/integrations.js';
import { OrchestrationStack } from './stacks/orchestration.js';

/** Adds every stack for one environment. */
export function addEnvironment(app: App, config: EnvConfig): void {
  new DataStack(app, { config });
  for (const region of config.gameRegions) {
    new GameInfraStack(app, { config, region });
  }
  new OrchestrationStack(app, { config });
  new ApiStack(app, { config });
  new IntegrationsStack(app, { config });
  new AuthStack(app, { config });
  new FrontendStack(app, { config });
}

/** cdk-nag AWS Solutions rules; violations fail synth. */
export function addChecks(app: App): void {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
}
