// Lambda entry points for the agent routes; ApiStack points one function at each export.
import { createServersStore } from '@hearth/core';
import { s3BackupStorage } from '../backups.js';
import { serverOperations } from '../servers/operations.js';
import { publishedVersions } from '../servers/versions.js';
import { stepFunctionsWorkflows } from '../servers/workflows.js';
import { s3UploadStorage } from '../uploads.js';
import { agentHandlers } from './handlers.js';
import { ssmAgentReleases } from './releases.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const store = createServersStore(requireEnv('SERVERS_TABLE'));
const backups = s3BackupStorage({
  bucket: requireEnv('BACKUP_BUCKET'),
  region: requireEnv('BACKUP_BUCKET_REGION'),
  // Only the credentials route assumes the writer role.
  writerRoleArn: process.env.BACKUP_WRITER_ROLE_ARN ?? '',
});
// Only the config route reads it: to sign the download of an accepted upload a server was created from.
const uploads = s3UploadStorage({ bucket: requireEnv('UPLOADS_BUCKET'), region: requireEnv('UPLOADS_BUCKET_REGION') });

const handlers = agentHandlers({
  store,
  instanceRoleNames: requireEnv('INSTANCE_ROLE_NAMES').split(','),
  releases: ssmAgentReleases({ env: requireEnv('HEARTH_ENV'), bucket: requireEnv('AGENT_RELEASES_BUCKET') }),
  backups,
  uploads,
  // The same operations as the admin routes. Agents only stop their own server, so only the idle
  // route's function gets the stop workflow's ARN (and permission to start it).
  operations: serverOperations({
    store,
    workflows: stepFunctionsWorkflows({ create: '', start: '', stop: process.env.STOP_WORKFLOW_ARN ?? '' }),
    backups,
    uploads, // never used here: agents don't create servers
    versions: publishedVersions(),
    homeRegion: process.env.AWS_REGION ?? '',
    gameRegions: [],
  }),
});

export const configHandler = handlers.config;
export const statusHandler = handlers.status;
export const backupCredentialsHandler = handlers.backupCredentials;
export const backupDoneHandler = handlers.backupDone;
export const restoredHandler = handlers.restored;
export const idleHandler = handlers.idle;
