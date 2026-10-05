// Lambda entry point for the /admin routes.
import { createServersStore } from '@hearth/core';
import { s3BackupStorage } from '../backups.js';
import { serverOperations } from '../servers/operations.js';
import { stepFunctionsWorkflows } from '../servers/workflows.js';
import { adminHandler } from './handlers.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const handler = adminHandler({
  operations: serverOperations({
    store: createServersStore(requireEnv('SERVERS_TABLE')),
    workflows: stepFunctionsWorkflows({
      create: requireEnv('CREATE_WORKFLOW_ARN'),
      start: requireEnv('START_WORKFLOW_ARN'),
      stop: requireEnv('STOP_WORKFLOW_ARN'),
    }),
    homeRegion: requireEnv('HOME_REGION'),
    gameRegions: requireEnv('GAME_REGIONS').split(','),
  }),
  backups: s3BackupStorage({
    bucket: requireEnv('BACKUP_BUCKET'),
    region: requireEnv('BACKUP_BUCKET_REGION'),
    writerRoleArn: '', // admin routes only read
  }),
  instanceRoleNames: requireEnv('INSTANCE_ROLE_NAMES').split(','),
});
