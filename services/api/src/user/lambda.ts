// Lambda entry point for the /v1 routes (signed-in users); ApiStack points the User function here.
import { createAccessStore, createServersStore, createUsersStore } from '@hearth/core';
import { serverOperations } from '../servers/operations.js';
import { userOperations } from '../users/operations.js';
import { userHandler } from './handlers.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** A dependency no /v1 route uses yet (creating, starting and the rest arrive with M8 PR5d–e). */
function notYet(what: string): never {
  throw new Error(`${what} is not available to the /v1 routes yet`);
}

const users = createUsersStore(requireEnv('USERS_TABLE'));

export const handler = userHandler({
  users,
  userOps: userOperations({ users }),
  serverOps: serverOperations({
    store: createServersStore(requireEnv('SERVERS_TABLE')),
    access: createAccessStore(requireEnv('ACCESS_TABLE')),
    workflows: { start: async () => notYet('Workflows') },
    backups: { list: async () => notYet('Backups') },
    uploads: { status: async () => notYet('Uploads'), accepted: () => notYet('Uploads') },
    versions: { releases: async () => notYet('Game versions') },
    homeRegion: requireEnv('HOME_REGION'),
    gameRegions: [],
  }),
});
