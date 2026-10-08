// Lambda entry point for the /v1 routes (signed-in users); ApiStack points the User function here.
import { createAccessStore, createOwnedServers, createServersStore, createUsersStore } from '@hearth/core';
import { OperationError, serverOperations } from '../servers/operations.js';
import { stepFunctionsWorkflows } from '../servers/workflows.js';
import { userOperations } from '../users/operations.js';
import { userHandler } from './handlers.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** A dependency no /v1 route uses yet (starting, stopping and the rest arrive with M8 PR5e). */
function notYet(what: string): never {
  throw new Error(`${what} is not available to the /v1 routes yet`);
}

const users = createUsersStore(requireEnv('USERS_TABLE'));
const serversTable = requireEnv('SERVERS_TABLE');
const accessTable = requireEnv('ACCESS_TABLE');

export const handler = userHandler({
  users,
  userOps: userOperations({ users }),
  serverOps: serverOperations({
    store: createServersStore(serversTable),
    access: createAccessStore(accessTable),
    ownership: createOwnedServers(serversTable, accessTable),
    users,
    // Only create, for now: its function may start no other workflow.
    workflows: stepFunctionsWorkflows({ create: requireEnv('CREATE_WORKFLOW_ARN'), start: '', stop: '', destroy: '' }),
    backups: { list: async () => notYet('Backups') },
    // A request naming an upload is the caller's to fix, so a 400 rather than an error.
    uploads: {
      status: async () => {
        throw new OperationError(400, 'Creating a server from an upload comes with the /v1 uploads');
      },
      accepted: () => notYet('Uploads'),
    },
    versions: { releases: async () => notYet('Game versions') },
    homeRegion: requireEnv('HOME_REGION'),
    gameRegions: requireEnv('GAME_REGIONS').split(','),
  }),
});
