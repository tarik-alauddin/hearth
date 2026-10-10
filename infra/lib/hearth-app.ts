import { fileURLToPath } from 'node:url';
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
import { WebContentStack } from './stacks/web-content.js';

/** Adds every stack for one environment. */
export function addEnvironment(app: App, config: EnvConfig): void {
  const data = new DataStack(app, { config });
  // Game regions other than the home region will need cross-region references for the instance roles.
  const gameInfra = config.gameRegions.map((region) => new GameInfraStack(app, { config, region }));
  const orchestration = new OrchestrationStack(app, { config, serversTable: data.serversTable, gameInfra });
  // The site's bucket and CloudFront first: sign-in needs its address for the callback, the API for CORS.
  const frontend = new FrontendStack(app, { config });
  const auth = new AuthStack(app, { config, siteOrigin: frontend.siteUrl });
  const api = new ApiStack(app, {
    config,
    serversTable: data.serversTable,
    usersTable: data.usersTable,
    serverAccessTable: data.serverAccessTable,
    invitesTable: data.invitesTable,
    userPool: auth.userPool,
    userPoolClients: auth.clients,
    webOrigins: [frontend.siteUrl, ...config.webOrigins],
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
  // Last: the web app's files and the config naming the API and its sign-in client.
  new WebContentStack(app, {
    config,
    siteDir: webAppBuild(app),
    distribution: frontend.distribution,
    webConfig: {
      env: config.env,
      apiUrl: api.api.apiEndpoint,
      auth: { region: config.homeRegion, domain: auth.domainUrl, clientId: auth.webClient.userPoolClientId },
    },
  });
}

/**
 * Where the built web app is: `apps/web/dist` (`pnpm --filter @hearth/web build`; `pnpm synth`
 * builds it first), or the `webDist` context value (tests point it at a small fixture).
 */
function webAppBuild(app: App): string {
  const fromContext: unknown = app.node.tryGetContext('webDist');
  return typeof fromContext === 'string' ? fromContext : fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
}

/** cdk-nag AWS Solutions rules; violations fail synth. */
export function addChecks(app: App): void {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
}
