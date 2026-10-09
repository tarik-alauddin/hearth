// Lambda entry point for the /v1 routes (signed-in users); ApiStack points the User function here.
import { createAccessStore, createInvitesStore, createOwnedServers, createServersStore, createUsersStore } from '@hearth/core';
import { s3BackupStorage } from '../backups.js';
import { inviteOperations } from '../invites/operations.js';
import { memberOperations } from '../members/operations.js';
import { serverOperations } from '../servers/operations.js';
import { publishedVersions } from '../servers/versions.js';
import { stepFunctionsWorkflows } from '../servers/workflows.js';
import { s3UploadStorage, uploadOperations } from '../uploads.js';
import { userOperations } from '../users/operations.js';
import { userHandler } from './handlers.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const users = createUsersStore(requireEnv('USERS_TABLE'));
const serversTable = requireEnv('SERVERS_TABLE');
const accessTable = requireEnv('ACCESS_TABLE');
const servers = createServersStore(serversTable);
const access = createAccessStore(accessTable);
const uploads = s3UploadStorage({ bucket: requireEnv('UPLOADS_BUCKET'), region: requireEnv('UPLOADS_BUCKET_REGION') });

export const handler = userHandler({
  users,
  userOps: userOperations({ users }),
  inviteOps: inviteOperations({ servers, access, invites: createInvitesStore(requireEnv('INVITES_TABLE')) }),
  memberOps: memberOperations({ access, users }),
  uploadOps: uploadOperations({ uploads, users }),
  serverOps: serverOperations({
    store: servers,
    access,
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
    uploads,
    versions: publishedVersions(),
    homeRegion: requireEnv('HOME_REGION'),
    gameRegions: requireEnv('GAME_REGIONS').split(','),
  }),
});
