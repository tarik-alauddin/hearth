// Lambda entry points for the agent routes; ApiStack points one function at each export.
import { createServersStore } from '@hearth/core';
import { agentHandlers } from './handlers.js';
import { ssmAgentReleases } from './releases.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const handlers = agentHandlers({
  store: createServersStore(requireEnv('SERVERS_TABLE')),
  instanceRoleNames: requireEnv('INSTANCE_ROLE_NAMES').split(','),
  releases: ssmAgentReleases({ env: requireEnv('HEARTH_ENV'), bucket: requireEnv('AGENT_RELEASES_BUCKET') }),
});

export const configHandler = handlers.config;
export const statusHandler = handlers.status;
