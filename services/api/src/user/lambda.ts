// Lambda entry point for the /v1 routes (signed-in users); ApiStack points the User function here.
import { createUsersStore } from '@hearth/core';
import { userOperations } from '../users/operations.js';
import { userHandler } from './handlers.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const users = createUsersStore(requireEnv('USERS_TABLE'));

export const handler = userHandler({ users, userOps: userOperations({ users }) });
