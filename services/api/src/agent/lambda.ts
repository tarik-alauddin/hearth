// Lambda entry points for the agent routes; ApiStack points one function at each export.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { dynamoServersStore } from '../servers.js';
import { agentHandlers } from './handlers.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const handlers = agentHandlers({
  store: dynamoServersStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), requireEnv('SERVERS_TABLE')),
  instanceRoleNames: requireEnv('INSTANCE_ROLE_NAMES').split(','),
});

export const configHandler = handlers.config;
export const statusHandler = handlers.status;
