import { App } from 'aws-cdk-lib';
import { ENVIRONMENTS, isEnvName } from '@hearth/shared';
import { envConfig } from '../lib/config.js';
import { addChecks, addEnvironment } from '../lib/hearth-app.js';
import { AccountStack } from '../lib/stacks/account.js';

// Synthesizes every environment into one cloud assembly, so the build that passed
// stage is the one deployed to prod. `-c env=dev` limits synth to one environment.
const app = new App();
const only: unknown = app.node.tryGetContext('env');
if (only !== undefined && !isEnvName(only)) {
  throw new Error(`Unknown env "${String(only)}"; expected one of ${ENVIRONMENTS.join(', ')}`);
}

for (const env of ENVIRONMENTS) {
  if (only === undefined || only === env) {
    addEnvironment(app, envConfig(env));
  }
}
// Account-wide resources (the budget), deployed alongside dev.
new AccountStack(app);
addChecks(app);
