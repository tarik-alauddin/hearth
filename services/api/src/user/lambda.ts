// Lambda entry point for the /v1 routes (signed-in users); ApiStack points the User function here.
import { createUsersStore } from '@hearth/core';
import { userHandler } from './handlers.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const handler = userHandler({ users: createUsersStore(requireEnv('USERS_TABLE')) });
