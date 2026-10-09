// Lambda entry point for the /v1 routes (signed-in users); ApiStack points the User function here.
import { createAccessStore, createOwnedServers, createServersStore, createUsersStore } from '@hearth/core';
import { s3BackupStorage } from '../backups.js';
import { OperationError, serverOperations } from '../servers/operations.js';
import { publishedVersions } from '../servers/versions.js';
import { stepFunctionsWorkflows } from '../servers/workflows.js';
import { userOperations } from '../users/operations.js';
import { userHandler } from './handlers.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** A dependency no /v1 route uses yet (uploads come with the /v1 uploads). */
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
    workflows: stepFunctionsWorkflows({
      create: requireEnv('CREATE_WORKFLOW_ARN'),
      start: requireEnv('START_WORKFLOW_ARN'),
      stop: requireEnv('STOP_WORKFLOW_ARN'),
      destroy: requireEnv('DESTROY_WORKFLOW_ARN'),
    }),
    // Listing only (a restore checks the backup is in the list): never writing or reading backups.
    backups: s3BackupStorage({
      bucket: requireEnv('BACKUP_BUCKET'),
      region: requireEnv('BACKUP_BUCKET_REGION'),
      writerRoleArn: '',
    }),
    // A request naming an upload is the caller's to fix, so a 400 rather than an error.
    uploads: {
      status: async () => {
        throw new OperationError(400, 'Creating a server from an upload comes with the /v1 uploads');
      },
      accepted: () => notYet('Uploads'),
    },
    versions: publishedVersions(),
    homeRegion: requireEnv('HOME_REGION'),
    gameRegions: requireEnv('GAME_REGIONS').split(','),
  }),
});
