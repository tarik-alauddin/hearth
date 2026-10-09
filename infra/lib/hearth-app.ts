import { Validations, type App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { EnvConfig } from './config.js';
import { ApiStack } from './stacks/api.js';
import { AuthStack } from './stacks/auth.js';
import { DataStack } from './stacks/data.js';
import { FrontendStack } from './stacks/frontend.js';
import { GameInfraStack } from './stacks/game-infra.js';
import { IntegrationsStack } from './stacks/integrations.js';
import { MonitoringStack } from './stacks/monitoring.js';
import { OrchestrationStack } from './stacks/orchestration.js';

/** Adds every stack for one environment. */
export function addEnvironment(app: App, config: EnvConfig): void {
  const data = new DataStack(app, { config });
  // Game regions other than the home region will need cross-region references for the instance roles.
  const gameInfra = config.gameRegions.map((region) => new GameInfraStack(app, { config, region }));
  const orchestration = new OrchestrationStack(app, { config, serversTable: data.serversTable, gameInfra });
  const auth = new AuthStack(app, { config });
  const api = new ApiStack(app, {
    config,
    serversTable: data.serversTable,
    usersTable: data.usersTable,
    serverAccessTable: data.serverAccessTable,
    invitesTable: data.invitesTable,
    userPool: auth.userPool,
    userPoolClients: auth.clients,
    instanceRoles: gameInfra.map((stack) => stack.instanceRole),
    workflows: {
      create: orchestration.workflows.createServer,
      start: orchestration.workflows.startServer,
      stop: orchestration.workflows.stopServer,
      destroy: orchestration.workflows.destroyServer,
    },
    gameRegions: config.gameRegions,
  });
  new MonitoringStack(app, {
    config,
    serversTable: data.serversTable,
    workflows: {
      create: orchestration.workflows.createServer,
      start: orchestration.workflows.startServer,
      stop: orchestration.workflows.stopServer,
      destroy: orchestration.workflows.destroyServer,
    },
    api: api.api,
    apiFunctions: api.functions,
    stateSync: orchestration.stateSync,
    stateChanges: orchestration.stateChanges,
  });
  new IntegrationsStack(app, { config });
  new FrontendStack(app, { config });
}

/** cdk-nag AWS Solutions rules; violations fail synth. */
export function addChecks(app: App): void {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
}
